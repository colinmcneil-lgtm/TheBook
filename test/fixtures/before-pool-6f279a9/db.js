import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { profileUrl } from './links.js';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));
// secure_delete: what is deleted is written over, not just marked as free space. People ask to be erased and keys
// get replaced, and neither should be readable afterwards in a copy of the file.
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  brand_color TEXT NOT NULL DEFAULT '#1f5443',
  website TEXT, industry TEXT, location TEXT, tagline TEXT, about TEXT,
  privacy_url TEXT,                                  -- the client's privacy notice, linked from the application form
  status TEXT NOT NULL DEFAULT 'active',            -- active | paused | ended
  engagement_model TEXT NOT NULL DEFAULT 'retainer', -- retainer | per_hire | hybrid
  monthly_retainer INTEGER NOT NULL DEFAULT 0,
  fee_percent REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  started_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,              -- never reused, so a stale Approve or Decline cannot land on a newer request
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL,                                -- admin | recruiter | client
  client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
  title TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  pending INTEGER NOT NULL DEFAULT 0,                -- 1 = self-registered and waiting for an agency user to approve
  requested_company TEXT,                            -- what a self-registered person typed as their company
  created_at TEXT NOT NULL
);

-- One-time links that let a specific person create their own account with the access chosen by the inviter.
CREATE TABLE IF NOT EXISTS invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,                   -- only a hash is stored; the link itself is shown once
  role TEXT NOT NULL,                                -- admin | recruiter | client
  client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
  email TEXT,                                        -- if set, the account must use this address
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  department TEXT, location TEXT,
  work_mode TEXT NOT NULL DEFAULT 'hybrid',          -- onsite | hybrid | remote
  employment_type TEXT NOT NULL DEFAULT 'full_time', -- full_time | part_time | contract
  salary_min INTEGER, salary_max INTEGER,
  salary_public INTEGER NOT NULL DEFAULT 1,
  description TEXT,
  ideal_profile TEXT,                                -- internal brief, never shown publicly
  brief TEXT NOT NULL DEFAULT '{}',                  -- the recruiter brief (must-haves, where to look, search terms, pay notes...), agency only
  status TEXT NOT NULL DEFAULT 'draft',              -- draft | open | paused | closed
  hiring_manager_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  openings INTEGER NOT NULL DEFAULT 1,
  questions TEXT NOT NULL DEFAULT '[]',
  criteria TEXT NOT NULL DEFAULT '[]',
  created_by INTEGER,
  created_at TEXT NOT NULL,
  opened_at TEXT, closed_at TEXT
);

CREATE TABLE IF NOT EXISTS stages (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,                                -- applied | interview | offer | hired
  position INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,              -- never reused, so an old link cannot open a different person
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT,                                        -- required for applicants; may be unknown for people the agency sourced
  phone TEXT, linkedin TEXT, location TEXT, current_title TEXT, current_company TEXT,
  photo_file TEXT,                                   -- profile photo saved with the candidate (a file in the uploads folder)
  created_at TEXT NOT NULL,
  UNIQUE (client_id, email)
);

CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  stage_id INTEGER NOT NULL REFERENCES stages(id),
  status TEXT NOT NULL DEFAULT 'active',             -- active | rejected | withdrawn | hired
  source TEXT NOT NULL DEFAULT 'careers_page',
  rating INTEGER,
  answers TEXT NOT NULL DEFAULT '[]',
  cover_note TEXT,
  resume_file TEXT, resume_name TEXT,
  reject_reason TEXT,
  review_status TEXT,                                -- null | pending | approved | declined
  submission_note TEXT, review_note TEXT,
  submitted_by INTEGER, reviewed_by INTEGER, reviewed_at TEXT,
  applied_at TEXT NOT NULL,
  stage_entered_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  hired_at TEXT,
  consent_at TEXT,                                   -- when the applicant ticked the data-processing consent box
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL, -- the recruiter responsible for this candidate in this job
  UNIQUE (candidate_id, job_id)
);

CREATE TABLE IF NOT EXISTS stage_history (
  id INTEGER PRIMARY KEY,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  stage_id INTEGER NOT NULL,
  entered_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  private INTEGER NOT NULL DEFAULT 0,                -- 1 = visible to the agency only
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  user_id INTEGER,
  type TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS interviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'video',                -- phone | video | onsite | technical
  starts_at TEXT NOT NULL,
  duration_min INTEGER NOT NULL DEFAULT 45,
  location TEXT, notes TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled',          -- scheduled | completed | cancelled
  created_by INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS interview_panel (
  interview_id INTEGER NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (interview_id, user_id)
);

CREATE TABLE IF NOT EXISTS scorecards (
  id INTEGER PRIMARY KEY,
  interview_id INTEGER NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recommendation TEXT NOT NULL,                      -- strong_yes | yes | no | strong_no
  ratings TEXT NOT NULL DEFAULT '{}',
  notes TEXT,
  submitted_at TEXT NOT NULL,
  UNIQUE (interview_id, user_id)
);

CREATE TABLE IF NOT EXISTS offers (
  id INTEGER PRIMARY KEY,
  application_id INTEGER NOT NULL UNIQUE REFERENCES applications(id) ON DELETE CASCADE,
  salary INTEGER,
  start_date TEXT,
  status TEXT NOT NULL DEFAULT 'draft',              -- draft | sent | accepted | declined
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS emails (
  id INTEGER PRIMARY KEY,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  sent_by INTEGER,
  delivery TEXT NOT NULL,                            -- sent | failed | not_configured
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS email_templates (
  id INTEGER PRIMARY KEY,
  key TEXT UNIQUE,                                   -- set for templates the system sends automatically
  name TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL
);

-- The Oracle: calls with candidates that a recruiter recorded or uploaded, or that were brought in from Metaview,
-- with the transcript, the notes summary and the draft write-up for the hiring team. Agency only: client users
-- never see any of it.
CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,              -- never reused, so an old link cannot open a different call
  recording_id TEXT NOT NULL UNIQUE,                 -- 32 hex characters; names the folder the pieces of a recording arrive in
  title TEXT NOT NULL,
  status TEXT NOT NULL,                              -- recording | uploaded | transcribing | ready | failed
  error TEXT,                                        -- why transcription failed, in plain English
  source TEXT NOT NULL,                              -- recorded | uploaded | metaview (and phone, on calls from before phone calls were taken out)
  mime_type TEXT,                                    -- the format the browser said it was recording in
  audio_file TEXT, audio_type TEXT, audio_size INTEGER, -- the finished audio: a file in the uploads folder
  duration_ms INTEGER,
  interrupted INTEGER NOT NULL DEFAULT 0,            -- 1 = finished from what had arrived after the recording was cut short
  joined_parts INTEGER,                              -- how many pieces of the recording the audio file was made from
  transcript TEXT,                                   -- JSON: [{ speaker, start, end, text }]
  transcript_source TEXT,                            -- deepgram | pasted | metaview
  speakers TEXT NOT NULL DEFAULT '{}',               -- JSON: speaker number -> name
  notes TEXT, notes_at TEXT,
  notes_auto INTEGER NOT NULL DEFAULT 0,             -- 1 = the notes are as the AI wrote them; 0 once somebody has typed or changed them
  notes_blind INTEGER NOT NULL DEFAULT 0,            -- 1 = the AI wrote them before the call was on a candidate, so without the person or the job
  notes_error TEXT,                                  -- why the last attempt to write the notes failed, in plain English
  submission TEXT, submission_at TEXT,
  note_id INTEGER,                                   -- the candidate note the summary was last saved as
  -- Removing an application leaves the call with the candidate; removing the candidate removes their calls.
  application_id INTEGER REFERENCES applications(id) ON DELETE SET NULL,
  candidate_id INTEGER REFERENCES candidates(id) ON DELETE CASCADE,
  consent_by INTEGER, consent_at TEXT, consent_wording TEXT, -- who confirmed everyone agreed to be recorded, when, and the words they agreed to
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`);

// ---------- migrations for databases created by an earlier version ----------
/** Add a column a table does not have yet. Says whether it was added just now, for a step that must only follow the first time. */
function addColumn(table, column, type) {
  const has = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  return !has;
}
/**
 * Rebuild a table with a changed definition (SQLite cannot alter a column in place). `change` receives the table's
 * CREATE statement and returns the new one; nothing happens if it returns it unchanged. Rows and ids are kept, and
 * so is the table's record of the highest id it ever gave out, so the id of a deleted row is still never reused.
 */
function rebuildTable(table, change) {
  const { sql } = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table);
  const changed = change(sql);
  if (changed === sql) return;
  const rebuilt = changed.replace(/^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?["`]?\w+["`]?/i, `CREATE TABLE ${table}__new`);
  // sqlite_sequence only exists once some table uses AUTOINCREMENT, and dropping a table discards its row.
  const hasSequences = db.prepare(`SELECT 1 AS x FROM sqlite_master WHERE name = 'sqlite_sequence'`).get();
  const highest = hasSequences ? db.prepare('SELECT seq FROM sqlite_sequence WHERE name = ?').get(table)?.seq : undefined;
  db.exec('PRAGMA foreign_keys = OFF'); // must be off, or dropping the old table would cascade into its children
  db.exec('BEGIN');
  try {
    db.exec(rebuilt);
    db.exec(`INSERT INTO ${table}__new SELECT * FROM ${table}`);
    db.exec(`DROP TABLE ${table}`);
    db.exec(`ALTER TABLE ${table}__new RENAME TO ${table}`);
    if (highest != null && /AUTOINCREMENT/i.test(changed)) {
      // The copy only counted up to the highest row that still exists; put back the real high-water mark.
      const kept = db.prepare('UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = ?').run(highest, table).changes;
      if (!kept) db.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)').run(table, highest);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}
/** Ids that are never reused after a delete, so an old link cannot open a different record. */
const ensureAutoincrement = (table) =>
  rebuildTable(table, (sql) => (/AUTOINCREMENT/i.test(sql) ? sql : sql.replace(/\bid INTEGER PRIMARY KEY\b/i, 'id INTEGER PRIMARY KEY AUTOINCREMENT')));
addColumn('clients', 'privacy_url', 'TEXT');
addColumn('jobs', 'brief', "TEXT NOT NULL DEFAULT '{}'");
addColumn('users', 'pending', 'INTEGER NOT NULL DEFAULT 0');
// Engagement terms that do not belong to the client's current model are not counted as revenue; clear any left by older versions.
db.exec(`UPDATE clients SET monthly_retainer = 0 WHERE engagement_model = 'per_hire' AND monthly_retainer != 0`);
db.exec(`UPDATE clients SET fee_percent = 0 WHERE engagement_model = 'retainer' AND fee_percent != 0`);
addColumn('users', 'requested_company', 'TEXT');
addColumn('applications', 'consent_at', 'TEXT');
addColumn('candidates', 'photo_file', 'TEXT');
// Columns the calls table gained after it was first made.
addColumn('calls', 'joined_parts', 'INTEGER');
addColumn('calls', 'notes_auto', 'INTEGER NOT NULL DEFAULT 0');
addColumn('calls', 'notes_blind', 'INTEGER NOT NULL DEFAULT 0');
addColumn('calls', 'notes_error', 'TEXT');
if (!db.prepare('PRAGMA table_info(applications)').all().some((c) => c.name === 'owner_id')) {
  db.exec('ALTER TABLE applications ADD COLUMN owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL');
  // Existing candidates belong to whoever added them, where that is known.
  db.exec(`UPDATE applications SET owner_id = (
    SELECT ac.user_id FROM activities ac JOIN users u ON u.id = ac.user_id AND u.role != 'client'
    WHERE ac.application_id = applications.id AND ac.type = 'added' ORDER BY ac.id LIMIT 1)`);
}
// Notes are in this list because a recorded call remembers the note its summary was saved as: a number handed out
// twice would let it write over somebody else's note.
for (const table of ['users', 'candidates', 'applications', 'interviews', 'notes']) ensureAutoincrement(table);
// People sourced from a profile often have no known email yet, so it is no longer required.
rebuildTable('candidates', (sql) => sql.replace(/\bemail TEXT NOT NULL\b/, 'email TEXT'));
// Profile links used to be saved as typed. People are recognised by the stored form of a LinkedIn profile link, so
// links saved by an earlier version are rewritten once into that form. Two records that end up with the same link
// are both kept: the workspace points them out as possible duplicates and leaves the decision to a person.
if (!db.prepare(`SELECT 1 AS x FROM settings WHERE key = 'links_normalised'`).get()) {
  db.exec('BEGIN');
  try {
    const save = db.prepare('UPDATE candidates SET linkedin = ? WHERE id = ?');
    for (const row of db.prepare(`SELECT id, linkedin FROM candidates WHERE linkedin IS NOT NULL AND linkedin != ''`).all()) {
      const link = profileUrl(row.linkedin);
      if (link && link !== row.linkedin) save.run(link, row.id);
    }
    db.prepare(`INSERT INTO settings (key, value) VALUES ('links_normalised', '1')`).run();
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// The dashboard picks out milestones by the type of an activity line. Lines written by an earlier version said less:
// every stage move was 'stage' (told apart by the stage's name, which stopped working when a stage was renamed) and
// a booked interview was an 'interview' line starting "Scheduled" (as did the cancelling of one titled "Scheduled…").
// They are given the newer types once: a move by the name of the stage or, where the stage has been renamed since,
// by the stage the candidate entered nearest that moment.
if (!db.prepare(`SELECT 1 AS x FROM settings WHERE key = 'activity_types_v2'`).get()) {
  db.exec('BEGIN');
  try {
    db.exec(`UPDATE activities SET type = 'interview_booked' WHERE type = 'interview' AND detail LIKE 'Scheduled %' AND detail NOT LIKE '% marked %'`);
    db.exec(`UPDATE activities SET type = COALESCE(
        (SELECT CASE s.kind WHEN 'interview' THEN 'stage_interview' WHEN 'offer' THEN 'stage_offer' END FROM applications a JOIN stages s ON s.job_id = a.job_id
          WHERE a.id = activities.application_id AND 'Moved to ' || s.name = activities.detail AND s.kind IN ('interview', 'offer') LIMIT 1),
        (SELECT CASE s.kind WHEN 'interview' THEN 'stage_interview' WHEN 'offer' THEN 'stage_offer' END FROM stage_history h JOIN stages s ON s.id = h.stage_id
          WHERE h.application_id = activities.application_id AND ABS(julianday(h.entered_at) - julianday(activities.created_at)) < 0.5
          ORDER BY ABS(julianday(h.entered_at) - julianday(activities.created_at)) LIMIT 1),
        type)
      WHERE type = 'stage'`);
    db.prepare(`INSERT INTO settings (key, value) VALUES ('activity_types_v2', '1')`).run();
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

db.exec(`
CREATE INDEX IF NOT EXISTS idx_jobs_client ON jobs(client_id);
CREATE INDEX IF NOT EXISTS idx_apps_job ON applications(job_id);
CREATE INDEX IF NOT EXISTS idx_candidates_link ON candidates(client_id, linkedin);
CREATE INDEX IF NOT EXISTS idx_apps_stage ON applications(stage_id);
CREATE INDEX IF NOT EXISTS idx_hist_app ON stage_history(application_id);
CREATE INDEX IF NOT EXISTS idx_interviews_app ON interviews(application_id);
CREATE INDEX IF NOT EXISTS idx_activities_app ON activities(application_id);
CREATE INDEX IF NOT EXISTS idx_activities_recent ON activities(created_at, id);
CREATE INDEX IF NOT EXISTS idx_calls_candidate ON calls(candidate_id);
CREATE INDEX IF NOT EXISTS idx_calls_application ON calls(application_id);
CREATE INDEX IF NOT EXISTS idx_calls_created_by ON calls(created_by);`);

// ---------- features that have been taken out ----------
// The Book once had phone calls of its own and a calendar in The Oracle. Both are gone, and a database made today has
// nothing of theirs. A database that was in use before still holds their tables (phone_calls, phone_webhooks,
// phone_recordings_owed, phone_calls_erased, calendar_links, calendar_events), their columns on users (phone and the
// PIN columns) and on calls (direction, phone_number, speaker_roles, audio_channels, voicemail, notified_at,
// event_key and the retry columns), and their triggers and indexes. They are left exactly as they are: nothing here
// drops, empties or rewrites them, because removing a feature is no reason to touch people's data on a live system.
// Nothing reads or writes them any more, so the app runs the same on a database that has them and on one that never did.
// The one way they are ever cleared is by hand: `node server/forget-removed.js` removes the saved calendar links and
// the phone numbers and PINs, for an owner who wants them gone.

// ---------- finding the candidate a conversation was with ----------
// Kept together and after everything above: the indexes and triggers on candidates have to be made again whenever
// that table has been rebuilt by a migration. They are what lets match.js look people up by e-mail address, by phone
// number and by name without reading every candidate.
db.exec(`
-- The first and last word of each candidate's name with accents and capitals removed ("kevin" and "tremblay" for
-- "Kévin Tremblay"), so the candidates a name might belong to are found through an index however many candidates
-- are on file. SQLite cannot remove accents by itself, so the words are worked out by the server (match.js): the
-- triggers note which candidates are new or changed, and the server catches up on those before it matches anything.
CREATE TABLE IF NOT EXISTS candidate_name_keys (
  candidate_id INTEGER PRIMARY KEY REFERENCES candidates(id) ON DELETE CASCADE,
  first TEXT NOT NULL,
  last TEXT NOT NULL                                 -- empty for a name of one word
);
CREATE INDEX IF NOT EXISTS idx_candidate_name_keys_words ON candidate_name_keys(first, last);
-- Each candidate's phone number as it is compared: its last ten digits, and whatever digits come before them (the
-- country code, when one was written). Numbers are stored as they were typed ("416-555-0183 ext 4", "416/555/0184"),
-- so the server works these out as well (match.js), by the one rule it also reads Metaview's numbers with. A box
-- holding two numbers gives two rows. A candidate whose number is too short to compare has one row with an empty
-- tail, so that they are not looked at again every time the server starts.
CREATE TABLE IF NOT EXISTS candidate_phone_keys (
  candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  tail TEXT NOT NULL,
  lead TEXT NOT NULL                                 -- the country code: 1 unless another was written; empty when the country is not known
);
CREATE INDEX IF NOT EXISTS idx_candidate_phone_keys_tail ON candidate_phone_keys(tail);
CREATE INDEX IF NOT EXISTS idx_candidate_phone_keys_candidate ON candidate_phone_keys(candidate_id);
-- The candidates whose name or number has to be worked out again.
CREATE TABLE IF NOT EXISTS candidate_name_dirty (candidate_id INTEGER PRIMARY KEY);
CREATE TRIGGER IF NOT EXISTS candidate_name_added AFTER INSERT ON candidates
  BEGIN INSERT OR IGNORE INTO candidate_name_dirty (candidate_id) VALUES (NEW.id); END;
CREATE TRIGGER IF NOT EXISTS candidate_name_changed AFTER UPDATE OF name ON candidates
  BEGIN INSERT OR IGNORE INTO candidate_name_dirty (candidate_id) VALUES (NEW.id); END;
CREATE TRIGGER IF NOT EXISTS candidate_phone_changed AFTER UPDATE OF phone ON candidates
  BEGIN INSERT OR IGNORE INTO candidate_name_dirty (candidate_id) VALUES (NEW.id); END;
INSERT OR IGNORE INTO candidate_name_dirty (candidate_id)
  SELECT id FROM candidates WHERE id NOT IN (SELECT candidate_id FROM candidate_name_keys)
    OR (phone IS NOT NULL AND phone != '' AND id NOT IN (SELECT candidate_id FROM candidate_phone_keys));

-- E-mail addresses are looked up through this. (A database from an earlier version also has an index on the last
-- ten characters of the phone number, idx_candidates_phone_tail. Numbers are looked up through candidate_phone_keys
-- now; the old index is left where it is, like everything else an earlier version made.)
CREATE INDEX IF NOT EXISTS idx_candidates_email_lower ON candidates(lower(email));`);

// ---------- Metaview in The Oracle ----------
// What The Book remembers about the conversations recorded in Metaview (see metaview.js). Agency only.
db.exec(`
-- One row for each conversation Metaview has told The Book about: enough to list it and to work out which candidate
-- it was with, and nothing more. The transcript and the notes are only fetched when a conversation is brought into
-- The Oracle, and they are kept on the call there (calls), not here.
CREATE TABLE IF NOT EXISTS metaview_calls (
  id INTEGER PRIMARY KEY,                            -- Metaview's own number for the conversation
  url TEXT,                                          -- its page in Metaview, where the recording can be listened to
  started_at TEXT NOT NULL,                          -- when the conversation took place
  title TEXT,                                        -- the calendar event's name; most phone calls have none
  kind TEXT, channel TEXT,                           -- "Job Interview"...; "Phone", "Zoom"...
  minutes INTEGER,
  has_transcript INTEGER NOT NULL DEFAULT 0,
  -- JSON: [{ name, role, emails, phones }], role candidate | interviewer | other. Addresses and numbers are kept only
  -- for the people a conversation is matched by (see readConversation in metaview-client.js); an interviewer keeps
  -- their address, which is how "my calls" and whose call it is are worked out.
  people TEXT NOT NULL DEFAULT '[]',
  search TEXT NOT NULL DEFAULT '',                   -- names, addresses, phone digits and the title in lower case: what the search box looks through
  call_id INTEGER REFERENCES calls(id) ON DELETE SET NULL, -- the call in The Oracle, once it has been brought in
  -- When it was first brought in. It stays when the call in The Oracle is deleted, so a call somebody removed is
  -- never brought back by itself (a person can still open it again).
  brought_in_at TEXT,
  auto_at TEXT,                                      -- when it was brought in with nobody clicking, for the daily limit
  -- Something is still owed to the call in The Oracle (notes Metaview had not finished writing, a transcript that
  -- arrived later): how often it has been asked for, and when it is next due. Empty when nothing is owed.
  fetch_tries INTEGER NOT NULL DEFAULT 0, fetch_next_at TEXT,
  seen_at TEXT NOT NULL                              -- when Metaview last told The Book about it
);
CREATE INDEX IF NOT EXISTS idx_metaview_calls_started ON metaview_calls(started_at);
CREATE INDEX IF NOT EXISTS idx_metaview_calls_call ON metaview_calls(call_id);
CREATE INDEX IF NOT EXISTS idx_metaview_calls_owed ON metaview_calls(fetch_next_at) WHERE fetch_next_at IS NOT NULL;

-- What each conversation can be matched or found by, one row per fact, so that the look-ups run through indexes:
--   email        an address of somebody on the call who is not an interviewer
--   phone        the last ten digits of such a person's number; the digits before them (the country code) are in the column "first"
--   name         such a person's name as plain words ("dana whitlock"), with its first and last word
--   interviewer  an interviewer's address (for "calls I took part in")
CREATE TABLE IF NOT EXISTS metaview_people (
  call_id INTEGER NOT NULL REFERENCES metaview_calls(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  first TEXT, last TEXT
);
CREATE INDEX IF NOT EXISTS idx_metaview_people_call ON metaview_people(call_id);
CREATE INDEX IF NOT EXISTS idx_metaview_people_value ON metaview_people(kind, value);

-- Conversations The Book has been told to forget: the ones that were with a candidate who has since been erased.
-- Only Metaview's numbers for them are kept, so that the next reading of Metaview's list does not bring the person's
-- name and contact details straight back. The list is kept for good, through disconnecting and connecting again.
CREATE TABLE IF NOT EXISTS metaview_forgotten (id INTEGER PRIMARY KEY);`);
// What a call in the Oracle carries when it came from Metaview (calls.source = 'metaview').
addColumn('calls', 'external_url', 'TEXT');    // the conversation's page in Metaview
addColumn('calls', 'took_place_at', 'TEXT');   // when the conversation happened (created_at is when it was brought in)
// ---------- reporting ----------
// The numbers on the Individual and Clients reports are written down as things happen (see reporting.js), not worked
// out afterwards from how the records look today. Everything here is new: no existing row is rewritten.
/**
 * Is this the name of an interview stage the agency holds itself ("Recruiter screen", "Agency interview")? Such a
 * stage does not count as an interview with the client unless somebody ticks it on the job form.
 */
export const agencyStageName = (name) => /recruiter|screen|agency/i.test(String(name || ''));
// Each interview stage says whether the client meets the candidate in it. On by default; off for the stages whose
// names say they are the agency's own. Stages that already exist get the same defaults, once, when the column arrives.
if (addColumn('stages', 'with_client', 'INTEGER NOT NULL DEFAULT 1')) {
  db.exec(`UPDATE stages SET with_client = 0 WHERE kind = 'interview' AND (name LIKE '%recruiter%' OR name LIKE '%screen%' OR name LIKE '%agency%')`);
}
addColumn('offers', 'accepted_at', 'TEXT'); // when the offer was marked accepted: the end of "time to fill"
db.exec(`
-- One row for each moment the reports count. A search is opened once; a candidate in a job is submitted once, has a
-- first interview with the client once and is placed once. Who gets the credit, the client, and for a placement the
-- fee and its currency are written here at that moment, so reassigning a candidate or editing a client's terms
-- afterwards changes none of it. Deleting the candidate, the job or the client removes their rows; merging two
-- candidate records keeps them, because the application they hang from is kept.
CREATE TABLE IF NOT EXISTS report_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                                -- search_opened | submission | first_interview | placement, or hired_earlier: a note, never
                                                     -- counted, that the candidate was hired in this job before anything was written down
  application_id INTEGER REFERENCES applications(id) ON DELETE CASCADE, -- empty for search_opened
  candidate_name TEXT,                               -- as it was at that moment
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, -- the recruiter credited
  at TEXT NOT NULL,                                  -- when it happened
  -- For a placement only:
  filled_at TEXT,                                    -- when the offer was accepted, or the hire itself when no accepted offer was on record
  salary INTEGER, fee_percent REAL,                  -- what the fee was worked out from
  fee INTEGER, currency TEXT,                        -- the fee, in the client's currency at that moment; empty when it could not be worked out
  fee_edited INTEGER NOT NULL DEFAULT 0,             -- 1 = somebody corrected the fee by hand
  set_aside_at TEXT                                  -- the hired candidate was moved out of Hired, rejected or withdrew; not counted until they are hired again
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_report_events_once ON report_events(application_id, kind) WHERE application_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_report_events_search ON report_events(job_id) WHERE kind = 'search_opened';
CREATE INDEX IF NOT EXISTS idx_report_events_at ON report_events(at);
CREATE INDEX IF NOT EXISTS idx_report_events_job ON report_events(job_id);
CREATE INDEX IF NOT EXISTS idx_report_events_client ON report_events(client_id);`);
// ---------- end of reporting ----------

export const q = {
  all: (sql, ...p) => db.prepare(sql).all(...p),
  get: (sql, ...p) => db.prepare(sql).get(...p),
  run: (sql, ...p) => db.prepare(sql).run(...p),
  insert: (sql, ...p) => Number(db.prepare(sql).run(...p).lastInsertRowid),
};

export const now = () => new Date().toISOString();
q.run('DELETE FROM sessions WHERE expires_at < ?', now()); // tidy expired sign-ins on startup

/**
 * Empty the file SQLite keeps recent changes in (app.db-wal) into the database. What was deleted is written over in
 * the database itself (secure_delete, above), but the earlier contents stay readable in that file until this is
 * done. Called after something that has to be gone has been deleted. It never fails the work it follows.
 */
export function scrub() {
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* somebody is reading; the next time will do */ }
}

export function tx(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export const getSetting = (key, fallback = null) => q.get('SELECT value FROM settings WHERE key = ?', key)?.value ?? fallback;
export const setSetting = (key, value) =>
  q.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);

export const DEFAULT_INTERVIEW_STAGES = ['Recruiter screen', 'Hiring manager interview', 'Final interview'];
export const DEFAULT_CRITERIA = ['Role-specific skills', 'Problem solving', 'Communication', 'Values and motivation'];

/**
 * Create the pipeline for a new job: Applied, the interview stages, Offer, Hired. An interview stage is a name, or
 * { name, with_client } when the job form said whether the client meets the candidate in it; a bare name goes by
 * what it says (see agencyStageName).
 */
export function createStages(jobId, interviewStages = DEFAULT_INTERVIEW_STAGES) {
  const interviews = interviewStages.map((s) => (typeof s === 'string' ? { name: s } : s))
    .map((s) => [s.name, 'interview', (typeof s.with_client === 'boolean' ? s.with_client : !agencyStageName(s.name)) ? 1 : 0]);
  const rows = [['Applied', 'applied', 1], ...interviews, ['Offer', 'offer', 1], ['Hired', 'hired', 1]];
  rows.forEach(([name, kind, withClient], i) => q.run('INSERT INTO stages (job_id, name, kind, position, with_client) VALUES (?, ?, ?, ?, ?)', jobId, name, kind, i, withClient));
}

const DEFAULT_TEMPLATES = [
  ['application_received', 'Application received', 'We received your application for {{job_title}}',
    'Hi {{candidate_first_name}},\n\nThank you for applying for the {{job_title}} role at {{company}}. We have your application and will review it shortly.\n\nIf your experience looks like a match, we will be in touch to arrange a first conversation.\n\nBest,\nThe {{company}} hiring team'],
  ['rejection', 'Not moving forward', 'Your application for {{job_title}} at {{company}}',
    'Hi {{candidate_first_name}},\n\nThank you for the time you put into your application for {{job_title}} at {{company}}.\n\nAfter careful consideration we have decided not to move forward at this stage. This was not an easy decision, and we would be glad to hear from you again for future roles.\n\nWishing you all the best,\n{{sender_name}}'],
  ['interview_invite', 'Interview invitation', 'Interview for {{job_title}} at {{company}}',
    'Hi {{candidate_first_name}},\n\nWe would like to invite you to an interview for the {{job_title}} role at {{company}}.\n\nWhen: {{interview_time}}\nFormat: {{interview_format}}\nWhere: {{interview_location}}\n\nPlease reply to confirm, or let us know if you need another time.\n\nBest,\n{{sender_name}}'],
  [null, 'Request availability', 'Next steps for {{job_title}} at {{company}}',
    'Hi {{candidate_first_name}},\n\nWe enjoyed learning about your background and would like to set up the next conversation for the {{job_title}} role.\n\nCould you share a few times that work for you over the coming week?\n\nBest,\n{{sender_name}}'],
  [null, 'Offer follow-up', 'Your offer from {{company}}',
    'Hi {{candidate_first_name}},\n\nIt has been a pleasure getting to know you through this process, and the team at {{company}} is excited to offer you the {{job_title}} role.\n\nI will call you to walk through the details. In the meantime, let me know if you have any questions.\n\nBest,\n{{sender_name}}'],
];

if (!q.get('SELECT 1 AS x FROM email_templates LIMIT 1')) {
  for (const t of DEFAULT_TEMPLATES) q.run('INSERT INTO email_templates (key, name, subject, body) VALUES (?, ?, ?, ?)', ...t);
}
