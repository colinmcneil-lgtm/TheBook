-- The job board's tables as they were first made, before posts could keep a job off the client's careers page,
-- round a salary range or be given a new address. A database that has these is given the new columns on start.
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
