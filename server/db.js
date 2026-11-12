import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { profileUrl } from './links.js';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));
// If another process has the database open and is writing to it (a deploy that starts the new container before the
// old one has stopped, two starts at once), wait up to five seconds for it instead of failing with "database is
// locked". Set before anything else, so that it also covers the lines below and every step of an upgrade.
db.exec('PRAGMA busy_timeout = 5000');
// secure_delete: what is deleted is written over, not just marked as free space. People ask to be erased and keys
// get replaced, and neither should be readable afterwards in a copy of the file.
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON;');
/**
 * Undo the transaction that just failed. SQLite has sometimes undone it already by itself (a full disk does that),
 * and a second ROLLBACK then fails with "no transaction is active". That must never take the place of the error
 * that says what actually went wrong, so it is swallowed here and the caller throws the real one.
 */
function undo() {
  try { db.exec('ROLLBACK'); } catch { /* SQLite had already rolled the transaction back */ }
}
/** Whether this error is SQLite saying the disk (or the volume the data folder is on) is full. */
const diskFull = (err) => err?.errcode === 13 || /database or disk is full/i.test(String(err?.message));

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
  created_by INTEGER,                                -- who created the job; never changed afterwards
  account_executive_id INTEGER REFERENCES users(id) ON DELETE SET NULL, -- the agency user the job belongs to: its creator, until it is handed to somebody else
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
  client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE, -- empty for someone saved to The Book without a job: they belong to the agency, not to a client
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
  -- A row with no job and no stage is the entry of someone saved to The Book without a job. It holds their owner,
  -- résumé, notes and history like any other row, and becomes a job's application (same id) when they are put on one.
  job_id INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
  stage_id INTEGER REFERENCES stages(id),
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
  general_until TEXT,                                -- when someone saved without a job was put on this one; what was written before then stays with the agency
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
 * The table's indexes and triggers are kept too, written as they were: dropping a table drops them with it, and
 * one that an earlier version made and this one no longer makes would otherwise be gone for good.
 */
function rebuildTable(table, change) {
  const defined = () => db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table).sql;
  if (change(defined()) === defined()) return;
  db.exec('PRAGMA foreign_keys = OFF'); // must be off, or dropping the old table would cascade into its children
  try {
    // IMMEDIATE: wait here for any other process that is writing, and then look again. Two starts at the same
    // moment both get this far, and the second must find the table already rebuilt and leave it alone.
    db.exec('BEGIN IMMEDIATE');
    try {
      const sql = defined();
      const changed = change(sql);
      if (changed !== sql) {
        const belongings = db.prepare(`SELECT sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL ORDER BY rowid`).all(table);
        const rebuilt = changed.replace(/^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?["`]?\w+["`]?/i, `CREATE TABLE ${table}__new`);
        // sqlite_sequence only exists once some table uses AUTOINCREMENT, and dropping a table discards its row.
        const hasSequences = db.prepare(`SELECT 1 AS x FROM sqlite_master WHERE name = 'sqlite_sequence'`).get();
        const highest = hasSequences ? db.prepare('SELECT seq FROM sqlite_sequence WHERE name = ?').get(table)?.seq : undefined;
        db.exec(rebuilt);
        db.exec(`INSERT INTO ${table}__new SELECT * FROM ${table}`);
        db.exec(`DROP TABLE ${table}`);
        db.exec(`ALTER TABLE ${table}__new RENAME TO ${table}`);
        for (const own of belongings) db.exec(own.sql);
        if (highest != null && /AUTOINCREMENT/i.test(changed)) {
          // The copy only counted up to the highest row that still exists; put back the real high-water mark.
          const kept = db.prepare('UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = ?').run(highest, table).changes;
          if (!kept) db.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)').run(table, highest);
        }
      }
      db.exec('COMMIT');
    } catch (err) {
      undo();
      if (diskFull(err)) {
        // Said in plain words, because the owner of a nearly full volume would otherwise see the server start, fail
        // and start again with nothing to go on. No row has been changed or lost: this table is as it was before this
        // start (one rebuilt before it stays rebuilt, with the rows it had). Measured, the most room needed at
        // once is about one and a half times the size of app.db in all: free space of about half its size.
        let size = '';
        try { size = ` (it is ${Math.ceil(fs.statSync(path.join(DATA_DIR, 'app.db')).size / 1e6)} MB now)`; } catch { /* the sentence does without it */ }
        throw new Error(`The disk that holds ${DATA_DIR} is full, so the database could not be upgraded. No row has been changed or lost. `
          + `The first start of this version needs room for about one and a half times the size of app.db${size} in all, so free space of about half its size, `
          + `while it rebuilds the table "${table}". `
          + 'Free some space or make the volume larger, and start again.', { cause: err });
      }
      throw err;
    }
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
  // The column and the owners that go in it are saved together. Were a start cut off between the two, the next one
  // would find the column there and never fill it in.
  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE applications ADD COLUMN owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL');
    // Existing candidates belong to whoever added them, where that is known.
    db.exec(`UPDATE applications SET owner_id = (
      SELECT ac.user_id FROM activities ac JOIN users u ON u.id = ac.user_id AND u.role != 'client'
      WHERE ac.application_id = applications.id AND ac.type = 'added' ORDER BY ac.id LIMIT 1)`);
    db.exec('COMMIT');
  } catch (err) {
    undo();
    throw err;
  }
}
// Every job has an account executive: the agency user it belongs to. That is whoever created it, until an admin or
// the account executive hands it to somebody else. Jobs that were there before the column are given their creator,
// once, when the column arrives: only when that person is still on file and is on the agency's team (a job nobody
// is recorded as creating, or whose creator has been removed or is a client's user, has no account executive until
// an admin names one). Nothing else on the job is touched, and who created it stays as it was.
// The column is added and filled as one step. If the server is stopped part-way, neither has happened and the next
// start does both: a column that was there but never filled would leave every job with nobody for good.
db.exec('BEGIN');
try {
  if (addColumn('jobs', 'account_executive_id', 'INTEGER REFERENCES users(id) ON DELETE SET NULL')) {
    db.exec(`UPDATE jobs SET account_executive_id = created_by
             WHERE created_by IN (SELECT id FROM users WHERE role != 'client')`);
  }
  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  throw err;
}
// Notes are in this list because a recorded call remembers the note its summary was saved as: a number handed out
// twice would let it write over somebody else's note.
for (const table of ['users', 'candidates', 'applications', 'interviews', 'notes']) ensureAutoincrement(table);
// People sourced from a profile often have no known email yet, so it is no longer required.
rebuildTable('candidates', (sql) => sql.replace(/\bemail TEXT NOT NULL\b/, 'email TEXT'));
// People in The Book without a job. Somebody can be saved with no job chosen: a candidate with no client, whose one
// application has no job and no stage. So those three columns stop being required. Nothing else about the two tables
// changes, and no row is touched: every existing person has a client, and every existing application a job and a stage.
// Each table is rebuilt in a transaction of its own, so a start that is cut short leaves it either as it was or
// finished, and the next start carries on from there.
rebuildTable('candidates', (sql) => sql.replace(/\bclient_id\s+INTEGER\s+NOT\s+NULL\b/i, 'client_id INTEGER'));
rebuildTable('applications', (sql) => sql
  .replace(/\bjob_id\s+INTEGER\s+NOT\s+NULL\b/i, 'job_id INTEGER')
  .replace(/\bstage_id\s+INTEGER\s+NOT\s+NULL\b/i, 'stage_id INTEGER'));
// Said plainly in the log if a table was not written the way the lines above expect, and so was left alone: saving
// somebody without a job would then be refused by the database, and everything else carries on as before.
for (const [table, column] of [['candidates', 'client_id'], ['applications', 'job_id'], ['applications', 'stage_id']]) {
  if (db.prepare(`PRAGMA table_info(${table})`).all().find((c) => c.name === column)?.notnull) {
    console.error(`The database was not upgraded: ${table}.${column} is still required, so nobody can be saved to The Book without a job yet.`);
  }
}
// When such a person is put on a job, their entry becomes that job's application. What was written on it before
// then (notes, e-mails, history) was written for the agency's eyes. It is taken off the application at that moment
// (see agency_activities below), and the moment itself is kept here: it says the application came from The Book, and
// the client's hiring team is only ever shown what came after it.
addColumn('applications', 'general_until', 'TEXT');
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
    undo();
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
    undo();
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
CREATE INDEX IF NOT EXISTS idx_calls_created_by ON calls(created_by);
-- The table's own rules (one record per e-mail at a client, one application per person in a job) do not reach rows
-- where the client or the job is empty, because SQLite counts every empty value as different from every other.
-- These two say the same for people saved without a job: one entry each, and one record per e-mail among them.
-- No existing row has an empty job or client, so neither can fail on a database made by an earlier version.
CREATE UNIQUE INDEX IF NOT EXISTS idx_apps_general ON applications(candidate_id) WHERE job_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_candidates_general_email ON candidates(email) WHERE client_id IS NULL;

-- A résumé that a newer one took the place of. Saving somebody who is already in The Book again with a résumé puts
-- the new file on their entry, and the one they had is kept here, so a save made by mistake never costs a file.
-- Agency only: the hiring team is shown the résumé on the application and nothing from this table.
CREATE TABLE IF NOT EXISTS earlier_resumes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  resume_file TEXT NOT NULL, resume_name TEXT,       -- a file in the uploads folder, and the name it was uploaded under
  kept_at TEXT NOT NULL,                             -- when the newer résumé took its place
  kept_by INTEGER                                    -- who sent the newer one
);
CREATE INDEX IF NOT EXISTS idx_earlier_resumes_app ON earlier_resumes(application_id);

-- What people sent a client themselves. One row for each résumé somebody attached to their own application, on the
-- client's careers page or through the agency's post: the client, and the SHA-256 of the file's bytes (a fingerprint,
-- which cannot be turned back into the file). Nothing else about the person or the file is kept here. It is how The
-- Book knows, when somebody goes back to The Book from a client's job, which file must not go on to the next client
-- (see clientsCopy in api.js). An empty client is a client no longer known: the rows written once at start-up for
-- files kept by an earlier version, and the rows of a client that was deleted. Rows go when the person is erased.
CREATE TABLE IF NOT EXISTS sent_resumes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  hash TEXT NOT NULL,                                -- SHA-256 of the file's bytes, in hex
  sent_at TEXT NOT NULL                              -- when it was sent (for a row written at start-up, when that was)
);
CREATE INDEX IF NOT EXISTS idx_sent_resumes_hash ON sent_resumes(hash);

-- History lines and e-mails on an application that only the agency may read: everything written while the person
-- was in The Book without a job (moved here the moment they are put on one), and the lines that say how they were
-- matched or joined to a record. They are kept in tables of their own, never in activities and emails, because
-- those two are what the client's hiring team is shown from. So nothing that reads those two tables can show a
-- client what is kept here: not a mistake in a later change, and not the release from before this was built, should
-- a deploy ever be rolled back to it. The columns are the ones activities and emails have.
CREATE TABLE IF NOT EXISTS agency_activities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  user_id INTEGER,
  type TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agency_activities_app ON agency_activities(application_id);
CREATE TABLE IF NOT EXISTS agency_emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  sent_by INTEGER,
  delivery TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agency_emails_app ON agency_emails(application_id);`);
/**
 * Move history lines and e-mails of an application out of the tables the hiring team is shown from and into the
 * agency's own (inside a transaction). `which` picks the lines, written against activities or emails as "x" and the
 * application as "a"; they arrive on `toApplicationId`, or stay on the application they were on when none is given.
 * Lines keep their order: they are copied oldest first, and the agency's tables number them as they arrive.
 */
export function keepForAgency(which, params = [], toApplicationId = null) {
  const to = toApplicationId == null ? 'x.application_id' : '?';
  const target = toApplicationId == null ? [] : [toApplicationId];
  for (const [from, into, columns] of [
    ['activities', 'agency_activities', 'user_id, type, detail, created_at'],
    ['emails', 'agency_emails', 'to_email, subject, body, sent_by, delivery, created_at'],
  ]) {
    const chosen = `FROM ${from} x JOIN applications a ON a.id = x.application_id WHERE ${which}`;
    db.prepare(`INSERT INTO ${into} (application_id, ${columns}) SELECT ${to}, ${columns.split(', ').map((c) => `x.${c}`).join(', ')} ${chosen} ORDER BY x.created_at, x.id`).run(...target, ...params);
    db.prepare(`DELETE FROM ${from} WHERE id IN (SELECT x.id ${chosen})`).run(...params);
  }
}
// A build of this release that was never deployed kept such lines where they were and marked them (a column
// agency_only on activities and on emails), or told them by their date (older than applications.general_until). A
// database that build has opened is put right here: the lines move to the agency's tables. The two columns stay,
// unused. The same build left a covering note saved with an entry on the application when the entry went on a job,
// and let screening answers and a consent date given to one client travel on to the next client's job. All three
// are taken off every application that came from The Book and kept as one agency-only note, as this version does
// at the moment of joining. A database that has only ever been opened by released versions has neither column,
// and nothing happens.
if (['activities', 'emails'].every((table) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === 'agency_only'))) {
  db.exec('BEGIN IMMEDIATE');
  try {
    keepForAgency('x.agency_only = 1 OR (a.job_id IS NOT NULL AND a.general_until IS NOT NULL AND x.created_at < a.general_until)');
    const left = `job_id IS NOT NULL AND general_until IS NOT NULL AND (cover_note IS NOT NULL OR answers != '[]' OR consent_at IS NOT NULL)`;
    db.exec(`INSERT INTO notes (application_id, user_id, body, private, created_at)
      SELECT id, COALESCE(owner_id, (SELECT MIN(id) FROM users), 0), 'From before they were put on this job. Kept for the agency only.'
        || COALESCE(char(10) || char(10) || 'Saved with their entry in The Book: ' || cover_note, '')
        || CASE WHEN answers != '[]' THEN char(10) || char(10) || 'Screening answers they gave elsewhere: ' || answers ELSE '' END
        || COALESCE(char(10) || char(10) || 'They agreed to their data being processed, elsewhere, on ' || substr(consent_at, 1, 10), ''), 1, general_until
      FROM applications WHERE ${left}`);
    db.exec(`UPDATE applications SET cover_note = NULL, answers = '[]', consent_at = NULL WHERE ${left}`);
    db.exec('COMMIT');
  } catch (err) {
    undo();
    throw err;
  }
}

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
// The column and its defaults are saved together. Were a start cut off between the two, the next one would find the
// column there and leave every "Recruiter screen" counted as an interview with the client.
if (!db.prepare('PRAGMA table_info(stages)').all().some((c) => c.name === 'with_client')) {
  db.exec('BEGIN');
  try {
    addColumn('stages', 'with_client', 'INTEGER NOT NULL DEFAULT 1');
    db.exec(`UPDATE stages SET with_client = 0 WHERE kind = 'interview' AND (name LIKE '%recruiter%' OR name LIKE '%screen%' OR name LIKE '%agency%')`);
    db.exec('COMMIT');
  } catch (err) {
    undo();
    throw err;
  }
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

// ---------- to do ----------
// Each agency user's own to-do list (see todos.js): the jobs they have picked to work on, and the people to prep
// before an interview and to debrief after one. Everything here is new: no existing row is rewritten.
db.exec(`
-- One row for each thing on somebody's list. A job to work on names the job; a person to prep or debrief names the
-- candidate in a job (the application) and, when The Book knows one, the interview it is about. Deleting the job,
-- the candidate or the person whose list it is removes their rows; merging two candidate records keeps them,
-- because the application they hang from is kept.
CREATE TABLE IF NOT EXISTS todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,              -- never reused, so an old tab cannot tick somebody else's newer item
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,          -- whose list it is on; nobody else sees it
  kind TEXT NOT NULL,                                -- job | prep | debrief
  job_id INTEGER REFERENCES jobs(id) ON DELETE CASCADE,                     -- for a job to work on
  application_id INTEGER REFERENCES applications(id) ON DELETE CASCADE,     -- for a person to prep or debrief
  interview_id INTEGER REFERENCES interviews(id) ON DELETE SET NULL,        -- the interview it is about, when there is one in The Book
  note TEXT,
  position INTEGER NOT NULL DEFAULT 0,               -- where it sits among what is still to do on that list, from 0
  auto INTEGER NOT NULL DEFAULT 0,                   -- 1 = The Book added it by itself, for that interview
  created_at TEXT NOT NULL,
  done_at TEXT,                                      -- when it was ticked; done items are shown for seven days and then only kept
  auto_done INTEGER NOT NULL DEFAULT 0,              -- 1 = The Book ticked it itself, because the interview's end had passed
  -- When it was taken off the list. The row is kept: taken off by the person, so that The Book does not put the same
  -- person back for the same interview; taken off by The Book (set_aside), so that the note on it is still there if
  -- the same interview brings it back.
  removed_at TEXT,
  set_aside INTEGER NOT NULL DEFAULT 0               -- 1 = The Book took it off by itself: the interview was moved over a week away or cancelled, or the candidate changed hands
);
CREATE INDEX IF NOT EXISTS idx_todos_list ON todos(user_id, kind);
CREATE INDEX IF NOT EXISTS idx_todos_job ON todos(job_id);
CREATE INDEX IF NOT EXISTS idx_todos_application ON todos(application_id);
CREATE INDEX IF NOT EXISTS idx_todos_interview ON todos(interview_id);
-- A job, or a person to prep or to debrief, is on one person's list once at a time (a person can be on both the
-- prep and the debrief list). Items that are done or removed do not count.
CREATE UNIQUE INDEX IF NOT EXISTS idx_todos_job_once ON todos(user_id, job_id) WHERE kind = 'job' AND done_at IS NULL AND removed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_todos_person_once ON todos(user_id, kind, application_id) WHERE kind != 'job' AND done_at IS NULL AND removed_at IS NULL;`);
// A to-do table made before items could be set aside gets the column; its rows are left as they are.
addColumn('todos', 'set_aside', 'INTEGER NOT NULL DEFAULT 0');
// ---------- end of to do ----------

// ---------- our website's jobs page ----------
// The agency's own, confidential adverts for its clients' jobs, shown on a public board in the agency's name (see
// board.js). Everything here is new: no existing row is rewritten.
db.exec(`
-- One row for a job the agency has written its own advert for. It holds only what the public is shown, written for
-- that purpose: nothing is copied here from the client. The job's working pattern, contract and salary range are
-- read from the job when the post is shown.
CREATE TABLE IF NOT EXISTS board_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,                        -- the post's public address: random, so it says nothing about the job or the client
  enabled INTEGER NOT NULL DEFAULT 0,                -- the switch "Post on our website (confidential)"
  title TEXT, location TEXT, description TEXT,       -- as the public sees them
  show_salary INTEGER NOT NULL DEFAULT 0,
  -- 1 = on the public board now: switched on, the job is open and the check found nothing. Worked out again
  -- whenever the post, the job or the client changes, and before anything is shown to the public.
  live INTEGER NOT NULL DEFAULT 0,
  problems TEXT NOT NULL DEFAULT '[]',               -- JSON: what the last check found, for the recruiter
  checked_at TEXT,
  posted_at TEXT,                                    -- when it last went public: the only date the public is given
  created_by INTEGER, created_at TEXT NOT NULL,
  updated_by INTEGER, updated_at TEXT NOT NULL
);
-- A word the check found that an admin has said is a false alarm (a client called North, in "North America"). It
-- holds for that word in those surroundings only: the same word anywhere else in the post is found again.
CREATE TABLE IF NOT EXISTS board_overrules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL REFERENCES board_posts(id) ON DELETE CASCADE,
  word TEXT NOT NULL,                                -- what was found, as the check compares it (lower case, no accents)
  phrase TEXT NOT NULL,                              -- the words around it, compared the same way
  shown TEXT NOT NULL,                               -- the phrase as it was written, for the record
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  UNIQUE (post_id, word, phrase)
);
-- What happened to each post, and who did it: published, taken down (and why), a word overruled, switched off.
CREATE TABLE IF NOT EXISTS board_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL REFERENCES board_posts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                                -- published | taken_down | overruled | overrule_withdrawn
  detail TEXT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, -- empty when The Book did it by itself
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_board_log_post ON board_log(post_id);
-- One row for each application that came through a confidential post. It is kept apart from the application itself
-- so that nothing about the post travels with the application to the client's hiring team. Until the candidate has
-- been told who the client is, nothing The Book sends them by itself may name it (see board.js).
CREATE TABLE IF NOT EXISTS board_applications (
  application_id INTEGER PRIMARY KEY REFERENCES applications(id) ON DELETE CASCADE,
  post_id INTEGER NOT NULL REFERENCES board_posts(id) ON DELETE CASCADE,
  public_title TEXT NOT NULL,                        -- the title the candidate saw when they applied, for e-mails to them
  client_known_at TEXT,                              -- when somebody ticked "Knows who the client is"
  client_known_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_board_applications_post ON board_applications(post_id);
-- Other names a client goes by, which the check looks for as it looks for the client's own name: a brand, a
-- product, a short name ("TD" for the Toronto-Dominion Bank). The agency lists them; the public never sees them.
CREATE TABLE IF NOT EXISTS board_names (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  UNIQUE (client_id, name)
);`);
// Added after the board's tables were first made. A database that already has those tables gets the columns; its rows are left as they are.
// 1 = while the post is switched on, the job is left off the client's own careers page, so the two adverts cannot be compared.
addColumn('board_posts', 'hide_from_careers', 'INTEGER NOT NULL DEFAULT 0');
// 1 = the salary range is shown rounded outwards, not to the job's exact figures.
addColumn('board_posts', 'round_salary', 'INTEGER NOT NULL DEFAULT 0');
// 1 = the check took the post down while it was public. It gets a new address when it next goes public, so the
// address that copies of the old text are filed under leads nowhere.
addColumn('board_posts', 'renew', 'INTEGER NOT NULL DEFAULT 0');
// When somebody who came through the post first applied for the same job on the client's careers page (see board.js).
addColumn('board_applications', 'direct_applied_at', 'TEXT');
// Part of people saved without a job, and here because it points at a post. Somebody who came through a post and
// was in The Book before goes back to The Book when they leave the job. What the board had noted about their
// application is taken out of board_applications then, so that none of it is on the entry if it goes on another
// client's job, and is set aside here. Nothing reads this table but the step that puts somebody on a job (putOnJob
// in board.js): when they go back on the job the post is for, the row is put back as it was, so the person is again
// somebody who came through the post and has, or has not, been told who the client is. A row goes with its
// application and with its post. It is made here, after applications has been rebuilt (see rebuildTable), so a
// first start on an older database does not have it yet while that table is dropped and made again. A release from
// before this one neither reads nor writes it.
db.exec(`
CREATE TABLE IF NOT EXISTS post_applications_set_aside (
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  post_id INTEGER NOT NULL REFERENCES board_posts(id) ON DELETE CASCADE,
  public_title TEXT NOT NULL,                        -- as in board_applications, when the person left the job
  client_known_at TEXT,
  client_known_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  direct_applied_at TEXT,
  set_aside_at TEXT NOT NULL,                        -- when they left the job
  PRIMARY KEY (application_id, post_id)
);
CREATE INDEX IF NOT EXISTS idx_post_applications_set_aside_post ON post_applications_set_aside(post_id);`);
// ---------- end of our website's jobs page ----------

// ---------- asking somebody on the team to review a candidate ----------
// One person on the agency team asks another (a job's account executive, usually) to look at a candidate, and the
// answer comes back to them (see reviews.js). It is the agency's business alone. Everything about a request is in this
// one table, which nothing but reviews.js reads: no line goes in the history, the e-mails or the notes, and no column
// is added to applications or candidates, so a version of the app from before this one, which shows the client's
// hiring team from those, has nothing of it to show. Everything here is new: no existing row is rewritten.
db.exec(`
-- One row for each time somebody was asked. A request goes with the candidate's application (deleting the candidate
-- or removing them from the job deletes it). Who asked and who was asked are kept as nobody when either is removed
-- from the database: the request stays in the candidate's history, and an open one is then answerable by nobody.
CREATE TABLE IF NOT EXISTS team_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,              -- never reused, so an old tab cannot answer somebody else's newer request
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  asked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,     -- who asked; the answer comes back to them
  reviewer_id INTEGER REFERENCES users(id) ON DELETE SET NULL,  -- who was asked
  note TEXT,                                         -- what they should look at
  created_at TEXT NOT NULL,
  answer TEXT,                                       -- good_to_go | not_a_fit, once answered
  comment TEXT,                                      -- what the reviewer added to their answer
  answered_at TEXT,
  cancelled_at TEXT,                                 -- taken back before it was answered, by whoever asked or an admin
  cancelled_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  done_at TEXT                                       -- whoever asked has read the answer and cleared it from their Inbox
);
CREATE INDEX IF NOT EXISTS idx_team_reviews_application ON team_reviews(application_id);
-- What is waiting on a person to answer. One open request for each candidate and person asked: asking the same
-- person again while one is open is refused.
CREATE UNIQUE INDEX IF NOT EXISTS idx_team_reviews_waiting ON team_reviews(reviewer_id, application_id) WHERE answered_at IS NULL AND cancelled_at IS NULL;
-- Answers that have come back to whoever asked and are still in their Inbox.
CREATE INDEX IF NOT EXISTS idx_team_reviews_answers ON team_reviews(asked_by) WHERE answered_at IS NOT NULL AND done_at IS NULL;`);
// ---------- end of asking somebody on the team to review a candidate ----------

// ---------- messages between people on the agency team ----------
// Chat inside the agency, one to one or in a named group (see messages.js). Like review requests it is the agency's
// business alone: it lives in these three tables, which nothing but messages.js reads, and nothing about a message is
// written to a candidate's history, notes or e-mails. A message can point at a candidate's application or at a job so
// that it shows on that profile too; deleting the candidate or the job only drops the pointer, and the words stay.
// Everything here is new: no existing row is rewritten.
db.exec(`
-- One row for each conversation. A one-to-one conversation is between two people and has no name; pair_key holds
-- their two user ids, smaller first ("4:7"), so that the database itself refuses a second one between the same two.
-- updated_at is when the last line was added, for putting the newest conversations first.
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,              -- never reused, so an old link cannot open somebody else's newer conversation
  kind TEXT NOT NULL CHECK (kind IN ('direct', 'group')),
  name TEXT,                                         -- groups only
  pair_key TEXT,                                     -- one-to-one only: "smaller id:larger id"
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_pair ON conversations(pair_key) WHERE pair_key IS NOT NULL;

-- Who is in each conversation. Leaving a group sets left_at and keeps the row, so the history stays as it was; adding
-- the person again clears it. A person removed from the database outright is in no conversation any more; what they
-- wrote stays (messages.user_id below).
-- How far somebody has read, and what their last e-mail was about, are kept as message ids as well as times. Ids only
-- go up, so unread is every message by somebody else after last_read_id (which the index on messages(conversation_id,
-- id) answers without reading the rest of the history), and an e-mail is answered once they have read as far as the
-- message it was about (mailed_id), however close together in time the message, the e-mail and the reading were.
CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at TEXT NOT NULL,
  last_read_at TEXT,                                 -- when they last read it
  last_read_id INTEGER NOT NULL DEFAULT 0,           -- the newest message they have read (0: none)
  left_at TEXT,
  mailed_at TEXT,                                    -- when they were last e-mailed about it
  mailed_id INTEGER,                                 -- the message that e-mail was about: no other until they have read it
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_conversation_members_user ON conversation_members(user_id);

-- Every line in a conversation. kind 'text' is something somebody wrote; 'system' is a short line the app adds when a
-- group is made, renamed, joined or left ("Priya Nair added Marcus Bell"). A deleted message keeps its row, so the
-- thread can say "This message was deleted", but its words and its candidate or job are cleared.
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,              -- never reused; the open thread asks for what is newer than the last id it has
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,          -- who wrote it, or who did what a system line says
  kind TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'system')),
  body TEXT,                                         -- empty once deleted
  application_id INTEGER REFERENCES applications(id) ON DELETE SET NULL,  -- the candidate it is about, if any
  job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,                  -- or the job
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_application ON messages(application_id) WHERE application_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_job ON messages(job_id) WHERE job_id IS NOT NULL;`);
// Each person's own choice about being e-mailed when a message comes in: on unless they switch it off in Settings.
addColumn('users', 'message_mail', 'INTEGER NOT NULL DEFAULT 1');
// ---------- end of messages between people on the agency team ----------

// ---------- the client's own job description file ----------
// The file a client sent with a job (a PDF or Word document), kept on the job for the agency: its name in the
// uploads folder, the name it came with, its size, and who added it and when. Agency only (see jobdescription.js);
// it goes from the disk when it is removed or replaced, and when its job is deleted.
addColumn('jobs', 'jd_file', 'TEXT');
addColumn('jobs', 'jd_file_name', 'TEXT');
addColumn('jobs', 'jd_file_size', 'INTEGER');
addColumn('jobs', 'jd_file_by', 'INTEGER REFERENCES users(id) ON DELETE SET NULL');
addColumn('jobs', 'jd_file_at', 'TEXT');

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
    undo();
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

// The confirmation sent to somebody who applied through the agency's own job board (see board.js). It is the
// agency's e-mail, not the client's: it names the agency and the title the public saw, and never the employer.
// A workspace that already has its templates is given this one too; one that somebody has edited is left alone.
export const BOARD_CONFIRMATION = {
  key: 'board_application_received', name: 'Application received (our website)',
  subject: 'Thanks for applying through {{agency_name}}',
  body: 'Hi {{candidate_first_name}},\n\nThanks for applying through {{agency_name}} for the {{job_title}} role. We have your application and one of our recruiters will read it shortly.\n\nWe are recruiting for this role on behalf of a client, and the employer’s name is kept confidential at this stage. If your experience looks like a match, we will be in touch to talk it through and tell you more.\n\nBest,\n{{agency_name}}',
};
if (!q.get('SELECT 1 AS x FROM email_templates WHERE key = ?', BOARD_CONFIRMATION.key)) {
  q.run('INSERT INTO email_templates (key, name, subject, body) VALUES (?, ?, ?, ?)', BOARD_CONFIRMATION.key, BOARD_CONFIRMATION.name, BOARD_CONFIRMATION.subject, BOARD_CONFIRMATION.body);
}
