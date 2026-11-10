// Metaview in The Oracle, end to end: the real server on a throwaway data folder, reading the stand-in for Metaview
// (test/metaview-standin.mjs) and a stand-in for the AI service. Run with `npm test`.
//
// The tests run in order and build on each other: connect, read the history, list, match, bring calls in, break the
// connection in every way the stand-in knows, forget the key. The real Metaview is never called.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { anthropicStandIn, session, until, tempDir, sleep, NOTES_DRAFT, SUBMISSION_DRAFT } from './oracle-helpers.mjs';
import { metaviewStandIn, PEOPLE, INTERVIEWERS, SPECIAL, WORKSPACE, READ_ONLY_TOOLS } from './metaview-standin.mjs';
import { PORTS, GOOD_KEY, startBook, workspace, connect, look } from './metaview-helpers.mjs';

const KEY_REFUSED = 'Metaview did not accept the key. Make a new one in Metaview (Settings, Integrations, MCP) and enter it again.';
const NOT_ANSWERING = 'Metaview is not answering right now. The Book will try again by itself in a few minutes.';
const BUSY = 'Metaview is busy right now. The Book will try again by itself in a few minutes.';
const UNREADABLE = 'Metaview sent back something The Book could not read. It will try again by itself in a few minutes.';
const COULD_NOT = 'Metaview could not answer that request. The Book will try again by itself in a few minutes.';
const WRONG_KEY = 'mv-a-key-metaview-does-not-know';

let standIn, anthropic, server, dataDir, w;
let c = {};   // the candidates added to The Book, by what they are there to show

const status = async (who = w.owner) => (await who.get('/metaview/status')).body;
/** Wait until the background has nothing more to read and nothing is wrong. */
const settled = () => until(status, (s) => s.connected && !s.catching_up && !s.error, 20000);
/** Every call the list gives for a query, read a page at a time. */
async function listed(query = '', who = w.owner) {
  const calls = [];
  for (let offset = 0; ; offset += 100) {
    const page = (await who.get(`/metaview/calls?limit=100&offset=${offset}${query ? `&${query}` : ''}`)).body;
    calls.push(...page.calls);
    if (calls.length >= page.total || !page.calls.length) return { total: page.total, calls };
  }
}
/** One conversation's row in the list. */
const row = async (id) => (await listed()).calls.find((call) => call.id === id);
/** The stand-in's conversations that pass a test, as their ids, newest first (the order the list gives them in). */
const idsWhere = (keep) => standIn.conversations.filter(keep).sort((a, b) => b.started - a.started).map((conv) => conv.id);
const open = (who, id, body = {}) => who.post(`/metaview/calls/${id}/open`, body);
const callOf = async (who, callId) => (await who.get(`/oracle/calls/${callId}`)).body;
const history = async (who, applicationId) => (await who.get(`/applications/${applicationId}`)).body.activities.map((a) => a.detail);
/** How often the stand-in was asked for one conversation's transcript. */
const fetchesOf = (id) => standIn.toolCalls().filter((r) => r.args?.conversation_ids?.includes(id)).length;

before(async () => {
  standIn = await metaviewStandIn(PORTS.standIn);
  anthropic = await anthropicStandIn(PORTS.anthropic);
  dataDir = tempDir('metaview');
  server = await startBook({ port: PORTS.main, dataDir, standIn, env: { ANTHROPIC_API_KEY: 'good', ANTHROPIC_BASE_URL: anthropic.url } });
  w = await workspace(server.base);
  // Calls are only brought in by hand in this file; bringing them in unasked has tests of its own.
  assert.equal((await w.owner.putJson('/metaview/settings', { auto: false })).body.auto, false);
});
after(async () => {
  await server?.stop();
  await standIn?.stop();
  await anthropic?.stop();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

test('before a key is entered: nothing is connected, and only the agency can even ask', async () => {
  assert.deepEqual(await status(), { connected: false, workspace: null, source: null, can_manage: true, last_checked_at: null, known: 0, in_the_book: 0, catching_up: false, error: null, auto: false });
  assert.equal((await status(w.priya)).can_manage, false);
  assert.deepEqual((await w.priya.get('/metaview/calls')).body, { total: 0, calls: [] });
  const refresh = await w.priya.post('/metaview/refresh');
  assert.equal(refresh.status, 409);
  assert.match(refresh.body.error, /not connected yet/);
  // A client's hiring team never sees any of it.
  for (const [method, pathname, body] of [['get', '/metaview/status'], ['get', '/metaview/calls'], ['post', '/metaview/refresh'], ['post', '/metaview/calls/1/open'],
    ['putJson', '/metaview/key', { key: GOOD_KEY }], ['putJson', '/metaview/settings', { auto: true }], ['del', '/metaview/key']]) {
    const answer = await w.maya[method](pathname, body);
    assert.equal(answer.status, 403, pathname);
    assert.equal(typeof answer.body.error, 'string');
  }
  // A recruiter can look, but the key and the settings are an admin's.
  for (const answer of [await w.priya.putJson('/metaview/key', { key: GOOD_KEY }), await w.priya.putJson('/metaview/settings', { auto: true }), await w.priya.del('/metaview/key')]) assert.equal(answer.status, 403);
  assert.equal(standIn.requests.length, 0, 'nothing was asked of Metaview');
});

test('a key Metaview refuses is not kept, and something that cannot be a key is not even tried', async () => {
  for (const key of ['', '   ', 'short', 'has a space in the middle', 'x'.repeat(600), 12345, null]) {
    const answer = await w.owner.putJson('/metaview/key', { key });
    assert.equal(answer.status, 400, String(key));
  }
  assert.equal(standIn.requests.length, 0);
  const refused = await w.owner.putJson('/metaview/key', { key: WRONG_KEY });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error, KEY_REFUSED);
  assert.equal(standIn.requests.length, 1);
  assert.equal(standIn.requests[0].keyOk, false);
  assert.equal((await status()).connected, false);
  // When Metaview cannot be reached at all, the key is not kept either, and the answer says which it was.
  standIn.fault = '500';
  const down = await w.owner.putJson('/metaview/key', { key: GOOD_KEY });
  assert.equal(down.status, 502);
  assert.equal(down.body.error, NOT_ANSWERING);
  assert.equal((await status()).connected, false);
  standIn.fault = null;
});

test('a key Metaview accepts connects the workspace, and is never given back', async () => {
  const connected = await connect(w.owner);
  assert.equal(connected.connected, true);
  assert.equal(connected.workspace, WORKSPACE);
  assert.equal(connected.source, 'settings');
  assert.equal(connected.catching_up, true);
  assert.ok(Date.parse(connected.last_checked_at) > Date.now() - 5000);
  assert.equal(JSON.stringify(connected).includes(GOOD_KEY), false);
  assert.equal(JSON.stringify(await status(w.priya)).includes(GOOD_KEY), false);
  // It is in the database sealed: the key itself is nowhere in the file.
  look(dataDir, (all) => {
    const [saved] = all(`SELECT value FROM settings WHERE key = 'metaview_key'`);
    assert.match(saved.value, /^v1\./);
    assert.equal(saved.value.includes(GOOD_KEY), false);
  });
});

test('the whole history is read a page at a time, one request at a time', async () => {
  const done = await settled();
  assert.equal(done.known, 130);
  assert.equal(done.in_the_book, 0);
  const pages = standIn.toolCalls().filter((r) => r.tool === 'search_conversations' && !r.args.conversation_ids);
  // Each page of history once (the first look is its first page), fifty at a time, and nothing else but new looks at the top.
  assert.deepEqual(pages.filter((r) => r.args.offset > 0).map((r) => r.args.offset), [50, 100]);
  assert.ok(pages.every((r) => r.args.limit === 50));
  assert.equal(standIn.mostAtOnce, 1);
  // Only what is needed to list and match a conversation was asked for: no transcripts, no notes.
  assert.ok(pages.every((r) => !r.args.fields.includes('default:transcript') && !r.args.fields.includes('default:summary')));
  look(dataDir, (all) => {
    assert.equal(all('SELECT COUNT(*) AS n FROM metaview_calls')[0].n, 130);
    assert.equal(all('SELECT COUNT(*) AS n FROM calls')[0].n, 0);
  });
});

test('the list: newest first, a page at a time, with names and roles but no addresses or numbers', async () => {
  const first = (await w.priya.get('/metaview/calls')).body;
  assert.equal(first.total, 130);
  assert.equal(first.calls.length, 30);
  const all = await listed();
  assert.deepEqual(all.calls.map((call) => call.id), idsWhere(() => true));
  const second = (await w.priya.get('/metaview/calls?offset=30&limit=5')).body;
  assert.deepEqual(second.calls.map((call) => call.id), all.calls.slice(30, 35).map((call) => call.id));
  // A phone call has no event name, so it is called after who it was with; a meeting keeps its name.
  const newest = standIn.at(0), phoneCall = standIn.at(1);
  assert.deepEqual(first.calls[0], {
    id: newest.id, url: `https://app.metaview.ai/notes/${newest.id}`, started_at: newest.started.toISOString(), title: newest.title, kind: 'Job Interview', channel: 'Zoom', minutes: 5,
    people: [{ name: PEOPLE[0].name, role: 'candidate' }, { name: 'Priya Nair', role: 'interviewer' }], has_transcript: true, call_id: null, match: null, suggestions: [],
  });
  assert.equal(first.calls[1].title, `Call with ${PEOPLE[1].name}`);
  assert.equal(first.calls[1].channel, 'Phone');
  // Metaview writes its times with and without a fraction; both are read to the same second.
  assert.equal(first.calls[1].started_at, new Date(Math.floor(phoneCall.started.getTime() / 1000) * 1000).toISOString());
  // A meeting with a client has no candidate: the other person is just somebody on the call.
  const meeting = all.calls.find((call) => call.id === standIn.at(9).id);
  assert.deepEqual(meeting.people, [{ name: 'Maya Okonkwo', role: 'other' }, { name: INTERVIEWERS[1].name, role: 'interviewer' }]);
  assert.equal(meeting.kind, 'Client Meeting');
  assert.equal(all.calls.find((call) => call.id === standIn.at(SPECIAL.noTranscript[0]).id).has_transcript, false);
  // Nobody's address or number leaves the server in the list.
  const text = JSON.stringify(all);
  assert.equal(/@mail\.example|@agency\.example|5550\d{3}/.test(text), false);
  // Things a list cannot be asked for.
  for (const query of ['who=nobody', 'show=everything', 'candidate_id=999999']) assert.ok([400, 404].includes((await w.priya.get(`/metaview/calls?${query}`)).status), query);
});

test('the search box finds names, addresses, phone digits and titles; "mine" is the calls somebody took part in', async () => {
  const dana = PEOPLE[0];
  const theirs = idsWhere((conv) => conv.person === dana);
  assert.equal(theirs.length, 3);
  const found = async (q) => (await listed(`q=${encodeURIComponent(q)}`)).calls.map((call) => call.id);
  assert.deepEqual(await found(dana.name), theirs);
  assert.deepEqual(await found('tremblay DANA'), theirs, 'words in any order, in any case');
  assert.deepEqual(await found(dana.email), theirs);
  assert.deepEqual(await found('(416) 555-0100'), theirs, 'a number however it is punctuated');
  assert.deepEqual(await found('4165550100'), theirs);
  assert.deepEqual(await found('zoe'), idsWhere((conv) => conv.other.shown.startsWith('Zoë')), 'accents do not matter');
  assert.deepEqual(await found('hiring plan'), idsWhere((conv) => conv.title.includes('hiring plan')));
  assert.deepEqual(await found('nobody-by-this-name'), []);
  assert.deepEqual(await found('100%'), [], 'a sign that means something to the database is just a character');
  // "Mine" goes by the signed-in person's address among the interviewers.
  const tookPart = (person) => idsWhere((conv) => conv.interviewers.some((p) => p.email === person));
  assert.deepEqual((await listed('who=mine', w.priya)).calls.map((call) => call.id), tookPart('priya@agency.example'));
  assert.deepEqual((await listed('who=mine', w.sam)).calls.map((call) => call.id), tookPart('sam@agency.example'));
  assert.equal((await listed('who=everyone', w.sam)).total, 130);
  assert.deepEqual((await listed(`who=mine&q=${encodeURIComponent(PEOPLE[4].name)}`, w.priya)).calls.map((call) => call.id), idsWhere((conv) => conv.person === PEOPLE[4]));
});

test('matching: an address, then a number, then an exact full name; anything less is only offered', async () => {
  // Nobody is on file yet, so nothing matches and nothing is offered.
  assert.ok((await listed()).calls.every((call) => call.match === null && call.suggestions.length === 0));
  const [dana, jonas, , kevin, chloe, farid] = PEOPLE;
  c.byEmail = await w.candidate({ name: 'D. Tremblay-Roy', email: dana.email });                              // the address is theirs, the name is not
  c.byPhone = await w.candidate({ name: 'JJ', email: 'jj@elsewhere.example', phone: '(647) 555-0101' });      // Jonas's number, typed the way people type numbers
  c.byName = await w.candidate({ name: 'KEVIN Chowdhury', email: 'kc@elsewhere.example', jobId: w.otherJob }); // the name is theirs, nothing else is
  c.otherKevin = await w.candidate({ name: 'Kevin Marsh', email: 'kevin.marsh@elsewhere.example' });
  c.accents = await w.candidate({ name: `ZOE ${PEOPLE[23].name.split(' ')[1]}`, email: 'zoe@elsewhere.example' });
  c.partial = await w.candidate({ name: 'Farid K. Okafor', email: 'fko@elsewhere.example' });
  // The same person on file under two clients: which record is meant is a person's call.
  c.twiceA = await w.candidate({ name: chloe.name, email: chloe.email });
  c.twiceB = await w.candidate({ name: chloe.name, email: chloe.email, jobId: w.elsewhere });

  const all = (await listed()).calls;
  const of = (index) => all.find((call) => call.id === standIn.at(index).id);
  const matchOf = (index) => { const { match } = of(index); return match && [match.candidate_id, match.application_id, match.how]; };
  // By address: every one of Dana's conversations, whatever The Book calls them.
  for (const index of [0, 48, 96]) assert.deepEqual(matchOf(index), [c.byEmail.candidate_id, c.byEmail.application_id, 'email'], `conversation ${index}`);
  assert.deepEqual(of(0).match, { application_id: c.byEmail.application_id, candidate_id: c.byEmail.candidate_id, name: 'D. Tremblay-Roy', photo: null, job_title: 'Head of Sales', client_name: 'Kestrel Logistics', how: 'email' });
  assert.deepEqual(of(0).suggestions, []);
  // By number: Jonas's calls came with a number and no address.
  for (const index of [1, 49, 97]) assert.deepEqual(matchOf(index), [c.byPhone.candidate_id, c.byPhone.application_id, 'phone'], `conversation ${index}`);
  // By exact full name, when no address or number on file says otherwise. Capitals and accents do not count.
  for (const index of [51, 99]) assert.deepEqual(matchOf(index), [c.byName.candidate_id, c.byName.application_id, 'name'], `conversation ${index}`);
  assert.equal(of(51).match.job_title, 'Sales Manager');
  for (const index of [71, 119]) assert.deepEqual(matchOf(index), [c.accents.candidate_id, c.accents.application_id, 'name'], `conversation ${index}`);
  // A first name alone: both Kevins are offered and neither is chosen.
  assert.equal(of(3).people[0].name, 'Kevin');
  assert.equal(of(3).match, null);
  assert.deepEqual(of(3).suggestions.map((s) => [s.candidate_id, s.how]).sort(), [[c.byName.candidate_id, 'name'], [c.otherKevin.candidate_id, 'name']].sort());
  // Part of a name ("Farid Okafor" for Farid K. Okafor) is offered too, never chosen.
  assert.equal(of(5).match, null);
  assert.deepEqual(of(5).suggestions.map((s) => s.candidate_id), [c.partial.candidate_id]);
  // The same address on two records: both offered.
  assert.equal(of(4).match, null);
  assert.deepEqual(of(4).suggestions.map((s) => [s.candidate_id, s.how]).sort(), [[c.twiceA.candidate_id, 'email'], [c.twiceB.candidate_id, 'email']].sort());
  assert.ok(all.every((call) => call.suggestions.length <= 5));

  // "Unmatched" is exactly the conversations with nobody chosen, and the count agrees with the list.
  const matched = all.filter((call) => call.match).map((call) => call.id);
  assert.equal(matched.length, 3 + 3 + 2 + 2);
  const unmatched = await listed('show=unmatched');
  assert.equal(unmatched.total, 130 - matched.length);
  assert.deepEqual(unmatched.calls.map((call) => call.id), all.filter((call) => !call.match).map((call) => call.id));
  assert.equal((await w.priya.get('/metaview/calls?show=unmatched&limit=7&offset=7')).body.calls.length, 7);
  assert.equal((await listed('show=new')).total, 130);

  // One candidate's conversations: by their address, their number or their exact full name.
  const forCandidate = async (who) => (await listed(`candidate_id=${who.candidate_id}`)).calls.map((call) => call.id);
  assert.deepEqual(await forCandidate(c.byEmail), idsWhere((conv) => conv.person === dana));
  assert.deepEqual(await forCandidate(c.byPhone), idsWhere((conv) => conv.person === jonas));
  assert.deepEqual(await forCandidate(c.byName), [51, 99].map((index) => standIn.at(index).id), 'the conversation that only says "Kevin" is not theirs for certain');
  assert.deepEqual(await forCandidate(c.otherKevin), []);
  assert.deepEqual(await forCandidate(c.twiceA), idsWhere((conv) => conv.person === chloe), 'offered on both records, so listed on both');
  assert.equal((await w.priya.get(`/metaview/calls?candidate_id=${c.byEmail.candidate_id}&limit=2`)).body.total, 3);
});

test('somebody with a login to The Book is never taken for a candidate', async () => {
  // Sam the recruiter is also on file as a candidate (people do add themselves to try things out), and Metaview
  // recorded a conversation in which Priya spoke to Sam.
  const samOnFile = await w.candidate({ name: 'Sam Okoro', email: 'sam@agency.example', phone: '+1 416 555 0188' });
  const internal = standIn.add({ person: { name: 'Sam Okoro', email: 'sam@agency.example', phone: '+14165550188' }, interviewers: [INTERVIEWERS[0]], minutesAgo: 3 });
  await w.owner.post('/metaview/refresh');
  const listedCall = await until(() => row(internal.id), Boolean);
  assert.equal(listedCall.match, null);
  assert.deepEqual(listedCall.suggestions, []);
  // An interviewer is never the candidate either, even when their name is all there is to go on.
  const asCandidate = await w.candidate({ name: 'Jordan Reyes', email: 'jr@elsewhere.example' });
  const theirs = (await listed(`candidate_id=${asCandidate.candidate_id}`)).calls;
  assert.deepEqual(theirs, []);
  assert.ok((await listed()).calls.every((call) => call.match?.candidate_id !== samOnFile.candidate_id && call.match?.candidate_id !== asCandidate.candidate_id));
});

test('opening a call brings it into The Oracle with its transcript, on the candidate it certainly was with', async () => {
  const conv = standIn.at(0);
  conv.summary = 'Job Interview with Dana\r\n\r\nBackground\r\n- Leads a team of six.\n\n\nNext steps\n- Send the job description.\n';
  standIn.notesAfter = Infinity;   // Metaview is still writing the notes
  const asked = standIn.requests.length;
  const opened = await open(w.sam, conv.id);
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  const detail = await callOf(w.sam, opened.body.call_id);
  const { call } = detail;
  assert.equal(call.source, 'metaview');
  assert.equal(call.status, 'ready');
  assert.equal(call.title, conv.title);
  assert.equal(call.external_url, `https://app.metaview.ai/notes/${conv.id}`);
  assert.equal(call.took_place_at, conv.started.toISOString());
  assert.ok(Date.parse(call.created_at) > conv.started.getTime());
  assert.equal(call.has_audio, false);
  assert.equal(call.duration_ms, 5 * 60000);
  assert.equal(call.transcript_source, 'metaview');
  // Nobody confirmed consent in The Book: the record says where the recording was made, with no name and no time beside it.
  assert.equal(call.consent_at, null);
  assert.equal(call.consent_by_name, null);
  assert.match(call.consent_wording, /recorded in Metaview, not in The Book/);
  // The speakers are named, and each turn has its start and end in seconds.
  assert.deepEqual(call.speakers, { 0: 'Priya Nair', 1: PEOPLE[0].name });
  assert.deepEqual(call.transcript[0], { speaker: 0, start: 1, end: 25, text: 'Hi Dana, thanks for making the time today. How are things?' });
  assert.deepEqual(call.transcript[1], { speaker: 1, start: 28, end: 52, text: 'Good, thanks. How are you?' });
  assert.ok(call.transcript.some((turn) => turn.text.includes('the ratio here is 3:1')), 'a colon in what was said is not a new speaker');
  assert.ok(call.transcript.some((turn) => turn.text.includes('(roughly) and a bonus')));
  // It belongs to the interviewer who has a login here, not to whoever happened to open it, and it is on the candidate.
  assert.equal(call.created_by_name, 'Priya Nair');
  assert.equal(detail.candidate.id, c.byEmail.candidate_id);
  assert.equal(detail.application.id, c.byEmail.application_id);
  assert.deepEqual(await history(w.sam, c.byEmail.application_id).then((lines) => lines.filter((line) => /call/i.test(line))), ['Metaview call, 5 min']);
  assert.equal((await history(w.maya, c.byEmail.application_id)).some((line) => /call/i.test(line)), false, 'a client never sees that there was a call');
  // The notes are on their way: the page is told to wait for them, and The Book's own AI is not asked to write any.
  assert.equal(call.notes, null);
  assert.equal(call.notes_pending, true);
  assert.equal(call.notes_error, null);
  assert.equal(anthropic.requests.length, 0);
  // One request brought it in, with the transcript and the notes asked for together.
  const fetched = standIn.requests.slice(asked).filter((r) => r.args?.conversation_ids);
  assert.equal(fetched.filter((r) => r.args.conversation_ids[0] === conv.id && r.args.fields.includes('default:transcript') && r.args.fields.includes('default:summary')).length >= 1, true);
  // Then Metaview finishes them, and they arrive by themselves, laid out as Metaview wrote them.
  standIn.notesAfter = 1;
  const withNotes = (await until(() => callOf(w.sam, opened.body.call_id), (d) => d.call.notes)).call;
  assert.equal(withNotes.notes, 'Job Interview with Dana\n\nBackground\n- Leads a team of six.\n\n\nNext steps\n- Send the job description.');
  assert.equal(withNotes.notes_pending, false);
  assert.equal(anthropic.requests.length, 0);

  // The lists know about it.
  const inList = await row(conv.id);
  assert.equal(inList.call_id, opened.body.call_id);
  assert.equal(inList.match.how, 'email');
  assert.equal((await status()).in_the_book, 1);
  assert.equal((await listed('show=new')).total, (await status()).known - 1);
  const [oracleRow] = (await w.sam.get('/oracle/calls?source=metaview')).body;
  assert.equal(oracleRow.id, opened.body.call_id);
  assert.deepEqual([oracleRow.source, oracleRow.has_audio, oracleRow.external_url, oracleRow.took_place_at, oracleRow.candidate_name], ['metaview', false, call.external_url, call.took_place_at, 'D. Tremblay-Roy']);
  assert.deepEqual((await w.sam.get('/oracle/calls?source=book')).body, []);
  assert.equal((await w.sam.get('/oracle/calls?source=elsewhere')).status, 400);
  // There is no audio to play or to transcribe.
  assert.equal((await w.sam.get(`/oracle/calls/${opened.body.call_id}/audio`)).status, 404);
  const transcribe = await w.sam.post(`/oracle/calls/${opened.body.call_id}/transcribe`);
  assert.equal(transcribe.status, 400);
  assert.match(transcribe.body.error, /recorded in Metaview/);
});

test('opening the same call again, or twice at once, gives the same call', async () => {
  const first = standIn.at(0);
  const before = fetchesOf(first.id);
  const again = await open(w.priya, first.id);
  assert.equal(again.body.call_id, (await row(first.id)).call_id);
  assert.equal(fetchesOf(first.id), before, 'Metaview was not asked a second time');
  // Two people press Open on the same conversation at the same moment.
  const conv = standIn.at(1);
  const [one, two] = await Promise.all([open(w.priya, conv.id), open(w.sam, conv.id)]);
  assert.equal(one.status, 200);
  assert.equal(one.body.call_id, two.body.call_id);
  look(dataDir, (all) => assert.equal(all('SELECT COUNT(*) AS n FROM calls WHERE external_url = ?', conv.url)[0].n, 1));
  assert.deepEqual((await history(w.sam, c.byPhone.application_id)).filter((line) => /call/i.test(line)), ['Metaview call, 12 min']);
  // Its interviewer is Sam, who has a login here, so it is Sam's call whoever opened it first.
  assert.equal((await callOf(w.priya, one.body.call_id)).call.created_by_name, 'Sam Okoro');
  // A conversation The Book does not know, or a candidate who is not there, is refused plainly.
  assert.equal((await open(w.sam, 123)).status, 404);
  assert.equal((await open(w.sam, standIn.at(2).id, { application_id: 424242 })).status, 404);
  assert.equal((await row(standIn.at(2).id)).call_id, null);
});

test('a call nobody on file matches is brought in on its own; one over an hour long keeps its times', async () => {
  const conv = standIn.at(SPECIAL.hourLong);
  const opened = await open(w.owner, conv.id);
  const { call, candidate, application } = await callOf(w.owner, opened.body.call_id);
  assert.equal(candidate, null);
  assert.equal(application, null);
  assert.equal(call.title, `Call with ${PEOPLE[20].name}`);
  assert.equal(call.duration_ms, 75 * 60000);
  const last = call.transcript.at(-1);
  assert.ok(last.start > 3600 && last.end > last.start, 'times past the hour are read as hours, minutes and seconds');
  assert.ok(call.transcript.every((turn, i) => i === 0 || turn.start >= call.transcript[i - 1].start));
  // A turn written over two lines is one turn.
  assert.ok(call.transcript.some((turn) => turn.text.endsWith('I should add: the team is six people now.')));
  assert.equal(Object.keys(call.speakers).length, 2);
  // Its interviewer is Priya; had it been somebody with no login here, it would be the opener's (see the next test).
  assert.equal(call.created_by_name, 'Priya Nair');
});

test('a call from Metaview works like any other: names, notes, the write-up, moving it, deleting it', async () => {
  const conv = standIn.at(51);   // Kevin Chowdhury by name; the interviewer has no login to The Book
  const { call_id } = (await open(w.sam, conv.id)).body;
  let detail = await callOf(w.sam, call_id);
  assert.equal(detail.call.created_by_name, 'Sam Okoro', 'no interviewer has a login here, so it is the opener\'s');
  assert.equal(detail.candidate.id, c.byName.candidate_id);
  await until(() => callOf(w.sam, call_id), (d) => d.call.notes);
  // Renaming a speaker.
  detail = (await w.sam.patch(`/oracle/calls/${call_id}`, { speakers: { 1: 'Kevin C.' } })).body;
  assert.equal(detail.call.speakers[1], 'Kevin C.');
  // "Write again": The Book's own AI writes the notes from the transcript, replacing Metaview's.
  const rewritten = await w.sam.post(`/oracle/calls/${call_id}/notes`);
  assert.equal(rewritten.status, 200, JSON.stringify(rewritten.body));
  assert.ok(rewritten.body.notes.startsWith(NOTES_DRAFT.overview));
  const sent = anthropic.requests.at(-1).body.messages[0].content;
  assert.match(sent, /\[0:01\] Speaker 0 \(Jordan Reyes\): Hi Kevin/);
  // The write-up for the hiring team, and the summary saved on the profile.
  const submission = await w.sam.post(`/oracle/calls/${call_id}/submission`);
  assert.equal(submission.status, 200, JSON.stringify(submission.body));
  assert.equal(submission.body.submission, SUBMISSION_DRAFT.submission);
  assert.equal((await w.sam.post(`/oracle/calls/${call_id}/save-note`)).status, 200);
  // Editing the notes by hand.
  assert.equal((await w.sam.patch(`/oracle/calls/${call_id}`, { notes: 'Kevin is open to a move.' })).body.call.notes, 'Kevin is open to a move.');
  // Moving it to somebody else says so on their history, and the Metaview list follows the call.
  detail = (await w.sam.patch(`/oracle/calls/${call_id}`, { application_id: c.otherKevin.application_id })).body;
  assert.equal(detail.candidate.id, c.otherKevin.candidate_id);
  assert.deepEqual((await history(w.sam, c.otherKevin.application_id)).filter((line) => /call/i.test(line)), [`Metaview call, ${conv.minutes} min`]);
  let inList = await row(conv.id);
  assert.deepEqual([inList.match.candidate_id, inList.match.how], [c.otherKevin.candidate_id, 'chosen']);
  assert.ok((await listed(`candidate_id=${c.otherKevin.candidate_id}`)).calls.some((call) => call.id === conv.id));
  assert.equal((await listed(`candidate_id=${c.byName.candidate_id}`)).calls.some((call) => call.id === conv.id), false, 'no longer on the person it was moved away from');
  // Taken off everybody, it is unmatched again, and the person its name points at is offered first.
  await w.sam.patch(`/oracle/calls/${call_id}`, { application_id: null });
  inList = await row(conv.id);
  assert.equal(inList.match, null);
  assert.equal(inList.suggestions[0].candidate_id, c.byName.candidate_id);
  assert.ok((await listed('show=unmatched')).calls.some((call) => call.id === conv.id));
  // Deleting it: by its owner or an admin only. The conversation is then "not in The Book" again, and can be opened afresh.
  assert.equal((await w.priya.del(`/oracle/calls/${call_id}`)).status, 403);
  assert.equal((await w.sam.del(`/oracle/calls/${call_id}`)).status, 200);
  assert.equal((await row(conv.id)).call_id, null);
  const reopened = (await open(w.priya, conv.id)).body.call_id;
  assert.notEqual(reopened, call_id);
  assert.equal((await callOf(w.priya, reopened)).candidate.id, c.byName.candidate_id);
});

test('a person chosen by hand wins, and is remembered', async () => {
  const conv = standIn.at(3);   // Metaview only knows "Kevin"
  assert.equal((await row(conv.id)).match, null);
  const { call_id } = (await open(w.priya, conv.id, { application_id: c.otherKevin.application_id })).body;
  const detail = await callOf(w.priya, call_id);
  assert.equal(detail.candidate.id, c.otherKevin.candidate_id);
  assert.equal(detail.call.title, conv.title);
  let inList = await row(conv.id);
  assert.deepEqual([inList.call_id, inList.match.candidate_id, inList.match.how, inList.suggestions.length], [call_id, c.otherKevin.candidate_id, 'chosen', 0]);
  // Opening it again without choosing leaves it where it was put.
  assert.equal((await open(w.sam, conv.id)).body.call_id, call_id);
  assert.equal((await callOf(w.sam, call_id)).candidate.id, c.otherKevin.candidate_id);
  // Choosing somebody else for a call that is already in moves it, like "Add to a candidate" does.
  assert.equal((await open(w.sam, conv.id, { application_id: c.byName.application_id })).body.call_id, call_id);
  assert.equal((await callOf(w.sam, call_id)).candidate.id, c.byName.candidate_id);
  inList = await row(conv.id);
  assert.deepEqual([inList.match.candidate_id, inList.match.how], [c.byName.candidate_id, 'chosen']);
  // A choice beats what the evidence says: Dana's conversation, put on Jonas by hand.
  const danas = standIn.at(48);
  const moved = (await open(w.sam, danas.id, { application_id: c.byPhone.application_id })).body.call_id;
  assert.equal((await callOf(w.sam, moved)).candidate.id, c.byPhone.candidate_id);
  assert.deepEqual([(await row(danas.id)).match.candidate_id, (await row(danas.id)).match.how], [c.byPhone.candidate_id, 'chosen']);
  assert.equal((await listed(`candidate_id=${c.byEmail.candidate_id}`)).calls.some((call) => call.id === danas.id), false);
});

test('a call with no transcript is brought in saying so, and its transcript follows when Metaview has one', async () => {
  const conv = standIn.at(SPECIAL.noTranscript[0]);
  const { call_id } = (await open(w.sam, conv.id)).body;
  let { call } = await callOf(w.sam, call_id);
  assert.equal(call.status, 'uploaded');
  assert.equal(call.transcript, null);
  assert.match(call.error, /Metaview has no transcript for this conversation yet/);
  assert.equal(call.notes, null);
  assert.equal(call.notes_pending, false, 'there is nothing for notes to be written from, so nothing is waited for');
  assert.equal(call.duration_ms, conv.minutes * 60000);
  assert.equal((await w.sam.post(`/oracle/calls/${call_id}/notes`)).status, 400);
  // Metaview finishes writing it out. The next look at the list notices, and the transcript and the notes arrive.
  conv.has_transcript = true;
  call = (await until(() => callOf(w.sam, call_id), (d) => d.call.notes)).call;
  assert.equal(call.status, 'ready');
  assert.equal(call.error, null);
  assert.ok(call.transcript.length > 5);
  assert.equal(call.speakers[0], 'Jordan Reyes');
  assert.equal((await row(conv.id)).has_transcript, true);
});

test('notes Metaview never writes are given up on after a few tries, and can then be written here', async () => {
  standIn.notesAfter = Infinity;
  const conv = standIn.at(2);
  const before = anthropic.requests.length;
  const { call_id } = (await open(w.sam, conv.id)).body;
  const { call } = await until(() => callOf(w.sam, call_id), (d) => d.call.notes_error, 20000);
  assert.match(call.notes_error, /Metaview has not written notes for this conversation/);
  assert.equal(call.notes, null);
  assert.equal(call.notes_pending, false);
  // Asked for when it was opened and five times after that, then left alone.
  assert.equal(fetchesOf(conv.id), 6);
  await sleep(700);
  assert.equal(fetchesOf(conv.id), 6);
  assert.equal(anthropic.requests.length, before, 'The Book\'s own AI was not asked unasked');
  const written = await w.sam.post(`/oracle/calls/${call_id}/notes`);
  assert.equal(written.status, 200);
  assert.equal((await callOf(w.sam, call_id)).call.notes_error, null);
  standIn.notesAfter = 1;
});

test('new conversations are found by themselves, and changes to recent ones are picked up', async () => {
  const known = (await status()).known;
  const fresh = standIn.add({ person: PEOPLE[0], minutesAgo: 1, minutes: 9, channel: 'Phone' });
  const found = await until(() => row(fresh.id), Boolean);
  assert.equal(found.match.candidate_id, c.byEmail.candidate_id);
  assert.equal((await listed()).calls[0].id, fresh.id);
  assert.equal((await status()).known, known + 1);
  // Metaview corrects a name and the length of a recent conversation.
  const recent = standIn.at(6);
  recent.other.shown = 'Grace Quigley-Stone';
  recent.minutes = 44;
  const corrected = await until(() => row(recent.id), (r) => r.minutes === 44);
  assert.equal(corrected.people[0].name, 'Grace Quigley-Stone');
  assert.deepEqual((await listed('q=quigley-stone')).calls.map((call) => call.id), [recent.id]);
  // "Refresh" looks now: with the ten minutes between looks that the real thing has, that is what a person would press.
  const refresh = await w.priya.post('/metaview/refresh');
  assert.equal(refresh.status, 202);
  assert.deepEqual(refresh.body, { ok: true });
});

test('every way Metaview can fail is survived, said plainly, and recovered from without anyone doing anything', async () => {
  const fails = async (fault, sentence) => {
    standIn.fault = fault;
    const during = await until(status, (s) => s.error, 20000);
    assert.equal(during.error, sentence, fault);
    assert.equal(during.connected, true);
    // The rest of The Book carries on: lists answer, calls open.
    assert.equal((await w.priya.get('/metaview/calls?limit=1')).status, 200);
    assert.equal((await w.priya.get('/oracle/calls')).status, 200);
    standIn.fault = null;
    await settled();
  };
  await fails('500', NOT_ANSWERING);
  await fails('slow', NOT_ANSWERING);
  await fails('drop', NOT_ANSWERING);
  await fails('429', BUSY);
  await fails('tool-error', COULD_NOT);
  await fails('malformed', UNREADABLE);
  await fails('garbage', UNREADABLE);

  // Busy twice and then fine: it is tried again after a pause, and nobody hears about it.
  const errorsBefore = (server.output().match(/Metaview: busy/g) || []).length;
  const from = standIn.requests.length;
  standIn.faults.push('429', '429');
  await w.priya.post('/metaview/refresh');
  await until(async () => standIn.requests.slice(from).map((r) => r.fault), (faults) => faults.filter((f) => f === '429').length === 2 && faults.at(-1) === null);
  assert.equal((await status()).error, null);
  assert.equal((server.output().match(/Metaview: busy/g) || []).length, errorsBefore);

  // Opening a call while Metaview is down: refused with the reason, and nothing half-made is left behind.
  const inTheBook = (await status()).in_the_book;
  standIn.fault = '500';
  const refused = await open(w.sam, standIn.at(49).id);
  assert.equal(refused.status, 502);
  assert.equal(refused.body.error, NOT_ANSWERING);
  standIn.fault = null;
  assert.equal((await settled()).in_the_book, inTheBook);
  assert.equal((await row(standIn.at(49).id)).call_id, null);
  // A call that is already in opens whatever state Metaview is in.
  standIn.fault = '500';
  assert.equal((await open(w.sam, standIn.at(0).id)).status, 200);
  standIn.fault = null;
  await settled();

  // The key is withdrawn at Metaview: the status says so, and all is well again once it is accepted again.
  standIn.keys.clear();
  assert.equal((await until(status, (s) => s.error)).error, KEY_REFUSED);
  assert.equal((await open(w.sam, standIn.at(49).id)).status, 502);
  standIn.keys.add(GOOD_KEY);
  await settled();

  // Metaview may answer without the event stream; that is read just the same.
  standIn.plainJson = true;
  const plain = standIn.add({ person: PEOPLE[1], minutesAgo: 1 });
  await until(() => row(plain.id), Boolean);
  const opened = await open(w.sam, plain.id);
  assert.equal(opened.status, 200);
  assert.ok((await callOf(w.sam, opened.body.call_id)).call.transcript.length > 5);
  standIn.plainJson = false;
  // Through all of it the server never stopped, and never had two requests with Metaview at once.
  assert.equal((await w.owner.get('/me')).status, 200);
  assert.equal(standIn.mostAtOnce, 1);
});

test('deleting a candidate deletes the calls brought in for them', async () => {
  const theirs = (await w.owner.get(`/oracle/calls?candidate_id=${c.byPhone.candidate_id}`)).body;
  assert.ok(theirs.length >= 2);
  assert.ok(theirs.every((call) => call.source === 'metaview'));
  const before = await status();
  assert.equal((await w.owner.del(`/candidates/${c.byPhone.candidate_id}`)).status, 200);
  for (const call of theirs) assert.equal((await w.owner.get(`/oracle/calls/${call.id}`)).status, 404);
  const after = await status();
  assert.equal(after.in_the_book, before.in_the_book - theirs.length);
  assert.equal(after.known, before.known, 'that the conversations exist in Metaview is still listed');
  const jonas = await row(standIn.at(1).id);
  assert.deepEqual([jonas.call_id, jonas.match, jonas.suggestions], [null, null, []]);
  look(dataDir, (all) => assert.equal(all('SELECT COUNT(*) AS n FROM calls WHERE candidate_id = ?', c.byPhone.candidate_id)[0].n, 0));
});

test('only the read-only tools were ever asked for, each with a reason, and the key went nowhere it should not', async () => {
  const good = standIn.requests.filter((r) => r.keyOk);
  assert.ok(good.length > 20);
  for (const r of good) {
    assert.equal(r.rpc, 'tools/call');
    assert.ok(READ_ONLY_TOOLS.includes(r.tool), r.tool);
    assert.ok(['get_user_context', 'search_conversations'].includes(r.tool), r.tool);
    assert.ok(typeof r.args.rationale === 'string' && r.args.rationale.length > 10);
    assert.equal(r.contentType, 'application/json');
    assert.equal(r.accept, 'application/json, text/event-stream');
    assert.equal(r.protocol, '2025-06-18');
    assert.ok(!r.args.limit || r.args.limit <= 50);
    assert.equal(r.args.filters, undefined);
  }
  // A transcript is only ever asked for one conversation at a time.
  assert.ok(good.filter((r) => r.args.fields?.includes('default:transcript')).every((r) => r.args.conversation_ids?.length === 1));
  // Neither key is in the server's log, and the good one is not readable in any file of the data folder.
  for (const key of [GOOD_KEY, WRONG_KEY]) assert.equal(server.output().includes(key), false);
  for (const name of fs.readdirSync(dataDir)) {
    const file = path.join(dataDir, name);
    if (fs.statSync(file).isFile()) assert.equal(fs.readFileSync(file).includes(GOOD_KEY), false, name);
  }
  // Nor are the people Metaview told The Book about.
  assert.equal(/@mail\.example|5550\d{3}/.test(server.output()), false);
});

test('forgetting the key forgets what was never brought in; the calls in The Oracle stay', async () => {
  const before = await status();
  assert.ok(before.in_the_book >= 5 && before.known > 130);
  const kept = (await w.owner.get('/oracle/calls?source=metaview')).body;
  assert.equal(kept.length, before.in_the_book);
  const forgotten = await w.owner.del('/metaview/key');
  assert.equal(forgotten.status, 200);
  assert.deepEqual(forgotten.body, { ok: true });
  const after = await status();
  assert.deepEqual(after, { connected: false, workspace: null, source: null, can_manage: true, last_checked_at: null, known: before.in_the_book, in_the_book: before.in_the_book, catching_up: false, error: null, auto: false });
  look(dataDir, (all) => {
    assert.deepEqual(all(`SELECT key FROM settings WHERE key LIKE 'metaview_%' AND key != 'metaview_auto'`), []);
    assert.equal(all('SELECT COUNT(*) AS n FROM metaview_calls WHERE call_id IS NULL')[0].n, 0);
  });
  // What is left of the list is the calls that are in The Oracle, and they still open, with nothing asked of Metaview.
  const asked = standIn.requests.length;
  const left = await listed();
  assert.equal(left.total, before.in_the_book);
  assert.deepEqual(left.calls.map((call) => call.call_id).sort(), kept.map((call) => call.id).sort());
  assert.equal((await open(w.sam, left.calls[0].id)).body.call_id, left.calls[0].call_id);
  assert.equal((await callOf(w.sam, kept[0].id)).call.source, 'metaview');
  assert.equal((await open(w.sam, standIn.at(100).id)).status, 404);
  assert.equal((await w.sam.post('/metaview/refresh')).status, 409);
  await sleep(700);
  assert.equal(standIn.requests.length, asked, 'the background stopped asking');
  // Connecting again starts the list afresh, and does not bring the same conversations in twice.
  await connect(w.owner);
  const again = await settled();
  assert.equal(again.known, standIn.conversations.length);
  assert.equal(again.in_the_book, before.in_the_book);
  assert.equal((await open(w.sam, standIn.at(0).id)).body.call_id, (await row(standIn.at(0).id)).call_id);
  assert.equal((await w.owner.get('/oracle/calls?source=metaview')).body.length, before.in_the_book);
});
