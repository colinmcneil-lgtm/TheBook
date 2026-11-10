import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

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
  status TEXT NOT NULL DEFAULT 'active',            -- active | paused | ended
  engagement_model TEXT NOT NULL DEFAULT 'retainer', -- retainer | per_hire | hybrid
  monthly_retainer INTEGER NOT NULL DEFAULT 0,
  fee_percent REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  started_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL,                                -- admin | recruiter | client
  client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
  title TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
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
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT, linkedin TEXT, location TEXT, current_title TEXT, current_company TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (client_id, email)
);

CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY,
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
  id INTEGER PRIMARY KEY,
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

CREATE INDEX IF NOT EXISTS idx_jobs_client ON jobs(client_id);
CREATE INDEX IF NOT EXISTS idx_apps_job ON applications(job_id);
CREATE INDEX IF NOT EXISTS idx_apps_stage ON applications(stage_id);
CREATE INDEX IF NOT EXISTS idx_hist_app ON stage_history(application_id);
CREATE INDEX IF NOT EXISTS idx_interviews_app ON interviews(application_id);
CREATE INDEX IF NOT EXISTS idx_activities_app ON activities(application_id);
`);

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
