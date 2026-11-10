-- The whole schema of a database made by The Book as it stood before jobs had an account executive (git branch
-- aeboard, at the commit "Interviews can be edited", November 2026): every table, index and trigger, with no rows.
-- The tests build a database from it to show that today's code, started on one, adds the account executive to the
-- jobs it finds and changes nothing else.
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
);

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
, with_client INTEGER NOT NULL DEFAULT 1);

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
, accepted_at TEXT);

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
, external_url TEXT, took_place_at TEXT);

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

CREATE TABLE candidate_name_keys (
  candidate_id INTEGER PRIMARY KEY REFERENCES candidates(id) ON DELETE CASCADE,
  first TEXT NOT NULL,
  last TEXT NOT NULL                                 -- empty for a name of one word
);

CREATE INDEX idx_candidate_name_keys_words ON candidate_name_keys(first, last);

CREATE TABLE candidate_phone_keys (
  candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  tail TEXT NOT NULL,
  lead TEXT NOT NULL                                 -- the country code: 1 unless another was written; empty when the country is not known
);

CREATE INDEX idx_candidate_phone_keys_tail ON candidate_phone_keys(tail);

CREATE INDEX idx_candidate_phone_keys_candidate ON candidate_phone_keys(candidate_id);

CREATE TABLE candidate_name_dirty (candidate_id INTEGER PRIMARY KEY);

CREATE TRIGGER candidate_name_added AFTER INSERT ON candidates
  BEGIN INSERT OR IGNORE INTO candidate_name_dirty (candidate_id) VALUES (NEW.id); END;

CREATE TRIGGER candidate_name_changed AFTER UPDATE OF name ON candidates
  BEGIN INSERT OR IGNORE INTO candidate_name_dirty (candidate_id) VALUES (NEW.id); END;

CREATE TRIGGER candidate_phone_changed AFTER UPDATE OF phone ON candidates
  BEGIN INSERT OR IGNORE INTO candidate_name_dirty (candidate_id) VALUES (NEW.id); END;

CREATE INDEX idx_candidates_email_lower ON candidates(lower(email));

CREATE TABLE metaview_calls (
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

CREATE INDEX idx_metaview_calls_started ON metaview_calls(started_at);

CREATE INDEX idx_metaview_calls_call ON metaview_calls(call_id);

CREATE INDEX idx_metaview_calls_owed ON metaview_calls(fetch_next_at) WHERE fetch_next_at IS NOT NULL;

CREATE TABLE metaview_people (
  call_id INTEGER NOT NULL REFERENCES metaview_calls(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  first TEXT, last TEXT
);

CREATE INDEX idx_metaview_people_call ON metaview_people(call_id);

CREATE INDEX idx_metaview_people_value ON metaview_people(kind, value);

CREATE TABLE metaview_forgotten (id INTEGER PRIMARY KEY);

CREATE TABLE report_events (
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

CREATE UNIQUE INDEX idx_report_events_once ON report_events(application_id, kind) WHERE application_id IS NOT NULL;

CREATE UNIQUE INDEX idx_report_events_search ON report_events(job_id) WHERE kind = 'search_opened';

CREATE INDEX idx_report_events_at ON report_events(at);

CREATE INDEX idx_report_events_job ON report_events(job_id);

CREATE INDEX idx_report_events_client ON report_events(client_id);

CREATE TABLE todos (
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

CREATE INDEX idx_todos_list ON todos(user_id, kind);

CREATE INDEX idx_todos_job ON todos(job_id);

CREATE INDEX idx_todos_application ON todos(application_id);

CREATE INDEX idx_todos_interview ON todos(interview_id);

CREATE UNIQUE INDEX idx_todos_job_once ON todos(user_id, job_id) WHERE kind = 'job' AND done_at IS NULL AND removed_at IS NULL;

CREATE UNIQUE INDEX idx_todos_person_once ON todos(user_id, kind, application_id) WHERE kind != 'job' AND done_at IS NULL AND removed_at IS NULL;
