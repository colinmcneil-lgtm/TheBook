// Messages between people on the agency team, end to end: who can be written to, one conversation for each pair of
// people (also when two requests arrive at once), groups made, renamed, joined and left, writing and deleting,
// unread counts, the thread asking for what is new, a candidate or a job carried on a message and listed on their
// page, the e-mail heads-up and each person's switch for it, and what happens when a teammate is deactivated or
// removed, or a candidate or job is deleted. Above all: a client's user is refused on every route and is not told
// that messages exist, and nobody learns of a conversation they are not in. Run with `npm test`.
//
// One real server on a throwaway data folder, with e-mail delivery connected to a stand-in for the mail provider (so
// every message the server sends can be read whole). Two states cannot be reached through the app and are written
// straight into the database: a person removed outright (the app only ever deactivates people), and a second
// one-to-one conversation for a pair, which the database must refuse.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer, session, tempDir, until, sleep, PORTS } from './oracle-helpers.mjs';
import { look } from './metaview-helpers.mjs';

// The two ports kept for this file (see PORT_PLAN in oracle-helpers.mjs; a unit test checks that no two files share one).
const PORT = PORTS.messages, MAIL_PORT = PORTS.messagesMail;
const APP_URL = 'https://book.harbourtalent.example';

const listen = (server, port) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
const close = (server) => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
/** Stand-in for the mail provider: every e-mail handed over is kept whole. With `failing` set it answers with an error. */
async function mailStandIn(port) {
  const state = { sent: [], failing: false };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (state.failing) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end('{"message":"stand-in is down"}'); }
      state.sent.push(JSON.parse(raw));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"id":"stub"}');
    });
  });
  await listen(server, port);
  return Object.assign(state, { url: `http://127.0.0.1:${port}/emails`, to: (address) => state.sent.filter((m) => m.to.includes(address)), stop: () => close(server) });
}

let server, mail, dataDir;
let alex, priya, marcus, orla, maya; // the admin, three recruiters, and somebody on Kestrel's hiring team
let id;                              // each person's user id, by first name
let kestrel;
const job = {};
const app = {};

const ok = (res) => { assert.equal(res.status, 200, JSON.stringify(res.body)); return res.body; };
const refused = (res, status, words) => { assert.equal(res.status, status, JSON.stringify(res.body)); if (words) assert.match(res.body.error, words); };
function write(sql, ...values) {
  const db = new DatabaseSync(path.join(dataDir, 'app.db'));
  try { db.exec('PRAGMA foreign_keys = ON'); return db.prepare(sql).run(...values); } finally { db.close(); }
}
const rows = (sql, ...values) => look(dataDir, (all) => all(sql, ...values));
/** How many rows the tables a client's user is shown from hold, and the newest of each: none of it may change for a message. */
const clientTables = () => look(dataDir, (all) => Object.fromEntries(['activities', 'agency_activities', 'emails', 'agency_emails', 'notes']
  .map((table) => [table, all(`SELECT COUNT(*) AS n, MAX(id) AS last FROM ${table}`)[0]])));

const join = async (role, name, email, extra = {}) => {
  const { token } = ok(await alex.post('/invites', { role, email, ...extra }));
  const person = session(server.base);
  ok(await person.post(`/invites/${token}/accept`, { name, password: 'demo1234' }));
  return person;
};
const userIds = async () => Object.fromEntries(ok(await alex.get('/users')).map((u) => [u.name.split(' ')[0].toLowerCase(), u.id]));
const add = async (fields) => ok(await alex.upload('/applications', fields)).id;
const direct = async (who, userId) => ok(await who.post('/messages/conversations', { kind: 'direct', user_id: userId }));
const group = async (who, name, userIds) => ok(await who.post('/messages/conversations', { kind: 'group', name, user_ids: userIds })).id;
const say = async (who, conversationId, body, extra = {}) => ok(await who.post(`/messages/conversations/${conversationId}/messages`, { body, ...extra })).message;
const thread = async (who, conversationId, query = '') => ok(await who.get(`/messages/conversations/${conversationId}${query}`));
const list = async (who) => ok(await who.get('/messages/conversations'));
const unread = async (who) => ok(await who.get('/nav')).messages;
const markRead = async (who, conversationId) => ok(await who.post(`/messages/conversations/${conversationId}/read`));
const about = async (who, query) => ok(await who.get(`/messages/about?${query}`));
/** Wait long enough for an e-mail that is not going to be sent to have been sent, were it going to be. */
const settle = () => sleep(400);

before(async () => {
  mail = await mailStandIn(MAIL_PORT);
  dataDir = tempDir('messages');
  server = await startServer({ port: PORT, dataDir, env: { RESEND_API_KEY: 'test-key', RESEND_API_URL: mail.url, MAIL_FROM: 'Harbour Talent <team@harbourtalent.example>', APP_URL } });
  alex = session(server.base);
  ok(await alex.post('/setup', { agencyName: 'Harbour Talent', name: 'Alex Morgan', email: 'alex@agency.example', password: 'demo1234' }));
  kestrel = ok(await alex.post('/clients', { name: 'Kestrel Logistics', brand_color: '#b45309' })).id;
  priya = await join('recruiter', 'Priya Nair', 'priya@agency.example');
  marcus = await join('recruiter', 'Marcus Bell', 'marcus@agency.example');
  orla = await join('recruiter', 'Orla Quillfeather', 'orla@agency.example');
  maya = await join('client', 'Maya Okonkwo', 'maya@kestrel.example', { client_id: kestrel });
  id = await userIds();
  job.sales = ok(await alex.post('/jobs', { client_id: kestrel, title: 'Head of Sales', status: 'open', description: 'A role.' })).id;
  app.ivo = await add({ job_id: job.sales, name: 'Ivo Interview', email: 'ivo@mail.example' });
  app.nora = await add({ name: 'Nora Nojob', email: 'nora@mail.example' }); // in The Book, on no job
});

after(async () => {
  await server?.stop();
  await mail?.stop();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

// ---------- a client's user ----------

test('a client’s user is refused on every route of Messages, and their /nav and /me answers have exactly the keys they had before', async () => {
  // What a client's user was sent before Messages existed, key for key.
  assert.deepEqual(Object.keys(ok(await maya.get('/nav'))).sort(), ['new_applicants', 'pending_accounts', 'pending_review', 'scorecards_due']);
  assert.deepEqual(Object.keys(ok(await maya.get(`/nav?client_id=${kestrel}`))).sort(), ['new_applicants', 'pending_accounts', 'pending_review', 'scorecards_due']);
  const me = ok(await maya.get('/me'));
  assert.deepEqual(Object.keys(me).sort(), ['agencyName', 'candidateMail', 'clientPhotos', 'clients', 'mailConfigured', 'user']);
  assert.deepEqual(Object.keys(me.user).sort(), ['active', 'client_id', 'email', 'id', 'name', 'role', 'title']);
  // The agency's own count is there for the agency.
  assert.equal(ok(await alex.get('/nav')).messages, 0);
  assert.equal('message_mail' in ok(await alex.get('/me')).user, false);

  const c = (await direct(alex, id.priya)).id;
  const m = await say(alex, c, 'For the agency only');
  for (const [method, pathname] of [['get', '/messages/people'], ['get', '/messages/settings'], ['put', '/messages/settings'], ['get', '/messages/conversations'], ['post', '/messages/conversations'],
    ['get', `/messages/conversations/${c}`], ['get', `/messages/conversations/${c}/messages?after=0`], ['post', `/messages/conversations/${c}/messages`], ['post', `/messages/conversations/${c}/read`],
    ['patch', `/messages/conversations/${c}`], ['post', `/messages/conversations/${c}/members`], ['post', `/messages/conversations/${c}/leave`], ['delete', `/messages/conversations/${c}/messages/${m.id}`],
    ['get', `/messages/about?application_id=${app.ivo}`], ['get', `/messages/about?job_id=${job.sales}`], ['get', '/messages/conversations/999999']]) {
    const body = { kind: 'direct', user_id: id.alex, body: 'From a client', name: 'x', user_ids: [id.alex, id.priya], email: false };
    const answer = method === 'get' ? await maya.get(pathname) : method === 'delete' ? await maya.del(pathname) : method === 'put' ? await maya.putJson(pathname, body) : await maya[method](pathname, body);
    refused(answer, 403, /Only the agency team can do this/);
    assert.equal(JSON.stringify(answer.body).includes('agency only'), false);
  }
  // Nothing she did reached the conversation, and the people she could be shown say nothing of it either.
  assert.deepEqual((await thread(alex, c)).messages.map((x) => x.body), ['For the agency only']);
  for (const pathname of ['/nav', '/me', '/users', '/dashboard', `/applications/${app.ivo}`, `/jobs/${job.sales}`]) {
    const body = JSON.stringify(ok(await maya.get(pathname)));
    for (const word of ['For the agency only', 'message_mail', '"messages"', 'conversation']) assert.equal(body.includes(word), false, `${pathname} mentions ${word}`);
  }
  // A visitor who is not signed in is told to sign in.
  refused(await session(server.base).get('/messages/conversations'), 401);
});

// ---------- one to one ----------

test('who can be written to: anybody active on the agency team but yourself, never a client’s user, somebody deactivated or somebody waiting', async () => {
  ok(await session(server.base).post('/signup', { name: 'Pat Pending', email: 'pat@agency.example' }));
  const dana = await join('recruiter', 'Dana Frost', 'dana@agency.example');
  id = await userIds();
  ok(await alex.patch(`/users/${id.dana}`, { active: false }));
  assert.ok(dana);
  assert.deepEqual(ok(await alex.get('/messages/people')).map((p) => p.name), ['Marcus Bell', 'Orla Quillfeather', 'Priya Nair']);
  assert.deepEqual(ok(await priya.get('/messages/people')).map((p) => p.name), ['Alex Morgan', 'Marcus Bell', 'Orla Quillfeather']);
  const before = rows('SELECT COUNT(*) AS n FROM conversations')[0].n;
  refused(await alex.post('/messages/conversations', { kind: 'direct', user_id: id.alex }), 400, /You cannot message yourself/);
  for (const userId of [id.maya, id.dana, id.pat, 999999, 'abc', null, true, [id.priya], `${id.priya}.0`, -1]) {
    refused(await alex.post('/messages/conversations', { kind: 'direct', user_id: userId }), 400, /Choose somebody who is active on your team/);
  }
  refused(await alex.post('/messages/conversations', { kind: 'chat', user_id: id.priya }), 400, /Choose one person/);
  assert.equal(rows('SELECT COUNT(*) AS n FROM conversations')[0].n, before, 'nothing was made');
});

test('one conversation for each pair: starting one you already have opens it, from either side, and two requests at once make one', async () => {
  const first = await direct(alex, id.priya); // made in the first test
  assert.equal(first.existing, true);
  assert.equal((await direct(priya, String(id.alex))).id, first.id, 'from the other side, the same one');
  // Marcus and Orla have none yet. Both ask at once, several times over.
  const answers = await Promise.all([direct(marcus, id.orla), direct(orla, id.marcus), direct(marcus, id.orla), direct(orla, id.marcus)]);
  assert.equal(new Set(answers.map((a) => a.id)).size, 1, JSON.stringify(answers));
  assert.deepEqual(answers.map((a) => a.existing).filter((e) => !e), [false], 'exactly one of them made it');
  const pair = [id.marcus, id.orla].sort((x, y) => x - y).join(':');
  assert.deepEqual(rows('SELECT id FROM conversations WHERE pair_key = ?', pair).map((r) => r.id), [answers[0].id]);
  assert.deepEqual(rows('SELECT user_id FROM conversation_members WHERE conversation_id = ? ORDER BY user_id', answers[0].id).map((r) => r.user_id), [id.marcus, id.orla].sort((x, y) => x - y));
  // And the database itself refuses a second one for the pair, whatever writes it.
  assert.throws(() => write(`INSERT INTO conversations (kind, pair_key, created_at, updated_at) VALUES ('direct', ?, 'x', 'x')`, pair), /UNIQUE constraint failed/);
  // A one-to-one has nobody to add and cannot be left or renamed.
  refused(await marcus.post(`/messages/conversations/${answers[0].id}/members`, { user_ids: [id.priya] }), 400, /only be added to a group/);
  refused(await marcus.post(`/messages/conversations/${answers[0].id}/leave`), 400, /Only a group can be left/);
  refused(await marcus.patch(`/messages/conversations/${answers[0].id}`, { name: 'Ours' }), 400, /Only a group has a name/);
});

test('a message is 1 to 4000 characters with its line breaks, carries one candidate or one job, and arrives once', async () => {
  const c = (await direct(alex, id.priya)).id;
  for (const body of [undefined, '', '   \n  ', 42, ['words']]) refused(await alex.post(`/messages/conversations/${c}/messages`, { body }), 400, /Write a message first/);
  refused(await alex.post(`/messages/conversations/${c}/messages`, { body: 'x'.repeat(4001) }), 400, /Keep a message to 4000 characters. This one has 4001/);
  assert.equal((await say(alex, c, 'y'.repeat(4000))).body.length, 4000);
  const lines = await say(alex, c, '  First line\r\nSecond line\n\nAfter a gap  ');
  assert.equal(lines.body, 'First line\nSecond line\n\nAfter a gap');
  // A candidate or a job, never both, and only one that is there.
  const withIvo = await say(alex, c, 'Have a look at Ivo', { application_id: app.ivo });
  assert.deepEqual(withIvo.attachment, { type: 'candidate', application_id: app.ivo, name: 'Ivo Interview', detail: 'Head of Sales at Kestrel Logistics' });
  assert.deepEqual((await say(alex, c, 'And Nora', { application_id: String(app.nora) })).attachment.detail, 'In The Book, not on a job');
  assert.deepEqual((await say(alex, c, 'This job', { job_id: job.sales })).attachment, { type: 'job', job_id: job.sales, title: 'Head of Sales', detail: 'Kestrel Logistics' });
  refused(await alex.post(`/messages/conversations/${c}/messages`, { body: 'Both', application_id: app.ivo, job_id: job.sales }), 400, /one candidate or one job, not both/);
  refused(await alex.post(`/messages/conversations/${c}/messages`, { body: 'Gone', application_id: 999999 }), 400, /That candidate is no longer in The Book/);
  refused(await alex.post(`/messages/conversations/${c}/messages`, { body: 'Gone', job_id: 'abc' }), 400, /That job is no longer in The Book/);
  // Asking for what is new after the last message there was gives each new message once.
  const { messages } = await thread(priya, c);
  const lastSeen = messages.at(-1).id;
  const sent = await say(alex, c, 'One more');
  const fresh = ok(await priya.get(`/messages/conversations/${c}/messages?after=${lastSeen}`));
  assert.deepEqual(fresh.messages.map((m) => [m.id, m.body, m.mine]), [[sent.id, 'One more', false]]);
  assert.deepEqual(ok(await priya.get(`/messages/conversations/${c}/messages?after=${sent.id}`)).messages, []);
  assert.equal(ok(await alex.get(`/messages/conversations/${c}/messages?after=${lastSeen}`)).messages[0].mine, true);
  // Oldest first in the thread, with names, and nothing written where a client's user is shown from.
  const now = await thread(priya, c);
  assert.deepEqual(now.messages.map((m) => m.id), [...now.messages.map((m) => m.id)].sort((x, y) => x - y));
  assert.equal(now.messages.at(-1).user_name, 'Alex Morgan');
  assert.deepEqual(now.conversation, { ...now.conversation, kind: 'direct', name: null, title: 'Alex Morgan', can_post: true, why_not: null });
});

test('unread: messages by others since you last read, per conversation and in all; opening the conversation marks it read', async () => {
  // Priya has not opened her conversation with Alex: everything Alex wrote in it is unread. What she writes is not.
  const c = (await direct(priya, id.alex)).id;
  const count = rows(`SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND user_id = ? AND kind = 'text'`, c, id.alex)[0].n;
  assert.equal(await unread(priya), count);
  assert.equal(await unread(alex), 0, 'your own messages are not unread for you');
  const [row] = (await list(priya)).filter((x) => x.id === c);
  assert.deepEqual([row.title, row.unread, row.last.text, row.last.mine, row.last.user_name], ['Alex Morgan', count, 'One more', false, 'Alex Morgan']);
  await say(priya, c, 'Thanks!\nI will look this afternoon.');
  assert.equal(await unread(priya), count, 'writing is not reading');
  const [mine] = (await list(alex)).filter((x) => x.id === c);
  assert.deepEqual([mine.unread, mine.last.text, mine.last.mine], [1, 'Thanks!', false], 'the first line only');
  assert.deepEqual(ok(await priya.post(`/messages/conversations/${c}/read`)), { ok: true, unread: 0 });
  assert.equal(await unread(priya), 0);
  assert.equal((await list(priya)).find((x) => x.id === c).unread, 0);
  // Reading only as far as a given message leaves what came after it unread.
  const a = await say(alex, c, 'First of two');
  await sleep(5);
  await say(alex, c, 'Second of two');
  ok(await priya.post(`/messages/conversations/${c}/read`, { up_to: a.id }));
  assert.equal(await unread(priya), 1);
  await markRead(priya, c);
  await markRead(alex, c);
  // Newest first in the list.
  const g = await group(marcus, 'Newest', [id.priya, id.orla]);
  assert.equal((await list(priya))[0].id, g);
  await say(alex, c, 'Back on top');
  assert.deepEqual((await list(priya)).slice(0, 2).map((x) => x.id), [c, g]);
  assert.equal(await unread(priya), 1, 'the app’s own line about the group is not counted');
  await markRead(priya, c);
});

// ---------- groups ----------

test('a group needs a name of 1 to 80 characters and at least two other people from the team', async () => {
  const before = rows('SELECT COUNT(*) AS n FROM conversations')[0].n;
  for (const name of [undefined, '', '   ', 7]) refused(await alex.post('/messages/conversations', { kind: 'group', name, user_ids: [id.priya, id.marcus] }), 400, /Give the group a name/);
  refused(await alex.post('/messages/conversations', { kind: 'group', name: 'n'.repeat(81), user_ids: [id.priya, id.marcus] }), 400, /80 characters/);
  refused(await alex.post('/messages/conversations', { kind: 'group', name: 'Two of us', user_ids: [id.priya] }), 400, /at least two other people/);
  refused(await alex.post('/messages/conversations', { kind: 'group', name: 'Twice', user_ids: [id.priya, id.priya] }), 400, /at least two other people/);
  refused(await alex.post('/messages/conversations', { kind: 'group', name: 'Me too', user_ids: [id.priya, id.alex] }), 400, /You are in it already/);
  for (const other of [id.maya, id.dana, id.pat, 999999]) refused(await alex.post('/messages/conversations', { kind: 'group', name: 'Bad', user_ids: [id.priya, other] }), 400, /active on your team/);
  refused(await alex.post('/messages/conversations', { kind: 'group', name: 'None', user_ids: 'everybody' }), 400, /Choose who to add/);
  assert.equal(rows('SELECT COUNT(*) AS n FROM conversations')[0].n, before);
  const g = await group(alex, `  ${'n'.repeat(80)}  `, [id.priya, id.marcus]);
  const t = await thread(priya, g);
  assert.equal(t.conversation.name, 'n'.repeat(80));
  assert.deepEqual(t.members.map((m) => m.name), ['Alex Morgan', 'Marcus Bell', 'Priya Nair']);
});

test('in a group anybody can rename it, add teammates and leave; each writes a line; somebody added reads the whole history', async () => {
  const g = await group(priya, 'Kestrel search', [id.alex, id.marcus]);
  await say(alex, g, 'Before Orla joined');
  // Marcus renames it; any member can.
  refused(await marcus.patch(`/messages/conversations/${g}`, { name: '' }), 400, /Give the group a name/);
  assert.deepEqual(ok(await marcus.patch(`/messages/conversations/${g}`, { name: 'Kestrel sales search' })), { ok: true, name: 'Kestrel sales search' });
  // Alex adds Orla. Adding somebody already there, yourself or a client's user is refused.
  refused(await alex.post(`/messages/conversations/${g}/members`, { user_ids: [id.marcus] }), 400, /in this group already/);
  refused(await alex.post(`/messages/conversations/${g}/members`, { user_ids: [id.alex] }), 400, /You are in it already/);
  refused(await alex.post(`/messages/conversations/${g}/members`, { user_ids: [id.maya] }), 400, /active on your team/);
  refused(await alex.post(`/messages/conversations/${g}/members`, { user_ids: [] }), 400, /Choose who to add/);
  ok(await alex.post(`/messages/conversations/${g}/members`, { user_ids: [id.orla] }));
  const forOrla = await thread(orla, g);
  assert.deepEqual(forOrla.messages.map((m) => [m.kind, m.body]), [
    ['system', 'Priya Nair made the group “Kestrel search” with Alex Morgan, Marcus Bell'],
    ['text', 'Before Orla joined'],
    ['system', 'Marcus Bell renamed the group “Kestrel sales search”'],
    ['system', 'Alex Morgan added Orla Quillfeather'],
  ]);
  assert.equal(forOrla.conversation.title, 'Kestrel sales search');
  assert.equal((await list(orla)).find((x) => x.id === g).unread, 0, 'what was written before she was added is not unread for her');
  await say(marcus, g, 'Welcome Orla');
  assert.equal((await list(orla)).find((x) => x.id === g).unread, 1);
  await markRead(orla, g);
});

test('somebody who left a group no longer sees it, cannot read or write in it, and is not counted or e-mailed about it; they can be added again', async () => {
  const g = await group(alex, 'Leaving test', [id.priya, id.marcus]);
  await say(priya, g, 'Before Marcus left');
  ok(await marcus.post(`/messages/conversations/${g}/leave`));
  assert.equal((await list(marcus)).some((x) => x.id === g), false);
  const unreadBefore = await unread(marcus);
  const mailsBefore = mail.to('marcus@agency.example').length;
  await say(priya, g, 'After Marcus left');
  await settle();
  assert.equal(await unread(marcus), unreadBefore);
  assert.equal(mail.to('marcus@agency.example').length, mailsBefore, 'no e-mail about it');
  for (const answer of [await marcus.get(`/messages/conversations/${g}`), await marcus.get(`/messages/conversations/${g}/messages?after=0`),
    await marcus.post(`/messages/conversations/${g}/messages`, { body: 'Can I?' }), await marcus.post(`/messages/conversations/${g}/read`),
    await marcus.patch(`/messages/conversations/${g}`, { name: 'Mine now' }), await marcus.post(`/messages/conversations/${g}/members`, { user_ids: [id.orla] }),
    await marcus.post(`/messages/conversations/${g}/leave`)]) refused(answer, 404, /not in your messages/);
  const t = await thread(alex, g);
  assert.equal(t.messages.at(-2).body, 'Marcus Bell left');
  assert.deepEqual(t.members.map((m) => m.name), ['Alex Morgan', 'Priya Nair']);
  // Priya adds him again: he reads it all again, and is counted and e-mailed again.
  ok(await priya.post(`/messages/conversations/${g}/members`, { user_ids: [id.marcus] }));
  assert.equal((await thread(marcus, g)).messages.some((m) => m.body === 'After Marcus left'), true);
  await say(alex, g, 'Welcome back');
  assert.equal(await unread(marcus), unreadBefore + 1);
  await until(() => mail.to('marcus@agency.example'), (sent) => sent.length === mailsBefore + 1);
  await markRead(marcus, g);
});

// ---------- privacy between people ----------

test('somebody not in a conversation gets the same 404 on every route of it, as for one that does not exist, and never sees its messages on a profile', async () => {
  const c = (await direct(alex, id.priya)).id;
  const secret = await say(alex, c, 'Between Alex and Priya: Ivo is the one', { application_id: app.ivo });
  const aboutJob = await say(priya, c, 'And the job is nearly filled', { job_id: job.sales });
  const notThere = 999999;
  for (const target of [c, notThere, 'abc']) {
    const answers = [await marcus.get(`/messages/conversations/${target}`), await marcus.get(`/messages/conversations/${target}?before=${secret.id + 1}`),
      await marcus.get(`/messages/conversations/${target}/messages?after=0`), await marcus.post(`/messages/conversations/${target}/messages`, { body: 'Hello?' }),
      await marcus.patch(`/messages/conversations/${target}`, { name: 'Taken over' }), await marcus.post(`/messages/conversations/${target}/members`, { user_ids: [id.marcus, id.orla] }),
      await marcus.post(`/messages/conversations/${target}/leave`), await marcus.post(`/messages/conversations/${target}/read`), await marcus.del(`/messages/conversations/${target}/messages/${secret.id}`)];
    for (const answer of answers) {
      refused(answer, 404);
      assert.deepEqual(answer.body, { error: 'That conversation is not in your messages.' }, 'the same words, whether or not it exists');
    }
  }
  // Nothing was changed by any of it.
  assert.deepEqual((await thread(alex, c)).messages.slice(-2).map((m) => [m.body, m.deleted]), [[secret.body, false], [aboutJob.body, false]]);
  // On the profile and the job: Alex and Priya see them, Marcus and Orla do not.
  assert.equal((await about(alex, `application_id=${app.ivo}`)).some((m) => m.id === secret.id), true);
  assert.equal((await about(priya, `job_id=${job.sales}`)).some((m) => m.id === aboutJob.id), true);
  for (const who of [marcus, orla]) {
    assert.equal(JSON.stringify(await about(who, `application_id=${app.ivo}`)).includes('Between Alex and Priya'), false);
    assert.equal(JSON.stringify(await about(who, `job_id=${job.sales}`)).includes('nearly filled'), false);
  }
  const shown = (await about(priya, `application_id=${app.ivo}`)).find((m) => m.id === secret.id);
  assert.deepEqual([shown.user_name, shown.conversation_kind, shown.conversation_title, shown.conversation_id, shown.mine], ['Alex Morgan', 'direct', 'Alex Morgan', c, false]);
  refused(await alex.get('/messages/about'), 400);
  refused(await alex.get(`/messages/about?application_id=${app.ivo}&job_id=${job.sales}`), 400);
  // And none of it is anywhere a client's user is shown from: not the candidate's history, notes or e-mails.
  const texts = rows(`SELECT detail AS t FROM activities UNION ALL SELECT detail FROM agency_activities UNION ALL SELECT body FROM emails
    UNION ALL SELECT body FROM agency_emails UNION ALL SELECT body FROM notes`).map((r) => r.t || '');
  assert.equal(texts.some((t) => /Between Alex and Priya|nearly filled/.test(t)), false);
  for (const table of ['applications', 'candidates', 'jobs']) {
    for (const column of rows(`SELECT name FROM pragma_table_info('${table}')`).map((r) => r.name)) assert.equal(/message|conversation/.test(column), false, `${table}.${column}`);
  }
  assert.equal(JSON.stringify(ok(await maya.get(`/applications/${app.ivo}`))).includes('Between Alex and Priya'), false);
});

test('a group member who left no longer sees the group’s messages on a profile', async () => {
  const g = await group(alex, 'Profile test', [id.priya, id.orla]);
  const m = await say(alex, g, 'Nora for the group', { application_id: app.nora });
  assert.equal((await about(orla, `application_id=${app.nora}`)).some((x) => x.id === m.id), true);
  ok(await orla.post(`/messages/conversations/${g}/leave`));
  assert.equal((await about(orla, `application_id=${app.nora}`)).some((x) => x.id === m.id), false);
});

// ---------- deleting a message ----------

test('the sender deletes their own message: it stays as “deleted”, and its words are gone from every answer and from the database', async () => {
  const c = (await direct(alex, id.priya)).id;
  const WORDS = 'Zephyrine-quartz salary figure 98765';
  const m = await say(alex, c, WORDS, { application_id: app.ivo });
  const before = (await thread(priya, c)).now;
  refused(await priya.del(`/messages/conversations/${c}/messages/${m.id}`), 403, /only delete your own messages/);
  const system = rows(`SELECT id FROM messages WHERE kind = 'system' AND user_id = ? LIMIT 1`, id.alex)[0].id;
  const systemIn = rows('SELECT conversation_id FROM messages WHERE id = ?', system)[0].conversation_id;
  refused(await alex.del(`/messages/conversations/${systemIn}/messages/${system}`), 403);
  refused(await alex.del(`/messages/conversations/${c}/messages/999999`), 404, /not in this conversation/);
  ok(await alex.del(`/messages/conversations/${c}/messages/${m.id}`));
  ok(await alex.del(`/messages/conversations/${c}/messages/${m.id}`)); // twice is the same

  const inThread = (await thread(priya, c)).messages.find((x) => x.id === m.id);
  assert.deepEqual([inThread.deleted, inThread.body, inThread.attachment, inThread.user_name], [true, null, null, 'Alex Morgan']);
  const polled = ok(await priya.get(`/messages/conversations/${c}/messages?after=${m.id - 1}&since=${encodeURIComponent(before)}`));
  assert.equal(polled.messages[0].body, null);
  assert.deepEqual(ok(await priya.get(`/messages/conversations/${c}/messages?after=${m.id}&since=${encodeURIComponent(before)}`)).deleted, [m.id], 'an open thread is told it was deleted');
  const [row] = (await list(priya)).filter((x) => x.id === c);
  assert.deepEqual([row.last.deleted, row.last.text], [true, null]);
  assert.equal((await about(priya, `application_id=${app.ivo}`)).some((x) => x.id === m.id), false);
  for (const who of [alex, priya]) for (const pathname of ['/messages/conversations', `/messages/conversations/${c}`, `/messages/about?application_id=${app.ivo}`]) {
    assert.equal(JSON.stringify(ok(await who.get(pathname))).includes('Zephyrine'), false, pathname);
  }
  assert.equal(await unread(priya) >= 0, true);
  // In the database: the row stays, with its words and its candidate cleared.
  assert.deepEqual(rows('SELECT body, application_id, job_id, deleted_at IS NOT NULL AS deleted FROM messages WHERE id = ?', m.id), [{ body: null, application_id: null, job_id: null, deleted: 1 }]);
  // And written over, not just marked as free: the words are in neither file of the database.
  await until(() => ['app.db', 'app.db-wal'].map((f) => path.join(dataDir, f)).filter((f) => fs.existsSync(f)).some((f) => fs.readFileSync(f).includes('Zephyrine')), (found) => !found, 3000);
  // A deleted message is not unread either.
  await markRead(priya, c);
  const total = await unread(priya);
  const late = await say(alex, c, 'Short-lived');
  assert.deepEqual([await unread(priya), (await list(priya)).find((x) => x.id === c).unread], [total + 1, 1]);
  ok(await alex.del(`/messages/conversations/${c}/messages/${late.id}`));
  assert.deepEqual([await unread(priya), (await list(priya)).find((x) => x.id === c).unread], [total, 0]);
});

// ---------- e-mail ----------

test('the e-mail heads-up: one per conversation until it is read, never to the sender, with the sender, the group and the start of the message', async () => {
  const g = await group(orla, 'Weekly numbers', [id.priya, id.marcus]);
  for (const who of [orla, priya, marcus]) await markRead(who, g);
  const count = (address) => mail.to(address).filter((m) => /Weekly numbers/.test(m.subject)).length;
  const long = `${'Numbers are in. '.repeat(20)}THE END`;
  await say(orla, g, long);
  await until(() => [count('priya@agency.example'), count('marcus@agency.example')], ([p, m]) => p === 1 && m === 1);
  const [email] = mail.to('priya@agency.example').filter((m) => /Weekly numbers/.test(m.subject));
  assert.equal(email.subject, 'Orla Quillfeather wrote in Weekly numbers');
  assert.ok(email.text.startsWith('Hi Priya,\n\nOrla Quillfeather wrote in Weekly numbers in The Book:\n\n'), email.text);
  assert.ok(email.text.includes(`${long.slice(0, 200)}…`), 'the first 200 characters');
  assert.equal(email.text.includes('THE END'), false);
  assert.ok(email.text.includes(`Open the conversation: ${APP_URL}/messages/${g}`));
  assert.ok(email.text.includes('Email me about new messages'));
  assert.equal(count('orla@agency.example'), 0, 'never to whoever wrote it');
  // More messages before Priya reads: no more e-mails. Marcus reads, and the next message e-mails him again.
  await say(orla, g, 'Second');
  await say(orla, g, 'Third');
  await markRead(marcus, g);
  await say(orla, g, 'Fourth');
  await until(() => count('marcus@agency.example'), (n) => n === 2);
  await settle();
  assert.equal(count('priya@agency.example'), 1, 'one until she has read it');
  // Priya answers: Orla and Marcus are told. Marcus has not read since his last e-mail: nothing more for him.
  await say(priya, g, 'Thanks Orla');
  await until(() => mail.to('orla@agency.example').filter((m) => /Weekly numbers/.test(m.subject)).length, (n) => n === 1);
  await settle();
  assert.equal(count('marcus@agency.example'), 2);
  // One to one: the subject names the sender.
  const c = (await direct(marcus, id.orla)).id;
  await markRead(orla, c);
  await say(marcus, c, 'Quick one');
  await until(() => mail.to('orla@agency.example').filter((m) => m.subject === 'Marcus Bell sent you a message').length, (n) => n === 1);
  assert.match(mail.to('orla@agency.example').find((m) => m.subject === 'Marcus Bell sent you a message').text, /Marcus Bell wrote to you in The Book:\n\nQuick one\n/);
  // Nothing goes to anybody at a client.
  assert.deepEqual(mail.to('maya@kestrel.example'), []);
});

test('each person can switch the e-mails off for themselves, and back on', async () => {
  assert.deepEqual(ok(await marcus.get('/messages/settings')), { email: true });
  for (const email of [undefined, 'no', 0, null]) refused(await marcus.putJson('/messages/settings', { email }), 400, /true or false/);
  assert.deepEqual(ok(await marcus.putJson('/messages/settings', { email: false })), { email: false });
  assert.deepEqual(ok(await marcus.get('/messages/settings')), { email: false });
  assert.deepEqual(ok(await priya.get('/messages/settings')), { email: true }, 'it is his alone');
  const c = (await direct(priya, id.marcus)).id;
  await markRead(marcus, c);
  const before = mail.to('marcus@agency.example').length;
  await say(priya, c, 'Marcus has them off');
  await settle();
  assert.equal(mail.to('marcus@agency.example').length, before);
  assert.equal(await unread(marcus) > 0, true, 'he is still told in the app');
  // Back on: the next message after he reads e-mails him.
  ok(await marcus.putJson('/messages/settings', { email: true }));
  await markRead(marcus, c);
  await say(priya, c, 'Back on');
  await until(() => mail.to('marcus@agency.example').length, (n) => n === before + 1);
  await markRead(marcus, c);
});

test('an e-mail that cannot be sent never stops the message', async () => {
  const c = (await direct(alex, id.orla)).id;
  await markRead(orla, c);
  mail.failing = true;
  try {
    const m = await say(alex, c, 'Sent while the mail provider is down');
    assert.ok(m.id);
    await until(() => server.output(), (log) => log.includes('Notification email failed'));
  } finally { mail.failing = false; }
  assert.equal((await thread(orla, c)).messages.at(-1).body, 'Sent while the mail provider is down');
  await markRead(orla, c);
});

// ---------- people, candidates and jobs that go ----------

test('deleting a candidate or a job leaves the message and drops its chip; folding two entries keeps the chip on the one kept', async () => {
  const c = (await direct(alex, id.priya)).id;
  const gil = await add({ job_id: job.sales, name: 'Gil Gone', email: 'gil@mail.example' });
  const aboutGil = await say(alex, c, 'Gil looks strong', { application_id: gil });
  const temp = ok(await alex.post('/jobs', { client_id: kestrel, title: 'Short-lived job', status: 'open' })).id;
  const aboutJob = await say(alex, c, 'This job will go', { job_id: temp });
  ok(await alex.del(`/candidates/${rows('SELECT candidate_id FROM applications WHERE id = ?', gil)[0].candidate_id}`));
  ok(await alex.del(`/jobs/${temp}`));
  const t = (await thread(priya, c)).messages;
  assert.deepEqual(t.filter((m) => [aboutGil.id, aboutJob.id].includes(m.id)).map((m) => [m.body, m.attachment, m.deleted]),
    [['Gil looks strong', null, false], ['This job will go', null, false]]);
  assert.deepEqual(rows('SELECT application_id, job_id FROM messages WHERE id IN (?, ?)', aboutGil.id, aboutJob.id), [{ application_id: null, job_id: null }, { application_id: null, job_id: null }]);

  const keptId = await add({ name: 'Ruth Merge', email: 'ruth@mail.example' });
  const goingId = await add({ name: 'Ruth Merge', email: 'ruth.other@mail.example' });
  const aboutRuth = await say(alex, c, 'Ruth, on the other entry', { application_id: goingId });
  const [kept, going] = [keptId, goingId].map((a) => rows('SELECT candidate_id FROM applications WHERE id = ?', a)[0].candidate_id);
  ok(await alex.post(`/candidates/${going}/merge`, { into: kept }));
  assert.equal((await thread(priya, c)).messages.find((m) => m.id === aboutRuth.id).attachment.application_id, keptId);
  assert.equal((await about(priya, `application_id=${keptId}`)).some((m) => m.id === aboutRuth.id), true);
});

test('a teammate deactivated keeps their messages and their name; a one-to-one with them is read-only; somebody removed is shown as no longer on the team', async () => {
  const tess = await join('recruiter', 'Tess Gray', 'tess@agency.example');
  id = await userIds();
  const c = (await direct(alex, id.tess)).id;
  const g = await group(tess, 'With Tess', [id.alex, id.priya]);
  await say(tess, c, 'From Tess, one to one');
  await say(tess, g, 'From Tess, to the group');
  for (const who of [alex, priya]) { await markRead(who, g); }
  await markRead(alex, c);
  ok(await alex.patch(`/users/${id.tess}`, { active: false }));
  refused(await tess.get('/messages/conversations'), 401);
  // Her messages stay, with her name; she is still listed in the group, as no longer on the team.
  const t = await thread(alex, c);
  assert.deepEqual([t.messages.at(-1).user_name, t.messages.at(-1).body], ['Tess Gray', 'From Tess, one to one']);
  assert.deepEqual([t.conversation.title, t.conversation.can_post], ['Tess Gray', false]);
  assert.match(t.conversation.why_not, /Tess Gray is no longer active on your team/);
  refused(await alex.post(`/messages/conversations/${c}/messages`, { body: 'Are you there?' }), 409, /no longer active/);
  refused(await alex.post('/messages/conversations', { kind: 'direct', user_id: id.tess }), 400, /active on your team/);
  assert.equal(ok(await alex.get('/messages/people')).some((p) => p.id === id.tess), false);
  const gt = await thread(priya, g);
  assert.deepEqual(gt.members.find((m) => m.id === id.tess), { id: id.tess, name: 'Tess Gray', left: false, on_team: false });
  // The group goes on without her, and she is not e-mailed.
  const before = mail.to('tess@agency.example').length;
  await say(priya, g, 'Tess has left us');
  await until(() => mail.to('alex@agency.example').filter((m) => /With Tess/.test(m.subject)).length, (n) => n === 1);
  assert.equal(mail.to('tess@agency.example').length, before);

  // Somebody removed outright: the conversation stays for the others, and their messages say who is no longer there.
  const sam = await join('recruiter', 'Sam Short', 'sam@agency.example');
  id = await userIds();
  const withSam = (await direct(priya, id.sam)).id;
  await say(sam, withSam, 'From Sam');
  await say(sam, withSam, 'Twice from Sam');
  write('DELETE FROM users WHERE id = ?', id.sam);
  const left = await thread(priya, withSam);
  assert.deepEqual(left.messages.map((m) => [m.user_id, m.user_name, m.body]), [[null, null, 'From Sam'], [null, null, 'Twice from Sam']]);
  assert.deepEqual([left.conversation.title, left.conversation.can_post], ['Somebody no longer on the team', false]);
  assert.deepEqual(left.members.map((m) => m.name), ['Priya Nair']);
  assert.equal((await list(priya)).find((x) => x.id === withSam).title, 'Somebody no longer on the team');
  assert.deepEqual(rows('SELECT COUNT(*) AS n FROM conversation_members WHERE user_id = ?', id.sam), [{ n: 0 }]);
});

test('“Show earlier messages”: a long conversation opens on its newest hundred, and the rest come a hundred at a time', async () => {
  const g = await group(alex, 'Long one', [id.priya, id.orla]);
  write(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 230)
         INSERT INTO messages (conversation_id, user_id, kind, body, created_at) SELECT ?, ?, 'text', 'Line ' || i, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM n`, g, id.alex);
  const first = await thread(priya, g);
  assert.equal(first.messages.length, 100);
  assert.equal(first.has_more, true);
  assert.equal(first.messages.at(-1).body, 'Line 230');
  const second = await thread(priya, g, `?before=${first.messages[0].id}`);
  assert.deepEqual([second.messages.length, second.has_more, second.messages.at(-1).id < first.messages[0].id], [100, true, true]);
  const third = await thread(priya, g, `?before=${second.messages[0].id}`);
  assert.deepEqual([third.messages.length, third.has_more, third.messages[0].kind], [31, false, 'system']);
  await markRead(priya, g);
});

test('nothing about messages is written to the tables a client’s user is shown from', async () => {
  const before = clientTables();
  const c = (await direct(alex, id.priya)).id;
  await say(alex, c, 'One more about Ivo', { application_id: app.ivo });
  const g = await group(alex, 'Last group', [id.priya, id.orla]);
  ok(await alex.patch(`/messages/conversations/${g}`, { name: 'Last group renamed' }));
  ok(await orla.post(`/messages/conversations/${g}/leave`));
  assert.deepEqual(clientTables(), before);
  assert.ok(rows('SELECT COUNT(*) AS n FROM messages')[0].n > 20, 'they are all in their own tables');
});
