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
if (!db.prepare('PRAGMA table_info(applications)').all().some((c) => c.name === 'owner_id')) {
  db.exec('ALTER TABLE applications ADD COLUMN owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL');
  // Existing candidates belong to whoever added them, where that is known.
  db.exec(`UPDATE applications SET owner_id = (
    SELECT ac.user_id FROM activities ac JOIN users u ON u.id = ac.user_id AND u.role != 'client'
    WHERE ac.application_id = applications.id AND ac.type = 'added' ORDER BY ac.id LIMIT 1)`);
}
for (const table of ['users', 'candidates', 'applications', 'interviews']) ensureAutoincrement(table);
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
CREATE INDEX IF NOT EXISTS idx_activities_app ON activities(application_id);`);

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
