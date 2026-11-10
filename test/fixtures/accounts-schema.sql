-- The whole schema of a database made by The Book as it stood before phone calls and the calendar were taken out
-- (git branch accounts, November 2026): every table, index and trigger, with no rows. The tests build a database
-- from it to show that today's code starts and works on one that still has the old tables and columns.
-- Made by running that version's server/db.js on an empty folder and listing sqlite_master.

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE clients (
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

CREATE TABLE users (
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
, phone TEXT, phone_pin_hash TEXT, phone_pin_fails INTEGER NOT NULL DEFAULT 0, phone_locked_until TEXT, phone_lock_level INTEGER NOT NULL DEFAULT 0, phone_pin_wrong INTEGER NOT NULL DEFAULT 0, phone_pin_wrong_since TEXT);

CREATE TABLE invites (
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

CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE jobs (
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

CREATE TABLE stages (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,                                -- applied | interview | offer | hired
  position INTEGER NOT NULL
);

CREATE TABLE candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,              -- never reused, so an old link cannot open a different person
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT,                                        -- required for applicants; may be unknown for people the agency sourced
  phone TEXT, linkedin TEXT, location TEXT, current_title TEXT, current_company TEXT,
  photo_file TEXT,                                   -- profile photo saved with the candidate (a file in the uploads folder)
  created_at TEXT NOT NULL,
  UNIQUE (client_id, email)
);

CREATE TABLE applications (
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

CREATE TABLE stage_history (
  id INTEGER PRIMARY KEY,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  stage_id INTEGER NOT NULL,
  entered_at TEXT NOT NULL
);

CREATE TABLE activities (
  id INTEGER PRIMARY KEY,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  user_id INTEGER,
  type TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE interviews (
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

CREATE TABLE interview_panel (
  interview_id INTEGER NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (interview_id, user_id)
);

CREATE TABLE scorecards (
  id INTEGER PRIMARY KEY,
  interview_id INTEGER NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recommendation TEXT NOT NULL,                      -- strong_yes | yes | no | strong_no
  ratings TEXT NOT NULL DEFAULT '{}',
  notes TEXT,
  submitted_at TEXT NOT NULL,
  UNIQUE (interview_id, user_id)
);

CREATE TABLE offers (
  id INTEGER PRIMARY KEY,
  application_id INTEGER NOT NULL UNIQUE REFERENCES applications(id) ON DELETE CASCADE,
  salary INTEGER,
  start_date TEXT,
  status TEXT NOT NULL DEFAULT 'draft',              -- draft | sent | accepted | declined
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE emails (
  id INTEGER PRIMARY KEY,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  sent_by INTEGER,
  delivery TEXT NOT NULL,                            -- sent | failed | not_configured
  created_at TEXT NOT NULL
);

CREATE TABLE email_templates (
  id INTEGER PRIMARY KEY,
  key TEXT UNIQUE,                                   -- set for templates the system sends automatically
  name TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL
);

CREATE TABLE calls (
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
, direction TEXT, phone_number TEXT, speaker_roles TEXT, audio_channels INTEGER, voicemail INTEGER NOT NULL DEFAULT 0, notified_at TEXT, event_key TEXT, transcribe_tries INTEGER NOT NULL DEFAULT 0, transcribe_next_at TEXT, notify_tries INTEGER NOT NULL DEFAULT 0, notify_next_at TEXT);

CREATE TABLE "notes" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  private INTEGER NOT NULL DEFAULT 0,                -- 1 = visible to the agency only
  created_at TEXT NOT NULL
);

CREATE INDEX idx_jobs_client ON jobs(client_id);

CREATE INDEX idx_apps_job ON applications(job_id);

CREATE INDEX idx_candidates_link ON candidates(client_id, linkedin);

CREATE INDEX idx_apps_stage ON applications(stage_id);

CREATE INDEX idx_hist_app ON stage_history(application_id);

CREATE INDEX idx_interviews_app ON interviews(application_id);

CREATE INDEX idx_activities_app ON activities(application_id);

CREATE INDEX idx_activities_recent ON activities(created_at, id);

CREATE INDEX idx_calls_candidate ON calls(candidate_id);

CREATE INDEX idx_calls_application ON calls(application_id);

CREATE INDEX idx_calls_created_by ON calls(created_by);

CREATE TABLE phone_calls (
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
, title TEXT);

CREATE TABLE phone_webhooks (
  id INTEGER PRIMARY KEY,
  phone_call_id INTEGER REFERENCES phone_calls(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  params TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_phone_calls_sid ON phone_calls(call_sid) WHERE call_sid IS NOT NULL;

CREATE INDEX idx_phone_calls_user ON phone_calls(user_id, started_at);

CREATE INDEX idx_phone_calls_candidate ON phone_calls(candidate_id);

CREATE INDEX idx_phone_calls_call ON phone_calls(call_id);

CREATE INDEX idx_phone_webhooks_call ON phone_webhooks(phone_call_id);

CREATE UNIQUE INDEX idx_users_phone ON users(phone) WHERE phone IS NOT NULL;

CREATE TABLE phone_recordings_owed (
  recording_sid TEXT PRIMARY KEY,
  noted_at TEXT NOT NULL,
  tries INTEGER NOT NULL DEFAULT 0,
  next_at TEXT
);

CREATE TABLE phone_calls_erased (
  call_sid TEXT PRIMARY KEY,
  noted_at TEXT NOT NULL,
  next_at TEXT
);

CREATE TRIGGER phone_calls_owed_recording BEFORE DELETE ON phone_calls
WHEN OLD.recording_sid IS NOT NULL AND OLD.recording_deleted_at IS NULL
BEGIN
  INSERT OR IGNORE INTO phone_recordings_owed (recording_sid, noted_at) VALUES (OLD.recording_sid, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER phone_calls_erased_unrecorded BEFORE DELETE ON phone_calls
WHEN OLD.record = 1 AND OLD.call_sid IS NOT NULL AND OLD.recording_sid IS NULL
  AND (OLD.recording_state = 'waiting' OR (OLD.recording_state IS NULL AND OLD.status NOT IN ('ended', 'failed')))
BEGIN
  INSERT OR IGNORE INTO phone_calls_erased (call_sid, noted_at) VALUES (OLD.call_sid, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TABLE calendar_links (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,                            -- google | outlook | icloud | other, going by the link's host
  link_sealed TEXT NOT NULL,
  tz TEXT,                                           -- the time zone the person last looked at their day in
  created_at TEXT NOT NULL,
  last_read_at TEXT,                                 -- when the calendar was last read successfully
  last_error TEXT                                    -- why the last read failed, in plain English; null when it worked
);

CREATE TABLE calendar_events (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_key TEXT NOT NULL,
  source TEXT NOT NULL,                              -- calendar | interview
  day TEXT NOT NULL, tz TEXT NOT NULL,               -- the day (YYYY-MM-DD, in that time zone) it was last seen on
  fingerprint TEXT,                                  -- finds a marked event again when the calendar gives it a new identity
  added INTEGER NOT NULL DEFAULT 0,                  -- 1 = marked to be recorded
  application_id INTEGER REFERENCES applications(id) ON DELETE SET NULL, -- the candidate the person chose themselves
  call_id INTEGER REFERENCES calls(id) ON DELETE SET NULL,               -- the call recorded for this event
  seen_at TEXT NOT NULL, series TEXT,
  PRIMARY KEY (user_id, event_key)
);

CREATE INDEX idx_calendar_events_print ON calendar_events(user_id, fingerprint);

CREATE INDEX idx_calendar_events_seen ON calendar_events(seen_at);

CREATE TABLE candidate_name_keys (
  candidate_id INTEGER PRIMARY KEY REFERENCES candidates(id) ON DELETE CASCADE,
  first TEXT NOT NULL,
  last TEXT NOT NULL                                 -- empty for a name of one word
);

CREATE INDEX idx_candidate_name_keys_words ON candidate_name_keys(first, last);

CREATE TABLE candidate_name_dirty (candidate_id INTEGER PRIMARY KEY);

CREATE TRIGGER candidate_name_added AFTER INSERT ON candidates
  BEGIN INSERT OR IGNORE INTO candidate_name_dirty (candidate_id) VALUES (NEW.id); END;

CREATE TRIGGER candidate_name_changed AFTER UPDATE OF name ON candidates
  BEGIN INSERT OR IGNORE INTO candidate_name_dirty (candidate_id) VALUES (NEW.id); END;

CREATE INDEX idx_candidates_email_lower ON candidates(lower(email));

CREATE INDEX idx_candidates_phone_tail ON candidates(substr(replace(replace(replace(replace(replace(replace(phone, ' ', ''), '-', ''), '(', ''), ')', ''), '.', ''), '+', ''), -10)) WHERE phone IS NOT NULL;

CREATE INDEX idx_interviews_starts ON interviews(starts_at);
