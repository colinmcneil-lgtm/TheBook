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
import { PORTS, GOOD_KEY, startBook, workspace, connect, look } from './metaview-helpers.mjs';

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

/** Whether any file in a data folder holds a piece of text (the database, and the file it keeps recent changes in). */
const inFiles = (dataDir, text) => fs.readdirSync(dataDir).some((name) => {
  const file = path.join(dataDir, name);
  return fs.statSync(file).isFile() && fs.readFileSync(file).includes(text);
});

test('disconnecting, or changing the key, while Metaview is being read: nothing asked for the old connection is kept', async () => {
  const standIn = keep(await metaviewStandIn(PORTS.standInRestart, { count: 400 }));
  const dataDir = keep(tempDir('metaview-midway'));
  const server = keep(await startBook({ port: PORTS.restart, dataDir, standIn, env: { METAVIEW_TIMEOUT_MS: '5000' } }));
  const w = await workspace(server.base);
  await w.owner.putJson('/metaview/settings', { auto: false });
  const sealedKey = () => look(dataDir, (all) => all(`SELECT value FROM settings WHERE key = 'metaview_key'`)[0].value);
  /** Connect with every answer taking a quarter of a second, and wait until the history is being read with a request in the air. */
  const midway = async () => {
    standIn.delay = 250;
    await connect(w.owner);
    await until(() => statusOf(w.owner), (s) => s.known >= 100 && s.catching_up, 20000);
    await until(async () => standIn.inFlight, (n) => n === 1, 5000);
  };

  // Disconnect with a page of the history on its way back.
  await midway();
  const sealed = sealedKey();
  const asked = standIn.requests.length;
  assert.deepEqual((await w.owner.del('/metaview/key')).body, { ok: true });
  // At once, and again after the page that was in the air has landed: nothing is remembered, and nothing more is asked.
  for (const wait of [0, 1500]) {
    await sleep(wait);
    assert.deepEqual(await statusOf(w.owner), { connected: false, workspace: null, source: null, can_manage: true, last_checked_at: null, known: 0, in_the_book: 0, catching_up: false, error: null, auto: false, total: null });
    assert.deepEqual((await w.priya.get('/metaview/calls')).body, { total: 0, calls: [] });
    look(dataDir, (all) => {
      assert.equal(all('SELECT COUNT(*) AS n FROM metaview_calls')[0].n, 0);
      assert.equal(all('SELECT COUNT(*) AS n FROM metaview_people')[0].n, 0);
      assert.deepEqual(all(`SELECT key FROM settings WHERE key LIKE 'metaview_%' AND key != 'metaview_auto'`), []);
    });
  }
  assert.equal(standIn.requests.length, asked, 'the background stopped asking');
  // Nor is any of it still readable in the files: not the sealed key, not the people Metaview told The Book about.
  for (const text of [sealed, '@mail.example', PEOPLE[0].name, PEOPLE[0].phone.slice(2)]) assert.equal(inFiles(dataDir, text), false, text);

  // Connecting again reads the whole history from the top: no page is skipped because of where the old reading had got to.
  standIn.delay = 0;
  const from = standIn.requests.length;
  await connect(w.owner);
  assert.equal((await settled(w.owner)).known, 400);
  assert.deepEqual(pagesAsked(standIn, from).filter((offset) => offset > 0), [50, 100, 150, 200, 250, 300, 350]);
  await w.owner.del('/metaview/key');

  // A key for another workspace entered while this one's history is being read: none of this one's conversations end up in the new list.
  const theirs = new Set(standIn.addWorkspace('mv-another-workspace-key', { workspace: 'Another Agency', count: 60 }).map((c) => c.id));
  await midway();
  const replaced = sealedKey();
  const changed = await w.owner.putJson('/metaview/key', { key: 'mv-another-workspace-key' });
  const changedAt = Date.now();
  assert.equal(changed.body.workspace, 'Another Agency');
  standIn.delay = 0;
  const done = await settled(w.owner);
  await sleep(600);   // anything still on its way for the first workspace would have landed by now
  assert.deepEqual([done.known, done.total, done.workspace], [60, 60, 'Another Agency']);
  look(dataDir, (all) => {
    const kept = all('SELECT id FROM metaview_calls').map((row) => row.id);
    assert.equal(kept.length, 60);
    assert.ok(kept.every((id) => theirs.has(id)), 'only the new workspace\'s conversations are listed');
  });
  // The old key was not used again once the new one was accepted, and it is not left behind in the files.
  assert.deepEqual(standIn.requests.filter((r) => r.key === GOOD_KEY && r.at > changedAt), []);
  assert.equal(inFiles(dataDir, replaced), false);
  assert.equal(standIn.mostAtOnce, 1);
  assert.equal(/Metaview:/.test(server.output()), false, 'none of this was a problem worth a line in the log');
  await server.stop();
  await standIn.stop();
});

test('what is known about a call points two ways: nobody is chosen, and nothing is brought in by itself', async () => {
  const standIn = keep(await metaviewStandIn(PORTS.standInRestart, { count: 0 }));
  const dataDir = keep(tempDir('metaview-two-ways'));
  const server = keep(await startBook({ port: PORTS.restart, dataDir, standIn }));
  const w = await workspace(server.base);
  const on = {
    ana: await w.candidate({ name: 'Ana Ruiz', email: 'ana.ruiz@mail.example', phone: '416-555-0150' }),
    ben: await w.candidate({ name: 'Ben Okafor', email: 'ben.okafor@mail.example', phone: '416-555-0151' }),
    carl: await w.candidate({ name: 'Carl Imre', email: 'carl.imre@mail.example' }),
    dee: await w.candidate({ name: 'Dee Lund', phone: '4165550157' }),
    // Two people in one household with one number, written two ways. Ines is in progress; Otto was turned down for another job.
    ines: await w.candidate({ name: 'Ines Vale', email: 'ines.vale@mail.example', phone: '(905) 555-0152' }),
    otto: await w.candidate({ name: 'Otto Vale', email: 'otto.vale@mail.example', phone: '905.555.0152', jobId: w.otherJob }),
    // A number in another country whose last ten digits are a Toronto number.
    lena: await w.candidate({ name: 'Lena Marsh', email: 'lena.marsh@mail.example', phone: '+44 4165 550158' }),
    // Numbers typed the way people type them.
    petra: await w.candidate({ name: 'Petra Novak', email: 'petra.novak@mail.example', phone: '416-555-0183 ext 4' }),
    quentin: await w.candidate({ name: 'Quentin Abara', email: 'quentin.abara@mail.example', phone: '416/555/0184' }),
    rhea: await w.candidate({ name: 'Rhea Sandhu', email: 'rhea.sandhu@mail.example', phone: '416-555-0185 / 647-555-0186 (evenings)' }),
  };
  assert.equal((await w.owner.post(`/applications/${on.otto.application_id}/reject`, {})).status, 200);
  const call = {
    // Ana's address, with Ben's number and Ben's name.
    mixed: standIn.add({ person: { name: 'Ben Okafor', email: 'ana.ruiz@mail.example', phone: '+14165550151' }, minutesAgo: 30 }),
    // Two candidates on one call, one known by address and one by number.
    panel: standIn.add({ person: { name: 'Carl Imre', email: 'carl.imre@mail.example' }, also: [{ name: 'Dee Lund', phone: '+14165550157' }], channel: 'Zoom', title: 'Panel', minutesAgo: 29 }),
    // The household's number, with Otto's name, with his first name only, and with no name at all.
    ottoNamed: standIn.add({ person: { name: 'Otto Vale', phone: '+19055550152' }, minutesAgo: 28 }),
    ottoFirstName: standIn.add({ person: { name: 'Otto', phone: '+19055550152' }, minutesAgo: 27 }),
    household: standIn.add({ person: { name: 'Nobody', phone: '+19055550152' }, shown: '+19055550152', minutesAgo: 26 }),
    // A Toronto caller whose number ends in the same ten digits as Lena's in another country.
    toronto: standIn.add({ person: { name: 'Nobody', phone: '+14165550158' }, shown: '+14165550158', minutesAgo: 25 }),
    ext: standIn.add({ person: { name: 'Petra', phone: '+14165550183' }, minutesAgo: 24 }),
    slashes: standIn.add({ person: { name: 'Quentin Abara', phone: '+14165550184' }, minutesAgo: 23 }),
    second: standIn.add({ person: { name: 'Rhea', phone: '+16475550186' }, minutesAgo: 22 }),
    plain: standIn.add({ person: { name: 'Ana Ruiz', email: 'ana.ruiz@mail.example' }, minutesAgo: 21 }),
  };
  await connect(w.owner);
  await settled(w.owner);
  // "Auto" is on. The four calls that one number or one address ties to one candidate come in; the other six do not.
  const brought = await until(() => oracleCalls(w.owner), (calls) => calls.length === 4, 20000);
  await sleep(900);
  assert.equal((await statusOf(w.owner)).in_the_book, 4);
  const onto = Object.fromEntries(brought.map((c) => [c.external_url, c.candidate_id]));
  assert.deepEqual([call.ext, call.slashes, call.second, call.plain].map((c) => onto[c.url]), [on.petra, on.quentin, on.rhea, on.ana].map((who) => who.candidate_id));

  const list = (await w.owner.get('/metaview/calls?limit=100')).body.calls;
  const of = (conv) => list.find((row) => row.id === conv.id);
  const matched = (conv) => { const { match } = of(conv); return match && [match.candidate_id, match.how]; };
  const offered = (conv) => of(conv).suggestions.map((s) => [s.candidate_id, s.how]).sort();
  // The address says Ana, the number and the name say Ben: both are offered, each with what it rests on.
  assert.equal(matched(call.mixed), null);
  assert.deepEqual(offered(call.mixed), [[on.ana.candidate_id, 'email'], [on.ben.candidate_id, 'phone']].sort());
  // Two candidates on one call: both offered.
  assert.equal(matched(call.panel), null);
  assert.deepEqual(offered(call.panel), [[on.carl.candidate_id, 'email'], [on.dee.candidate_id, 'phone']].sort());
  // The household's number: the name on the conversation says which of the two it was, whoever is still in progress.
  assert.deepEqual(matched(call.ottoNamed), [on.otto.candidate_id, 'phone']);
  assert.deepEqual(matched(call.ottoFirstName), [on.otto.candidate_id, 'phone']);
  assert.equal(matched(call.household), null);
  assert.deepEqual(offered(call.household), [[on.ines.candidate_id, 'phone'], [on.otto.candidate_id, 'phone']].sort());
  // The same last ten digits in another country are another number.
  assert.deepEqual([matched(call.toronto), offered(call.toronto)], [null, []]);
  assert.deepEqual([call.ext, call.slashes, call.second].map((c) => of(c).match.how), ['phone', 'phone', 'phone']);

  // Each profile lists what is, or may be, that person's, and nothing that is plainly somebody else's.
  const theirs = async (who) => (await w.owner.get(`/metaview/calls?candidate_id=${who.candidate_id}`)).body.calls.map((row) => row.id);
  assert.deepEqual(await theirs(on.ines), [call.household.id]);
  assert.deepEqual(await theirs(on.otto), [call.household.id, call.ottoFirstName.id, call.ottoNamed.id]);
  assert.deepEqual(await theirs(on.ana), [call.plain.id, call.mixed.id]);
  assert.deepEqual(await theirs(on.ben), [call.mixed.id]);
  assert.deepEqual(await theirs(on.dee), [call.panel.id]);
  assert.deepEqual(await theirs(on.lena), []);
  assert.deepEqual(await theirs(on.petra), [call.ext.id]);
  assert.deepEqual(await theirs(on.rhea), [call.second.id]);

  // Opening one without saying who it is for puts it on nobody when nobody could be chosen, and on Otto when the name said Otto.
  const opened = async (conv) => (await w.owner.get(`/oracle/calls/${(await w.sam.post(`/metaview/calls/${conv.id}/open`)).body.call_id}`)).body.call;
  for (const conv of [call.household, call.mixed, call.panel, call.toronto]) assert.deepEqual([(await opened(conv)).application_id, (await opened(conv)).candidate_id], [null, null]);
  const ottos = await opened(call.ottoNamed);
  assert.deepEqual([ottos.application_id, ottos.candidate_id, ottos.title], [on.otto.application_id, on.otto.candidate_id, 'Call with Otto Vale']);
  assert.deepEqual((await history(w.owner, on.otto.application_id)).map((a) => a.detail), ['Metaview call, 12 min']);
  for (const who of [on.ines, on.ben, on.carl, on.dee, on.lena]) assert.deepEqual(await history(w.owner, who.application_id), [], 'nobody else\'s history says anything about a call');
  // Only Ana's own call is on Ana.
  assert.deepEqual((await history(w.owner, on.ana.application_id)).map((a) => a.detail), ['Metaview call, 12 min']);
  await server.stop();
  await standIn.stop();
});

test('a key set where The Book is hosted that cannot be a key is never sent and never logged, and the status says so', async () => {
  const standIn = keep(await metaviewStandIn(PORTS.standInRestart, { count: 5 }));
  const dataDir = keep(tempDir('metaview-bad-host-key'));
  // Pasted over two lines, which is how a long key ends up with a line break in the middle.
  const server = keep(await startBook({ port: PORTS.restart, dataDir, standIn, env: { METAVIEW_API_KEY: 'mv-key-pasted\non-two-lines' } }));
  const w = await workspace(server.base);
  await sleep(500);
  const s = await statusOf(w.owner);
  assert.deepEqual([s.connected, s.source, s.catching_up], [false, null, false]);
  assert.match(s.error, /METAVIEW_API_KEY\) does not look like a key/);
  assert.equal((await w.priya.post('/metaview/refresh')).status, 409);
  assert.equal(standIn.requests.length, 0, 'nothing was sent to Metaview');
  assert.equal(/mv-key-pasted|on-two-lines/.test(server.output()), false);
  // A key entered in the app works all the same.
  assert.equal((await connect(w.owner)).source, 'settings');
  assert.equal((await settled(w.owner)).known, 5);
  assert.equal(/mv-key-pasted|on-two-lines/.test(server.output()), false);
  await server.stop();
  await standIn.stop();
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
