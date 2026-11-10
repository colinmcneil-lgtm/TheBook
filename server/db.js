import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { profileUrl } from './links.js';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

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

-- The Oracle: calls with candidates that a recruiter recorded or uploaded, with the transcript, the notes summary
-- and the draft write-up for the hiring team. Agency only: client users never see any of it.
CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,              -- never reused, so an old link cannot open a different call
  recording_id TEXT NOT NULL UNIQUE,                 -- 32 hex characters; names the folder the pieces of a recording arrive in
  title TEXT NOT NULL,
  status TEXT NOT NULL,                              -- recording | uploaded | transcribing | ready | failed
  error TEXT,                                        -- why transcription failed, in plain English
  source TEXT NOT NULL,                              -- recorded | uploaded
  mime_type TEXT,                                    -- the format the browser said it was recording in
  audio_file TEXT, audio_type TEXT, audio_size INTEGER, -- the finished audio: a file in the uploads folder
  duration_ms INTEGER,
  interrupted INTEGER NOT NULL DEFAULT 0,            -- 1 = finished from what had arrived after the recording was cut short
  joined_parts INTEGER,                              -- how many pieces of the recording the audio file was made from
  transcript TEXT,                                   -- JSON: [{ speaker, start, end, text }]
  transcript_source TEXT,                            -- deepgram | pasted
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
function addColumn(table, column, type) {
  const has = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
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

db.exec(`
CREATE INDEX IF NOT EXISTS idx_jobs_client ON jobs(client_id);
CREATE INDEX IF NOT EXISTS idx_apps_job ON applications(job_id);
CREATE INDEX IF NOT EXISTS idx_candidates_link ON candidates(client_id, linkedin);
CREATE INDEX IF NOT EXISTS idx_apps_stage ON applications(stage_id);
CREATE INDEX IF NOT EXISTS idx_hist_app ON stage_history(application_id);
CREATE INDEX IF NOT EXISTS idx_interviews_app ON interviews(application_id);
CREATE INDEX IF NOT EXISTS idx_activities_app ON activities(application_id);
CREATE INDEX IF NOT EXISTS idx_calls_candidate ON calls(candidate_id);
CREATE INDEX IF NOT EXISTS idx_calls_application ON calls(application_id);
CREATE INDEX IF NOT EXISTS idx_calls_created_by ON calls(created_by);`);

// ---------- phone calls ----------
// Calls placed and received through The Book's own phone number (see phone.js). Agency only, like the Oracle.
db.exec(`
-- One row for each phone call, from the moment it is placed or arrives. This is what the screen follows while the
-- call is live, and what ties the phone service's webhooks and its recording to the call in the Oracle.
CREATE TABLE IF NOT EXISTS phone_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,   -- the recruiter on the call
  direction TEXT NOT NULL,                                   -- outbound (clicked in the app) | switchboard (dialled in from their own phone) | inbound
  status TEXT NOT NULL,                                      -- ringing_you | waiting_for_you | calling_them | in_call | ended | failed
  outcome TEXT,                                              -- completed | busy | no_answer | failed | you_did_not_answer | cancelled
  reason TEXT,                                               -- which sentence explains the outcome, when the outcome alone does not say
  to_number TEXT,                                            -- the other person's number, in the stored form (+1...)
  user_number TEXT,                                          -- the recruiter's own phone that was rung, or that rang in
  -- Erasing a person erases the record of the calls with them. Removing an application leaves it with the person.
  candidate_id INTEGER REFERENCES candidates(id) ON DELETE CASCADE,
  application_id INTEGER REFERENCES applications(id) ON DELETE SET NULL,
  record INTEGER NOT NULL DEFAULT 1,                         -- 0 = placed with no recording and no notice
  event_key TEXT,                                            -- the calendar event this call was made from, if any
  call_sid TEXT, child_sid TEXT,                             -- the phone service's names for the two halves of the call
  pin_ok INTEGER NOT NULL DEFAULT 0,                         -- switchboard: the right PIN has been keyed in on this call
  tries INTEGER NOT NULL DEFAULT 0,                          -- how many times this call has been asked for a key or a number
  notice_at TEXT,                                            -- when the recorded-call notice was played to the other person
  answered_at TEXT, ended_at TEXT, hangup_at TEXT,           -- when the two were joined, when it ended, when the app asked to hang up
  talk_sec INTEGER,                                          -- how long the two spoke
  voicemail INTEGER NOT NULL DEFAULT 0,                      -- 1 = nobody answered and the caller left a message
  -- The recording: waiting (for the phone service to say it is ready) | pending (ready, to be fetched) | fetching |
  -- stored (the audio is on our disk) | absent (none was made) | discarded (the call was deleted first) | failed
  recording_state TEXT, recording_sid TEXT, recording_channels INTEGER, recording_sec INTEGER,
  recording_tries INTEGER NOT NULL DEFAULT 0, recording_next_at TEXT, recording_since TEXT,
  recording_deleted_at TEXT,                                 -- when the phone service's own copy was deleted
  call_id INTEGER REFERENCES calls(id) ON DELETE SET NULL,   -- the call in the Oracle that this one is, or will become
  call_made INTEGER NOT NULL DEFAULT 0,                      -- 1 = it has had a call in the Oracle; with call_id empty, that call was deleted
  checked_at TEXT,                                           -- when the phone service was last asked about a call that went quiet
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- What the phone service told us about each call, kept for two weeks so a call that went wrong can be understood.
-- Numbers and keys pressed are masked before a row is written: nothing here can be used to ring anyone.
CREATE TABLE IF NOT EXISTS phone_webhooks (
  id INTEGER PRIMARY KEY,
  phone_call_id INTEGER REFERENCES phone_calls(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  params TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_phone_calls_sid ON phone_calls(call_sid) WHERE call_sid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_phone_calls_user ON phone_calls(user_id, started_at);
CREATE INDEX IF NOT EXISTS idx_phone_calls_candidate ON phone_calls(candidate_id);
CREATE INDEX IF NOT EXISTS idx_phone_calls_call ON phone_calls(call_id);
CREATE INDEX IF NOT EXISTS idx_phone_webhooks_call ON phone_webhooks(phone_call_id);`);
// Each agency user's own mobile (the phone The Book rings for them, and the one they may ring in from) and the PIN
// that goes with ringing in. Only a hash of the PIN is kept. Three wrong PINs lock that phone out for a while.
addColumn('users', 'phone', 'TEXT');
addColumn('users', 'phone_pin_hash', 'TEXT');
addColumn('users', 'phone_pin_fails', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'phone_locked_until', 'TEXT');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users(phone) WHERE phone IS NOT NULL'); // a phone says who is ringing in, so no two people share one
// What a call in the Oracle carries when it was a phone call (calls.source = 'phone').
addColumn('calls', 'direction', 'TEXT');                       // outbound | inbound
addColumn('calls', 'phone_number', 'TEXT');                    // the other person's number
addColumn('calls', 'speaker_roles', 'TEXT');                   // JSON: channel of the audio -> recruiter | candidate
addColumn('calls', 'audio_channels', 'INTEGER');               // 2 = each person is on a channel of their own
addColumn('calls', 'voicemail', 'INTEGER NOT NULL DEFAULT 0'); // 1 = a message a caller left when nobody answered
addColumn('calls', 'notified_at', 'TEXT');                     // when the recruiter was e-mailed that the notes are ready
addColumn('calls', 'event_key', 'TEXT');                       // the calendar event the call was made from, if any
// ---------- end of phone calls ----------
// ---------- your calendar in The Oracle ----------
// Kept together and after everything above: the tables below point at users, applications and calls, and the indexes
// and triggers on candidates have to be made again whenever that table has been rebuilt by a migration.
/**
 * A candidate's phone number with the usual punctuation taken out, cut to its last ten characters. A number found in
 * a calendar event is looked up by this, using the index on the same expression, so the look-up does not read every
 * candidate. Numbers are stored as they were typed, which is why the tidying happens here.
 */
export const PHONE_TAIL = `substr(replace(replace(replace(replace(replace(replace(phone, ' ', ''), '-', ''), '(', ''), ')', ''), '.', ''), '+', ''), -10)`;
db.exec(`
-- The private calendar link each agency user may save. The link is a password to that person's whole calendar, so
-- it is stored sealed (see secret.js), never returned by any route and never written to a log.
CREATE TABLE IF NOT EXISTS calendar_links (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,                            -- google | outlook | icloud | other, going by the link's host
  link_sealed TEXT NOT NULL,
  tz TEXT,                                           -- the time zone the person last looked at their day in
  created_at TEXT NOT NULL,
  last_read_at TEXT,                                 -- when the calendar was last read successfully
  last_error TEXT                                    -- why the last read failed, in plain English; null when it worked
);

-- What a person has done with the events of their day: marked one to be recorded ("+ Add"), chosen the candidate it
-- is with, recorded a call for it. One row per event a person has been shown, so that an event can be found again
-- from its key alone. Nothing from the calendar itself is kept here: no titles, guests or times, only the key (a
-- keyed hash that is different for every person) and a fingerprint of the title and start time.
CREATE TABLE IF NOT EXISTS calendar_events (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_key TEXT NOT NULL,
  source TEXT NOT NULL,                              -- calendar | interview
  day TEXT NOT NULL, tz TEXT NOT NULL,               -- the day (YYYY-MM-DD, in that time zone) it was last seen on
  fingerprint TEXT,                                  -- finds a marked event again when the calendar gives it a new identity
  added INTEGER NOT NULL DEFAULT 0,                  -- 1 = marked to be recorded
  application_id INTEGER REFERENCES applications(id) ON DELETE SET NULL, -- the candidate the person chose themselves
  call_id INTEGER REFERENCES calls(id) ON DELETE SET NULL,               -- the call recorded for this event
  seen_at TEXT NOT NULL,
  PRIMARY KEY (user_id, event_key)
);
CREATE INDEX IF NOT EXISTS idx_calendar_events_print ON calendar_events(user_id, fingerprint);
CREATE INDEX IF NOT EXISTS idx_calendar_events_seen ON calendar_events(seen_at);

-- The first and last word of each candidate's name with accents and capitals removed ("kevin" and "tremblay" for
-- "Kévin Tremblay"), so the candidates an event's title might be naming are found through an index however many
-- candidates are on file. SQLite cannot remove accents by itself, so the words are worked out by the server
-- (calendar.js): the two triggers note which candidates are new or renamed, and the server catches up on those
-- before it matches anything.
CREATE TABLE IF NOT EXISTS candidate_name_keys (
  candidate_id INTEGER PRIMARY KEY REFERENCES candidates(id) ON DELETE CASCADE,
  first TEXT NOT NULL,
  last TEXT NOT NULL                                 -- empty for a name of one word
);
CREATE INDEX IF NOT EXISTS idx_candidate_name_keys_words ON candidate_name_keys(first, last);
CREATE TABLE IF NOT EXISTS candidate_name_dirty (candidate_id INTEGER PRIMARY KEY);
CREATE TRIGGER IF NOT EXISTS candidate_name_added AFTER INSERT ON candidates
  BEGIN INSERT OR IGNORE INTO candidate_name_dirty (candidate_id) VALUES (NEW.id); END;
CREATE TRIGGER IF NOT EXISTS candidate_name_changed AFTER UPDATE OF name ON candidates
  BEGIN INSERT OR IGNORE INTO candidate_name_dirty (candidate_id) VALUES (NEW.id); END;
INSERT OR IGNORE INTO candidate_name_dirty (candidate_id)
  SELECT id FROM candidates WHERE id NOT IN (SELECT candidate_id FROM candidate_name_keys);

-- Guests' e-mail addresses and phone numbers in events are looked up through these.
CREATE INDEX IF NOT EXISTS idx_candidates_email_lower ON candidates(lower(email));
CREATE INDEX IF NOT EXISTS idx_candidates_phone_tail ON candidates(${PHONE_TAIL}) WHERE phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_interviews_starts ON interviews(starts_at);`);
// ---------- end of the calendar's part ----------

export const q = {
  all: (sql, ...p) => db.prepare(sql).all(...p),
  get: (sql, ...p) => db.prepare(sql).get(...p),
  run: (sql, ...p) => db.prepare(sql).run(...p),
  insert: (sql, ...p) => Number(db.prepare(sql).run(...p).lastInsertRowid),
};

export const now = () => new Date().toISOString();
q.run('DELETE FROM sessions WHERE expires_at < ?', now()); // tidy expired sign-ins on startup

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

/** Create the pipeline for a new job: Applied, the interview stages, Offer, Hired. */
export function createStages(jobId, interviewStages = DEFAULT_INTERVIEW_STAGES) {
  const rows = [['Applied', 'applied'], ...interviewStages.map((n) => [n, 'interview']), ['Offer', 'offer'], ['Hired', 'hired']];
  rows.forEach(([name, kind], i) => q.run('INSERT INTO stages (job_id, name, kind, position) VALUES (?, ?, ?, ?)', jobId, name, kind, i));
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
