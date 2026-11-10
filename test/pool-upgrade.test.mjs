// Upgrading a database made before people could be saved to The Book without a job. Run with `npm test`.
//
// The upgrade makes three columns optional (candidates.client_id, applications.job_id, applications.stage_id), adds
// one empty column (applications.general_until) and two indexes. SQLite cannot change a column in place, so both
// tables are rebuilt, on a database that holds real people. It also adds three new, empty tables: one for résumés
// that a newer one replaced, and two for the history lines and e-mails that only the agency may read (the tables of
// history lines and e-mails that are there already are not touched at all). These
// tests build a database with the code as it was before, fill it with awkward data, start the code as it is now on
// it, and compare everything: every row of every table, every id, the counters that stop a deleted row's id being
// used again, every index, trigger and foreign key.
//
// "Before" is three releases, each kept word for word, and every test is run on a database last opened by each:
//   test/fixtures/before-pool/          the release this change was first built on (5f16829);
//   test/fixtures/before-pool-3f7b1a4/  the release after it (3f7b1a4). It gives older history lines newer types
//                                       once, and adds an index to the activity feed;
//   test/fixtures/before-pool-6f279a9/  the newest release without this change (6f279a9): Metaview and the reports
//                                       are in, phone calls and the calendar are out. Its database is one the
//                                       release before it made and filled, which it then opened and used, because
//                                       that is how a database that has been in use reaches it.
// The first release's database code is kept as well (test/fixtures/first-release/), for the tests at the end.
// Today's code is all of those releases and this change, so a database last opened by an older release gets the
// newer releases' changes and this change's in one start. What it must end up as is worked out from the code
// itself, not written out by hand: a copy of the database is opened by the newest release without this change,
// and this change's own differences (listed in expectedAfter) are applied to what that leaves. Every index and
// trigger an earlier release made is in that comparison too, including the ones today's code no longer makes.
//
// What they cannot show: the owner's own database. Its tables may carry the marks of every release since the first;
// one test builds a database that began at the first release for that reason, but it is still a made-up database.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDir } from './oracle-helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const NOW = path.join(ROOT, 'server', 'db.js');
// The releases a database may have been made or last opened by, each with the commit its two files were copied from.
// `reviewed` says whether that release already gave history lines their newer types and added the feed's index.
// `live` marks the newest release without this change: what a database is compared against.
const BEFORES = [
  { name: 'the release before the review fixes (5f16829)', folder: 'before-pool', commit: '5f168294b6e98be5423fd4fa15c720ac577423a9', reviewed: false },
  { name: 'the release with the review fixes (3f7b1a4)', folder: 'before-pool-3f7b1a4', commit: '3f7b1a45f5015b9b0fa3d5bf7cfd84d3d215c392', reviewed: true },
  { name: 'the release with Metaview and the reports (6f279a9)', folder: 'before-pool-6f279a9', commit: '6f279a95dbabb74de036601e48de524c8a6efcda', reviewed: true, live: true },
].map((b) => ({ ...b, code: path.join(HERE, 'fixtures', b.folder, 'db.js') }));
const [OLDER, NEWER, LIVE] = BEFORES;

const dirs = [];
after(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });
const newDir = (name) => { const dir = tempDir(name); dirs.push(dir); return dir; };

const open_ = (code, dataDir, env = {}) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(HERE, 'pool-open.mjs'), code], {
  cwd: ROOT, env: { PATH: process.env.PATH, HOME: process.env.HOME, DATA_DIR: dataDir, ...env }, encoding: 'utf8',
});
/** Start the database code on a data folder, as a start of the server would, and wait for it to finish. */
function start(code, dataDir) {
  const run = open_(code, dataDir);
  assert.equal(run.status, 0, `The database did not open:\n${run.stdout}\n${run.stderr}`);
}
/**
 * Start the database code and kill it outright just before its n-th statement that can change the database.
 * Answers false when the start finished first: it has fewer statements than that.
 */
function startCutOffAt(code, dataDir, n) {
  const run = open_(code, dataDir, { STOP_AT: String(n) });
  if (run.signal === 'SIGKILL') return true;
  assert.equal(run.status, 0, `The database did not open:\n${run.stdout}\n${run.stderr}`);
  return false;
}
const open = (dataDir) => {
  const db = new DatabaseSync(path.join(dataDir, 'app.db'));
  db.exec('PRAGMA foreign_keys = ON');
  return db;
};
const plain = (value) => JSON.parse(JSON.stringify(value));

/** Everything in the database: what each table is made of, and every row in it. */
function snapshot(dataDir) {
  const db = open(dataDir);
  const all = (sql) => plain(db.prepare(sql).all());
  const master = all(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`);
  const tables = master.filter((m) => m.type === 'table').map((m) => m.name);
  // The first release let ids be reused, so a database it made has no table of id counters at all.
  const counted = all(`SELECT name FROM sqlite_master WHERE name = 'sqlite_sequence'`).length > 0;
  const shot = { master, rows: {}, columns: {}, foreignKeys: {}, indexes: {}, counters: counted ? all('SELECT name, seq FROM sqlite_sequence ORDER BY name') : [] };
  for (const table of tables) {
    shot.rows[table] = all(`SELECT rowid AS "(rowid)", * FROM "${table}" ORDER BY rowid`);
    shot.columns[table] = all(`PRAGMA table_info("${table}")`);
    shot.foreignKeys[table] = all(`PRAGMA foreign_key_list("${table}")`)
      .map(({ id, seq, ...key }) => key).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    // Each index with its columns. The rules written inside a table (UNIQUE, the primary key) are indexes too.
    shot.indexes[table] = all(`PRAGMA index_list("${table}")`)
      .map(({ seq, ...index }) => ({ ...index, columns: all(`PRAGMA index_xinfo("${index.name}")`).filter((c) => c.key).map((c) => c.name ?? '(expression)') }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  shot.problems = { integrity: all('PRAGMA integrity_check'), foreignKeys: all('PRAGMA foreign_key_check') };
  db.close();
  return shot;
}

/** How a table or index that did not exist before is defined in a database made new today by the code as it is now. */
let madeNewToday;
function definedToday(name) {
  if (!madeNewToday) {
    const dir = newDir('pool-new-tables');
    start(NOW, dir);
    madeNewToday = snapshot(dir);
  }
  return madeNewToday.master.find((m) => m.name === name);
}

/**
 * What the newest release without this change leaves when it opens this database: tried on a copy, so the database
 * itself is not touched. For a database that release has already opened, that is the database as it stands.
 */
function openedByLive(dataDir) {
  const copy = copyOf(dataDir, 'pool-by-live');
  start(LIVE.code, copy);
  return snapshot(copy);
}

/**
 * What the snapshot of a database the newest release without this change has opened should be after the upgrade:
 * the same, except that the three columns are optional, applications has one more column that is empty in every
 * row, there are two more indexes, and there are three new tables with nothing in them. History lines and e-mails
 * are exactly as they were.
 */
function expectedAfter(before) {
  const want = plain(before);
  assert.ok(want.master.some((m) => m.name === 'report_events'), 'expectedAfter is given a database as the newest release without this change leaves it');
  // Three new tables, each made as it is in a database made new today, and empty: résumés that a newer one took the
  // place of, and the history lines and e-mails that are the agency's alone. Each hangs from an application and goes
  // when the application does.
  for (const [table, index] of [['earlier_resumes', 'idx_earlier_resumes_app'], ['agency_activities', 'idx_agency_activities_app'], ['agency_emails', 'idx_agency_emails_app']]) {
    want.master.push(definedToday(table), definedToday(index));
    want.rows[table] = [];
    want.columns[table] = madeNewToday.columns[table];
    want.foreignKeys[table] = [{ table: 'applications', from: 'application_id', to: 'id', on_update: 'NO ACTION', on_delete: 'CASCADE', match: 'NONE' }];
    want.indexes[table] = [{ name: index, unique: 0, origin: 'c', partial: 0, columns: ['application_id'] }];
    want.counters = want.counters.filter((c) => c.name !== table);
  }
  const column = (table, name) => want.columns[table].find((c) => c.name === name);
  column('candidates', 'client_id').notnull = 0;
  column('applications', 'job_id').notnull = 0;
  column('applications', 'stage_id').notnull = 0;
  want.columns.applications.push({ cid: want.columns.applications.length, name: 'general_until', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 });
  want.rows.applications = want.rows.applications.map((row) => ({ ...row, general_until: null }));
  want.indexes.applications.push({ name: 'idx_apps_general', unique: 1, origin: 'c', partial: 1, columns: ['candidate_id'] });
  want.indexes.candidates.push({ name: 'idx_candidates_general_email', unique: 1, origin: 'c', partial: 1, columns: ['email'] });
  for (const table of ['applications', 'candidates']) want.indexes[table].sort((a, b) => a.name.localeCompare(b.name));
  // The words each table and index was made with. A rebuilt table is stored under its name in quotes.
  const sqlOf = (name) => want.master.find((m) => m.name === name);
  const requoted = (sql, table) => sql.replace(new RegExp(`^CREATE TABLE "?${table}"?`), `CREATE TABLE "${table}"`);
  sqlOf('candidates').sql = requoted(sqlOf('candidates').sql, 'candidates').replace('client_id INTEGER NOT NULL REFERENCES', 'client_id INTEGER REFERENCES');
  sqlOf('applications').sql = requoted(sqlOf('applications').sql, 'applications')
    .replace('job_id INTEGER NOT NULL REFERENCES', 'job_id INTEGER REFERENCES').replace('stage_id INTEGER NOT NULL REFERENCES', 'stage_id INTEGER REFERENCES')
    // SQLite writes a column added later straight after the last column the table had.
    .replace('owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL', 'owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL, general_until TEXT');
  want.master.push(
    { type: 'index', name: 'idx_apps_general', tbl_name: 'applications', sql: 'CREATE UNIQUE INDEX idx_apps_general ON applications(candidate_id) WHERE job_id IS NULL' },
    { type: 'index', name: 'idx_candidates_general_email', tbl_name: 'candidates', sql: 'CREATE UNIQUE INDEX idx_candidates_general_email ON candidates(email) WHERE client_id IS NULL' });
  want.master.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
  return want;
}
/** The rows of a table that were not there before, going by their ids. */
const appeared = (rows, before) => rows.filter((row) => !before.some((old) => old['(rowid)'] === row['(rowid)']));
/** The row of a table that has this row's id; the test fails here if it is gone. */
function sameRow(rows, row, what) {
  const found = rows.find((x) => x['(rowid)'] === row['(rowid)']);
  assert.ok(found, `${what} is still there`);
  return found;
}
/** Compare two snapshots a part at a time, so a failure names the table it is in. */
function assertSame(actual, expected, what) {
  assert.deepEqual(actual.counters, expected.counters, `${what}: the highest id each table has given out`);
  assert.deepEqual(actual.master.map((m) => `${m.type} ${m.name}`), expected.master.map((m) => `${m.type} ${m.name}`), `${what}: the tables, indexes and triggers that exist`);
  for (const m of expected.master) assert.equal(actual.master.find((x) => x.name === m.name).sql, m.sql, `${what}: how ${m.type} ${m.name} is defined`);
  for (const table of Object.keys(expected.rows)) {
    assert.deepEqual(actual.columns[table], expected.columns[table], `${what}: the columns of ${table}`);
    assert.deepEqual(actual.foreignKeys[table], expected.foreignKeys[table], `${what}: the foreign keys of ${table}`);
    assert.deepEqual(actual.indexes[table], expected.indexes[table], `${what}: the indexes of ${table}`);
    assert.deepEqual(actual.rows[table], expected.rows[table], `${what}: the rows of ${table}`);
  }
  assert.deepEqual(actual.problems, { integrity: [{ integrity_check: 'ok' }], foreignKeys: [] }, `${what}: the database's own checks`);
}

// ---------- awkward data ----------
const at = (day, time = '09:00:00') => `2026-${day}T${time}.000Z`;
/**
 * History lines as releases before the review fixes wrote them: every stage move was 'stage', and a booked
 * interview was an 'interview' line that began "Scheduled". Each is [application, user, type, detail, when, the
 * type the release with the review fixes gives it the first time it opens the database]. A database that release
 * has already opened is left exactly as it is, whatever its lines say.
 */
const OLD_LINES = [
  [1, 2, 'stage', 'Moved to Recruiter screen', at('03-10'), 'stage_interview'],                   // told by the name of the stage
  [4, 2, 'stage', 'Moved to Offer', at('03-20'), 'stage_offer'],
  [6, 2, 'stage', 'Moved to Phone screen', at('03-20'), 'stage_interview'],                       // the stage has been renamed since: told by the stage entered at that moment
  [2, 2, 'stage', 'Moved to Applied', at('03-02'), 'stage'],                                      // not an interview or offer stage: stays as it is
  [8, 1, 'stage', 'Moved to Final round', at('01-15'), 'stage'],                                  // a stage that no longer exists, entered at no recorded moment: stays as it is
  [1, 2, 'interview', 'Scheduled Recruiter screen', at('03-11'), 'interview_booked'],
  [1, 2, 'interview', 'Scheduled catch-up marked cancelled', at('03-12'), 'interview'],            // an interview called "Scheduled catch-up" being cancelled: not a booking
  [1, 2, 'interview', 'Rescheduled Second interview', at('03-13'), 'interview'],
];
/**
 * Fill a database from before with the kinds of rows a year of use leaves behind: one person at two clients and in
 * two jobs, a person with no e-mail address, names with accents and apostrophes, a link saved in an old form, rows
 * deleted from the middle and from the end of every table whose ids are never reused, calls on a candidate, on a
 * removed application and on nobody, phone calls, a recording still owed to the phone service, calendar choices,
 * photos, notes (one the summary of a call), interviews with a panel and scorecards, offers and e-mails.
 */
function fill(dataDir) {
  const db = open(dataDir);
  const run = (sql, ...p) => db.prepare(sql).run(...p);
  db.exec('BEGIN');
  run(`INSERT INTO settings (key, value) VALUES ('agency_name', 'Harbour Talent'), ('client_photos', '0')`);
  for (const [name, slug, status, model, retainer, fee] of [['Maple Freight', 'maple-freight', 'active', 'hybrid', 6500, 12.5], ['Northline Dental', 'northline-dental', 'paused', 'retainer', 4800, 0],
    ['Old & Sons', 'old-sons', 'ended', 'per_hire', 0, 20], ['Gone Ltd', 'gone', 'active', 'retainer', 100, 0]]) {
    run(`INSERT INTO clients (name, slug, status, engagement_model, monthly_retainer, fee_percent, currency, privacy_url, started_at, created_at) VALUES (?, ?, ?, ?, ?, ?, 'CAD', ?, '2026-01-05', ?)`,
      name, slug, status, model, retainer, fee, slug === 'maple-freight' ? 'https://maple.example/privacy' : null, at('01-05'));
  }
  const user = (email, name, role, clientId, extra = {}) => run(
    `INSERT INTO users (email, password_hash, name, role, client_id, title, active, pending, requested_company, phone, phone_pin_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    email, extra.pending ? '!0123456789abcdef' : 'salt:hash', name, role, clientId, extra.title ?? null, extra.active ?? 1, extra.pending ?? 0, extra.company ?? null, extra.phone ?? null, extra.pin ?? null, at('01-06'));
  user('alex@agency.example', 'Alex Morgan', 'admin', null, { title: 'Founder', phone: '+16475550142', pin: 'salt:pin' });   // 1
  user('dana@agency.example', 'Dana Recruiter', 'recruiter', null);                                                            // 2
  user('sam@agency.example', 'Sam Okoro', 'recruiter', null, { active: 0 });                                                   // 3: has left
  user('maya@maple.example', 'Maya Okonkwo', 'client', 1, { title: 'Controller' });                                            // 4
  user('asker@example.com', 'Ask Er', 'client', null, { active: 0, pending: 1, company: 'Somewhere Inc' });                    // 5: a request still waiting
  user('gone@example.com', 'Gone Person', 'client', 4);                                                                        // 6: removed below
  run(`INSERT INTO invites (token_hash, role, client_id, email, created_by, created_at, expires_at, used_at) VALUES ('hash-used', 'client', 1, 'maya@maple.example', 1, ?, ?, ?), ('hash-open', 'recruiter', NULL, NULL, 1, ?, ?, NULL)`,
    at('01-06'), at('01-13'), at('01-07'), at('11-09'), '2099-01-01T00:00:00.000Z');
  run(`INSERT INTO sessions (token, user_id, expires_at) VALUES ('aaaa', 1, '2099-01-01T00:00:00.000Z'), ('bbbb', 4, '2099-01-01T00:00:00.000Z')`);

  const job = (clientId, title, status, extra = {}) => run(
    `INSERT INTO jobs (client_id, title, status, brief, hiring_manager_id, questions, criteria, created_by, created_at, opened_at, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    clientId, title, status, JSON.stringify(extra.brief ?? {}), extra.manager ?? null, '[{"id":"q1","label":"Right to work?","type":"yesno","required":true}]', '["Skills","Communication"]', 2, at('02-01'), at('02-02'), extra.closed ?? null);
  job(1, 'Senior Accountant', 'open', { manager: 4, brief: { must_haves: ['CPA'] } });     // 1
  job(1, 'Payroll Specialist', 'paused');                                                  // 2
  job(2, 'Hygienist', 'open');                                                             // 3
  job(3, 'Yard Foreman', 'closed', { closed: at('06-30') });                               // 4
  job(4, 'Soon gone', 'draft');                                                            // 5: removed below, with its client
  for (let jobId = 1; jobId <= 5; jobId++) {
    ['Applied', 'Recruiter screen', 'Interview', 'Offer', 'Hired'].forEach((name, i) =>
      run('INSERT INTO stages (job_id, name, kind, position) VALUES (?, ?, ?, ?)', jobId, name, ['applied', 'interview', 'interview', 'offer', 'hired'][i], i));
  }
  const stage = (jobId, position) => (jobId - 1) * 5 + position + 1;

  const candidate = (clientId, name, email, extra = {}) => run(
    'INSERT INTO candidates (client_id, name, email, phone, linkedin, location, current_title, current_company, photo_file, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    clientId, name, email, extra.phone ?? null, extra.linkedin ?? null, extra.location ?? null, extra.title ?? null, extra.company ?? null, extra.photo ?? null, at('03-01'));
  candidate(1, 'Kevin Tremblay', 'kevin.tremblay@example.com', { phone: '(416) 555-0142', linkedin: 'https://www.linkedin.com/in/kevin-tremblay', photo: '0123456789abcdef0123456789abcdef.jpg', title: 'Controller', company: 'Varsity Freight' }); // 1
  candidate(2, 'Kévin Tremblay', 'kevin.tremblay@example.com', { phone: '+1 416 555 0142' });                                   // 2: the same person, on file at a second client
  candidate(1, 'Aïsha Khan', null, { linkedin: 'http://ca.linkedin.com/in/Aisha-Khan-1/?utm_source=share' });                   // 3: no e-mail address, a link as an earlier version saved it
  candidate(1, 'Nadia Petrov', 'nadia@example.com', { location: 'Montréal, QC' });                                              // 4
  candidate(2, "Zoë O'Brien-Smith", 'zoe@example.org', { phone: '905.555.0166', photo: 'fedcba9876543210fedcba9876543210.webp' }); // 5
  candidate(1, 'Removed Midway', 'midway@example.com');                                                                         // 6: removed below
  candidate(3, 'Li', 'li@example.cn', { phone: 'ext. 12' });                                                                    // 7: a name of one word, a number nobody can ring
  candidate(4, 'Goes With Client', 'client4@example.com');                                                                      // 8: removed below, with its client
  candidate(2, 'Removed Last', null, { linkedin: 'https://github.com/removed-last' });                                          // 9: removed below

  const application = (candidateId, jobId, position, status, extra = {}) => run(
    `INSERT INTO applications (candidate_id, job_id, stage_id, status, source, rating, answers, cover_note, resume_file, resume_name, reject_reason, review_status, submission_note, review_note,
       submitted_by, reviewed_by, reviewed_at, applied_at, stage_entered_at, updated_at, hired_at, consent_at, owner_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    candidateId, jobId, stage(jobId, position), status, extra.source ?? 'agency_sourced', extra.rating ?? null, JSON.stringify(extra.answers ?? []), extra.cover ?? null,
    extra.resume ?? null, extra.resume ? 'CV (final) v2.pdf' : null, extra.reason ?? null, extra.review ?? null, extra.submission ?? null, extra.reviewNote ?? null,
    extra.review ? 2 : null, extra.review === 'approved' ? 4 : null, extra.review === 'approved' ? at('04-02') : null,
    at('03-02'), at('03-20'), at('04-01'), status === 'hired' ? at('05-01') : null, extra.consent ?? null, extra.owner ?? null);
  application(1, 1, 2, 'active', { rating: 4, resume: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.pdf', review: 'approved', submission: 'Strong on month-end.', reviewNote: 'Yes please', owner: 2 }); // 1
  application(1, 2, 0, 'rejected', { reason: 'Salary expectations too far apart', owner: 2 });                                          // 2: the same person in a second job
  application(2, 3, 4, 'hired', { owner: 3, source: 'referral' });                                                                      // 3: owned by somebody who has left
  application(3, 1, 3, 'active', { review: 'pending', submission: 'Worth meeting.', owner: 2, source: 'linkedin' });                    // 4
  application(6, 1, 0, 'active');                                                                                                        // 5: removed below, with its candidate
  application(4, 2, 1, 'withdrawn', { reason: 'Took another offer', source: 'careers_page', consent: at('03-02'), cover: 'Line one\nLine two', answers: [{ question: 'Right to work?', answer: 'Yes' }] }); // 6
  application(5, 3, 0, 'active', { source: 'careers_page', consent: at('03-02'), resume: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.docx' });      // 7: nobody owns them yet
  application(7, 4, 4, 'hired', { owner: 1, source: 'job_board' });                                                                      // 8: in a job that has closed
  application(8, 5, 0, 'active');                                                                                                        // 9: removed below, with its client
  application(9, 3, 1, 'active', { owner: 2 });                                                                                          // 10: removed below, with its candidate
  for (const [appId, stageId, when] of [[1, stage(1, 0), '03-02'], [1, stage(1, 1), '03-10'], [1, stage(1, 2), '03-20'], [2, stage(2, 0), '03-02'], [3, stage(3, 0), '03-02'], [3, stage(3, 4), '05-01'],
    [4, stage(1, 3), '03-20'], [4, 999, '03-05'], [6, stage(2, 1), '03-20'], [7, stage(3, 0), '03-02'], [8, stage(4, 4), '05-01'], [10, stage(3, 1), '03-20']]) {
    run('INSERT INTO stage_history (application_id, stage_id, entered_at) VALUES (?, ?, ?)', appId, stageId, at(when)); // 999: a stage that was removed from its job since
  }
  for (const [appId, userId, body, isPrivate] of [[1, 2, 'Notes from Call with Kevin Tremblay\n\nLooking for 95,000.', 1], [1, 4, 'Met him at the open day.', 0], [4, 2, 'No e-mail yet; ask on the call.', 1],
    [7, 2, 'To be removed (middle of the table)', 0], [3, 3, 'Started on the first of May.', 0], [10, 2, 'To be removed (end of the table)', 1]]) {
    run('INSERT INTO notes (application_id, user_id, body, private, created_at) VALUES (?, ?, ?, ?, ?)', appId, userId, body, isPrivate, at('04-01'));
  }
  for (const [appId, userId, type, detail] of [[1, 2, 'added', 'Added to the pipeline (agency sourced)'], [1, 2, 'stage_interview', 'Moved to Interview'], [1, 2, 'call', 'Call recorded, 12 min'],
    [1, 2, 'submitted', 'Submitted to the hiring team for review'], [1, 4, 'review', 'Approved for interview'], [2, 2, 'rejected', 'Rejected: Salary expectations too far apart'],
    [3, null, 'applied', 'Applied via referral'], [3, 3, 'hired', 'Marked as hired'], [6, null, 'applied', 'Applied via careers page'], [6, 2, 'withdrawn', 'Candidate withdrew: Took another offer'],
    [7, null, 'applied', 'Possible duplicate of Kévin Tremblay (same LinkedIn link)'], [8, 1, 'offer', 'Offer accepted'], [10, 2, 'owner', 'Assigned to Dana Recruiter']]) {
    run('INSERT INTO activities (application_id, user_id, type, detail, created_at) VALUES (?, ?, ?, ?, ?)', appId, userId, type, detail, at('04-01'));
  }
  for (const [appId, userId, type, detail, when] of OLD_LINES) run('INSERT INTO activities (application_id, user_id, type, detail, created_at) VALUES (?, ?, ?, ?, ?)', appId, userId, type, detail, when);
  const interview = (appId, title, kind, when, status) => run(
    `INSERT INTO interviews (application_id, title, kind, starts_at, duration_min, location, notes, status, created_by, created_at) VALUES (?, ?, ?, ?, 45, ?, ?, ?, 2, ?)`,
    appId, title, kind, when, kind === 'video' ? 'https://meet.google.com/abc-defg-hij' : null, kind === 'phone' ? 'Ring her on 905.555.0166' : null, status, at('03-15'));
  interview(1, 'Recruiter screen', 'phone', at('03-12', '14:00:00'), 'completed');     // 1
  interview(1, 'Second interview', 'video', '2099-03-01T15:00:00.000Z', 'scheduled');  // 2: still to come
  interview(3, 'Final interview', 'onsite', at('04-20', '10:30:00'), 'cancelled');     // 3
  interview(4, 'To be removed', 'technical', at('04-25', '10:30:00'), 'scheduled');    // 4: removed below
  interview(10, 'Goes with its candidate', 'video', at('04-26', '10:30:00'), 'scheduled'); // 5: removed below
  run('INSERT INTO interview_panel (interview_id, user_id) VALUES (1, 2), (2, 2), (2, 4), (3, 3), (4, 1), (5, 2)');
  run(`INSERT INTO scorecards (interview_id, user_id, recommendation, ratings, notes, submitted_at) VALUES (1, 2, 'strong_yes', '{"Skills":4}', 'Clear and specific.', ?), (4, 1, 'no', '{}', NULL, ?)`, at('03-12'), at('04-25'));
  run(`INSERT INTO offers (application_id, salary, start_date, status, notes, created_at, updated_at) VALUES (3, 78000, '2026-05-01', 'accepted', 'Standard benefits.', ?, ?), (4, 91000, NULL, 'draft', NULL, ?, ?)`,
    at('04-28'), at('04-30'), at('04-29'), at('04-29'));
  run(`INSERT INTO emails (application_id, to_email, subject, body, sent_by, delivery, created_at) VALUES (1, 'kevin.tremblay@example.com', 'Interview for Senior Accountant', 'Hi Kevin,\n\nSee you then.', 2, 'sent', ?),
    (6, 'nadia@example.com', 'We received your application', 'Hi Nadia', NULL, 'not_configured', ?), (10, 'x@example.com', 'Goes with its candidate', 'x', 2, 'failed', ?)`, at('03-11'), at('03-02'), at('03-03'));
  run(`INSERT INTO email_templates (key, name, subject, body) VALUES (NULL, 'Checking in', 'Still interested?', 'Hi {{candidate_first_name}}')`);
  run(`DELETE FROM email_templates WHERE name = 'Offer follow-up'`);

  // The Oracle: a recorded call on a candidate whose summary was saved as note 1, a call left with a person after its
  // application was removed, a call on nobody, and three phone calls (one that never connected, one from a stranger).
  const call = (recording, title, source, extra = {}) => run(
    `INSERT INTO calls (recording_id, title, status, source, audio_file, audio_type, audio_size, duration_ms, transcript, transcript_source, speakers, notes, notes_at, submission, note_id,
       application_id, candidate_id, consent_by, consent_at, consent_wording, created_by, created_at, updated_at, direction, phone_number, voicemail, event_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 2, ?, 'Everyone on this call knew it was being recorded and agreed.', 2, ?, ?, ?, ?, ?, ?)`,
    recording, title, extra.status ?? 'ready', source, extra.audio ?? null, extra.audio ? 'audio/webm' : null, extra.audio ? 54321 : null, 725000,
    extra.status === 'uploaded' ? null : '[{"speaker":0,"start":0,"end":2.5,"text":"Hello"}]', extra.status === 'uploaded' ? null : 'deepgram', '{"0":"Dana Recruiter","1":"Kevin Tremblay"}',
    extra.notes ?? null, extra.notes ? at('04-01') : null, extra.submission ?? null, extra.noteId ?? null, extra.app ?? null, extra.candidate ?? null, at('04-01'), at('04-01'), at('04-02'),
    extra.direction ?? null, extra.number ?? null, extra.voicemail ?? 0, extra.eventKey ?? null);
  call('11111111111111111111111111111111', 'Call with Kevin Tremblay', 'recorded', { audio: 'call-1111.webm', notes: 'Looking for 95,000.', submission: 'I spoke to Kevin on Monday.', noteId: 1, app: 1, candidate: 1, eventKey: 'AAAAAAAAAAAAAAAAAAAAAA' }); // 1
  call('22222222222222222222222222222222', 'Catch-up', 'uploaded', { candidate: 2, status: 'uploaded', audio: 'call-2222.mp3' });  // 2: its application was removed; it stays with the person
  call('33333333333333333333333333333333', 'Untitled call', 'recorded');                                                           // 3: on nobody
  call('44444444444444444444444444444444', 'Call with Zoë O\'Brien-Smith', 'phone', { app: 7, candidate: 5, direction: 'outbound', number: '+19055550166', audio: 'call-4444.wav' }); // 4
  call('55555555555555555555555555555555', 'Voicemail', 'phone', { direction: 'inbound', number: '+12045550199', voicemail: 1 });   // 5
  call('66666666666666666666666666666666', 'Goes with its candidate', 'recorded', { app: 10, candidate: 9 });                       // 6: removed below
  const phoneCall = (direction, status, extra = {}) => run(
    `INSERT INTO phone_calls (user_id, direction, status, outcome, to_number, user_number, candidate_id, application_id, record, call_sid, recording_state, recording_sid, recording_deleted_at, call_id, call_made, title, started_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '+16475550142', ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    extra.user ?? 1, direction, status, extra.outcome ?? null, extra.to ?? null, extra.candidate ?? null, extra.app ?? null, extra.sid ?? null, extra.recording ?? null, extra.recordingSid ?? null,
    extra.deleted ?? null, extra.callId ?? null, extra.callId ? 1 : 0, extra.title ?? null, at('04-03'), at('04-03'));
  phoneCall('outbound', 'ended', { outcome: 'completed', to: '+19055550166', candidate: 5, app: 7, sid: 'CA01', recording: 'stored', recordingSid: 'RE01', deleted: at('04-03'), callId: 4 }); // 1
  phoneCall('outbound', 'ended', { outcome: 'busy', to: '+14165550142', candidate: 1, app: 1, sid: 'CA02' });                                                                                   // 2
  phoneCall('inbound', 'ended', { outcome: 'no_answer', to: '+12045550199', sid: 'CA03', recording: 'stored', recordingSid: 'RE03', deleted: at('04-04'), callId: 5, user: 2 });                // 3
  phoneCall('switchboard', 'ended', { outcome: 'completed', to: '+14165550100', sid: 'CA04', recording: 'pending', recordingSid: 'RE04', title: 'Chat with a client' });                         // 4: removed below, its recording still owed
  run(`INSERT INTO phone_webhooks (phone_call_id, kind, params, received_at) VALUES (1, 'status', '{"CallStatus":"completed"}', ?), (4, 'recording', '{}', ?)`, at('04-03'), at('04-03'));
  run(`INSERT INTO calendar_links (user_id, provider, link_sealed, tz, created_at, last_read_at, last_error) VALUES (2, 'google', 'v1.sealed.blob', 'America/Toronto', ?, ?, NULL)`, at('05-01'), at('11-09'));
  run(`INSERT INTO calendar_events (user_id, event_key, source, day, tz, fingerprint, added, application_id, call_id, seen_at, series) VALUES
    (2, 'AAAAAAAAAAAAAAAAAAAAAA', 'calendar', '2026-04-01', 'America/Toronto', 'fp1', 1, 1, 1, ?, 'series1'),
    (2, 'BBBBBBBBBBBBBBBBBBBBBB', 'calendar', '2026-11-10', 'America/Toronto', 'fp2', 1, NULL, NULL, ?, NULL),
    (2, 'CCCCCCCCCCCCCCCCCCCCCC', 'interview', '2026-11-10', 'America/Toronto', NULL, 0, 10, 6, ?, NULL)`, at('04-01'), at('11-09'), at('11-09'));
  // Names the calendar has already worked out for some people; the rest are still waiting to be.
  run(`INSERT INTO candidate_name_keys (candidate_id, first, last) VALUES (1, 'kevin', 'tremblay'), (2, 'kevin', 'tremblay'), (7, 'li', '')`);
  run('DELETE FROM candidate_name_dirty WHERE candidate_id IN (1, 2, 7)');

  // Rows removed again, from the middle and from the end, so that ids have gaps and the counters are ahead of the rows.
  run('DELETE FROM notes WHERE id = 4');
  run('DELETE FROM interviews WHERE id = 4');
  run('DELETE FROM phone_calls WHERE id = 4');
  run('DELETE FROM users WHERE id = 6');
  run('DELETE FROM candidates WHERE id IN (6, 9)');   // their applications (5 and 10) go with them, and so do those applications' notes, interviews, e-mails and calls
  run('DELETE FROM clients WHERE id = 4');            // its job, that job's application (9) and its candidate (8) go with it
  db.exec('COMMIT');
  db.close();
}

/**
 * What using the newest release without this change adds to a database from before: the names and numbers worked
 * out for looking people up, conversations remembered from Metaview (one brought in as a call, one only listed, one
 * forgotten with the person it was with), and the moments the reports count, with one removed again so that its
 * counter is ahead of its rows. Every one of these hangs off a candidate or an application, the two tables this
 * change rebuilds.
 */
function fillLive(dataDir) {
  const db = open(dataDir);
  const run = (sql, ...p) => db.prepare(sql).run(...p);
  db.exec('BEGIN');
  run(`INSERT INTO settings (key, value) VALUES ('reports_first_run', ?), ('reports_start', '2026-03-02'), ('reports_began', ?), ('metaview_auto', '0'), ('metaview_checked_at', ?)`, at('02-20'), at('03-02', '05:00:00'), at('11-09'));
  run(`INSERT INTO candidate_name_keys (candidate_id, first, last) VALUES (3, 'aisha', 'khan'), (4, 'nadia', 'petrov'), (5, 'zoe', 'smith')`);
  run(`INSERT INTO candidate_phone_keys (candidate_id, tail, lead) VALUES (1, '4165550142', '1'), (2, '4165550142', '1'), (5, '9055550166', '1'), (7, '', '')`);
  run('DELETE FROM candidate_name_dirty');
  run(`INSERT INTO calls (recording_id, title, status, source, duration_ms, transcript, transcript_source, speakers, notes, notes_at, external_url, took_place_at, application_id, candidate_id, consent_wording, created_by, created_at, updated_at)
       VALUES ('88888888888888888888888888888888', 'Call with Nadia Petrov', 'ready', 'metaview', 1260000, '[{"speaker":0,"start":0,"end":2.5,"text":"Hello"}]', 'metaview', '{"0":"Dana Recruiter","1":"Nadia Petrov"}',
         'Open to a move in the spring.', ?, 'https://app.metaview.ai/notes/880000137', ?, 6, 4, 'Recorded in Metaview.', 2, ?, ?)`, at('10-02'), at('10-01', '14:00:00'), at('10-02'), at('10-02'));   // 7
  const conversation = (id, title, people, search, callId, broughtIn) => run(
    `INSERT INTO metaview_calls (id, url, started_at, title, kind, channel, minutes, has_transcript, people, search, call_id, brought_in_at, seen_at) VALUES (?, ?, ?, ?, 'Job Interview', 'Phone', 21, 1, ?, ?, ?, ?, ?)`,
    id, `https://app.metaview.ai/notes/${id}`, at('10-01', '14:00:00'), title, JSON.stringify(people), search, callId, broughtIn, at('11-09'));
  conversation(880000137, null, [{ name: 'Nadia Petrov', role: 'candidate', emails: ['nadia@example.com'], phones: [] }, { name: 'Dana Recruiter', role: 'interviewer', emails: ['dana@agency.example'], phones: [] }],
    'nadia petrov nadia@example.com dana recruiter', 7, at('10-02'));
  conversation(880000274, 'Zoë and Dana: first conversation', [{ name: "Zoë O'Brien-Smith", role: 'candidate', emails: [], phones: ['+19055550166'] }], "zoe o'brien-smith 19055550166", null, null);
  run(`INSERT INTO metaview_people (call_id, kind, value, first, last) VALUES (880000137, 'email', 'nadia@example.com', NULL, NULL), (880000137, 'name', 'nadia petrov', 'nadia', 'petrov'),
       (880000137, 'interviewer', 'dana@agency.example', NULL, NULL), (880000274, 'phone', '9055550166', '1', NULL), (880000274, 'name', 'zoe o brien smith', 'zoe', 'smith')`);
  run('INSERT INTO metaview_forgotten (id) VALUES (880000411)');
  // The reports: a tick moved by hand on the job form, when an offer was accepted, and the moments written down.
  run('UPDATE stages SET with_client = 1 WHERE id = 2');
  run('UPDATE stages SET with_client = 0 WHERE id = 13');
  run('UPDATE offers SET accepted_at = ? WHERE application_id = 3', at('04-30'));
  const moment = (kind, appId, name, jobId, clientId, userId, when, extra = {}) => run(
    `INSERT INTO report_events (kind, application_id, candidate_name, job_id, client_id, user_id, at, filled_at, salary, fee_percent, fee, currency, fee_edited, set_aside_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    kind, appId, name, jobId, clientId, userId, when, extra.filled ?? null, extra.salary ?? null, extra.percent ?? null, extra.fee ?? null, extra.currency ?? null, extra.edited ?? 0, extra.aside ?? null);
  moment('search_opened', null, null, 1, 1, null, at('03-03'));                                                                                             // 1
  moment('submission', 4, 'Aïsha Khan', 1, 1, 2, at('03-18'));                                                                                              // 2
  moment('first_interview', 4, 'Aïsha Khan', 1, 1, 2, at('03-19'));                                                                                         // 3
  moment('placement', 3, 'Kévin Tremblay', 3, 2, 3, at('05-01'), { filled: at('04-30'), salary: 78000, percent: 0, fee: 9000, currency: 'CAD', edited: 1 }); // 4: a fee corrected by hand
  moment('placement', 8, 'Li', 4, 3, 1, at('05-01'), { filled: at('05-01'), percent: 20, currency: 'CAD', aside: at('05-02') });                             // 5: set aside, with no fee worked out
  moment('submission', 6, 'Nadia Petrov', 2, 1, 2, at('03-19'));                                                                                            // 6: removed below
  run('DELETE FROM report_events WHERE id = 6');
  db.exec('COMMIT');
  db.close();
}

/**
 * A database last opened by one of the releases from before, with the awkward data in it. `first` is run on the
 * empty folder before any release's code starts. The newest release without this change has no way to hold some of
 * that data any more (phone calls, the calendar), so its database is made and filled by the release before it, then
 * opened and used by it.
 */
function databaseFromBefore(release, name, first = () => {}) {
  const dataDir = newDir(name);
  first(dataDir);
  const maker = release.live ? NEWER : release;
  start(maker.code, dataDir);
  fill(dataDir);
  start(maker.code, dataDir); // an ordinary restart on the old code, so the snapshot is of a database at rest
  if (release.live) {
    start(release.code, dataDir);
    fillLive(dataDir);
    start(release.code, dataDir);
  }
  return dataDir;
}
/** A copy of a data folder at rest, to try something else on the same database. */
function copyOf(dataDir, name) {
  const copy = newDir(name);
  fs.cpSync(dataDir, copy, { recursive: true });
  return copy;
}
/** The highest id each table has given out in the awkward data, for a database last opened by this release. */
const COUNTERS = (release) => ({ applications: 10, calls: release.live ? 7 : 6, candidates: 9, interviews: 5, invites: 2, notes: 6, phone_calls: 4, ...(release.live ? { report_events: 6 } : {}), users: 6 });
/** Run a test once for each release a database may have been made by. */
const forEachBefore = (name, fn) => { for (const release of BEFORES) test(`${name} [a database last opened by ${release.name}]`, (t) => fn(release, t)); };

forEachBefore('the database code kept from before is the code that was released', (release, t) => {
  // Only where the repository's history is to hand; a copy of the files without it has nothing to compare with.
  let released;
  try {
    released = (file) => execFileSync('git', ['show', `${release.commit}:server/${file}`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    released('db.js');
  } catch { return t.skip('the commit from before is not in this copy of the repository'); }
  for (const file of ['db.js', 'links.js']) assert.equal(fs.readFileSync(path.join(HERE, 'fixtures', release.folder, file), 'utf8'), released(file), file);
});

forEachBefore('upgrading changes nothing but the three columns, the new column, the new empty tables and the indexes, and starting twice changes nothing more', (release) => {
  const dataDir = databaseFromBefore(release, 'pool-upgrade');
  const before = snapshot(dataDir);
  // Whether the release that made it had already given history lines their newer types is as the list above says.
  assert.equal(before.rows.settings.some((row) => row.key === 'activity_types_v2'), release.reviewed);
  assert.equal(before.master.some((m) => m.name === 'idx_activities_recent'), release.reviewed);
  const oldLines = (shot) => shot.rows.activities.filter((row) => OLD_LINES.some(([appId, , , detail, when]) => row.application_id === appId && row.detail === detail && row.created_at === when)).map((row) => [row.id, row.type]);
  assert.deepEqual(oldLines(before), OLD_LINES.map((line, i) => [14 + i, line[2]]), 'the old history lines are there as they were written');
  // The data is what the comments in fill() say it is: gaps in the ids, and counters ahead of the rows.
  assert.deepEqual(before.rows.candidates.map((c) => c.id), [1, 2, 3, 4, 5, 7]);
  assert.deepEqual(before.rows.applications.map((a) => a.id), [1, 2, 3, 4, 6, 7, 8]);
  assert.deepEqual(before.rows.notes.map((n) => n.id), [1, 2, 3, 5]);
  assert.deepEqual(Object.fromEntries(before.counters.map((c) => [c.name, c.seq])), COUNTERS(release));
  assert.deepEqual(before.rows.phone_recordings_owed.map((r) => r.recording_sid), ['RE04']);
  assert.deepEqual(before.rows.calls.map((c) => [c.id, c.application_id, c.candidate_id]), [[1, 1, 1], [2, null, 2], [3, null, null], [4, 7, 5], [5, null, null], ...(release.live ? [[7, 6, 4]] : [])]);
  // An index the calendar looked numbers up through, which today's code no longer makes: it has to survive the rebuild of its table.
  assert.ok(before.master.some((m) => m.name === 'idx_candidates_phone_tail'));
  if (release.live) {
    assert.deepEqual(before.rows.report_events.map((e) => [e.id, e.kind, e.application_id]), [[1, 'search_opened', null], [2, 'submission', 4], [3, 'first_interview', 4], [4, 'placement', 3], [5, 'placement', 8]]);
    assert.deepEqual([before.rows.metaview_calls.length, before.rows.metaview_people.length, before.rows.metaview_forgotten.length, before.rows.candidate_phone_keys.length], [2, 5, 1, 4]);
    assert.ok(before.master.some((m) => m.type === 'trigger' && m.name === 'candidate_phone_changed'));
  }
  for (const [table, column] of [['candidates', 'client_id'], ['applications', 'job_id'], ['applications', 'stage_id']]) {
    assert.equal(before.columns[table].find((c) => c.name === column).notnull, 1, `${table}.${column} is required before the upgrade`);
  }

  const byLive = openedByLive(dataDir);
  if (release.live) assertSame(byLive, before, 'opened once more by the release it was last opened by');
  start(NOW, dataDir);
  const upgraded = snapshot(dataDir);
  assertSame(upgraded, expectedAfter(byLive), 'after the upgrade');
  // Everything an earlier release made is still there, written as it was, but for the two tables that were rebuilt
  // and the two that gained a marker: every other table, and every index and trigger, those of the rebuilt tables included.
  for (const m of byLive.master) {
    if (['candidates', 'applications', 'activities', 'emails'].includes(m.name)) continue;
    assert.equal(upgraded.master.find((x) => x.name === m.name)?.sql, m.sql, `${m.type} ${m.name}`);
  }
  // Said once more without the helper: no row of any table from before is missing or has another id, and the only
  // values that differ are the types of the history lines listed above, on a database that still had the old ones.
  for (const [table, rows] of Object.entries(before.rows)) {
    for (const row of rows) {
      const now = sameRow(upgraded.rows[table], row, `${table} ${row['(rowid)']}`);
      for (const [column, value] of Object.entries(row)) {
        if (table === 'activities' && column === 'type' && !release.reviewed) continue;
        assert.deepEqual(now[column], value, `${table} ${row['(rowid)']}.${column}`);
      }
    }
  }
  assert.deepEqual(oldLines(upgraded), OLD_LINES.map((line, i) => [14 + i, release.reviewed ? line[2] : line[5]]), 'the old history lines have the types they should have now');
  assert.deepEqual(upgraded.counters, before.counters);
  // The only rows that have appeared anywhere are the ones the releases in between add on their first start: two
  // "this was done" settings, and a note for each candidate whose name or number is still to be worked out.
  for (const [table, rows] of Object.entries(before.rows)) {
    const extra = appeared(upgraded.rows[table], rows);
    if (table === 'settings') assert.deepEqual(extra.map((row) => row.key), release.reviewed ? [] : ['activity_types_v2']);
    else if (table === 'candidate_name_dirty') assert.deepEqual(extra.map((row) => row.candidate_id), release.live ? [] : [1, 2, 7], 'the candidates with a phone number, whose numbers are still to be filed');
    else assert.deepEqual(extra, [], `no rows have appeared in ${table}`);
  }

  start(NOW, dataDir);
  assertSame(snapshot(dataDir), upgraded, 'after a second start');
  start(NOW, dataDir);
  assertSame(snapshot(dataDir), upgraded, 'after a third start');
});

test('a database the oldest release made ends up the same whichever of the newer releases opened it on the way', () => {
  const dataDir = databaseFromBefore(OLDER, 'pool-two-ways');
  const viaNewer = copyOf(dataDir, 'pool-two-ways-via-newer'), viaBoth = copyOf(dataDir, 'pool-two-ways-via-both'), viaLive = copyOf(dataDir, 'pool-two-ways-via-live');
  start(NEWER.code, viaNewer);
  start(NEWER.code, viaBoth);
  start(LIVE.code, viaBoth);
  const onTheWay = snapshot(viaBoth);
  start(LIVE.code, viaLive);
  assertSame(snapshot(viaLive), onTheWay, 'the newest release without this change, straight from the oldest and by way of the one between');
  for (const dir of [dataDir, viaNewer, viaBoth, viaLive]) start(NOW, dir);
  const straight = snapshot(dataDir);
  assertSame(straight, snapshot(viaNewer), 'straight to today\'s code, against by way of the release with the review fixes');
  assertSame(straight, snapshot(viaBoth), 'straight to today\'s code, against by way of both newer releases');
  assertSame(straight, snapshot(viaLive), 'straight to today\'s code, against by way of the newest release without this change');
  assertSame(straight, expectedAfter(onTheWay), 'against what the newest release without this change left, upgraded');
});

forEachBefore('after the upgrade the rules still hold: foreign keys, one record per e-mail at a client, ids never reused', (release) => {
  const dataDir = databaseFromBefore(release, 'pool-rules');
  start(NOW, dataDir);
  const db = open(dataDir);
  const run = (sql, ...p) => db.prepare(sql).run(...p);
  const get = (sql, ...p) => db.prepare(sql).get(...p);
  const count = (table, where = '1 = 1') => get(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).n;
  const newApplication = (candidateId, jobId, stageId) => run(
    `INSERT INTO applications (candidate_id, job_id, stage_id, applied_at, stage_entered_at, updated_at) VALUES (?, ?, ?, 'x', 'x', 'x')`, candidateId, jobId, stageId);
  const newCandidate = (clientId, name, email) => run(`INSERT INTO candidates (client_id, name, email, created_at) VALUES (?, ?, ?, 'x')`, clientId, name, email);

  // Rows that point at nothing are still refused.
  assert.throws(() => newApplication(999, 1, 1), /FOREIGN KEY/);
  assert.throws(() => newApplication(4, 999, 1), /FOREIGN KEY/);
  assert.throws(() => newApplication(4, 1, 999), /FOREIGN KEY/);
  assert.throws(() => newCandidate(999, 'Nobody', 'nobody@example.com'), /FOREIGN KEY/);
  assert.throws(() => run(`INSERT INTO notes (application_id, user_id, body, created_at) VALUES (5, 2, 'on a removed application', 'x')`), /FOREIGN KEY/);
  assert.throws(() => run(`INSERT INTO calls (recording_id, title, status, source, candidate_id, created_at, updated_at) VALUES ('77777777777777777777777777777777', 'x', 'ready', 'recorded', 6, 'x', 'x')`), /FOREIGN KEY/);
  // The rules written inside the two tables are still there.
  assert.throws(() => newCandidate(1, 'Another Kevin', 'kevin.tremblay@example.com'), /UNIQUE/);
  assert.throws(() => newApplication(1, 1, 1), /UNIQUE/);
  assert.throws(() => run(`INSERT INTO candidates (client_id, email, created_at) VALUES (1, 'noname@example.com', 'x')`), /NOT NULL/);
  assert.throws(() => run(`INSERT INTO applications (candidate_id, job_id, stage_id, applied_at, stage_entered_at) VALUES (4, 1, 1, 'x', 'x')`), /NOT NULL/);

  // New rows carry on from the highest id ever given out, not from the highest row that is left.
  assert.equal(Number(newCandidate(1, 'New Person', 'new@example.com').lastInsertRowid), 10);
  assert.equal(Number(newApplication(10, 1, 1).lastInsertRowid), 11);
  // The note that a new or renamed person's name is still to be worked out, or a changed number, is written as before.
  assert.equal(count('candidate_name_dirty', 'candidate_id = 10'), 1);
  run('DELETE FROM candidate_name_dirty WHERE candidate_id = 10');
  run(`UPDATE candidates SET name = 'Renamed Person' WHERE id = 10`);
  assert.equal(count('candidate_name_dirty', 'candidate_id = 10'), 1);
  run('DELETE FROM candidate_name_dirty WHERE candidate_id = 10');
  run(`UPDATE candidates SET phone = '416 555 0188' WHERE id = 10`);
  assert.equal(count('candidate_name_dirty', 'candidate_id = 10'), 1);
  // What the reports wrote down, and what was worked out for looking people up, still hangs off the rebuilt tables.
  run(`INSERT INTO candidate_phone_keys (candidate_id, tail, lead) VALUES (10, '4165550188', '1')`);
  run(`INSERT INTO report_events (kind, application_id, candidate_name, job_id, client_id, at) VALUES ('submission', 11, 'Renamed Person', 1, 1, 'x')`);
  assert.throws(() => run(`INSERT INTO report_events (kind, application_id, candidate_name, job_id, client_id, at) VALUES ('submission', 11, 'Renamed Person', 1, 1, 'x')`), /UNIQUE/, 'a candidate is submitted in a job once');
  assert.throws(() => run(`INSERT INTO report_events (kind, application_id, candidate_name, job_id, client_id, at) VALUES ('placement', 999, 'Nobody', 1, 1, 'x')`), /FOREIGN KEY/);
  assert.throws(() => run(`INSERT INTO candidate_phone_keys (candidate_id, tail, lead) VALUES (999, '4165550188', '1')`), /FOREIGN KEY/);
  run('DELETE FROM applications WHERE id = 11');
  assert.equal(count('report_events', 'application_id = 11'), 0);
  assert.equal(Number(newApplication(10, 1, 1).lastInsertRowid), 12);
  const reportsBefore = count('report_events'), keysBefore = count('candidate_phone_keys');

  // What the upgrade is for: a person with no client, whose entry has no job and no stage.
  assert.equal(Number(newCandidate(null, 'In The Book', 'book@example.com').lastInsertRowid), 11);
  assert.equal(Number(newApplication(11, null, null).lastInsertRowid), 13);
  assert.throws(() => newApplication(11, null, null), /UNIQUE/, 'one entry per person saved without a job');
  assert.throws(() => newCandidate(null, 'Same Address', 'book@example.com'), /UNIQUE/, 'one record per e-mail among people saved without a job');
  newCandidate(null, 'No Address', null);
  newCandidate(null, 'No Address Either', null);                 // people with no e-mail address are not held to that rule
  newCandidate(1, 'At A Client', 'book@example.com');            // and the same address may be on a client's record too

  // Removing things still takes with it what hung off them, and leaves the rest.
  run('DELETE FROM applications WHERE id = 7');                  // Zoë's only application: her phone call's recording stays with her
  assert.deepEqual({ ...get('SELECT application_id, candidate_id FROM calls WHERE id = 4') }, { application_id: null, candidate_id: 5 });
  assert.deepEqual({ ...get('SELECT application_id, candidate_id FROM phone_calls WHERE id = 1') }, { application_id: null, candidate_id: 5 });
  run('DELETE FROM candidates WHERE id = 1');                    // Kevin at Maple: both applications, their notes, interviews, scorecards, e-mails and calls
  assert.equal(count('applications', 'candidate_id = 1'), 0);
  assert.equal(count('notes', 'application_id IN (1, 2)'), 0);
  assert.equal(count('interviews', 'application_id = 1'), 0);
  assert.equal(count('scorecards', 'interview_id IN (1, 2)'), 0);
  assert.equal(count('interview_panel', 'interview_id IN (1, 2)'), 0);
  assert.equal(count('emails', 'application_id = 1'), 0);
  assert.equal(count('calls', 'candidate_id = 1'), 0);
  assert.equal(count('phone_calls', 'candidate_id = 1'), 0);
  assert.equal(count('candidate_name_keys', 'candidate_id = 1'), 0);
  assert.equal(get(`SELECT application_id FROM calendar_events WHERE event_key = 'AAAAAAAAAAAAAAAAAAAAAA'`).application_id, null);
  assert.equal(count('candidates', 'id = 2'), 1, 'the same person on file at another client is a record of its own');
  run('DELETE FROM jobs WHERE id = 3');                          // a job takes its applications with it
  assert.equal(count('applications', 'job_id = 3'), 0);
  assert.equal(count('applications', 'id = 13'), 1, 'and leaves the entry of someone on no job alone');
  // The reports' moments went with the candidate (Kevin at Maple had none), the job (Kévin's placement at Northline) and nothing else.
  assert.equal(count('report_events'), reportsBefore - (release.live ? 1 : 0));
  assert.equal(count('candidate_phone_keys'), keysBefore - (release.live ? 1 : 0), 'the numbers filed for a removed candidate go with them');
  if (release.live) {
    assert.deepEqual(db.prepare('SELECT id, kind FROM report_events WHERE id <= 5 ORDER BY id').all().map((e) => [e.id, e.kind]), [[1, 'search_opened'], [2, 'submission'], [3, 'first_interview'], [5, 'placement']]);
    assert.deepEqual({ ...get('SELECT call_id FROM metaview_calls WHERE id = 880000137') }, { call_id: 7 }, 'a conversation brought in from Metaview is still the call it became');
  }
  assert.throws(() => run('DELETE FROM stages WHERE id = 4'), /FOREIGN KEY/, 'a stage with somebody in it cannot be removed');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  db.close();
});

// What a database that was in use before phone calls and the calendar were taken out still holds of theirs.
const LEFT_BEHIND = {
  master: ['index idx_calendar_events_print', 'index idx_calendar_events_seen', 'index idx_candidates_phone_tail', 'index idx_interviews_starts', 'index idx_phone_calls_call', 'index idx_phone_calls_candidate',
    'index idx_phone_calls_sid', 'index idx_phone_calls_user', 'index idx_phone_webhooks_call', 'index idx_users_phone', 'table calendar_events', 'table calendar_links', 'table phone_calls', 'table phone_calls_erased',
    'table phone_recordings_owed', 'table phone_webhooks', 'trigger phone_calls_erased_unrecorded', 'trigger phone_calls_owed_recording'],
  columns: {
    users: ['phone', 'phone_pin_hash', 'phone_pin_fails', 'phone_locked_until', 'phone_lock_level', 'phone_pin_wrong', 'phone_pin_wrong_since'],
    calls: ['direction', 'phone_number', 'speaker_roles', 'audio_channels', 'voicemail', 'notified_at', 'event_key', 'transcribe_tries', 'transcribe_next_at', 'notify_tries', 'notify_next_at'],
  },
};

/**
 * A snapshot without what phone calls and the calendar left behind, for comparing a database that went through the
 * releases that had them with one that never did. The two tables that carry their columns (users and calls) are
 * compared by their columns, not by the words they were made with, since those say which columns came when.
 */
function withoutLeftBehind(shot) {
  const out = plain(shot);
  const gone = LEFT_BEHIND.master.map((name) => name.split(' ')[1]);
  out.master = out.master.filter((m) => !gone.includes(m.name)).map((m) => (LEFT_BEHIND.columns[m.name] ? { ...m, sql: null } : m));
  for (const part of ['rows', 'columns', 'foreignKeys', 'indexes']) for (const name of gone) delete out[part][name];
  for (const table of Object.keys(out.indexes)) out.indexes[table] = out.indexes[table].filter((index) => !gone.includes(index.name));
  for (const [table, columns] of Object.entries(LEFT_BEHIND.columns)) {
    out.columns[table] = out.columns[table].filter((c) => !columns.includes(c.name)).map(({ cid, ...column }) => column).sort((a, b) => a.name.localeCompare(b.name));
    out.rows[table] = out.rows[table].map((row) => Object.fromEntries(Object.entries(row).filter(([column]) => !columns.includes(column))));
  }
  out.counters = out.counters.filter((c) => !gone.includes(c.name));
  return out;
}

forEachBefore('a database made new today is built the same as one that was upgraded', (release) => {
  const upgradedDir = databaseFromBefore(release, 'pool-compare');
  start(NOW, upgradedDir);
  const freshDir = newDir('pool-fresh');
  start(NOW, freshDir);
  const upgraded = snapshot(upgradedDir), fresh = snapshot(freshDir);
  // Everything a database made new today has, the upgraded one has, made the same way. What the upgraded one has
  // besides is what phone calls and the calendar left behind, which nothing reads any more and nothing removes.
  const names = (shot) => shot.master.map((m) => `${m.type} ${m.name}`);
  assert.deepEqual(names(upgraded).filter((name) => !names(fresh).includes(name)), LEFT_BEHIND.master);
  assert.deepEqual(names(fresh).filter((name) => !names(upgraded).includes(name)), []);
  const definition = ({ cid, ...column }) => column;
  for (const table of Object.keys(fresh.rows)) {
    const left = LEFT_BEHIND.columns[table] ?? [];
    assert.deepEqual(upgraded.columns[table].map((c) => c.name).filter((name) => !fresh.columns[table].some((c) => c.name === name)).sort(), [...left].sort(), `the columns only an upgraded ${table} has`);
    // The same columns, defined the same way. (Their order differs where a column was added to a table later on.)
    const byName = (a, b) => a.name.localeCompare(b.name);
    assert.deepEqual(upgraded.columns[table].filter((c) => !left.includes(c.name)).map(definition).sort(byName), fresh.columns[table].map(definition).sort(byName), `the columns of ${table}`);
    assert.deepEqual(upgraded.foreignKeys[table], fresh.foreignKeys[table], `the foreign keys of ${table}`);
    assert.deepEqual(upgraded.indexes[table].filter((index) => !LEFT_BEHIND.master.includes(`index ${index.name}`)), fresh.indexes[table], `the indexes of ${table}`);
  }
  // And both carry the same "this was done" markers, so neither will ever be converted a second time.
  const done = (shot) => shot.rows.settings.map((row) => row.key).filter((key) => ['links_normalised', 'activity_types_v2'].includes(key)).sort();
  assert.deepEqual(done(fresh), ['activity_types_v2', 'links_normalised']);
  assert.deepEqual(done(upgraded), done(fresh));
});

// As the first release made these tables: ids that could be reused, an e-mail address that was required, and none
// of the columns added since. Every release since has changed them a step at a time, which leaves them stored in
// a different form from tables made new today.
const FIRST_RELEASE = `
CREATE TABLE users (
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
CREATE TABLE candidates (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT, linkedin TEXT, location TEXT, current_title TEXT, current_company TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (client_id, email)
);
CREATE TABLE applications (
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
CREATE TABLE interviews (
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
CREATE TABLE notes (
  id INTEGER PRIMARY KEY,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  private INTEGER NOT NULL DEFAULT 0,                -- 1 = visible to the agency only
  created_at TEXT NOT NULL
);`;

/** A database whose tables were made by the first release, then brought up to date and filled by a later one. */
const beganAtFirstRelease = (release, name) => databaseFromBefore(release, name, (dir) => {
  const db = new DatabaseSync(path.join(dir, 'app.db'));
  db.exec(FIRST_RELEASE);
  db.close();
});

forEachBefore('a database that began at the first release, and was changed by every release since, upgrades the same way', (release) => {
  const dataDir = beganAtFirstRelease(release, 'pool-first-release');
  const before = snapshot(dataDir);
  // The code from before has brought those tables up to date its own way, which is the form the upgrade has to cope with.
  const tableSql = (shot, name) => shot.master.find((m) => m.name === name).sql;
  assert.match(tableSql(before, 'candidates'), /^CREATE TABLE "candidates"/);
  assert.match(tableSql(before, 'applications'), /hired_at TEXT, consent_at TEXT, owner_id INTEGER REFERENCES users\(id\) ON DELETE SET NULL,\n/, 'columns added since were written in after the last one');
  assert.deepEqual(Object.fromEntries(before.counters.map((c) => [c.name, c.seq])), COUNTERS(release));

  const byLive = openedByLive(dataDir);
  start(NOW, dataDir);
  const upgraded = snapshot(dataDir);
  assertSame(upgraded, expectedAfter(byLive), 'after the upgrade');
  start(NOW, dataDir);
  assertSame(snapshot(dataDir), upgraded, 'after a second start');
});

// The steps the upgrade takes to rebuild a table (see rebuildTable in server/db.js), for the two tests below. `own`
// is the table's indexes and triggers as they were written, which go when the table is dropped and are made again.
const REBUILD_CANDIDATES = (sql, own = []) => `
  CREATE TABLE candidates__new ${sql.slice(sql.indexOf('(')).replace('client_id INTEGER NOT NULL', 'client_id INTEGER')};
  INSERT INTO candidates__new SELECT * FROM candidates;
  DROP TABLE candidates;
  ALTER TABLE candidates__new RENAME TO candidates;
  ${own.join(';\n  ')};`;

forEachBefore('a start that is cut off in the middle of rebuilding a table leaves the database as it was, and the next start finishes the job', (release) => {
  const dataDir = databaseFromBefore(release, 'pool-cut-off');
  const before = snapshot(dataDir);
  // A process that gets as far as dropping the old table and is then killed, before anything is committed.
  const script = `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1]);
    const { sql } = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'candidates'").get();
    db.exec('PRAGMA foreign_keys = OFF; BEGIN;' + (${REBUILD_CANDIDATES.toString()})(sql).replace(/ALTER TABLE[^;]*;/, ''));
    process.kill(process.pid, 'SIGKILL');`;
  const killed = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', script, path.join(dataDir, 'app.db')], { encoding: 'utf8' });
  assert.equal(killed.signal, 'SIGKILL', killed.stderr);
  assertSame(snapshot(dataDir), before, 'after the start that was cut off');

  const byLive = openedByLive(dataDir);
  start(NOW, dataDir);
  assertSame(snapshot(dataDir), expectedAfter(byLive), 'after the next start');
});

// Builds of this release from before it was finished kept the agency's own history lines and e-mails in the tables
// the hiring team is shown from, marked with a column (agency_only) or told by their date. No released version did,
// so no database in use has such lines; one that such a build opened is put right when it is next started.
test('a database an unfinished build of this release has used: the lines it marked for the agency are moved to the agency\'s own tables', () => {
  const dataDir = newDir('pool-marked');
  start(NOW, dataDir);
  const db = open(dataDir);
  db.exec(`
    ALTER TABLE activities ADD COLUMN agency_only INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE emails ADD COLUMN agency_only INTEGER NOT NULL DEFAULT 0;
    INSERT INTO clients (id, name, slug, created_at) VALUES (1, 'Maple Freight', 'maple', '2026-01-01');
    INSERT INTO jobs (id, client_id, title, created_at) VALUES (1, 1, 'Dispatcher', '2026-01-01');
    INSERT INTO stages (id, job_id, name, kind, position) VALUES (1, 1, 'Applied', 'applied', 0);
    INSERT INTO candidates (id, client_id, name, created_at) VALUES (1, 1, 'On A Job', '2026-04-01'), (2, NULL, 'In The Book', '2026-04-01'), (3, 1, 'Joined', '2026-04-01');
    INSERT INTO applications (id, candidate_id, job_id, stage_id, applied_at, stage_entered_at, updated_at, general_until) VALUES
      (1, 1, 1, 1, '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z'),
      (2, 2, NULL, NULL, '2026-04-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z', NULL),
      (3, 3, 1, 1, '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z', NULL);
    INSERT INTO activities (application_id, user_id, type, detail, created_at, agency_only) VALUES
      (1, 7, 'added', 'Added to The Book (linkedin)', '2026-04-01T00:00:00.000Z', 0),
      (1, 7, 'call', 'Call added, 9 min', '2026-04-02T00:00:00.000Z', 0),
      (1, 7, 'added', 'Added to Dispatcher at Applied', '2026-05-01T00:00:00.000Z', 0),
      (1, 7, 'added', 'A newer résumé was added', '2026-05-01T00:00:00.000Z', 1),
      (2, 7, 'added', 'Added to The Book (referral)', '2026-04-01T00:00:00.000Z', 0),
      (3, NULL, 'applied', 'Applied via careers page', '2026-03-01T00:00:00.000Z', 0),
      (3, 7, 'added', 'Added to The Book (agency sourced)', '2026-02-01T00:00:00.000Z', 1),
      (3, 7, 'merged', 'Joined with their entry in The Book, which had no job', '2026-03-05T00:00:00.000Z', 1);
    INSERT INTO emails (application_id, to_email, subject, body, sent_by, delivery, created_at, agency_only) VALUES
      (1, 'a@example.com', 'Before the job', 'Between us', 7, 'sent', '2026-04-03T00:00:00.000Z', 0),
      (1, 'a@example.com', 'On the job', 'Interview', 7, 'sent', '2026-05-02T00:00:00.000Z', 0),
      (2, 'b@example.com', 'In The Book', 'Hello', 7, 'sent', '2026-04-03T00:00:00.000Z', 0),
      (3, 'c@example.com', 'From the entry', 'Between us', 7, 'sent', '2026-02-02T00:00:00.000Z', 1),
      (3, 'c@example.com', 'We received your application', 'Thanks', NULL, 'sent', '2026-03-01T00:00:00.000Z', 0);`);
  db.close();
  const read = () => {
    const now = open(dataDir);
    const all = (sql) => plain(now.prepare(sql).all());
    const out = {
      shown: all('SELECT application_id, detail FROM activities ORDER BY application_id, created_at, id').map((r) => `${r.application_id} ${r.detail}`),
      kept: all('SELECT application_id, user_id, type, detail, created_at FROM agency_activities ORDER BY application_id, id'),
      mailShown: all('SELECT application_id, subject FROM emails ORDER BY application_id, created_at, id').map((r) => `${r.application_id} ${r.subject}`),
      mailKept: all('SELECT application_id, to_email, subject, body, sent_by, delivery, created_at FROM agency_emails ORDER BY application_id, id'),
    };
    now.close();
    return out;
  };
  start(NOW, dataDir);
  const after_ = read();
  // What the hiring team is shown from holds the job's own lines and nothing else; somebody in The Book is left alone.
  assert.deepEqual(after_.shown, ['1 Added to Dispatcher at Applied', '2 Added to The Book (referral)', '3 Applied via careers page']);
  assert.deepEqual(after_.mailShown, ['1 On the job', '2 In The Book', '3 We received your application']);
  // The rest is the agency's, whole and in the order it was written.
  assert.deepEqual(after_.kept, [
    { application_id: 1, user_id: 7, type: 'added', detail: 'Added to The Book (linkedin)', created_at: '2026-04-01T00:00:00.000Z' },
    { application_id: 1, user_id: 7, type: 'call', detail: 'Call added, 9 min', created_at: '2026-04-02T00:00:00.000Z' },
    { application_id: 1, user_id: 7, type: 'added', detail: 'A newer résumé was added', created_at: '2026-05-01T00:00:00.000Z' },
    { application_id: 3, user_id: 7, type: 'added', detail: 'Added to The Book (agency sourced)', created_at: '2026-02-01T00:00:00.000Z' },
    { application_id: 3, user_id: 7, type: 'merged', detail: 'Joined with their entry in The Book, which had no job', created_at: '2026-03-05T00:00:00.000Z' },
  ]);
  assert.deepEqual(after_.mailKept, [
    { application_id: 1, to_email: 'a@example.com', subject: 'Before the job', body: 'Between us', sent_by: 7, delivery: 'sent', created_at: '2026-04-03T00:00:00.000Z' },
    { application_id: 3, to_email: 'c@example.com', subject: 'From the entry', body: 'Between us', sent_by: 7, delivery: 'sent', created_at: '2026-02-02T00:00:00.000Z' },
  ]);
  start(NOW, dataDir);
  assert.deepEqual(read(), after_, 'the next start changes nothing more');
});

// A disk that fills up in the middle of the upgrade. SQLite undoes the transaction by itself when that happens, so
// undoing it again fails; that second failure used to be all the owner was told ("cannot rollback - no transaction
// is active"), on every restart, with no mention of the disk.
forEachBefore('a disk that fills up during the upgrade is reported as a full disk, nothing is changed, and the next start finishes the job', (release) => {
  const dataDir = databaseFromBefore(release, 'pool-disk-full');
  const before = snapshot(dataDir);
  const byLive = openedByLive(dataDir);
  // What every release up to the live one does first is not what fills the disk: it is done, and then compared against.
  const run = open_(NOW, dataDir, { DISK_FULL: '1' });
  assert.notEqual(run.status, 0, 'the start fails');
  assert.match(run.stderr, /The disk that holds .* is full, so the database could not be upgraded\. Nothing has been changed or lost\./);
  assert.match(run.stderr, /about one and a half times the size of app\.db \(it is \d+ MB now\) while it rebuilds the table "\w+"/);
  assert.doesNotMatch(run.stderr, /cannot rollback/);
  const left = snapshot(dataDir);
  assert.deepEqual(left.problems, { integrity: [{ integrity_check: 'ok' }], foreignKeys: [] });
  for (const table of Object.keys(before.rows)) assert.deepEqual(left.rows[table], before.rows[table], `${table} after the start that ran out of disk`);
  assert.equal(left.master.some((m) => /__new$/.test(m.name)), false, 'no half-built table is left behind');
  start(NOW, dataDir);
  assertSame(snapshot(dataDir), expectedAfter(byLive), 'after the next start, with room on the disk');
});

test('an error inside a transaction is the error that is reported, even when SQLite has already undone the transaction itself', () => {
  const script = `
    const { db, tx } = await import(${JSON.stringify(pathToFileURL(NOW).href)});
    try { tx(() => { db.exec('ROLLBACK'); throw new Error('the real reason'); }); } catch (err) { console.log(err.message); }
    console.log(tx(() => 'and the next transaction works'));
    db.close();`;
  const run = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script], {
    cwd: ROOT, env: { PATH: process.env.PATH, HOME: process.env.HOME, DATA_DIR: newDir('pool-tx') }, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.stdout.trim().split('\n'), ['the real reason', 'and the next transaction works']);
});

// Two processes on one data folder: a deploy that starts the new container before the old one has stopped, or two
// starts at the same moment. The one that finds the database being written to used to fail at once with "database
// is locked"; it now waits its turn.
test('a start waits for another process that is writing to the database, and then upgrades it as if it had been alone', async () => {
  const dataDir = databaseFromBefore(LIVE, 'pool-busy');
  const byLive = openedByLive(dataDir);
  // Another process takes the database for writing, says so, and lets go a second and a half later.
  const holder = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1]);
    db.exec('BEGIN IMMEDIATE');
    console.log('locked');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
    db.exec('COMMIT');
    db.close();`, path.join(dataDir, 'app.db')], { stdio: ['ignore', 'pipe', 'inherit'] });
  const done = new Promise((resolve) => holder.once('exit', resolve));
  await new Promise((resolve, reject) => { holder.stdout.once('data', resolve); holder.once('error', reject); });
  const began = Date.now();
  start(NOW, dataDir);
  assert.ok(Date.now() - began >= 1000, `the start waited for the other process (it took ${Date.now() - began} ms)`);
  assert.equal(await done, 0);
  assertSame(snapshot(dataDir), expectedAfter(byLive), 'after the start that had to wait');
});

forEachBefore('a start that stops between the two tables is carried on by the next one', (release) => {
  const dataDir = databaseFromBefore(release, 'pool-half-way');
  const before = snapshot(dataDir);
  // The first table is done and saved; the second, the new column and the indexes are not.
  const byLive = openedByLive(dataDir);
  const db = new DatabaseSync(path.join(dataDir, 'app.db'));
  const { sql } = db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'candidates'`).get();
  const own = db.prepare(`SELECT sql FROM sqlite_master WHERE tbl_name = 'candidates' AND type IN ('index', 'trigger') AND sql IS NOT NULL ORDER BY rowid`).all().map((row) => row.sql);
  const counter = db.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'candidates'`).get().seq;
  db.exec(`PRAGMA foreign_keys = OFF; BEGIN; ${REBUILD_CANDIDATES(sql, own)}`);
  db.prepare(`UPDATE sqlite_sequence SET seq = ? WHERE name = 'candidates'`).run(counter);
  db.exec('COMMIT');
  db.close();
  const half = snapshot(dataDir);
  assert.equal(half.columns.candidates.find((c) => c.name === 'client_id').notnull, 0);
  assert.equal(half.columns.applications.find((c) => c.name === 'job_id').notnull, 1);
  assert.deepEqual(half.indexes.candidates, before.indexes.candidates, 'a rebuilt table has the indexes it had, saved in the same step as the table');
  assert.deepEqual(half.master.filter((m) => m.type === 'trigger'), before.master.filter((m) => m.type === 'trigger'), 'and its triggers');

  start(NOW, dataDir);
  assertSame(snapshot(dataDir), expectedAfter(byLive), 'after the next start');
  // The app runs on it: the old code's own start would too, but the new code is what is deployed.
  start(NOW, dataDir);
});

/**
 * Cut the upgrade off before each of its steps in turn, every time on a fresh copy of the same database. After each
 * cut the database must pass its own checks with every row of every table still there under the id it had, each
 * value either as it was or as the finished upgrade leaves it, and no id counter below where it was or below an id
 * in use. The next start must then finish the job, to exactly what an upgrade that was never interrupted gives
 * (`finished`: worked out from the database as it was, unless given).
 */
function cutOffAtEveryStep(dataDir, name, finished) {
  const before = snapshot(dataDir);
  finished ??= expectedAfter(openedByLive(dataDir));
  let cuts = 0;
  for (let step = 1; ; step++) {
    const copy = copyOf(dataDir, `${name}-${step}`);
    if (!startCutOffAt(NOW, copy, step)) {
      // No statement left to stop at: this start ran to its end, like any other.
      assertSame(snapshot(copy), finished, `a start with nothing to stop it at step ${step}`);
      break;
    }
    cuts++;
    const cut = snapshot(copy);
    const what = `cut off before step ${step}`;
    assert.deepEqual(cut.problems, { integrity: [{ integrity_check: 'ok' }], foreignKeys: [] }, `${what}: the database's own checks`);
    for (const counter of before.counters) assert.deepEqual(cut.counters.find((c) => c.name === counter.name), counter, `${what}: the highest id ${counter.name} has given out`);
    for (const counter of cut.counters) assert.ok(counter.seq >= Math.max(0, ...(cut.rows[counter.name] ?? []).map((row) => row['(rowid)'])), `${what}: the counter of ${counter.name} is not behind its rows`);
    for (const [table, rows] of Object.entries(before.rows)) {
      assert.ok(cut.rows[table], `${what}: the table ${table} is there`);
      // The only rows that may appear in a table from before are the ones the finished upgrade leaves there: its
      // "this was done" settings, and the note of whose number is still to be filed for looking up.
      for (const row of appeared(cut.rows[table], rows)) assert.deepEqual(row, finished.rows[table].find((x) => x['(rowid)'] === row['(rowid)']), `${what}: a row that has appeared in ${table}`);
      for (const row of rows) {
        const now = sameRow(cut.rows[table], row, `${what}: ${table} ${row['(rowid)']}`);
        const then = sameRow(finished.rows[table], row, `the finished upgrade: ${table} ${row['(rowid)']}`);
        for (const [column, value] of Object.entries(row)) {
          if (JSON.stringify(now[column]) !== JSON.stringify(value)) assert.deepEqual(now[column], then[column], `${what}: ${table} ${row['(rowid)']}.${column}`);
        }
      }
    }
    // Every index and trigger there was is there, as it was written: none is ever left out by a start that was cut off.
    for (const m of before.master.filter((x) => x.type !== 'table')) assert.equal(cut.master.find((x) => x.name === m.name)?.sql, m.sql, `${what}: ${m.type} ${m.name}`);
    start(NOW, copy);
    assertSame(snapshot(copy), finished, `${what}, after the next start`);
    fs.rmSync(copy, { recursive: true, force: true });
  }
  return cuts;
}

forEachBefore('cut off before each step of the upgrade in turn, nothing is ever lost or renumbered, and the next start finishes the job', (release) => {
  const cuts = cutOffAtEveryStep(databaseFromBefore(release, 'pool-every-step'), 'pool-every-step');
  // The two tables are rebuilt in nine steps each, and there is more besides: fewer cuts than that would mean the
  // upgrade was not being stopped where it does its work.
  assert.ok(cuts >= 20, `${cuts} cuts`);
});

forEachBefore('the same for a database that began at the first release', (release) => {
  const cuts = cutOffAtEveryStep(beganAtFirstRelease(release, 'pool-every-step-first'), 'pool-every-step-first');
  assert.ok(cuts >= 20, `${cuts} cuts`);
});


// ---------- straight from the first release ----------
// A database the first release made and nothing since has opened. The live database has been opened by every
// release, so this is not its case; it is here because today's code is also every earlier upgrade, and each of them
// has to survive being cut off as well. The first release's database code is kept word for word, like the others.
const FIRST = { name: 'the first release (3013785)', folder: 'first-release', commit: '3013785bdd76f6e223185e286d6386179ef7fe32', code: path.join(HERE, 'fixtures', 'first-release', 'db.js') };

/** People, jobs and history as the first release stored them, with rows removed again so that the ids have gaps. */
function fillFirstRelease(dataDir) {
  const db = open(dataDir);
  const run = (sql, ...p) => db.prepare(sql).run(...p);
  db.exec('BEGIN');
  run(`INSERT INTO settings (key, value) VALUES ('agency_name', 'Harbour Talent')`);
  run(`INSERT INTO clients (name, slug, engagement_model, monthly_retainer, fee_percent, created_at) VALUES ('Maple Freight', 'maple-freight', 'hybrid', 6500, 12.5, ?), ('Northline Dental', 'northline-dental', 'retainer', 4800, 0, ?)`, at('01-05'), at('01-05'));
  for (const [email, name, role, clientId] of [['alex@agency.example', 'Alex Morgan', 'admin', null], ['dana@agency.example', 'Dana Recruiter', 'recruiter', null], ['maya@maple.example', 'Maya Okonkwo', 'client', 1], ['gone@example.com', 'Gone Person', 'client', 2]]) {
    run('INSERT INTO users (email, password_hash, name, role, client_id, created_at) VALUES (?, ?, ?, ?, ?, ?)', email, 'salt:hash', name, role, clientId, at('01-06'));
  }
  run(`INSERT INTO sessions (token, user_id, expires_at) VALUES ('aaaa', 1, '2099-01-01T00:00:00.000Z')`);
  run(`INSERT INTO jobs (client_id, title, status, hiring_manager_id, created_by, created_at, opened_at) VALUES (1, 'Senior Accountant', 'open', 3, 2, ?, ?), (2, 'Hygienist', 'open', NULL, 1, ?, ?)`, at('02-01'), at('02-02'), at('02-01'), at('02-02'));
  for (let jobId = 1; jobId <= 2; jobId++) {
    ['Applied', 'Recruiter screen', 'Interview', 'Offer', 'Hired'].forEach((name, i) =>
      run('INSERT INTO stages (job_id, name, kind, position) VALUES (?, ?, ?, ?)', jobId, name, ['applied', 'interview', 'interview', 'offer', 'hired'][i], i));
  }
  const stage = (jobId, position) => (jobId - 1) * 5 + position + 1;
  for (const [clientId, name, email, linkedin] of [[1, 'Kevin Tremblay', 'kevin.tremblay@example.com', 'https://www.linkedin.com/in/kevin-tremblay'], [1, 'Aïsha Khan', 'aisha@example.com', 'http://ca.linkedin.com/in/Aisha-Khan-1/?utm_source=share'],
    [1, 'Removed Midway', 'midway@example.com', null], [2, "Zoë O'Brien-Smith", 'zoe@example.org', null], [2, 'Removed Last', 'last@example.com', null]]) {
    run('INSERT INTO candidates (client_id, name, email, linkedin, created_at) VALUES (?, ?, ?, ?, ?)', clientId, name, email, linkedin, at('03-01'));
  }
  for (const [candidateId, jobId, position, status, source] of [[1, 1, 2, 'active', 'agency_sourced'], [2, 1, 3, 'active', 'linkedin'], [3, 1, 0, 'active', 'agency_sourced'], [4, 2, 4, 'hired', 'careers_page'], [5, 2, 1, 'active', 'referral']]) {
    run(`INSERT INTO applications (candidate_id, job_id, stage_id, status, source, resume_file, resume_name, applied_at, stage_entered_at, updated_at, hired_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      candidateId, jobId, stage(jobId, position), status, source, candidateId === 1 ? 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.pdf' : null, candidateId === 1 ? 'CV (final) v2.pdf' : null, at('03-02'), at('03-20'), at('04-01'), status === 'hired' ? at('05-01') : null);
  }
  for (const [appId, stageId, when] of [[1, stage(1, 0), '03-02'], [1, stage(1, 1), '03-10'], [1, stage(1, 2), '03-20'], [2, stage(1, 3), '03-20'], [4, stage(2, 4), '05-01'], [5, stage(2, 1), '03-20']]) {
    run('INSERT INTO stage_history (application_id, stage_id, entered_at) VALUES (?, ?, ?)', appId, stageId, at(when));
  }
  for (const [appId, userId, body, isPrivate] of [[1, 2, 'Looking for 95,000.', 1], [3, 2, 'To be removed (middle of the table)', 0], [1, 3, 'Met him at the open day.', 0], [5, 2, 'To be removed (end of the table)', 1]]) {
    run('INSERT INTO notes (application_id, user_id, body, private, created_at) VALUES (?, ?, ?, ?, ?)', appId, userId, body, isPrivate, at('04-01'));
  }
  // History as the first release wrote it: every stage move 'stage', a booked interview an 'interview' line.
  for (const [appId, userId, type, detail, when] of [[1, 2, 'added', 'Added to the pipeline (agency sourced)', '03-02'], [1, 2, 'stage', 'Moved to Recruiter screen', '03-10'], [1, 2, 'interview', 'Scheduled Recruiter screen', '03-11'],
    [1, 2, 'stage', 'Moved to Interview', '03-20'], [1, 3, 'review', 'Approved for interview', '03-21'], [2, 3, 'added', 'Added to the pipeline (linkedin)', '03-02'], [2, 2, 'stage', 'Moved to Offer', '03-20'],
    [3, 1, 'added', 'Added to the pipeline (agency sourced)', '03-02'], [4, null, 'applied', 'Applied via careers page', '03-02'], [4, 1, 'hired', 'Marked as hired', '05-01'], [5, 2, 'added', 'Added to the pipeline (referral)', '03-02']]) {
    run('INSERT INTO activities (application_id, user_id, type, detail, created_at) VALUES (?, ?, ?, ?, ?)', appId, userId, type, detail, at(when));
  }
  run(`INSERT INTO interviews (application_id, title, kind, starts_at, status, created_by, created_at) VALUES (1, 'Recruiter screen', 'phone', ?, 'completed', 2, ?), (5, 'Goes with its candidate', 'video', ?, 'scheduled', 2, ?)`,
    at('03-12', '14:00:00'), at('03-11'), at('04-26', '10:30:00'), at('03-15'));
  run('INSERT INTO interview_panel (interview_id, user_id) VALUES (1, 2), (1, 3), (2, 2)');
  run(`INSERT INTO scorecards (interview_id, user_id, recommendation, ratings, notes, submitted_at) VALUES (1, 2, 'strong_yes', '{"Skills":4}', 'Clear and specific.', ?)`, at('03-12'));
  run(`INSERT INTO offers (application_id, salary, start_date, status, created_at, updated_at) VALUES (2, 91000, NULL, 'draft', ?, ?)`, at('04-29'), at('04-29'));
  run(`INSERT INTO emails (application_id, to_email, subject, body, sent_by, delivery, created_at) VALUES (1, 'kevin.tremblay@example.com', 'Interview for Senior Accountant', 'Hi Kevin', 2, 'sent', ?)`, at('03-11'));
  run('DELETE FROM notes WHERE id = 2');
  run('DELETE FROM users WHERE id = 4');
  run('DELETE FROM candidates WHERE id IN (3, 5)'); // their applications (3 and 5) go with them, and what hung off those
  db.exec('COMMIT');
  db.close();
}
function databaseFromFirstRelease(name) {
  const dataDir = newDir(name);
  start(FIRST.code, dataDir);
  fillFirstRelease(dataDir);
  start(FIRST.code, dataDir);
  return dataDir;
}

test('the first release\'s database code kept here is the code that was released', (t) => {
  let released;
  try { released = execFileSync('git', ['show', `${FIRST.commit}:server/db.js`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return t.skip('the first release is not in this copy of the repository'); }
  assert.equal(fs.readFileSync(FIRST.code, 'utf8'), released);
});

test('a database straight from the first release keeps every row under its id, and ends up as it would have by way of every release since', () => {
  const dataDir = databaseFromFirstRelease('pool-from-first');
  const before = snapshot(dataDir);
  assert.deepEqual(before.counters, [], 'the first release kept no id counters');
  assert.deepEqual([before.rows.candidates.map((c) => c.id), before.rows.applications.map((a) => a.id), before.rows.notes.map((n) => n.id), before.rows.users.map((u) => u.id)], [[1, 2, 4], [1, 2, 4], [1, 3], [1, 2, 3]]);

  // By way of the three releases kept here, as the live database went; and straight to today's code.
  const byWay = copyOf(dataDir, 'pool-from-first-by-way');
  start(OLDER.code, byWay);
  start(NEWER.code, byWay);
  start(LIVE.code, byWay);
  start(NOW, byWay);
  start(NOW, dataDir);
  const straight = snapshot(dataDir);
  // The releases in between had phone calls and the calendar, and left their empty tables and columns behind;
  // a database that never met them has none. Everything else is the same.
  assert.deepEqual(straight.master.filter((m) => LEFT_BEHIND.master.includes(`${m.type} ${m.name}`)), []);
  assertSame(withoutLeftBehind(straight), withoutLeftBehind(snapshot(byWay)), 'straight to today\'s code, against by way of the releases in between');

  // Nothing lost or renumbered, and nothing changed but what those releases change on purpose.
  for (const [table, rows] of Object.entries(before.rows)) {
    const extra = straight.rows[table].slice(rows.length);
    assert.ok(!extra.length || table === 'settings', `no rows have appeared in ${table}`);
    assert.deepEqual(straight.rows[table].slice(0, rows.length).map((row) => row['(rowid)']), rows.map((row) => row['(rowid)']), `the ids of ${table}`);
    rows.forEach((row, i) => {
      for (const [column, value] of Object.entries(row)) {
        if ((table === 'activities' && column === 'type') || (table === 'candidates' && column === 'linkedin')) continue; // both looked at below
        assert.deepEqual(straight.rows[table][i][column], value, `${table} ${row['(rowid)']}.${column}`);
      }
    });
  }
  assert.deepEqual(straight.rows.activities.map((a) => [a.id, a.type]), [[1, 'added'], [2, 'stage_interview'], [3, 'interview_booked'], [4, 'stage_interview'], [5, 'review'], [6, 'added'], [7, 'stage_offer'], [9, 'applied'], [10, 'hired']]);
  assert.deepEqual(straight.rows.candidates.map((c) => c.linkedin), ['https://www.linkedin.com/in/kevin-tremblay', 'https://www.linkedin.com/in/aisha-khan-1', null]);
  // Each candidate belongs to the recruiter who added them, where the history says who that was (not a client's user).
  assert.deepEqual(straight.rows.applications.map((a) => [a.id, a.owner_id, a.general_until]), [[1, 2, null], [2, null, null], [4, null, null]]);
  // Ids are never reused from here on: each counter starts at the highest id in use.
  assert.deepEqual(Object.fromEntries(straight.counters.map((c) => [c.name, c.seq])), { applications: 4, candidates: 4, interviews: 1, notes: 3, users: 3 });
  for (const [table, column] of [['candidates', 'client_id'], ['applications', 'job_id'], ['applications', 'stage_id']]) assert.equal(straight.columns[table].find((c) => c.name === column).notnull, 0, `${table}.${column}`);
  start(NOW, dataDir);
  assertSame(snapshot(dataDir), straight, 'after a second start');
});

test('cut off before each step of every upgrade since the first release in turn, nothing is ever lost or renumbered, and the next start finishes the job', () => {
  const dataDir = databaseFromFirstRelease('pool-first-every-step');
  const whole = copyOf(dataDir, 'pool-first-every-step-whole');
  start(NOW, whole);
  const cuts = cutOffAtEveryStep(dataDir, 'pool-first-every-step', snapshot(whole));
  assert.ok(cuts >= 60, `${cuts} cuts`);
});
