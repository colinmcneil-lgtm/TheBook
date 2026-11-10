// The small readers behind Metaview in Otterview, on their own: what an answer from Metaview says, a transcript's
// lines, who a conversation was with, and the sealing of the key. Run with `npm test`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import { tempDir } from './oracle-helpers.mjs';

// The modules open the database when they load, so they are pointed at a folder of their own first.
process.env.DATA_DIR = tempDir('metaview-units');
process.env.METAVIEW_API_URL = 'http://127.0.0.1:9/mcp';   // nothing listens here: no test in this file may reach Metaview
process.env.METAVIEW_RETRY_MS = '5';
const { messagesIn, startTime, metaviewPage, readConversation, transcriptTurns, onlyANumber, askMetaview, MetaviewError, READ_ONLY } = await import('../server/metaview-client.js');
const { nameTokens, namesAgree, phoneParts, phonesIn, sameNumber, decide, acrossPeople, fold } = await import('../server/match.js');
const { seal, unseal } = await import('../server/secret.js');
test.after(() => fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }));

test('an answer is found in an event stream, with or without other messages around it, and in plain JSON', () => {
  const answer = { jsonrpc: '2.0', id: 7, result: { content: [{ type: 'text', text: '{}' }] } };
  const note = { jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info' } };
  const stream = `event: message\ndata: ${JSON.stringify(note)}\n\nevent: message\nid: 3\ndata: ${JSON.stringify(answer)}\n\n`;
  assert.deepEqual(messagesIn(stream, 'text/event-stream'), [note, answer]);
  assert.deepEqual(messagesIn(stream.replace(/\n/g, '\r\n'), 'text/event-stream; charset=utf-8'), [note, answer]);
  // A message written over several "data:" lines is one message; comments and blank blocks are skipped.
  assert.deepEqual(messagesIn(': keep-alive\n\ndata: {"jsonrpc":"2.0",\ndata: "id":7,"result":{}}\n\n\n\n', 'text/event-stream'), [{ jsonrpc: '2.0', id: 7, result: {} }]);
  assert.deepEqual(messagesIn(JSON.stringify(answer), 'application/json'), [answer]);
  assert.deepEqual(messagesIn(JSON.stringify([note, answer]), 'application/json'), [note, answer]);
  assert.throws(() => messagesIn('<html>Bad gateway</html>', 'text/html'));
  assert.throws(() => messagesIn('data: {"half":\n\n', 'text/event-stream'));
});

test('The Book cannot be made to ask Metaview for anything that writes', async () => {
  assert.deepEqual([...READ_ONLY].sort(), ['get_user_context', 'list_field_values', 'list_fields', 'search_conversations']);
  for (const tool of ['generate_notes', 'create_ai_field', 'manage_sequence', 'submit_feedback', 'update_screen_plan', 'enrich_candidate_contacts', '']) {
    // Refused before any request is made (the address here is one nothing listens on).
    await assert.rejects(askMetaview('a-key', tool, { rationale: 'x' }), /only reads from Metaview/);
  }
});

test('what goes wrong on the way to Metaview is described without the key, even when the key itself is what was wrong', async () => {
  // Nothing is listening (on a port that was free a moment ago): the code for that is all that is kept.
  const free = await new Promise((resolve) => { const probe = net.createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); }); });
  process.env.METAVIEW_API_URL = `http://127.0.0.1:${free}/mcp`;
  const refused = await askMetaview('mv-a-secret-key', 'get_user_context', { rationale: 'x' }).catch((err) => err);
  assert.ok(refused instanceof MetaviewError);
  assert.deepEqual([refused.kind, refused.detail], ['silent', 'ECONNREFUSED']);
  // A key with a line break in it cannot be sent at all, and the complaint about that quotes it. None of it is kept.
  const unsendable = await askMetaview('mv-a-secret\nkey-on-two-lines', 'get_user_context', { rationale: 'x' }).catch((err) => err);
  assert.ok(unsendable instanceof MetaviewError);
  assert.deepEqual([unsendable.kind, unsendable.detail], ['silent', 'the request could not be made']);
  assert.equal(/mv-a-secret|two-lines/.test(`${unsendable.message} ${unsendable.detail} ${unsendable.stack}`), false);
  // A request whose connection has ended by the time its turn comes is never sent.
  await assert.rejects(askMetaview('a-key', 'get_user_context', { rationale: 'x' }, { stillWanted: () => false }), /no longer wanted/);
});

test('the two ways Metaview writes a time are read to the same moment', () => {
  assert.equal(startTime('2026-11-09 23:40:45.014643+00:00'), '2026-11-09T23:40:45.014Z');
  assert.equal(startTime('2026-11-09 22:00:00+00:00'), '2026-11-09T22:00:00.000Z');
  assert.equal(startTime('2026-11-09T22:00:00Z'), '2026-11-09T22:00:00.000Z');
  assert.equal(startTime('2026-11-09 18:00:00-0500'), '2026-11-09T23:00:00.000Z');
  assert.equal(startTime('2026-11-09 18:00:00.5'), '2026-11-09T18:00:00.500Z', 'no zone given is read as UTC');
  for (const bad of ['', null, undefined, 'yesterday', '2026-13-45 99:00:00+00:00', 1762731645, '2026-11-09']) assert.equal(startTime(bad), null, String(bad));
});

test('only a link to Metaview itself is kept as a call\'s link', () => {
  assert.equal(metaviewPage('https://app.metaview.ai/notes/123456789'), 'https://app.metaview.ai/notes/123456789');
  for (const bad of ['http://app.metaview.ai/notes/1', 'javascript:alert(1)', 'https://metaview.ai.evil.example/notes/1', 'https://evil.example/?x=app.metaview.ai', '', null, 'notes/1'])
    assert.equal(metaviewPage(bad), null, String(bad));
});

test('a conversation from the list: the fields are lists that may be empty or missing, and everyone has a part', () => {
  const who = (value, name, emails = [], phone_numbers = []) => ({ value, label: name, details: { name, emails, phone_numbers } });
  const raw = {
    id: 123456789, url: 'https://app.metaview.ai/notes/123456789', has_transcript: true,
    fields: {
      'default:start_time': [{ value: '2026-11-09 23:40:45.014643+00:00', label: 'x' }],
      'default:calendar_event_title': [{ value: '', label: '' }],
      'default:candidate': [who('c1', 'Dana  Whitlock', [], ['+1 (416) 555-0100'])],
      'default:interviewer': [who('i1', 'Priya Nair', ['Priya@Agency.Example', 'not an address'], ['+16475550142'])],
      'default:contact': [who('c1', 'Dana Whitlock'), who('i1', 'Priya Nair'), who('x1', 'Morgan Lee', ['morgan@client.example'])],
      'default:conversation_type': [{ value: 'uuid', label: 'Job Interview' }],
      'default:call_duration': [{ value: 5, label: '5' }],
      'default:video_conferencing_platform': [{ value: 'Phone', label: 'Phone' }],
      'default:phone_number': [{ value: '+14165550100', label: '+14165550100' }, { value: '+14165550199', label: '' }],
      'default:language': [{ value: 'English (US)', label: 'English (US)' }],
    },
  };
  assert.deepEqual(readConversation(raw), {
    id: 123456789, url: 'https://app.metaview.ai/notes/123456789', startedAt: '2026-11-09T23:40:45.014Z', title: '', kind: 'Job Interview', channel: 'Phone', minutes: 5,
    hasTranscript: true,
    people: [
      // The candidate first, with the conversation's own number added to theirs; then anyone else; then the interviewers.
      { name: 'Dana Whitlock', role: 'candidate', emails: [], phones: ['+1 (416) 555-0100', '+14165550100', '+14165550199'] },
      // No more is kept than is used: with a candidate on the call nobody else's address is needed, and an
      // interviewer is known by their address, never by their own number.
      { name: 'Morgan Lee', role: 'other', emails: [], phones: [] },
      { name: 'Priya Nair', role: 'interviewer', emails: ['priya@agency.example'], phones: [] },
    ],
  });
  // When Metaview names no candidate, anybody who is not an interviewer may be the one, so they keep what they can be matched by.
  const unnamedParts = readConversation({ ...raw, fields: { ...raw.fields, 'default:candidate': [], 'default:phone_number': [] } });
  assert.deepEqual(unnamedParts.people, [
    { name: 'Dana Whitlock', role: 'other', emails: [], phones: [] },
    { name: 'Morgan Lee', role: 'other', emails: ['morgan@client.example'], phones: [] },
    { name: 'Priya Nair', role: 'interviewer', emails: ['priya@agency.example'], phones: [] },
  ]);
  assert.equal('language' in unnamedParts, false, 'the language is not used, so it is not kept');
  // An interviewer listed again among "everybody", under another identity, is still only an interviewer.
  const repeated = readConversation({ ...raw, fields: { ...raw.fields, 'default:contact': [who('other-id-1', 'Somebody Else', ['priya@agency.example']), who('other-id-2', 'Dana Whitlock')] } });
  assert.deepEqual(repeated.people.map((p) => [p.name, p.role]), [['Dana Whitlock', 'candidate'], ['Priya Nair', 'interviewer']]);
  // Almost everything can be missing.
  assert.deepEqual(readConversation({ id: 5, fields: { 'default:start_time': [{ value: '2026-11-09 22:00:00+00:00' }] } }),
    { id: 5, url: null, startedAt: '2026-11-09T22:00:00.000Z', title: '', kind: '', channel: '', minutes: null, hasTranscript: false, people: [] });
  // A number with nobody to give it to is still kept, to match by.
  const numberOnly = readConversation({ id: 6, fields: { 'default:start_time': [{ value: '2026-11-09 22:00:00+00:00' }], 'default:phone_number': [{ value: '+14165550100' }] } });
  assert.deepEqual(numberOnly.people, [{ name: '', role: 'candidate', emails: [], phones: ['+14165550100'] }]);
  // Somebody Metaview has no name for is called by their number there. It stays what they are called, and is their number too.
  const unnamed = readConversation({ ...raw, fields: { ...raw.fields, 'default:candidate': [who('c9', '+14165550123')], 'default:contact': [], 'default:phone_number': [] } });
  assert.deepEqual(unnamed.people[0], { name: '+14165550123', role: 'candidate', emails: [], phones: ['+14165550123'] });
  for (const number of ['+14165550123', '(416) 555-0123', '416.555.0123', ' 4165550123 ']) assert.equal(onlyANumber(number), true, number);
  for (const name of ['Dana', 'Dana 2', 'R2-D2', '12345', '', null, 'x4165550123']) assert.equal(onlyANumber(name), false, String(name));
  // Without a number of its own or a start time there is nothing to file it under.
  for (const bad of [null, {}, { id: 'abc', fields: raw.fields }, { id: 7, fields: {} }, { id: 7, fields: { 'default:start_time': 'soon' } }, { id: -1, fields: raw.fields }]) assert.equal(readConversation(bad), null);
  // Text from outside is tidied and cut: no line breaks, nothing endless.
  const untidy = readConversation({ ...raw, url: 'javascript:alert(1)', fields: { ...raw.fields, 'default:calendar_event_title': [{ value: `Interview\nwith\tDana ${'x'.repeat(500)}` }], 'default:call_duration': [{ value: 'long' }] } });
  assert.equal(untidy.title.length, 160);
  assert.ok(untidy.title.startsWith('Interview with Dana x'));
  assert.equal(untidy.url, null);
  assert.equal(untidy.minutes, null);
});

test('a transcript\'s lines become turns with seconds and named speakers', () => {
  const { turns, speakers } = transcriptTurns([
    'Priya Nair (Interviewer) @0:00-0:04: Hi Dana, thanks for making the time.',
    'Dana Whitlock (Candidate) @0:04-0:11: Good, thanks. The ratio is 3:1 (roughly) @ the moment.',
    'and I should add one thing.',
    '',
    'Priya Nair (Interviewer) @0:10-0:15: Go on.',                       // starts before the turn before it ended: people talk over each other
    'Dana (Dee) Whitlock (Candidate) @59:58-1:00:07: That is the hour.',  // a bracket in a name; a time that crosses the hour
    ' (Candidate) @1:02:03-1:02:09: No name was given for this one.',
    'Priya Nair (Interviewer) @1:15:00-1:14:00:   ',                      // nothing was said: not a turn
    'Priya Nair (Interviewer) @75:30-75:20: Minutes can run past sixty.',
    '+14165550123 (Candidate) @75:40-75:50: A number is not a name.',     // Metaview knew this caller only by their number
  ].join('\r\n'));
  assert.deepEqual(speakers, { 0: 'Priya Nair', 1: 'Dana Whitlock', 2: 'Dana (Dee) Whitlock', 3: 'Candidate' });
  assert.deepEqual(turns, [
    { speaker: 0, start: 0, end: 4, text: 'Hi Dana, thanks for making the time.' },
    { speaker: 1, start: 4, end: 11, text: 'Good, thanks. The ratio is 3:1 (roughly) @ the moment. and I should add one thing.' },
    { speaker: 0, start: 10, end: 15, text: 'Go on.' },
    { speaker: 2, start: 3598, end: 3607, text: 'That is the hour.' },
    { speaker: 3, start: 3723, end: 3729, text: 'No name was given for this one.' },
    { speaker: 0, start: 4530, end: 4530, text: 'Minutes can run past sixty.' },   // an end before its start is not believed
    { speaker: 3, start: 4540, end: 4550, text: 'A number is not a name.' },       // called by their part in the call, like anybody with no name
  ]);
  // Nothing, or text that is not a transcript, gives no turns rather than a guess.
  for (const empty of ['', null, undefined, 'Just some words with no speaker.\nAnd some more.']) assert.deepEqual(transcriptTurns(empty), { turns: [], speakers: {} });
  // A very long line is dealt with quickly.
  const from = performance.now();
  transcriptTurns(`${'a ('.repeat(40000)} @0:00-0:01: x\n${'('.repeat(100000)}`);
  assert.ok(performance.now() - from < 500);
});

test('names and numbers are compared in a form that ignores how they were written', () => {
  assert.deepEqual(nameTokens('Tremblay, Kévin (Client)'), ['kevin', 'tremblay']);
  assert.deepEqual(nameTokens('  Dr. ZOË  O\'Brien-Smith  '), ['zoe', "o'brien-smith"]);
  assert.deepEqual(nameTokens('Kevin'), ['kevin']);
  assert.deepEqual(nameTokens(null), []);
  assert.equal(fold('Zoë ÉCOLE'), 'zoe ecole');
  // Two names may be one person's when the first and last words agree, or one is the other with something added.
  const agree = (a, b) => namesAgree(nameTokens(a), nameTokens(b));
  for (const [a, b] of [['Otto Vale', 'otto vale'], ['Otto', 'Otto Vale'], ['Ana Ruiz', 'Ana Ruiz Ortega'], ['Dana M. Tremblay', 'Dana Tremblay'], ['Dr Sam Cole', 'Sam Cole']]) assert.equal(agree(a, b), true, `${a} / ${b}`);
  for (const [a, b] of [['Otto Vale', 'Ines Vale'], ['Otto', 'Ines Vale'], ['Dana Tremblay', 'D. Tremblay-Roy'], ['', 'Otto Vale'], ['Otto Vale', null]]) assert.equal(agree(a, b), false, `${a} / ${b}`);

  // A number is its last ten digits and what came before them. Ten digits with nothing in front are North American.
  for (const typed of ['+1 (647) 555-0199', '647.555.0199', '1-647-555-0199', '6475550199', ' 647 555 0199 ', '647/555/0199', '647-555-0199 ext 4', '(647) 555-0199 x12', '647 555 0199 poste 3', '6475550199 #2', 'cell: 647-555-0199'])
    assert.deepEqual(phoneParts(typed), { tail: '6475550199', lead: '1' }, typed);
  assert.deepEqual(phoneParts('+44 7700 900123'), { tail: '7700900123', lead: '44' });
  assert.deepEqual(phoneParts('0044 7700 900123'), { tail: '7700900123', lead: '44' });
  assert.deepEqual(phoneParts('07700 900123'), { tail: '7700900123', lead: '' }, 'dialled from inside another country: which country is not known');
  for (const not of ['555-0199', '', null, 'call me', 5550199, '647 555 0199 647 555 0188']) assert.equal(phoneParts(not), null, String(not));
  // What somebody typed into a phone box is usually one number, and sometimes two.
  assert.deepEqual(phonesIn('416-555-0183 / 647-555-0199'), [{ tail: '4165550183', lead: '1' }, { tail: '6475550199', lead: '1' }]);
  assert.deepEqual(phonesIn('416-555-0183 or 647-555-0199 (evenings)'), [{ tail: '4165550183', lead: '1' }, { tail: '6475550199', lead: '1' }]);
  assert.deepEqual(phonesIn('416/555/0184'), [{ tail: '4165550184', lead: '1' }]);
  assert.deepEqual(phonesIn('ask her sister'), []);
  assert.deepEqual(phonesIn(null), []);
  // The same ten digits in two countries are two numbers. With the country missing on one side they may be the same, and no more.
  const same = (a, b) => sameNumber(phoneParts(a), phoneParts(b));
  assert.equal(same('+1 416 555 0158', '416-555-0158'), 2);
  assert.equal(same('+44 4165 550158', '0044 4165 550158'), 2);
  assert.equal(same('+44 4165 550158', '+1 416 555 0158'), 0);
  assert.equal(same('+44 4165 550158', '416 555 0158'), 0, 'ten digits with nothing in front are a North American number');
  assert.equal(same('+44 7700 900123', '07700 900123'), 1);
  assert.equal(same('+1 770 090 0123', '07700 900123'), 0);
  assert.equal(same('416-555-0158', '416-555-0159'), 0);
  assert.equal(same('416-555-0158', 'no number'), 0);
});

test('who a conversation was with: strong evidence chooses, weak evidence only offers, and evidence that disagrees chooses nobody', () => {
  const person = (id, more = {}) => ({ id, name: `Person ${id}`, email: `p${id}@mail.example`, phone: null, ...more });
  const active = () => ({ status: 'active' });
  const picked = (found, best = active) => { const { person: who, how, sure, offered } = decide(found, best); return [who?.id ?? null, how, sure, offered.map((p) => `${p.id} ${p.how}`)]; };
  // One record by address, or by number: chosen, and certain enough to act on with nobody looking.
  assert.deepEqual(picked({ byEmail: [person(1)] }), [1, 'email', true, []]);
  assert.deepEqual(picked({ byPhone: [person(2)] }), [2, 'phone', true, []]);
  assert.deepEqual(picked({ byEmail: [person(1)], byPhone: [person(1)] }), [1, 'email', true, []], 'the address and the number are the same record\'s');
  // A number that only may be theirs (the country is not known) chooses, but is never acted on unasked.
  assert.deepEqual(picked({ byPhone: [person(2)], loose: true }), [2, 'phone', false, []]);
  // The address is one candidate's and the number is another's: nobody is chosen, both are offered.
  assert.deepEqual(picked({ byEmail: [person(1)], byPhone: [person(2)] }), [null, 'email', false, ['1 email', '2 phone']]);
  // The address is one candidate's, and another candidate has exactly the name on the conversation: the same.
  const dana = person(3, { name: 'Dana Whitlock' });
  assert.deepEqual(picked({ words: ['dana', 'whitlock'], byEmail: [person(1)], byName: [dana] }), [null, 'email', false, ['1 email', '3 name']]);
  // But a namesake on file is no reason to doubt an address that belongs to somebody of that very name.
  assert.deepEqual(picked({ words: ['dana', 'whitlock'], byEmail: [person(4, { name: 'Dana M. Whitlock' })], byName: [dana] }), [4, 'email', true, []]);
  // An exact full name chooses, but is never certain enough to act on unasked.
  assert.deepEqual(picked({ byName: [person(3)] }), [3, 'name', false, []]);
  // Part of a name only ever offers.
  assert.deepEqual(picked({ partial: [person(4), person(5)] }), [null, 'name', false, ['4 name', '5 name']]);
  assert.deepEqual(picked({}), [null, 'name', false, []]);
  assert.equal(decide({ partial: [person(4)] }, active).firm, false);
  assert.equal(decide({ byName: [person(4), person(5)] }, active).firm, true);

  // One address on two records of one name (the same person under two clients): chosen only when just one is still in progress, and never "certain".
  const twice = [person(6, { name: 'Chloe Castillo', email: 'same@mail.example' }), person(7, { name: 'Chloe Castillo', email: 'same@mail.example' })];
  assert.deepEqual(picked({ byEmail: twice }), [null, 'email', false, ['6 email', '7 email']]);
  assert.deepEqual(picked({ byEmail: twice }, (p) => ({ status: p.id === 7 ? 'active' : 'rejected' })), [7, 'email', false, []]);
  // One number on two records of different names (a household): they are two people, whichever is still in progress.
  const household = [person(8, { name: 'Ines Vale' }), person(9, { name: 'Otto Vale' })];
  const inesInProgress = (p) => ({ status: p.id === 8 ? 'active' : 'rejected' });
  assert.deepEqual(picked({ byPhone: household }, inesInProgress), [null, 'phone', false, ['8 phone', '9 phone']], 'no name on the conversation: both are offered');
  assert.deepEqual(picked({ words: ['otto', 'vale'], byPhone: household }, inesInProgress), [9, 'phone', false, []], 'the name on the conversation says which of them it was');
  assert.deepEqual(picked({ words: ['otto'], byPhone: household }, inesInProgress), [9, 'phone', false, []]);
  assert.deepEqual(picked({ words: ['ines', 'vale'], byPhone: household }, inesInProgress), [8, 'phone', false, []]);
  assert.deepEqual(picked({ words: ['vale'], byPhone: household }, inesInProgress), [null, 'phone', false, ['8 phone', '9 phone']], 'a name that fits both says nothing');
  assert.deepEqual(picked({ words: ['somebody', 'else'], byPhone: household }, inesInProgress), [null, 'phone', false, ['8 phone', '9 phone']]);
  // Two addresses that belong to two different people: offered, not chosen.
  assert.deepEqual(picked({ byEmail: [person(8), person(9)] }), [null, 'email', false, ['8 email', '9 email']]);
  // Two records with the same name are one person only if an address or a number says so.
  assert.deepEqual(picked({ byName: [person(10), person(11)] }), [null, 'name', false, ['10 name', '11 name']]);
  assert.deepEqual(picked({ byName: [person(12, { email: 'x@mail.example' }), person(13, { email: 'x@mail.example' })] }, (p) => ({ status: p.id === 12 ? 'active' : 'hired' })), [12, 'name', false, []]);
  assert.deepEqual(picked({ byName: [person(12, { phone: '416-555-0158' }), person(13, { phone: '+1 (416) 555 0158 ext 2' })] }, (p) => ({ status: p.id === 12 ? 'active' : 'hired' })), [12, 'name', false, []]);
  // Somebody with no application left cannot be matched to anything.
  assert.deepEqual(picked({ byEmail: [person(14)] }, () => undefined), [null, 'email', false, []]);
});

test('several people on one call choose a candidate only when they are all the same one', () => {
  const person = (id) => ({ id, name: `Person ${id}` });
  const chosen = (id, how, sure = how !== 'name') => ({ person: person(id), how, sure, firm: true, offered: [] });
  const offered = (ids, how, firm) => ({ person: null, how, sure: false, firm, offered: ids.map((id) => ({ ...person(id), how })) });
  const nobody = offered([], 'name', false);
  const result = (verdicts) => { const { person: who, how, sure, offered: list } = acrossPeople(verdicts); return [who?.id ?? null, how, sure, list.map((p) => `${p.id} ${p.how}`)]; };
  assert.deepEqual(result([chosen(1, 'email')]), [1, 'email', true, []]);
  assert.deepEqual(result([chosen(1, 'phone'), nobody]), [1, 'phone', true, []], 'somebody nothing is known about changes nothing');
  assert.deepEqual(result([chosen(1, 'name'), chosen(1, 'email')]), [1, 'email', true, []], 'the same candidate twice over, by the stronger evidence');
  // Two candidates on one call: it belongs to neither for certain.
  assert.deepEqual(result([chosen(1, 'email'), chosen(2, 'phone')]), [null, 'email', false, ['1 email', '2 phone']]);
  assert.deepEqual(result([chosen(1, 'email'), offered([2, 3], 'phone', true)]), [null, 'email', false, ['1 email', '2 phone', '3 phone']]);
  // Somebody known by a first name only is not evidence against a match, and is offered only when there is nothing better.
  assert.deepEqual(result([chosen(1, 'email'), offered([4, 5], 'name', false)]), [1, 'email', true, []]);
  assert.deepEqual(result([offered([4, 5], 'name', false), offered([5, 6], 'name', false)]), [null, 'name', false, ['4 name', '5 name', '6 name']]);
  assert.deepEqual(result([]), [null, 'name', false, []]);
});

test('what is sealed can only be opened by this server, for the purpose it was sealed for', () => {
  const sealed = seal('mv-a-secret-key', 'metaview-key');
  assert.match(sealed, /^v1\./);
  assert.equal(sealed.includes('mv-a-secret-key'), false);
  assert.equal(unseal(sealed, 'metaview-key'), 'mv-a-secret-key');
  assert.notEqual(seal('mv-a-secret-key', 'metaview-key'), sealed, 'sealing the same thing twice does not give the same text');
  assert.equal(unseal(sealed, 'another-purpose'), null);
  assert.equal(unseal(`${sealed.slice(0, -2)}xx`, 'metaview-key'), null, 'a changed value is refused, not misread');
  for (const junk of ['', null, 'v2.a.b.c', 'not sealed at all']) assert.equal(unseal(junk, 'metaview-key'), null);
  // The secret itself is a file beside the database, readable by the server's own account only.
  assert.equal(fs.statSync(`${process.env.DATA_DIR}/server-secret`).mode & 0o777, 0o600);
});
