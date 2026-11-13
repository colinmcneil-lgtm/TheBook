// E-mails to the agency team about notes on candidates, end to end: when somebody writes a note on a candidate, the
// candidate's owner and the account executive of their job are e-mailed, once each, never the person who wrote it,
// and only people active on the agency team who have their switch on. Notes from a client's hiring team count, notes
// for the agency only count, notes The Book files by itself do not. After an e-mail about a candidate, further notes on
// them send that person nothing for 15 minutes, which holds after a restart; an e-mail that did not go is not counted.
// The note itself is saved, and answered, exactly as before. Run with `npm test`.
//
// One real server on a throwaway data folder, with e-mail delivery connected to a stand-in for the mail provider (so
// every e-mail the server sends can be read whole). It is started again once without delivery connected. The 15
// minutes are not waited for: the time an e-mail was noted is moved back in the database instead.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer, session, tempDir, until, sleep, PORTS } from './oracle-helpers.mjs';
import { look } from './metaview-helpers.mjs';

// The one port kept for this file (see PORT_PLAN in oracle-helpers.mjs). The mail stand-in takes any free port.
const PORT = PORTS.noteMail;
const APP_URL = 'https://book.harbourtalent.example';
const SWITCH = 'Email me about notes on my candidates and jobs';

const listen = (server, port) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
const close = (server) => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
/**
 * Stand-in for the mail provider: every e-mail handed over is kept whole. With `failing` set it answers with an error;
 * with `delay` set it answers that many milliseconds late.
 */
async function mailStandIn() {
  const state = { sent: [], failing: false, delay: 0 };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const answer = () => {
        if (state.failing) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end('{"message":"stand-in is down"}'); }
        state.sent.push(JSON.parse(raw));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"id":"stub"}');
      };
      if (state.delay) setTimeout(answer, state.delay); else answer();
    });
  });
  await listen(server, 0);
  return Object.assign(state, {
    url: `http://127.0.0.1:${server.address().port}/emails`,
    to: (address) => state.sent.filter((m) => m.to.includes(address)),
    stop: () => close(server),
  });
}

let server, mail, dataDir;
let alex, priya, marcus, orla, maya; // the admin, three recruiters, and somebody on Kestrel's hiring team
let id;                              // each person's user id, by first name
let kestrel;
const job = {};

const ok = (res) => { assert.equal(res.status, 200, JSON.stringify(res.body)); return res.body; };
const refused = (res, status, words) => { assert.equal(res.status, status, JSON.stringify(res.body)); if (words) assert.match(res.body.error, words); };
function write(sql, ...values) {
  const db = new DatabaseSync(path.join(dataDir, 'app.db'));
  try { db.exec('PRAGMA foreign_keys = ON'); return db.prepare(sql).run(...values); } finally { db.close(); }
}
const rows = (sql, ...values) => look(dataDir, (all) => all(sql, ...values));
const PRIYA = 'priya@agency.example', MARCUS = 'marcus@agency.example', ORLA = 'orla@agency.example', ALEX = 'alex@agency.example', MAYA = 'maya@kestrel.example';

const env = (connected) => ({ ...(connected ? { RESEND_API_KEY: 'test-key', RESEND_API_URL: mail.url, MAIL_FROM: 'Harbour Talent <team@harbourtalent.example>' } : {}), APP_URL });
const join = async (role, name, email, extra = {}) => {
  const { token } = ok(await alex.post('/invites', { role, email, ...extra }));
  const person = session(server.base);
  ok(await person.post(`/invites/${token}/accept`, { name, password: 'demo1234' }));
  return person;
};
const userIds = async () => Object.fromEntries(ok(await alex.get('/users')).map((u) => [u.name.split(' ')[0].toLowerCase(), u.id]));
/** Add somebody as Alex (on a job, or in The Book with no job_id), owned by `owner` when given. */
const add = async (fields, owner) => {
  const appId = ok(await alex.upload('/applications', fields)).id;
  if (owner) ok(await alex.patch(`/applications/${appId}`, { owner_id: owner }));
  return appId;
};
const note = async (who, appId, body, extra = {}) => ok(await who.post(`/applications/${appId}/notes`, { body, ...extra }));
/** The e-mails about notes on this candidate sent to this address. */
const about = (address, name) => mail.to(address).filter((m) => m.subject.includes(` wrote a note on ${name}`));
/** Wait long enough for an e-mail that is not going to be sent to have been sent, were it going to be. */
const settle = () => sleep(400);
const minutesAgo = (n) => new Date(Date.now() - n * 60000).toISOString();

before(async () => {
  mail = await mailStandIn();
  dataDir = tempDir('note-mail');
  server = await startServer({ port: PORT, dataDir, env: env(true) });
  alex = session(server.base);
  ok(await alex.post('/setup', { agencyName: 'Harbour Talent', name: 'Alex Morgan', email: ALEX, password: 'demo1234' }));
  kestrel = ok(await alex.post('/clients', { name: 'Kestrel Logistics', brand_color: '#b45309' })).id;
  priya = await join('recruiter', 'Priya Nair', PRIYA);
  marcus = await join('recruiter', 'Marcus Bell', MARCUS);
  orla = await join('recruiter', 'Orla Quillfeather', ORLA);
  maya = await join('client', 'Maya Okonkwo', MAYA, { client_id: kestrel });
  id = await userIds();
  job.sales = ok(await alex.post('/jobs', { client_id: kestrel, title: 'Head of Sales', status: 'open', description: 'A role.' })).id;
  job.ops = ok(await alex.post('/jobs', { client_id: kestrel, title: 'Operations Lead', status: 'open', description: 'A role.' })).id;
  // Marcus is the account executive of Head of Sales.
  write('UPDATE jobs SET account_executive_id = ? WHERE id = ?', id.marcus, job.sales);
});

after(async () => {
  await server?.stop();
  await mail?.stop();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

// ---------- who is told ----------

test('a note e-mails the candidate’s owner and the job’s account executive, once each, and never the person who wrote it', async () => {
  const tom = await add({ job_id: job.sales, name: 'Tom Kaplan', email: 'tom@mail.example' }, id.priya);
  const long = `${'Strong on enterprise deals and a calm negotiator. '.repeat(6)}THE END`;
  const answer = await note(orla, tom, long);
  await until(() => [about(PRIYA, 'Tom Kaplan').length, about(MARCUS, 'Tom Kaplan').length], ([p, m]) => p === 1 && m === 1);
  await settle();
  assert.equal(about(PRIYA, 'Tom Kaplan').length, 1);
  assert.equal(about(MARCUS, 'Tom Kaplan').length, 1);
  assert.equal(about(ORLA, 'Tom Kaplan').length, 0, 'never the writer');
  assert.equal(about(ALEX, 'Tom Kaplan').length, 0, 'nobody else on the team');

  const [toPriya] = about(PRIYA, 'Tom Kaplan'), [toMarcus] = about(MARCUS, 'Tom Kaplan');
  assert.deepEqual(toPriya.to, [PRIYA], 'one e-mail for each person, to them alone');
  assert.equal(toPriya.subject, 'Orla Quillfeather wrote a note on Tom Kaplan (Head of Sales)');
  assert.ok(toPriya.text.startsWith('Hi Priya,\n\nOrla Quillfeather wrote a note on Tom Kaplan, on Head of Sales at Kestrel Logistics. You are told because you own Tom Kaplan.\n\n'), toPriya.text);
  assert.ok(toMarcus.text.startsWith('Hi Marcus,\n\nOrla Quillfeather wrote a note on Tom Kaplan, on Head of Sales at Kestrel Logistics. You are told because you are the account executive of Head of Sales.\n\n'), toMarcus.text);
  for (const email of [toPriya, toMarcus]) {
    assert.ok(email.text.includes(`\n\n${long.slice(0, 200)}…\n\n`), 'the first 200 characters of the note');
    assert.equal(email.text.includes('THE END'), false);
    assert.ok(email.text.includes(`Open their profile: ${APP_URL}/jobs/${job.sales}?c=${tom}\n`), email.text);
    assert.ok(email.text.includes(`switch off "${SWITCH}" in Settings, under Your account.`));
    assert.ok(email.text.endsWith('\n\nHarbour Talent\n'));
    assert.equal(email.text.includes('agency only'), false, 'a note the hiring team can read is not called the agency’s');
  }
  // The note was saved as it always was.
  assert.deepEqual(rows('SELECT application_id, user_id, body, private FROM notes WHERE id = ?', answer.id), [{ application_id: tom, user_id: id.orla, body: long, private: 0 }]);

  // The owner writing on their own candidate: only the account executive is told.
  const wes = await add({ job_id: job.sales, name: 'Wes Writer', email: 'wes@mail.example' }, id.priya);
  await note(priya, wes, 'Called him back.');
  await until(() => about(MARCUS, 'Wes Writer').length, (n) => n === 1);
  await settle();
  assert.equal(about(PRIYA, 'Wes Writer').length, 0);
});

test('somebody who is both the owner and the account executive gets one e-mail, which says both', async () => {
  const bea = await add({ job_id: job.sales, name: 'Bea Both', email: 'bea@mail.example' }, id.marcus);
  await note(orla, bea, 'Keen, and free from March.');
  await until(() => about(MARCUS, 'Bea Both').length, (n) => n === 1);
  await settle();
  assert.equal(about(MARCUS, 'Bea Both').length, 1);
  assert.equal(mail.sent.filter((m) => m.subject.includes('Bea Both')).length, 1);
  assert.match(about(MARCUS, 'Bea Both')[0].text, /You are told because you own Bea Both and are the account executive of Head of Sales\./);
});

test('a note from the client’s hiring team on their own job e-mails the agency’s owner and account executive', async () => {
  const cal = await add({ job_id: job.sales, name: 'Cal Client', email: 'cal@mail.example' }, id.priya);
  const answer = await note(maya, cal, 'We would like to meet him.');
  assert.deepEqual(Object.keys(answer), ['id']);
  await until(() => [about(PRIYA, 'Cal Client').length, about(MARCUS, 'Cal Client').length], ([p, m]) => p === 1 && m === 1);
  await settle();
  assert.equal(about(MAYA, 'Cal Client').length, 0);
  const [email] = about(PRIYA, 'Cal Client');
  assert.equal(email.subject, 'Maya Okonkwo wrote a note on Cal Client (Head of Sales)');
  assert.match(email.text, /^Hi Priya,\n\nMaya Okonkwo \(hiring team at Kestrel Logistics\) wrote a note on Cal Client, on Head of Sales at Kestrel Logistics\./);
  assert.match(email.text, /\n\nWe would like to meet him\.\n\n/);
});

test('a note for the agency only still e-mails the owner and the account executive, and says it is for the agency only', async () => {
  const pia = await add({ job_id: job.sales, name: 'Pia Private', email: 'pia@mail.example' }, id.priya);
  const answer = await note(orla, pia, 'Asking for more than the budget.', { private: true });
  assert.equal(rows('SELECT private FROM notes WHERE id = ?', answer.id)[0].private, 1);
  await until(() => [about(PRIYA, 'Pia Private').length, about(MARCUS, 'Pia Private').length], ([p, m]) => p === 1 && m === 1);
  for (const address of [PRIYA, MARCUS]) assert.match(about(address, 'Pia Private')[0].text, /The note is for the agency only\./);
});

test('nobody deactivated, still waiting for their account, or on a client’s account is e-mailed', async () => {
  const tess = await join('recruiter', 'Tess Gone', 'tess@agency.example');
  const pat = await join('recruiter', 'Pat Waiting', 'pat@agency.example');
  id = await userIds();
  const dan = await add({ job_id: job.ops, name: 'Dan Nobody', email: 'dan@mail.example' }, id.tess);
  write('UPDATE jobs SET account_executive_id = ? WHERE id = ?', id.pat, job.ops);
  // Deactivated owner, account executive waiting for their account.
  ok(await alex.patch(`/users/${id.tess}`, { active: false }));
  write('UPDATE users SET pending = 1 WHERE id = ?', id.pat);
  await note(orla, dan, 'First note.');
  await settle();
  assert.equal(about('tess@agency.example', 'Dan Nobody').length, 0, 'not somebody deactivated');
  assert.equal(about('pat@agency.example', 'Dan Nobody').length, 0, 'not somebody waiting for their account');
  assert.deepEqual(rows('SELECT * FROM note_mail WHERE application_id = ?', dan), [], 'and nobody is noted as told');
  // Back on the team, and active: they are told (so it was the account that kept them out, and nothing else).
  write('UPDATE users SET active = 1 WHERE id = ?', id.tess);
  write('UPDATE users SET pending = 0 WHERE id = ?', id.pat);
  await note(orla, dan, 'Second note.');
  await until(() => [about('tess@agency.example', 'Dan Nobody').length, about('pat@agency.example', 'Dan Nobody').length], ([t, p]) => t === 1 && p === 1);
  // Now both are a client's users (a state the app can come to when somebody is invited again as a client): never e-mailed.
  write(`UPDATE users SET role = 'client', client_id = ? WHERE id IN (?, ?)`, kestrel, id.tess, id.pat);
  write('DELETE FROM note_mail WHERE application_id = ?', dan);
  await note(orla, dan, 'Third note.');
  await settle();
  assert.equal(about('tess@agency.example', 'Dan Nobody').length, 1);
  assert.equal(about('pat@agency.example', 'Dan Nobody').length, 1);
  // And Maya herself, as owner and account executive, is never told.
  write('UPDATE applications SET owner_id = ? WHERE id = ?', id.maya, dan);
  write('UPDATE jobs SET account_executive_id = ? WHERE id = ?', id.maya, job.ops);
  await note(orla, dan, 'Fourth note.');
  await settle();
  assert.equal(about(MAYA, 'Dan Nobody').length, 0);
  assert.deepEqual(rows('SELECT * FROM note_mail WHERE application_id = ?', dan), []);
  write('UPDATE jobs SET account_executive_id = ? WHERE id = ?', id.alex, job.ops);
  void tess; void pat;
});

test('somebody in The Book on no job: only their owner is told, with a link to their profile under Candidates', async () => {
  const nora = await add({ name: 'Nora Nojob', email: 'nora@mail.example' }, id.priya);
  await note(orla, nora, 'Open to contract work.');
  await until(() => about(PRIYA, 'Nora Nojob').length, (n) => n === 1);
  await settle();
  assert.equal(mail.sent.filter((m) => m.subject.includes('Nora Nojob')).length, 1, 'nobody but the owner');
  const [email] = about(PRIYA, 'Nora Nojob');
  assert.equal(email.subject, 'Orla Quillfeather wrote a note on Nora Nojob');
  assert.match(email.text, /^Hi Priya,\n\nOrla Quillfeather wrote a note on Nora Nojob, who is in The Book on no job\. You are told because you own Nora Nojob\. The note is for the agency only\.\n\n/);
  assert.ok(email.text.includes(`Open their profile: ${APP_URL}/candidates?c=${nora}\n`));
});

// ---------- not too many ----------

test('after an e-mail about a candidate, further notes on them send that person nothing for 15 minutes; a note after that does', async () => {
  const rae = await add({ job_id: job.sales, name: 'Rae Repeat', email: 'rae@mail.example' }, id.priya);
  await note(orla, rae, 'One.');
  await until(() => [about(PRIYA, 'Rae Repeat').length, about(MARCUS, 'Rae Repeat').length], ([p, m]) => p === 1 && m === 1);
  await note(orla, rae, 'Two.');
  await note(alex, rae, 'Three, by somebody else.');
  await settle();
  assert.equal(about(PRIYA, 'Rae Repeat').length, 1, 'quiet within the 15 minutes');
  assert.equal(about(MARCUS, 'Rae Repeat').length, 1);
  // What is kept is one row for each person told about the candidate, with the note it was about.
  const kept = rows('SELECT user_id, note_id FROM note_mail WHERE application_id = ? ORDER BY user_id', rae);
  assert.deepEqual(kept.map((r) => r.user_id), [id.priya, id.marcus].sort((x, y) => x - y));
  // Priya's e-mail was 16 minutes ago, Marcus's 14: the next note e-mails Priya and not Marcus.
  write('UPDATE note_mail SET mailed_at = ? WHERE application_id = ? AND user_id = ?', minutesAgo(16), rae, id.priya);
  write('UPDATE note_mail SET mailed_at = ? WHERE application_id = ? AND user_id = ?', minutesAgo(14), rae, id.marcus);
  // A row long over for somebody else is cleared the next time a note is written, so the table stays small.
  const old = await add({ name: 'Old Row', email: 'old@mail.example' }, id.priya);
  write('INSERT INTO note_mail (user_id, application_id, note_id, mailed_at) VALUES (?, ?, 0, ?)', id.orla, old, minutesAgo(60 * 24));
  await note(orla, rae, 'Four, after the window.');
  await until(() => about(PRIYA, 'Rae Repeat').length, (n) => n === 2);
  await settle();
  assert.equal(about(MARCUS, 'Rae Repeat').length, 1);
  assert.match(about(PRIYA, 'Rae Repeat')[1].text, /Four, after the window\./);
  assert.deepEqual(rows('SELECT * FROM note_mail WHERE application_id = ?', old), []);
  assert.equal(rows('SELECT COUNT(*) AS n FROM note_mail WHERE mailed_at < ?', minutesAgo(15))[0].n, 0);
});

test('each person can switch the e-mails off for themselves, and back on; the switch for messages is not touched', async () => {
  assert.deepEqual(ok(await marcus.get('/note-mail/settings')), { email: true });
  refused(await marcus.putJson('/note-mail/settings', { email: 'no' }), 400, /email must be true or false/);
  assert.deepEqual(ok(await marcus.putJson('/note-mail/settings', { email: false })), { email: false });
  assert.deepEqual(ok(await marcus.get('/note-mail/settings')), { email: false });
  assert.deepEqual(ok(await marcus.get('/messages/settings')), { email: true }, 'the messages switch stays on');
  const sam = await add({ job_id: job.sales, name: 'Sam Switch', email: 'sam@mail.example' }, id.priya);
  await note(orla, sam, 'While Marcus has them off.');
  await until(() => about(PRIYA, 'Sam Switch').length, (n) => n === 1);
  await settle();
  assert.equal(about(MARCUS, 'Sam Switch').length, 0);
  // Switched on again: he was never noted as told, so the next note e-mails him at once (and not Priya, within her 15 minutes).
  assert.deepEqual(ok(await marcus.putJson('/note-mail/settings', { email: true })), { email: true });
  await note(orla, sam, 'Now he has them on.');
  await until(() => about(MARCUS, 'Sam Switch').length, (n) => n === 1);
  await settle();
  assert.equal(about(PRIYA, 'Sam Switch').length, 1);
  // Switching the messages e-mails off does not switch these off.
  ok(await marcus.putJson('/messages/settings', { email: false }));
  assert.deepEqual(ok(await marcus.get('/note-mail/settings')), { email: true });
  ok(await marcus.putJson('/messages/settings', { email: true }));
});

test('a client’s user is refused the switch, and nothing they are sent mentions it', async () => {
  refused(await maya.get('/note-mail/settings'), 403, /Only the agency team can do this/);
  refused(await maya.putJson('/note-mail/settings', { email: false }), 403, /Only the agency team can do this/);
  assert.equal(rows('SELECT note_mail FROM users WHERE id = ?', id.maya)[0].note_mail, 1, 'nothing changed');
  for (const pathname of ['/me', '/users', '/nav']) {
    assert.equal(JSON.stringify(ok(await maya.get(pathname))).includes('note_mail'), false, `${pathname} mentions it`);
  }
  assert.equal('note_mail' in ok(await alex.get('/me')).user, false);
});

// ---------- what counts ----------

test('a note written when adding somebody counts; the notes The Book files by itself do not', async () => {
  // Added to Head of Sales with a note: Alex wrote it and owns them, so Marcus, the account executive, is told.
  await add({ job_id: job.sales, name: 'Ada Added', email: 'ada@mail.example', note: 'Met her at the conference.' });
  await until(() => about(MARCUS, 'Ada Added').length, (n) => n === 1);
  await settle();
  assert.equal(about(ALEX, 'Ada Added').length, 0);
  assert.match(about(MARCUS, 'Ada Added')[0].text, /Met her at the conference\./);

  // Somebody in The Book with a covering note, owned by Priya, is put on Head of Sales by Alex: The Book keeps the
  // covering note as a note for the agency. Nobody is e-mailed about that.
  const fay = await add({ name: 'Fay Filed', email: 'fay@mail.example', cover_note: 'Sent through a friend.' }, id.priya);
  assert.equal(await add({ job_id: job.sales, name: 'Fay Filed', email: 'fay@mail.example' }), fay);
  assert.equal(rows(`SELECT COUNT(*) AS n FROM notes WHERE application_id = ? AND body LIKE 'Saved with their entry in The Book:%'`, fay)[0].n, 1);
  // Taken off the job again with something to keep for the agency: another note The Book files by itself.
  write('UPDATE applications SET cover_note = ? WHERE id = ?', 'Their own words to the client.', fay);
  ok(await alex.del(`/applications/${fay}`));
  assert.equal(rows(`SELECT COUNT(*) AS n FROM notes WHERE application_id = ? AND body LIKE '%Kept for the agency only.%'`, fay)[0].n, 1);
  await settle();
  assert.equal(mail.sent.filter((m) => m.subject.includes('Fay Filed')).length, 0);
  assert.deepEqual(rows('SELECT * FROM note_mail WHERE application_id = ?', fay), []);
});

test('a debrief written from To do counts, once: sending the same debrief again e-mails nobody', async () => {
  const deb = await add({ job_id: job.sales, name: 'Deb Debrief', email: 'deb@mail.example' }, id.orla);
  const item = ok(await priya.post('/todos', { kind: 'debrief', application_id: deb })).id;
  const answer = ok(await priya.patch(`/todos/${item}`, { done: true, debrief: 'Liked the team, worried about the commute.' }));
  assert.deepEqual(Object.keys(answer).sort(), ['note_id', 'ok']);
  await until(() => [about(ORLA, 'Deb Debrief').length, about(MARCUS, 'Deb Debrief').length], ([o, m]) => o === 1 && m === 1);
  await settle();
  assert.equal(about(PRIYA, 'Deb Debrief').length, 0);
  assert.match(about(ORLA, 'Deb Debrief')[0].text, /\n\nDebrief:\nLiked the team, worried about the commute\.\n\n/);
  // The same words again (the first answer was lost on the way back) are the same note, and tell nobody again, even
  // once the 15 minutes are over.
  write('UPDATE note_mail SET mailed_at = ? WHERE application_id = ?', minutesAgo(20), deb);
  const again = ok(await priya.patch(`/todos/${item}`, { done: true, debrief: 'Liked the team, worried about the commute.' }));
  assert.equal(again.note_id, answer.note_id);
  await settle();
  assert.equal(about(ORLA, 'Deb Debrief').length, 1);
  assert.equal(about(MARCUS, 'Deb Debrief').length, 1);
});

// ---------- the note comes first ----------

test('the note is answered at once, with what it was answered before, however slow the mail provider is', async () => {
  const sly = await add({ job_id: job.sales, name: 'Sly Slow', email: 'sly@mail.example' }, id.priya);
  mail.delay = 3000;
  try {
    const began = Date.now();
    const res = await orla.post(`/applications/${sly}/notes`, { body: 'Quick one.' });
    const took = Date.now() - began;
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body), ['id']);
    assert.equal(typeof res.body.id, 'number');
    assert.ok(took < 1500, `the note took ${took} ms`);
    assert.equal(about(PRIYA, 'Sly Slow').length, 0, 'answered before the e-mail was handed over');
    await until(() => about(PRIYA, 'Sly Slow').length, (n) => n === 1, 10000);
  } finally { mail.delay = 0; }
});

test('an e-mail the provider refuses never stops the note, and is not counted: the next note tries again', async () => {
  const fia = await add({ job_id: job.sales, name: 'Fia Failing', email: 'fia@mail.example' }, id.priya);
  mail.failing = true;
  try {
    const answer = await note(orla, fia, 'While the provider is down.');
    assert.deepEqual(Object.keys(answer), ['id']);
    assert.equal(rows('SELECT body FROM notes WHERE id = ?', answer.id)[0].body, 'While the provider is down.');
    await until(() => rows('SELECT COUNT(*) AS n FROM note_mail WHERE application_id = ?', fia)[0].n, (n) => n === 0);
    await settle();
    assert.deepEqual(rows('SELECT * FROM note_mail WHERE application_id = ?', fia), []);
  } finally { mail.failing = false; }
  await note(orla, fia, 'And now it is back.');
  await until(() => [about(PRIYA, 'Fia Failing').length, about(MARCUS, 'Fia Failing').length], ([p, m]) => p === 1 && m === 1);
  assert.match(about(PRIYA, 'Fia Failing')[0].text, /And now it is back\./);
});

test('with delivery not connected, the note is saved and nobody is noted as told; the 15 minutes hold across a restart', async () => {
  const una = await add({ job_id: job.sales, name: 'Una Unconnected', email: 'una@mail.example' }, id.priya);
  const rae = rows(`SELECT a.id FROM applications a JOIN candidates c ON c.id = a.candidate_id WHERE c.name = 'Rae Repeat'`)[0].id;
  // Marcus was told about Rae within the last 15 minutes (the test above), and that is kept in the database.
  assert.equal(rows('SELECT COUNT(*) AS n FROM note_mail WHERE application_id = ? AND user_id = ?', rae, id.marcus)[0].n, 1);
  write('UPDATE note_mail SET mailed_at = ? WHERE application_id = ? AND user_id = ?', minutesAgo(5), rae, id.marcus);
  await server.stop();
  server = await startServer({ port: PORT, dataDir, env: env(false) });
  const sentBefore = mail.sent.length;
  // Nothing at all is written while delivery is not connected: not even the clearing of rows long over.
  write('INSERT INTO note_mail (user_id, application_id, note_id, mailed_at) VALUES (?, ?, 0, ?)', id.orla, una, minutesAgo(60));
  const answer = await note(orla, una, 'Written while e-mail is not connected.');
  assert.deepEqual(Object.keys(answer), ['id']);
  await settle();
  assert.equal(mail.sent.length, sentBefore);
  assert.deepEqual(rows('SELECT user_id, note_id FROM note_mail WHERE application_id = ?', una), [{ user_id: id.orla, note_id: 0 }]);

  await server.stop();
  server = await startServer({ port: PORT, dataDir, env: env(true) });
  await note(orla, una, 'Written once it is connected.');
  await until(() => [about(PRIYA, 'Una Unconnected').length, about(MARCUS, 'Una Unconnected').length], ([p, m]) => p === 1 && m === 1);
  // After the restart Marcus is still inside his 15 minutes for Rae.
  const marcusBefore = about(MARCUS, 'Rae Repeat').length;
  await note(orla, rae, 'After the restart.');
  await settle();
  assert.equal(about(MARCUS, 'Rae Repeat').length, marcusBefore);
});

test('no client user was ever e-mailed by any of the above', () => {
  // Tess and Pat were recruiters when they were told, and only made a client's users afterwards (see above).
  const clients = rows(`SELECT email FROM users WHERE role = 'client' AND email NOT IN ('tess@agency.example', 'pat@agency.example')`).map((u) => u.email);
  assert.deepEqual(clients, [MAYA]);
  const notes = mail.sent.filter((m) => m.subject.includes(' wrote a note on '));
  assert.ok(notes.length > 20, 'the tests sent e-mails to look through');
  for (const m of notes) for (const address of clients) assert.equal(m.to.includes(address), false, `${m.subject} went to ${address}`);
});
