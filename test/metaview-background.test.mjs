// What Metaview in The Oracle does with nobody clicking: carrying on after a restart, bringing calls in by itself,
// and staying quick with a few years of conversations and a large workspace. Run with `npm test`.
//
// The real server each time, reading the stand-in for Metaview. The real Metaview is never called.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { until, tempDir, sleep } from './oracle-helpers.mjs';
import { metaviewStandIn, PEOPLE, SPECIAL } from './metaview-standin.mjs';
import { PORTS, startBook, workspace, connect, look } from './metaview-helpers.mjs';

const started = [];   // servers, stand-ins and folders to clear away, whatever a test did
after(async () => {
  for (const thing of started) await (typeof thing === 'string' ? fs.rmSync(thing, { recursive: true, force: true }) : thing.stop?.());
});
const keep = (thing) => { started.push(thing); return thing; };
const statusOf = async (who) => (await who.get('/metaview/status')).body;
const settled = (who) => until(() => statusOf(who), (s) => s.connected && !s.catching_up && !s.error, 30000);
const oracleCalls = async (who) => (await who.get('/oracle/calls?source=metaview')).body;
const history = async (who, applicationId) => (await who.get(`/applications/${applicationId}`)).body.activities.filter((a) => /call/i.test(a.detail));
/** Offsets of the pages of the list the stand-in was asked for, from request number `from` on. */
const pagesAsked = (standIn, from = 0) => standIn.requests.slice(from).filter((r) => r.tool === 'search_conversations' && !r.args.conversation_ids).map((r) => r.args.offset);

test('a restart carries on where the history stopped, and still fetches the notes that were owed', async () => {
  const standIn = keep(await metaviewStandIn(PORTS.standInRestart));
  const dataDir = keep(tempDir('metaview-restart'));
  // Slow enough to be stopped half-way: two seconds between pages, and notes not asked for again for a while.
  const slow = { METAVIEW_PAGE_PAUSE_MS: '2000', METAVIEW_NOTES_PACE: '0.15', METAVIEW_POLL_MS: '60000' };
  let server = await startBook({ port: PORTS.restart, dataDir, standIn, env: slow });
  const w = await workspace(server.base);
  await w.owner.putJson('/metaview/settings', { auto: false });
  await connect(w.owner);
  // Two pages are in; the third has not been asked for yet. A call is opened, and its notes are still being written.
  await until(() => statusOf(w.owner), (s) => s.known === 100, 20000);
  const { call_id } = (await w.owner.post(`/metaview/calls/${standIn.at(0).id}/open`)).body;
  assert.equal((await w.owner.get(`/oracle/calls/${call_id}`)).body.call.notes_pending, true);
  assert.deepEqual(pagesAsked(standIn), [0, 50]);
  await server.stop('SIGKILL');   // the plug is pulled

  const from = standIn.requests.length;
  server = keep(await startBook({ port: PORTS.restart, dataDir, standIn, env: { ...slow, METAVIEW_PAGE_PAUSE_MS: '20' } }));
  const during = await statusOf(w.owner);
  assert.equal(during.connected, true);
  assert.equal(during.known, 100);
  assert.equal(during.catching_up, true);
  const done = await settled(w.owner);
  assert.equal(done.known, 130);
  // After the restart: one look at the top for anything new, then the one page that was still to come. Nothing read twice.
  assert.deepEqual(pagesAsked(standIn, from), [0, 100]);
  // The notes that were owed when the plug was pulled arrive too.
  const { call } = await until(async () => (await w.owner.get(`/oracle/calls/${call_id}`)).body, (d) => d.call.notes, 20000);
  assert.match(call.notes, /Next steps/);
  assert.equal(call.notes_pending, false);
  assert.equal(standIn.mostAtOnce, 1);
  await server.stop();
  await standIn.stop();   // the next tests use these ports again
});

test('with "auto" on, recent calls that an address or a number ties to one candidate are brought in by themselves', async () => {
  const standIn = keep(await metaviewStandIn(PORTS.standInAuto));
  const dataDir = keep(tempDir('metaview-auto'));
  const server = keep(await startBook({ port: PORTS.auto, dataDir, standIn }));
  const w = await workspace(server.base);
  const [dana, jonas, amara, , chloe, , grace, hugo] = PEOPLE;
  const on = {
    email: await w.candidate({ name: 'Dana T.', email: dana.email }),                                  // conversations 0 (today), 48 and 96 (weeks ago)
    phone: await w.candidate({ name: 'Jonas J.', email: 'jonas@elsewhere.example', phone: '647-555-0101' }), // 1, 49, 97
    other: await w.candidate({ name: 'Amara S.', email: amara.email, jobId: w.otherJob }),             // 2, 50, 98
    nameOnly: await w.candidate({ name: grace.name, email: 'grace@elsewhere.example' }),                // 6: the name is all that agrees
    twiceA: await w.candidate({ name: chloe.name, email: chloe.email }),                               // 4: on file twice, so not certain
    twiceB: await w.candidate({ name: chloe.name, email: chloe.email, jobId: w.elsewhere }),
    noTranscript: await w.candidate({ name: hugo.name, email: hugo.email }),                           // 7: Metaview has not written it out yet
  };
  assert.equal((await statusOf(w.owner)).auto, true, 'on unless somebody turns it off');
  await connect(w.owner);
  await settled(w.owner);
  // The three recent conversations that are certain, and only those.
  const brought = await until(() => oracleCalls(w.owner), (calls) => calls.length === 3, 20000);
  await sleep(900);   // several more looks at the list
  assert.equal((await statusOf(w.owner)).in_the_book, 3);
  const byUrl = Object.fromEntries(brought.map((call) => [call.external_url, call]));
  for (const [index, who, owner] of [[0, on.email, 'Priya Nair'], [1, on.phone, 'Sam Okoro'], [2, on.other, 'Alex Morgan']]) {
    const conv = standIn.at(index), call = byUrl[conv.url];
    assert.ok(call, `conversation ${index} was brought in`);
    assert.deepEqual([call.application_id, call.candidate_id, call.source, call.has_transcript], [who.application_id, who.candidate_id, 'metaview', true]);
    assert.equal(call.created_by_name, owner, 'it belongs to the interviewer who has a login here');
    // The candidate's history says so, once, in the name of the person whose call it is.
    assert.deepEqual((await history(w.owner, who.application_id)).map((a) => [a.detail, a.user_name]), [[`Metaview call, ${conv.minutes} min`, owner]]);
  }
  assert.equal(byUrl[standIn.at(2).url].job_title, 'Sales Manager', 'on the job that candidate is in for');
  // Their notes arrive without anyone opening them.
  await until(() => oracleCalls(w.owner), (calls) => calls.every((call) => call.has_notes), 20000);
  // Nothing older than two weeks, nothing matched by name alone, nothing on file twice, nothing without a transcript.
  const transcriptsAsked = new Set(standIn.toolCalls().filter((r) => r.args?.conversation_ids).map((r) => r.args.conversation_ids[0]));
  assert.deepEqual([...transcriptsAsked].sort(), [0, 1, 2].map((index) => standIn.at(index).id).sort(), 'no other conversation\'s transcript was ever fetched');
  const list = (await w.owner.get('/metaview/calls?limit=100')).body.calls;
  const of = (index) => list.find((call) => call.id === standIn.at(index).id);
  assert.deepEqual([of(48).match.how, of(48).call_id], ['email', null], 'matched, but too old to be brought in unasked');
  assert.deepEqual([of(6).match.how, of(6).call_id], ['name', null]);
  assert.deepEqual([of(4).match, of(4).suggestions.length, of(4).call_id], [null, 2, null]);
  assert.deepEqual([of(7).match.how, of(7).call_id], ['email', null]);

  // A new call with a known candidate is brought in as soon as it is seen.
  const fresh = standIn.add({ person: dana, minutesAgo: 2, minutes: 8 });
  await until(() => oracleCalls(w.owner), (calls) => calls.some((call) => call.external_url === fresh.url), 20000);
  // So is the one that had no transcript, once Metaview has written it out.
  standIn.at(SPECIAL.noTranscript[0]).has_transcript = true;
  await until(() => oracleCalls(w.owner), (calls) => calls.some((call) => call.external_url === standIn.at(7).url), 20000);
  // And one whose candidate is only added to The Book afterwards.
  const late = await w.candidate({ name: 'Kevin C.', email: PEOPLE[3].email, phone: PEOPLE[3].phone });
  const lateCall = (await until(() => oracleCalls(w.owner), (calls) => calls.some((call) => call.external_url === standIn.at(3).url), 20000)).find((call) => call.external_url === standIn.at(3).url);
  assert.equal(lateCall.candidate_id, late.candidate_id);
  assert.equal((await statusOf(w.owner)).in_the_book, 6);

  // A call somebody deleted is not brought back by itself.
  const gone = byUrl[standIn.at(1).url];
  assert.equal((await w.owner.del(`/oracle/calls/${gone.id}`)).status, 200);
  await sleep(1000);
  assert.equal((await oracleCalls(w.owner)).some((call) => call.external_url === standIn.at(1).url), false);
  assert.equal((await statusOf(w.owner)).in_the_book, 5);
  // A person can still open it.
  assert.equal((await w.sam.post(`/metaview/calls/${standIn.at(1).id}/open`)).status, 200);

  // With "auto" off nothing more comes in by itself; turned on again, what was waiting does.
  assert.equal((await w.owner.putJson('/metaview/settings', { auto: false })).body.auto, false);
  assert.equal((await w.owner.putJson('/metaview/settings', { auto: 'yes' })).status, 400);
  const waiting = standIn.add({ person: amara, minutesAgo: 1 });
  await until(async () => (await w.owner.get('/metaview/calls?limit=5')).body.calls, (calls) => calls.some((call) => call.id === waiting.id), 20000);
  await sleep(900);
  assert.equal((await oracleCalls(w.owner)).some((call) => call.external_url === waiting.url), false);
  assert.equal((await w.owner.putJson('/metaview/settings', { auto: true })).body.auto, true);
  await until(() => oracleCalls(w.owner), (calls) => calls.some((call) => call.external_url === waiting.url), 20000);
  // Only the two read-only tools were ever used, one request at a time.
  assert.ok(standIn.toolCalls().every((r) => ['get_user_context', 'search_conversations'].includes(r.tool)));
  assert.equal(standIn.mostAtOnce, 1);
});

test('no more than the daily limit is brought in unasked, and with "auto" off from the start nothing is', async () => {
  const shared = keep(await metaviewStandIn(PORTS.standInRestart));
  const people = async (w) => { for (const n of [0, 1, 2, 6, 8, 10]) await w.candidate({ name: `Person ${n}`, email: PEOPLE[n].email, phone: PEOPLE[n].phone }); };

  // A limit of two a day: six conversations are certain and recent, two come in, and it stays at two.
  const limitedDir = keep(tempDir('metaview-limit'));
  const limited = keep(await startBook({ port: PORTS.restart, dataDir: limitedDir, standIn: shared, env: { METAVIEW_AUTO_PER_DAY: '2' } }));
  const first = await workspace(limited.base);
  await people(first);
  await connect(first.owner);
  await settled(first.owner);
  await until(() => statusOf(first.owner), (s) => s.in_the_book === 2, 20000);
  await sleep(1200);
  assert.equal((await statusOf(first.owner)).in_the_book, 2);
  // The newest two.
  assert.deepEqual((await oracleCalls(first.owner)).map((call) => call.external_url), [0, 1].map((index) => shared.at(index).url));
  look(limitedDir, (all) => assert.equal(all('SELECT COUNT(*) AS n FROM metaview_calls WHERE auto_at IS NOT NULL')[0].n, 2));
  // Opening by hand is not held back by it.
  assert.equal((await first.owner.post(`/metaview/calls/${shared.at(2).id}/open`)).status, 200);
  await limited.stop();

  // "Auto" turned off before the key is entered: everything is listed and matched, nothing is brought in.
  const offDir = keep(tempDir('metaview-off'));
  const off = keep(await startBook({ port: PORTS.restart, dataDir: offDir, standIn: shared }));
  const second = await workspace(off.base);
  await people(second);
  await second.owner.putJson('/metaview/settings', { auto: false });
  await connect(second.owner);
  const done = await settled(second.owner);
  await sleep(900);
  assert.deepEqual([done.known, (await statusOf(second.owner)).in_the_book, done.auto], [130, 0, false]);
  assert.equal((await second.owner.get('/metaview/calls?limit=1')).body.calls[0].match.how, 'email');
});

test('the key can come from where The Book is hosted instead: it connects by itself and cannot be removed in the app', async () => {
  const standIn = keep(await metaviewStandIn(PORTS.standInLarge, { count: 20, keys: ['mv-key-from-the-host'] }));
  const dataDir = keep(tempDir('metaview-host'));
  const server = keep(await startBook({ port: PORTS.large, dataDir, standIn, env: { METAVIEW_API_KEY: 'mv-key-from-the-host' } }));
  const w = await workspace(server.base);
  const done = await settled(w.owner);
  assert.deepEqual([done.source, done.workspace, done.known], ['server', 'Harbour Talent Partners', 20]);
  // Twenty conversations fit on one page, so one look is the whole history.
  assert.deepEqual(pagesAsked(standIn).filter((offset) => offset > 0), []);
  const refused = await w.owner.del('/metaview/key');
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /METAVIEW_API_KEY/);
  assert.equal((await statusOf(w.owner)).connected, true);
  assert.equal(server.output().includes('mv-key-from-the-host'), false);
  // A key an admin enters takes over, and forgetting it hands back to the host's.
  standIn.keys.add('mv-key-typed-in');
  assert.equal((await w.owner.putJson('/metaview/key', { key: 'Bearer mv-key-typed-in' })).body.source, 'settings');
  assert.equal((await w.owner.del('/metaview/key')).status, 200);
  assert.equal((await settled(w.owner)).source, 'server');
  await server.stop();
  await standIn.stop();
});

test('the whole list is read again from time to time: what was deleted in Metaview leaves the list, a call in The Oracle stays', async () => {
  const standIn = keep(await metaviewStandIn(PORTS.standInLarge, { count: 60 }));
  const dataDir = keep(tempDir('metaview-again'));
  // "From time to time" is a week; here it is half a second.
  const server = keep(await startBook({ port: PORTS.large, dataDir, standIn, env: { METAVIEW_REWALK_MS: '500' } }));
  const w = await workspace(server.base);
  await w.owner.putJson('/metaview/settings', { auto: false });
  await connect(w.owner);
  assert.equal((await settled(w.owner)).known, 60);
  // Three old conversations, all beyond the newest page, so only a full reading can notice anything about them:
  // one is brought in and then deleted in Metaview, one is deleted there without ever being brought in, one is renamed.
  const broughtIn = standIn.at(55), deleted = standIn.at(57), renamed = standIn.at(59);
  const { call_id } = (await w.owner.post(`/metaview/calls/${broughtIn.id}/open`)).body;
  const from = standIn.requests.length;
  standIn.conversations.splice(standIn.conversations.indexOf(broughtIn), 1);
  standIn.conversations.splice(standIn.conversations.indexOf(deleted), 1);
  renamed.other.shown = 'Somebody Renamed';
  await until(() => statusOf(w.owner), (s) => s.known === 59, 20000);
  const list = (await w.owner.get('/metaview/calls?limit=100')).body.calls;
  assert.equal(list.some((call) => call.id === deleted.id), false, 'the one deleted in Metaview is forgotten');
  assert.equal(list.find((call) => call.id === broughtIn.id).call_id, call_id, 'the one that is a call in The Oracle stays listed');
  assert.equal((await w.owner.get(`/oracle/calls/${call_id}`)).status, 200);
  assert.equal(list.find((call) => call.id === renamed.id).people[0].name, 'Somebody Renamed');
  // It was read a page at a time like the first time, and before forgetting a conversation Metaview was asked for it by its number.
  assert.ok(pagesAsked(standIn, from).includes(50));
  assert.ok(standIn.requests.slice(from).some((r) => r.args?.conversation_ids?.includes(deleted.id) && !r.args.fields.includes('default:transcript')));
  assert.equal((await statusOf(w.owner)).catching_up, false);
  assert.equal(standIn.mostAtOnce, 1);
  await server.stop();
  await standIn.stop();
});

test('the lists stay quick with 3,000 conversations remembered and 20,000 candidates on file', async (t) => {
  const standIn = keep(await metaviewStandIn(PORTS.standInLarge, { count: 3000 }));
  const dataDir = keep(tempDir('metaview-large'));
  const server = keep(await startBook({ port: PORTS.large, dataDir, standIn, env: { METAVIEW_PAGE_PAUSE_MS: '1' } }));
  const w = await workspace(server.base);
  await w.owner.putJson('/metaview/settings', { auto: false });
  // 20,000 candidates, each in a job, written straight into the database (adding them one request at a time would
  // take minutes). The first 48 have the addresses of the stand-in's people; hundreds share each first name.
  const db = new DatabaseSync(path.join(dataDir, 'app.db'));
  db.exec('PRAGMA busy_timeout = 5000; BEGIN');
  const stage = db.prepare('SELECT id FROM stages WHERE job_id = ? ORDER BY position LIMIT 1').get(w.job).id;
  const addCandidate = db.prepare('INSERT INTO candidates (client_id, name, email, phone, created_at) VALUES (?, ?, ?, ?, ?)');
  const addApplication = db.prepare('INSERT INTO applications (candidate_id, job_id, stage_id, applied_at, stage_entered_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
  const at = new Date().toISOString();
  for (let n = 0; n < 20000; n++) {
    const known = PEOPLE[n];
    const name = known ? known.name : `${PEOPLE[n % 48].first} Invented${n}`;
    const id = addCandidate.run(w.clientId, name, known ? known.email : `person${n}@elsewhere.example`, known ? null : `+1 (289) 5${String(n).padStart(6, '0')}`, at).lastInsertRowid;
    addApplication.run(id, w.job, stage, at, at, at);
  }
  db.exec('COMMIT');
  db.close();
  const candidateId = look(dataDir, (all) => all('SELECT id FROM candidates WHERE email = ?', PEOPLE[0].email)[0].id);

  await connect(w.owner);
  const done = await until(() => statusOf(w.owner), (s) => !s.catching_up && !s.error, 60000);
  assert.equal(done.known, 3000);
  const timed = async (query) => {
    const from = performance.now();
    const answer = await w.priya.get(`/metaview/calls${query}`);
    assert.equal(answer.status, 200, query);
    return { ms: Math.round(performance.now() - from), body: answer.body };
  };
  await timed('');   // the first list also files the 20,000 names for looking up, once
  const results = {};
  for (const [name, query] of [['the first page', ''], ['a later page', '?offset=2900&limit=100'], ['a search', '?q=tremblay'], ['mine', '?who=mine'], ['not in The Book', '?show=new'],
    ['unmatched', '?show=unmatched'], ['one candidate', `?candidate_id=${candidateId}`]]) {
    results[name] = await timed(query);
    t.diagnostic(`${name}: ${results[name].ms} ms (${results[name].body.total} conversations)`);
    assert.ok(results[name].ms < 1500, `${name} took ${results[name].ms} ms`);
  }
  assert.equal(results['the first page'].body.total, 3000);
  assert.equal(results['the first page'].body.calls[0].match.how, 'email');
  // Every conversation whose person is on file under their address is matched; the ones Metaview has only a first
  // name or a number for are not, and are offered a handful of the hundreds who share that first name.
  assert.ok(results.unmatched.body.total > 300 && results.unmatched.body.total < 3000);
  assert.ok(results.unmatched.body.calls.every((call) => call.match === null && call.suggestions.length <= 5));
  assert.ok(results.unmatched.body.calls.some((call) => call.suggestions.length === 5));
  assert.ok(results['one candidate'].body.total >= 40);
});
