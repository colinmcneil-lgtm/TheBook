// Phone calls and the calendar were taken out of The Book. These tests show what that left behind: nothing a user
// can reach, and nothing lost from a database that was in use before. Run with `npm test`.
//
// The "before" database is built from test/fixtures/accounts-schema.sql (the schema as the earlier code made it),
// with invented rows in the old tables. The real server is then started on it.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { startServer, session, tempDir, FIXTURES } from './oracle-helpers.mjs';
import { PORTS, look } from './metaview-helpers.mjs';

const OLD_TABLES = ['phone_calls', 'phone_webhooks', 'phone_recordings_owed', 'phone_calls_erased', 'calendar_links', 'calendar_events'];
const OLD_USER_COLUMNS = ['phone', 'phone_pin_hash', 'phone_pin_fails', 'phone_locked_until', 'phone_lock_level', 'phone_pin_wrong', 'phone_pin_wrong_since'];
const OLD_CALL_COLUMNS = ['direction', 'phone_number', 'speaker_roles', 'audio_channels', 'voicemail', 'notified_at', 'event_key', 'transcribe_tries', 'transcribe_next_at', 'notify_tries', 'notify_next_at'];
// Every route the two features had, as (method, path). Signed in, each must now be just another address that does not exist.
const GONE = [
  ['GET', '/phone/status'], ['GET', '/phone/calls'], ['POST', '/phone/calls'], ['GET', '/phone/calls/1'], ['POST', '/phone/calls/1/hangup'], ['GET', '/phone/current'],
  ['PUT', '/me/phone'], ['DELETE', '/me/phone'], ['PUT', '/me/phone/pin'], ['POST', '/phone/hooks/voice'], ['POST', '/phone/hooks/status'], ['POST', '/phone/hooks/recording'],
  ['GET', '/calendar'], ['GET', '/calendar/day'], ['GET', '/calendar/status'], ['PUT', '/calendar/link'], ['DELETE', '/calendar/link'], ['POST', '/calendar/events/abc/add'],
  ['PUT', '/calendar/events/abc'], ['POST', '/calendar/refresh'],
];

const T = '2026-10-20T15:00:00.000Z';
const hash = (password) => { const salt = crypto.randomBytes(16).toString('hex'); return `${salt}:${crypto.scryptSync(password, salt, 32).toString('hex')}`; };
const TURNS = JSON.stringify([{ speaker: 0, start: 0.5, end: 4, text: 'Hello, is now a good time?' }, { speaker: 1, start: 4.5, end: 7, text: 'Yes, go ahead.' }]);

/** A database as the earlier version left it, with people, calls and rows in every table the removed features had. */
function oldDatabase(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, 'app.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(fs.readFileSync(path.join(FIXTURES, 'accounts-schema.sql'), 'utf8'));
  const run = (sql, ...values) => db.prepare(sql).run(...values);
  for (const [key, value] of [['agency_name', 'Harbour Talent'], ['links_normalised', '1'], ['activity_types_v2', '1']]) run('INSERT INTO settings (key, value) VALUES (?, ?)', key, value);
  run(`INSERT INTO clients (id, name, slug, created_at) VALUES (1, 'Kestrel Logistics', 'kestrel-logistics', ?)`, T);
  run(`INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (1, 'alex@agency.example', ?, 'Alex Morgan', 'admin', ?)`, hash('demo1234'), T);
  run(`INSERT INTO users (id, email, password_hash, name, role, created_at, phone, phone_pin_hash, phone_lock_level) VALUES (2, 'priya@agency.example', ?, 'Priya Nair', 'recruiter', ?, '+16475550142', 'pin-hash', 1)`, hash('demo1234'), T);
  run(`INSERT INTO users (id, email, password_hash, name, role, client_id, created_at) VALUES (3, 'maya@kestrel.example', ?, 'Maya Okonkwo', 'client', 1, ?)`, hash('demo1234'), T);
  run(`INSERT INTO jobs (id, client_id, title, status, created_at) VALUES (1, 1, 'Head of Sales', 'open', ?)`, T);
  run(`INSERT INTO stages (id, job_id, name, kind, position) VALUES (1, 1, 'Applied', 'applied', 0), (2, 1, 'Recruiter screen', 'interview', 1)`);
  run(`INSERT INTO candidates (id, client_id, name, email, phone, created_at) VALUES (1, 1, 'Dana Whitlock', 'dana@mail.example', '(416) 555-0101', ?), (2, 1, 'Jonas Brandt', 'jonas@mail.example', NULL, ?)`, T, T);
  run(`INSERT INTO candidate_name_keys (candidate_id, first, last) VALUES (1, 'dana', 'whitlock')`);
  for (const id of [1, 2]) run(`INSERT INTO applications (id, candidate_id, job_id, stage_id, applied_at, stage_entered_at, updated_at, owner_id) VALUES (?, ?, 1, 1, ?, ?, ?, 2)`, id, id, T, T, T);
  // Three calls in The Oracle: one recorded in the browser, one phone call with everything a phone call carried,
  // and one phone call that was waiting to be transcribed again when the server last stopped.
  const call = (id, source, status, extra = {}) => {
    const row = { id, recording_id: crypto.randomBytes(16).toString('hex'), title: `Call ${id}`, status, source, created_by: 2, created_at: T, updated_at: T, ...extra };
    run(`INSERT INTO calls (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`, ...Object.values(row));
  };
  call(1, 'recorded', 'ready', { transcript: TURNS, transcript_source: 'deepgram', application_id: 2, candidate_id: 2, duration_ms: 7000, consent_by: 2, consent_at: T, consent_wording: 'Everyone agreed.' });
  call(2, 'phone', 'ready', { transcript: TURNS, transcript_source: 'deepgram', speakers: '{"0":"Priya Nair","1":"Dana Whitlock"}', notes: 'Dana is open to a move.', notes_at: T, application_id: 1, candidate_id: 1,
    duration_ms: 180000, direction: 'outbound', phone_number: '+14165550101', speaker_roles: '{"0":"recruiter","1":"candidate"}', audio_channels: 2, voicemail: 0, notified_at: T, event_key: 'event-key-1', consent_at: T,
    consent_wording: 'The Book played this notice to Dana Whitlock when they answered.' });
  call(3, 'phone', 'transcribing', { direction: 'inbound', phone_number: '+14165550101', audio_channels: 2, transcribe_tries: 2, transcribe_next_at: '2099-01-01T00:00:00.000Z' });
  run(`INSERT INTO activities (application_id, user_id, type, detail, created_at) VALUES (1, 2, 'call', 'Phone call, 3 min', ?)`, T);
  // The list of phone calls: one with a recording still at the phone service, one that was never recorded.
  run(`INSERT INTO phone_calls (id, user_id, direction, status, outcome, to_number, user_number, candidate_id, application_id, record, call_sid, recording_state, recording_sid, call_id, call_made, title, started_at, updated_at)
       VALUES (1, 2, 'outbound', 'ended', 'completed', '+14165550101', '+16475550142', 1, 1, 1, 'call-sid-1', 'stored', 'recording-sid-1', 2, 1, NULL, ?, ?)`, T, T);
  run(`INSERT INTO phone_calls (id, user_id, direction, status, outcome, to_number, candidate_id, record, call_sid, event_key, started_at, updated_at) VALUES (2, 2, 'outbound', 'ended', 'busy', '+14165550101', 1, 0, 'call-sid-2', 'event-key-1', ?, ?)`, T, T);
  run(`INSERT INTO phone_webhooks (phone_call_id, kind, params, received_at) VALUES (1, 'status', '{"CallStatus":"completed"}', ?)`, T);
  run(`INSERT INTO phone_recordings_owed (recording_sid, noted_at) VALUES ('recording-sid-0', ?)`, T);
  run(`INSERT INTO phone_calls_erased (call_sid, noted_at) VALUES ('call-sid-0', ?)`, T);
  // A saved calendar link, and two events one of them recorded.
  run(`INSERT INTO calendar_links (user_id, provider, link_sealed, tz, created_at) VALUES (2, 'google', 'v1.sealed.link.value', 'America/Toronto', ?)`, T);
  run(`INSERT INTO calendar_events (user_id, event_key, source, day, tz, added, application_id, call_id, seen_at, series) VALUES (2, 'event-key-1', 'calendar', '2026-10-20', 'America/Toronto', 1, 1, 2, ?, 'series-1')`, T);
  run(`INSERT INTO calendar_events (user_id, event_key, source, day, tz, seen_at) VALUES (2, 'event-key-2', 'calendar', '2026-10-21', 'America/Toronto', ?)`, T);
  db.close();
}

const objects = (all) => Object.fromEntries(all(`SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'`).map((o) => [o.name, o.sql]));
const counts = (all) => Object.fromEntries(OLD_TABLES.map((table) => [table, all(`SELECT COUNT(*) AS n FROM ${table}`)[0].n]));

let oldDir, newDir, server, alex, schemaBefore;

before(async () => {
  oldDir = tempDir('old-database');
  oldDatabase(oldDir);
  schemaBefore = look(oldDir, objects);
  server = await startServer({ port: PORTS.legacy, dataDir: oldDir });
  alex = session(server.base);
  assert.equal((await alex.post('/login', { email: 'alex@agency.example', password: 'demo1234' })).status, 200);
});
after(async () => {
  await server?.stop();
  for (const dir of [oldDir, newDir]) if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test('the app starts on a database that still has the old tables, and nothing in them is touched', () => {
  look(oldDir, (all) => {
    assert.deepEqual(counts(all), { phone_calls: 2, phone_webhooks: 1, phone_recordings_owed: 1, phone_calls_erased: 1, calendar_links: 1, calendar_events: 2 });
    // Every table, index and trigger that was there is still there, exactly as it was written.
    const now = objects(all);
    for (const [name, sql] of Object.entries(schemaBefore)) if (name !== 'calls') assert.equal(now[name], sql, `${name} was changed or dropped`);
    // The calls table only gained columns: every column it had is still there, with what was in it.
    const columns = all('PRAGMA table_info(calls)').map((c) => c.name);
    for (const column of OLD_CALL_COLUMNS) assert.ok(columns.includes(column), `calls.${column} was dropped`);
    assert.deepEqual(all('SELECT direction, phone_number, audio_channels, event_key, transcribe_tries FROM calls WHERE id = 2'),
      [{ direction: 'outbound', phone_number: '+14165550101', audio_channels: 2, event_key: 'event-key-1', transcribe_tries: 0 }]);
    assert.deepEqual(all('SELECT phone, phone_pin_hash, phone_lock_level FROM users WHERE id = 2'), [{ phone: '+16475550142', phone_pin_hash: 'pin-hash', phone_lock_level: 1 }]);
    assert.deepEqual(all('SELECT link_sealed, tz FROM calendar_links'), [{ link_sealed: 'v1.sealed.link.value', tz: 'America/Toronto' }]);
    // Candidates who were on file before are noted to have their numbers filed for looking up, the way names already were.
    assert.deepEqual(all('SELECT candidate_id FROM candidate_name_dirty ORDER BY candidate_id').map((r) => r.candidate_id), [1, 2]);
    assert.deepEqual(all('SELECT * FROM candidate_phone_keys'), []);
  });
});

test('calls that were already in The Oracle still list and open, whatever they came from', async () => {
  const list = (await alex.get('/oracle/calls')).body;
  assert.deepEqual(list.map((c) => [c.id, c.source, c.status]).sort(), [[1, 'recorded', 'ready'], [2, 'phone', 'ready'], [3, 'phone', 'uploaded']]);
  // An old phone call counts as a call made in The Book, so it is on that list and not on Metaview's.
  assert.deepEqual((await alex.get('/oracle/calls?source=book')).body.length, 3);
  assert.deepEqual((await alex.get('/oracle/calls?source=metaview')).body, []);
  const phone = (await alex.get('/oracle/calls/2')).body;
  assert.equal(phone.call.transcript.length, 2);
  assert.deepEqual(phone.call.speakers, { 0: 'Priya Nair', 1: 'Dana Whitlock' });
  assert.equal(phone.call.notes, 'Dana is open to a move.');
  assert.equal(phone.candidate.name, 'Dana Whitlock');
  assert.equal(phone.call.external_url, null);
  // Nothing about the phone is in the answer any more.
  for (const field of ['direction', 'phone_display', 'phone_number', 'voicemail', 'event_key']) assert.equal(field in phone.call, false, field);
  // A phone call that was waiting for another go at transcription is simply a call with no transcript now.
  const waiting = (await alex.get('/oracle/calls/3')).body.call;
  assert.equal(waiting.status, 'uploaded');
  assert.equal(waiting.has_audio, false);
  // Old history lines stay readable.
  const history = (await alex.get('/applications/1')).body.activities.map((a) => a.detail);
  assert.ok(history.includes('Phone call, 3 min'));
  // And such a call can still be worked on: renamed, moved, its notes edited.
  assert.equal((await alex.patch('/oracle/calls/2', { title: 'Call with Dana', notes: 'Dana is open to a move, from March.' })).status, 200);
});

test('every route of the removed features answers like an address that never existed', async () => {
  const cookie = alex.cookie();
  const unknown = await fetch(`${server.base}/api/no/such/route`, { headers: { Cookie: cookie } });
  assert.equal(unknown.status, 404);
  const wording = await unknown.json();
  for (const [method, pathname] of GONE) {
    const res = await fetch(`${server.base}/api${pathname}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : '{}' });
    assert.equal(res.status, 404, `${method} ${pathname}`);
    assert.deepEqual(await res.json(), wording, `${method} ${pathname}`);
  }
  // The phone service's own routes took no sign-in. Now they are behind it like everything else.
  const hook = await fetch(`${server.base}/api/phone/hooks/voice`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'CallSid=x' });
  assert.equal(hook.status, 401);
  // What The Oracle says about itself no longer mentions either.
  assert.deepEqual(Object.keys((await alex.get('/oracle/status')).body).sort(), ['ai', 'maxRecordingMinutes', 'maxUploadMb', 'transcription']);
  // A recording that still names a calendar event is started as an ordinary one.
  const started = await alex.post('/oracle/recordings', { mimeType: 'audio/webm', consent: { confirmed: true, wording: 'Everyone agreed.' }, event_key: 'event-key-2' });
  assert.equal(started.status, 201);
  look(oldDir, (all) => assert.deepEqual(all('SELECT event_key FROM calls WHERE id = ?', started.body.call_id), [{ event_key: null }]));
});

test('everyday work goes on in the old database: people are added, deactivated and deleted', async () => {
  // Adding somebody (the old trigger that notes new names is still there, and still works).
  const added = await alex.upload('/applications', { job_id: 1, name: 'Amara Adeyemi', email: 'amara@mail.example' });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  // Deactivating someone used to clear their saved mobile. Now it leaves it alone, and does not trip over it.
  assert.equal((await alex.patch('/users/2', { active: false })).status, 200);
  look(oldDir, (all) => assert.deepEqual(all('SELECT phone, active FROM users WHERE id = 2'), [{ phone: '+16475550142', active: 0 }]));
  // Deleting a candidate deletes their calls, and the database's own rules for the old phone tables still run:
  // the calls made to them go, and the recording still at the phone service is noted.
  assert.equal((await alex.del('/candidates/1')).status, 200);
  assert.equal((await alex.get('/oracle/calls/2')).status, 404);
  look(oldDir, (all) => {
    assert.deepEqual(counts(all), { phone_calls: 0, phone_webhooks: 0, phone_recordings_owed: 2, phone_calls_erased: 1, calendar_links: 1, calendar_events: 2 });
    assert.deepEqual(all(`SELECT call_id, application_id FROM calendar_events WHERE event_key = 'event-key-1'`), [{ call_id: null, application_id: null }]);
  });
  // The other candidate and their call are as they were.
  assert.equal((await alex.get('/oracle/calls/1')).body.candidate.name, 'Jonas Brandt');
  // Metaview is simply not connected yet.
  const status = (await alex.get('/metaview/status')).body;
  assert.equal(status.connected, false);
  assert.equal(status.known, 0);
});

/** Run the script that clears what the removed features left, on a data folder. Resolves to what it printed. */
function forgetRemoved(dataDir, ...args) {
  const ran = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/forget-removed.js', ...args],
    { cwd: path.resolve(import.meta.dirname, '..'), env: { PATH: process.env.PATH, DATA_DIR: dataDir }, encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
  return ran.stdout;
}

test('what people saved for the removed features is only ever cleared by hand, with the one script for it', async () => {
  const before = look(oldDir, (all) => ({ schema: objects(all), counts: counts(all), calls: all('SELECT id, source, phone_number, event_key FROM calls ORDER BY id') }));
  // Asked without "--yes" it says what is there and changes nothing. The app is running all the while.
  const dry = forgetRemoved(oldDir);
  assert.match(dry, /1 saved calendar links/);
  assert.match(dry, /2 remembered calendar events/);
  assert.match(dry, /1 saved mobile numbers/);
  assert.match(dry, /1 phone PINs/);
  assert.match(dry, /Nothing was changed/);
  look(oldDir, (all) => {
    assert.deepEqual(counts(all), before.counts);
    assert.deepEqual(all('SELECT phone, phone_pin_hash, phone_lock_level FROM users WHERE id = 2'), [{ phone: '+16475550142', phone_pin_hash: 'pin-hash', phone_lock_level: 1 }]);
  });
  // With "--yes" the calendar links, the remembered events, the mobile numbers and the PINs go. Nothing else does.
  assert.match(forgetRemoved(oldDir, '--yes'), /Cleared from this database/);
  look(oldDir, (all) => {
    assert.deepEqual(counts(all), { ...before.counts, calendar_links: 0, calendar_events: 0 });
    assert.deepEqual(all('SELECT phone, phone_pin_hash, phone_pin_fails, phone_locked_until, phone_lock_level FROM users ORDER BY id'),
      [1, 2, 3].map(() => ({ phone: null, phone_pin_hash: null, phone_pin_fails: 0, phone_locked_until: null, phone_lock_level: 0 })));
    assert.deepEqual(objects(all), before.schema, 'no table, column, index or trigger was dropped');
    assert.deepEqual(all('SELECT id, source, phone_number, event_key FROM calls ORDER BY id'), before.calls, 'calls in The Oracle are not its business');
  });
  // The sealed link is not left readable in the files either.
  for (const name of fs.readdirSync(oldDir)) {
    const at = path.join(oldDir, name);
    if (fs.statSync(at).isFile()) assert.equal(fs.readFileSync(at).includes('v1.sealed.link.value'), false, name);
  }
  // The app did not notice, and a second run finds nothing.
  assert.equal((await alex.get('/oracle/calls/1')).status, 200);
  assert.match(forgetRemoved(oldDir, '--yes'), /Nothing is left/);
  // Pointed at a folder with no database, it says so and makes nothing.
  const empty = tempDir('no-database');
  const missed = spawnSync(process.execPath, ['server/forget-removed.js', '--yes'], { cwd: path.resolve(import.meta.dirname, '..'), env: { PATH: process.env.PATH, DATA_DIR: empty }, encoding: 'utf8' });
  assert.equal(missed.status, 1);
  assert.match(missed.stderr, /There is no database/);
  assert.deepEqual(fs.readdirSync(empty), []);
  fs.rmSync(empty, { recursive: true, force: true });
});

test('a database made today has nothing of the removed features in it', async () => {
  await server.stop();
  server = null;
  newDir = tempDir('new-database');
  server = await startServer({ port: PORTS.legacy, dataDir: newDir });
  assert.match(forgetRemoved(newDir, '--yes'), /Nothing is left/);
  look(newDir, (all) => {
    const tables = all(`SELECT name FROM sqlite_master WHERE type IN ('table', 'trigger', 'index')`).map((t) => t.name);
    // (A candidate's own phone number is still looked up, which is what the names with "candidate_phone" in them are for.)
    for (const name of tables) assert.equal(/phone_|calendar/.test(name.replace('candidate_phone_', '')), false, `${name} is still made`);
    const users = all('PRAGMA table_info(users)').map((c) => c.name), calls = all('PRAGMA table_info(calls)').map((c) => c.name);
    for (const column of OLD_USER_COLUMNS) assert.equal(users.includes(column), false, `users.${column}`);
    for (const column of OLD_CALL_COLUMNS) assert.equal(calls.includes(column), false, `calls.${column}`);
    // What matching a conversation to a candidate needs is made, and so is what Metaview needs.
    for (const name of ['candidate_name_keys', 'candidate_phone_keys', 'candidate_name_dirty', 'candidate_name_added', 'candidate_phone_changed', 'idx_candidates_email_lower', 'idx_candidate_phone_keys_tail',
      'metaview_calls', 'metaview_people', 'metaview_forgotten']) assert.ok(tables.includes(name), name);
  });
  // And the app works on it from the first request.
  const owner = session(server.base);
  assert.equal((await owner.post('/setup', { agencyName: 'Harbour Talent', name: 'Alex Morgan', email: 'alex@agency.example', password: 'demo1234' })).status, 200);
  assert.deepEqual((await owner.get('/oracle/calls')).body, []);
});
