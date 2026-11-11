// Asking somebody on the team to review a candidate, end to end: asking, the one-open-request rule, the reviewer's
// Inbox and count, answering, the answer coming back, cancelling and marking done, the e-mail heads-up, and what
// happens to requests when entries are folded together, when somebody goes back to The Book and when a person is
// erased. Above all: a client's user is sent nothing of it, on any route, and nothing of it is written to the tables
// the live release reads for clients. Run with `npm test`.
//
// One real server on a throwaway data folder, with e-mail delivery connected to a stand-in for the mail provider (so
// every message the server sends can be read whole). Two states cannot be reached through the app and are written
// straight into the database: a person removed outright (the app only ever deactivates people).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer, session, tempDir, until, PORTS } from './oracle-helpers.mjs';
import { look } from './metaview-helpers.mjs';

// The two ports kept for this file (see PORT_PLAN in oracle-helpers.mjs; a unit test checks that no two files share one).
const PORT = PORTS.reviews, MAIL_PORT = PORTS.reviewsMail;
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
let alex, priya, marcus, orla, maya; // the admin, two recruiters, a recruiter only ever asked to review, and somebody on Kestrel's hiring team
let id;                              // each person's user id, by first name
let kestrel, lumen;                  // the two clients
const job = {};                      // jobs by a short name
const app = {};                      // applications by a short name

const NOTE = 'Look at the gap after the last role and tell me if it worries you';
const COMMENT = 'The gap is explained in the cover letter: fine by me';
const ok = (res) => { assert.equal(res.status, 200, JSON.stringify(res.body)); return res.body; };
const refused = (res, status, words) => { assert.equal(res.status, status, JSON.stringify(res.body)); if (words) assert.match(res.body.error, words); };
/** Change the server's database behind its back, for the state no route can produce. */
function write(sql, ...values) {
  const db = new DatabaseSync(path.join(dataDir, 'app.db'));
  try { db.exec('PRAGMA foreign_keys = ON'); return db.prepare(sql).run(...values); } finally { db.close(); }
}
const rows = (sql, ...values) => look(dataDir, (all) => all(sql, ...values));
/** How many rows the tables the live release reads for clients hold, and the newest of each: none of it may change for a review. */
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
const ask = (who, applicationId, reviewerId, note) => who.post(`/applications/${applicationId}/reviews`, { reviewer_id: reviewerId, ...(note !== undefined ? { note } : {}) });
const reviewsOf = async (who, applicationId) => ok(await who.get(`/applications/${applicationId}/reviews`));
const inbox = async (who, query = '') => ok(await who.get(`/reviews${query}`));
const nav = async (who, query = '') => ok(await who.get(`/nav${query}`));

before(async () => {
  mail = await mailStandIn(MAIL_PORT);
  dataDir = tempDir('reviews');
  server = await startServer({ port: PORT, dataDir, env: { RESEND_API_KEY: 'test-key', RESEND_API_URL: mail.url, MAIL_FROM: 'Harbour Talent <team@harbourtalent.example>', APP_URL } });
  alex = session(server.base);
  ok(await alex.post('/setup', { agencyName: 'Harbour Talent', name: 'Alex Morgan', email: 'alex@agency.example', password: 'demo1234' }));
  kestrel = ok(await alex.post('/clients', { name: 'Kestrel Logistics', brand_color: '#b45309' })).id;
  lumen = ok(await alex.post('/clients', { name: 'Lumen Health', brand_color: '#0b6e99' })).id;
  priya = await join('recruiter', 'Priya Nair', 'priya@agency.example');
  marcus = await join('recruiter', 'Marcus Bell', 'marcus@agency.example');
  // Orla's name is written nowhere but in review requests, so finding it in what a client's user is sent could only be a leak.
  orla = await join('recruiter', 'Orla Quillfeather', 'orla@agency.example');
  maya = await join('client', 'Maya Okonkwo', 'maya@kestrel.example', { client_id: kestrel });
  id = await userIds();
  // Priya is the account executive of Kestrel's sales job, Marcus of Lumen's designer job.
  job.sales = ok(await priya.post('/jobs', { client_id: kestrel, title: 'Head of Sales', status: 'open', description: 'A role.' })).id;
  job.designer = ok(await marcus.post('/jobs', { client_id: lumen, title: 'Product Designer', status: 'open', description: 'A role.' })).id;
  app.ivo = await add({ job_id: job.sales, name: 'Ivo Interview', email: 'ivo@mail.example' });
  app.lena = await add({ job_id: job.designer, name: 'Lena Lumen', email: 'lena@mail.example' });
  app.nora = await add({ name: 'Nora Nojob', email: 'nora@mail.example' }); // in The Book, on no job
});

after(async () => {
  await server?.stop();
  await mail?.stop();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

// ---------- asking ----------

test('who can be asked: anybody active on the agency team but yourself, with the job’s account executive suggested when it is somebody else', async () => {
  // A request for an account, waiting: not somebody on the team yet. And somebody who has left.
  ok(await session(server.base).post('/signup', { name: 'Pat Pending', email: 'pat@agency.example' }));
  const dana = await join('recruiter', 'Dana Frost', 'dana@agency.example');
  id = await userIds();
  ok(await alex.patch(`/users/${id.dana}`, { active: false }));
  assert.ok(dana);

  const forAlex = await reviewsOf(alex, app.ivo);
  assert.deepEqual(forAlex.people.map((p) => p.name), ['Marcus Bell', 'Orla Quillfeather', 'Priya Nair']);
  assert.equal(forAlex.suggested, id.priya, 'the job’s account executive');
  assert.deepEqual(forAlex.reviews, []);
  // Priya is the account executive herself: nobody is suggested, and she is not offered.
  const forPriya = await reviewsOf(priya, app.ivo);
  assert.deepEqual([forPriya.suggested, forPriya.people.map((p) => p.name)], [null, ['Alex Morgan', 'Marcus Bell', 'Orla Quillfeather']]);
  // Somebody on no job has no account executive.
  assert.equal((await reviewsOf(alex, app.nora)).suggested, null);
  assert.equal((await reviewsOf(alex, app.lena)).suggested, id.marcus);

  // Never yourself, never a client's user, never somebody deactivated or waiting, never somebody who does not exist.
  refused(await ask(alex, app.ivo, id.alex), 400, /You cannot ask yourself/);
  for (const reviewer of [id.maya, id.dana, id.pat, 999999, 'abc', null, true, [id.priya], `${id.priya}.0`]) refused(await ask(alex, app.ivo, reviewer), 400, /Choose somebody who is active on your team/);
  refused(await ask(alex, 999999, id.priya), 404);
  assert.equal(rows('SELECT COUNT(*) AS n FROM team_reviews')[0].n, 0, 'nothing was made');
});

test('asking makes one open request for each candidate and person; asking the same person again is refused, asking somebody else is not', async () => {
  const before = clientTables();
  const first = ok(await ask(alex, app.ivo, id.priya, `  ${NOTE}  `)).id;
  refused(await ask(alex, app.ivo, id.priya, 'Again'), 409, /^Priya Nair has already been asked to review Ivo Interview and has not answered yet\.$/);
  refused(await ask(marcus, app.ivo, String(id.priya)), 409, /Priya Nair has already been asked/);
  const second = ok(await ask(alex, app.ivo, id.orla)).id;
  assert.ok(second > first);

  const { reviews } = await reviewsOf(marcus, app.ivo);
  assert.deepEqual(reviews.map((r) => [r.id, r.reviewer_name, r.asked_by_name, r.note, r.open, r.reviewer_can_answer, r.yours_to_answer, r.can_cancel]),
    [[second, 'Orla Quillfeather', 'Alex Morgan', null, true, true, false, false], [first, 'Priya Nair', 'Alex Morgan', NOTE, true, true, false, false]], 'newest first; Marcus neither asked nor was asked');
  assert.deepEqual((await reviewsOf(priya, app.ivo)).reviews.map((r) => [r.yours_to_answer, r.can_cancel]), [[false, false], [true, false]]);
  assert.deepEqual((await reviewsOf(alex, app.ivo)).reviews.map((r) => r.can_cancel), [true, true]);

  // An e-mail to Priya, and only to her. Nothing is recorded where a client could be shown it.
  await until(() => mail.to('priya@agency.example'), (list) => list.length === 1);
  await until(() => mail.to('orla@agency.example'), (list) => list.length === 1);
  const [message] = mail.to('priya@agency.example');
  assert.equal(message.subject, 'Alex Morgan asked you to review a candidate');
  for (const words of ['Hi Priya', 'Candidate: Ivo Interview', 'Job: Head of Sales at Kestrel Logistics', `What to look at: ${NOTE}`, `Open their profile: ${APP_URL}/inbox?tab=reviews&c=${app.ivo}`]) {
    assert.ok(message.text.includes(words), `the e-mail says ${words}:\n${message.text}`);
  }
  assert.equal(mail.to('orla@agency.example')[0].text.includes('What to look at'), false, 'no note, no line for it');
  // Nothing to the candidate, nor to anybody at the client: the heads-up goes to the two people asked and nobody else.
  assert.deepEqual(mail.sent.filter((m) => /asked you to review/.test(m.subject)).flatMap((m) => m.to).sort(), ['orla@agency.example', 'priya@agency.example']);
  assert.deepEqual([...mail.to('ivo@mail.example'), ...mail.to('maya@kestrel.example')], []);
  assert.deepEqual(clientTables(), before);
});

test('a request for somebody on no job, and an e-mail that cannot be sent, are both still requests', async () => {
  mail.failing = true;
  try {
    const made = ok(await ask(priya, app.nora, id.alex, 'Worth putting forward for the Kestrel job?'));
    assert.ok(made.id);
    // The server tried, the provider failed, and the request stands. The failure is in the log.
    await until(() => server.output(), (log) => log.includes('Notification email failed'));
  } finally { mail.failing = false; }
  const [nora] = (await reviewsOf(alex, app.nora)).reviews;
  assert.deepEqual([nora.reviewer_name, nora.asked_by_name, nora.yours_to_answer], ['Alex Morgan', 'Priya Nair', true]);
  ok(await ask(priya, app.nora, id.marcus));
  await until(() => mail.to('marcus@agency.example'), (list) => list.length === 1);
  assert.match(mail.to('marcus@agency.example')[0].text, /Job: Not on a job yet/);
});

test('an admin can send themselves a test e-mail, and is told what the mail provider said when it refuses', async () => {
  const before = mail.sent.length;
  assert.deepEqual(ok(await alex.post('/settings/test-email', {})), { ok: true, to: 'alex@agency.example' });
  const [sent] = mail.sent.slice(before);
  assert.deepEqual(sent.to, ['alex@agency.example']);
  assert.match(sent.subject, /^A test e-mail from /);
  assert.equal(mail.sent.length, before + 1, 'one e-mail, to the admin and nobody else');
  // The provider refuses: the admin is told, in the provider's words.
  mail.failing = true;
  try {
    const refused = await alex.post('/settings/test-email', {});
    assert.equal(refused.status, 502);
    assert.equal(refused.body.error, 'The test email was not sent. Resend answered: stand-in is down');
  } finally { mail.failing = false; }
  // It is the admins': not a recruiter's, not a client's user's, not a visitor's.
  assert.equal((await priya.post('/settings/test-email', {})).status, 403);
  assert.equal((await maya.post('/settings/test-email', {})).status, 403);
  assert.equal((await session(server.base).post('/settings/test-email', {})).status, 401);
  assert.equal(mail.sent.length, before + 1);
});

// ---------- the reviewer's Inbox, and the count ----------

test('the Inbox lists what is waiting on you, oldest first, with the candidate, the job and client, who asked, when and the note', async () => {
  ok(await ask(marcus, app.lena, id.priya, 'Designer or researcher?'));
  const { waiting, answers } = await inbox(priya);
  assert.deepEqual(answers, []);
  assert.deepEqual(waiting.map((r) => [r.name, r.job_title, r.client_name, r.asked_by_name, r.note]), [
    ['Ivo Interview', 'Head of Sales', 'Kestrel Logistics', 'Alex Morgan', NOTE],
    ['Lena Lumen', 'Product Designer', 'Lumen Health', 'Marcus Bell', 'Designer or researcher?'],
  ]);
  assert.ok(waiting[0].created_at < waiting[1].created_at);
  assert.equal(waiting[0].application_id, app.ivo, 'what "Review" opens');
  // Alex's: Nora, on no job, whatever client the menu shows.
  const forAlex = await inbox(alex);
  assert.deepEqual(forAlex.waiting.map((r) => [r.name, r.job_id, r.job_title, r.asked_by_name]), [['Nora Nojob', null, null, 'Priya Nair']]);
  assert.deepEqual((await inbox(alex, `?client_id=${kestrel}`)).waiting.map((r) => r.name), ['Nora Nojob']);
  // It follows the client chosen in the menu, except that people on no job are always there.
  assert.deepEqual((await inbox(priya, `?client_id=${lumen}`)).waiting.map((r) => r.name), ['Lena Lumen']);
  assert.deepEqual((await inbox(priya, `?client_id=${kestrel}`)).waiting.map((r) => r.name), ['Ivo Interview']);
  assert.deepEqual((await inbox(marcus)).waiting.map((r) => r.name), ['Nora Nojob']);
});

test('the menu’s count: what is waiting on you, in view of the client chosen, and of it what is yours to answer', async () => {
  assert.deepEqual([(await nav(priya)).reviews, (await nav(priya)).to_review], [2, 2]);
  assert.deepEqual([(await nav(priya, `?client_id=${lumen}`)).reviews, (await nav(priya, `?client_id=${lumen}`)).to_review], [1, 1]);
  assert.deepEqual([(await nav(alex)).reviews, (await nav(alex, `?client_id=${lumen}`)).reviews], [1, 1], 'Nora, on no job, counts in every view');
  assert.deepEqual([(await nav(orla)).reviews, (await nav(orla)).to_review], [1, 1]);
});

test('one open request for each candidate and person holds across their jobs: the same record on a second job cannot be put to the same person again', async () => {
  job.ops = ok(await alex.post('/jobs', { client_id: kestrel, title: 'Operations Lead', status: 'open', description: 'A role.' })).id;
  const onSales = await add({ job_id: job.sales, name: 'Tom Twice', email: 'tom@mail.example' });
  const onOps = await add({ job_id: job.ops, name: 'Tom Twice', email: 'tom@mail.example' });
  const [a, b] = [onSales, onOps].map((x) => rows('SELECT candidate_id FROM applications WHERE id = ?', x)[0].candidate_id);
  assert.equal(a, b, 'one record, on two jobs');
  const first = ok(await ask(alex, onSales, id.marcus)).id;
  refused(await ask(priya, onOps, id.marcus), 409, /^Marcus Bell has already been asked to review Tom Twice, on their profile for Head of Sales at Kestrel Logistics, and has not answered yet\.$/);
  const forOrla = ok(await ask(priya, onOps, id.orla)).id;
  assert.equal((await nav(marcus)).to_review, 2, 'Nora, and Tom once');
  // Closed, he can be asked again on either.
  ok(await alex.post(`/reviews/${first}/cancel`));
  ok(await priya.post(`/reviews/${ok(await ask(priya, onOps, id.marcus)).id}/cancel`));
  ok(await priya.post(`/reviews/${forOrla}/cancel`));
});

// ---------- answering, and the answer coming back ----------

test('only the person asked answers, once, with Good to go or Not a fit and a comment; the answer goes back to whoever asked', async () => {
  const [forIvo] = (await inbox(priya)).waiting;
  refused(await alex.post(`/reviews/${forIvo.id}/answer`, { answer: 'good_to_go' }), 403, /Only the person who was asked can answer/);
  refused(await marcus.post(`/reviews/${forIvo.id}/answer`, { answer: 'good_to_go' }), 403);
  for (const answer of [undefined, 'yes', 'Good to go', '', 1, ['good_to_go'], { good_to_go: true }]) refused(await priya.post(`/reviews/${forIvo.id}/answer`, { answer }), 400, /Choose Good to go or Not a fit/);
  refused(await priya.post('/reviews/999999/answer', { answer: 'good_to_go' }), 404);
  // Rejecting the candidate does not close the request: Priya can still answer.
  ok(await alex.post(`/applications/${app.ivo}/reject`, { reason: 'Not a match' }));
  const before = clientTables();
  ok(await priya.post(`/reviews/${forIvo.id}/answer`, { answer: 'good_to_go', comment: COMMENT }));
  refused(await priya.post(`/reviews/${forIvo.id}/answer`, { answer: 'not_a_fit' }), 409, /already answered/);
  assert.deepEqual(clientTables(), before, 'an answer is written nowhere a client is shown from');
  ok(await alex.post(`/applications/${app.ivo}/restore`));

  // Gone from Priya's Inbox and count; in Alex's, as an answer, counted.
  assert.deepEqual((await inbox(priya)).waiting.map((r) => r.name), ['Lena Lumen']);
  assert.deepEqual([(await nav(priya)).reviews, (await nav(priya)).to_review], [1, 1]);
  const { answers } = await inbox(alex);
  assert.deepEqual(answers.map((r) => [r.name, r.reviewer_name, r.answer, r.comment, r.can_mark_done]), [['Ivo Interview', 'Priya Nair', 'good_to_go', COMMENT, true]]);
  assert.deepEqual([(await nav(alex)).reviews, (await nav(alex)).to_review], [2, 1]);
  // The answer follows the client chosen in the menu, in the count as in the Inbox: Ivo is Kestrel's.
  assert.deepEqual([(await nav(alex, `?client_id=${kestrel}`)).reviews, (await nav(alex, `?client_id=${lumen}`)).reviews], [2, 1]);
  assert.deepEqual([(await inbox(alex, `?client_id=${kestrel}`)).answers.length, (await inbox(alex, `?client_id=${lumen}`)).answers.length], [1, 0]);
  // Only whoever asked is offered Done on the profile.
  for (const [who, can] of [[alex, true], [priya, false], [marcus, false]]) {
    assert.equal((await reviewsOf(who, app.ivo)).reviews.find((r) => r.id === forIvo.id).can_mark_done, can);
  }
  // Answered, it can no longer be taken back.
  refused(await alex.post(`/reviews/${forIvo.id}/cancel`), 409, /answered already/);
});

test('Done clears an answer from the Inbox of whoever asked; opening the candidate does not', async () => {
  const [answer] = (await inbox(alex)).answers;
  // Opening the profile, and its requests, leaves it where it is.
  ok(await alex.get(`/applications/${answer.application_id}`));
  ok(await alex.get(`/applications/${answer.application_id}/reviews`));
  assert.equal((await inbox(alex)).answers.length, 1);
  refused(await priya.post(`/reviews/${answer.id}/done`), 403, /Only whoever asked can mark this done/);
  const open = (await inbox(priya)).waiting[0];
  refused(await marcus.post(`/reviews/${open.id}/done`), 409, /not been answered yet/);
  ok(await alex.post(`/reviews/${answer.id}/done`));
  ok(await alex.post(`/reviews/${answer.id}/done`)); // twice is the same
  assert.deepEqual((await inbox(alex)).answers, []);
  assert.deepEqual([(await nav(alex)).reviews, (await nav(alex)).to_review], [1, 1]);
  // The profile keeps it, as history: who asked whom, when, the note, the answer and the comment.
  const kept = (await reviewsOf(marcus, app.ivo)).reviews.find((r) => r.id === answer.id);
  assert.deepEqual([kept.asked_by_name, kept.reviewer_name, kept.note, kept.answer, kept.comment, kept.open, Boolean(kept.done_at), Boolean(kept.answered_at)],
    ['Alex Morgan', 'Priya Nair', NOTE, 'good_to_go', COMMENT, false, true, true]);
  // And with this one closed, Priya can be asked about Ivo again.
  ok(await ask(marcus, app.ivo, id.priya, 'One more look, now the client changed the brief?'));
});

test('whoever asked, or an admin, can take a request back; nobody else can', async () => {
  const req = ok(await ask(priya, app.lena, id.orla, 'Portfolio first'));
  refused(await marcus.post(`/reviews/${req.id}/cancel`), 403, /Only whoever asked, or an admin/);
  refused(await orla.post(`/reviews/${req.id}/cancel`), 403);
  ok(await alex.post(`/reviews/${req.id}/cancel`));   // an admin
  ok(await priya.post(`/reviews/${req.id}/cancel`));  // already taken back: the same answer
  refused(await orla.post(`/reviews/${req.id}/answer`, { answer: 'not_a_fit' }), 409, /taken back/);
  assert.equal((await inbox(orla)).waiting.some((r) => r.id === req.id), false);
  const cancelled = (await reviewsOf(priya, app.lena)).reviews.find((r) => r.id === req.id);
  assert.deepEqual([cancelled.open, cancelled.cancelled_by_name, cancelled.can_cancel], [false, 'Alex Morgan', false]);
  // Taken back, Orla can be asked again.
  const again = ok(await ask(priya, app.lena, id.orla));
  ok(await priya.post(`/reviews/${again.id}/cancel`));
});

test('the profile always has every open request and every answer still in somebody’s Inbox, however many closed ones come after', async () => {
  const hal = await add({ name: 'Hal History', email: 'hal@mail.example' });
  const open = ok(await ask(alex, hal, id.priya, 'The oldest, and still open')).id;
  const answered = ok(await ask(alex, hal, id.marcus)).id;
  ok(await marcus.post(`/reviews/${answered}/answer`, { answer: 'not_a_fit' }));
  for (let i = 0; i < 21; i += 1) ok(await marcus.post(`/reviews/${ok(await ask(marcus, hal, id.orla)).id}/cancel`));
  const mine = (await reviewsOf(priya, hal)).reviews;
  assert.deepEqual(mine.find((r) => r.id === open)?.yours_to_answer, true, 'Priya can answer it on the profile');
  const forAlex = (await reviewsOf(alex, hal)).reviews;
  assert.deepEqual([forAlex.find((r) => r.id === open)?.can_cancel, forAlex.find((r) => r.id === answered)?.can_mark_done], [true, true]);
  assert.equal(forAlex.length, 22, 'the two, and the 20 newest of the rest');
  assert.deepEqual(forAlex.map((r) => r.id), [...forAlex.map((r) => r.id)].sort((x, y) => y - x), 'newest first');
  // Once done, the answer is history like the rest, and the 20 newest of those are shown.
  ok(await alex.post(`/reviews/${answered}/done`));
  assert.deepEqual((await reviewsOf(alex, hal)).reviews.map((r) => r.id).includes(answered), false);
  ok(await priya.post(`/reviews/${open}/answer`, { answer: 'good_to_go' }));
  ok(await alex.post(`/reviews/${open}/done`));
});

// ---------- somebody who can no longer answer ----------

test('a reviewer who is deactivated, made a client’s user, or removed leaves their open requests answerable by nobody, and they can be taken back', async () => {
  const tess = await join('recruiter', 'Tess Gray', 'tess@agency.example');
  const vic = await join('recruiter', 'Vic Hale', 'vic@agency.example');
  id = await userIds();
  const forTess = ok(await ask(marcus, app.lena, id.tess, 'Salary check')).id;
  const forVic = ok(await ask(marcus, app.lena, id.vic)).id;
  const forOrla = ok(await ask(priya, app.lena, id.orla, 'Orla, before she leaves')).id;
  assert.equal((await inbox(tess)).waiting.length, 1);

  // Tess leaves: deactivated. Then she comes back as somebody on Kestrel's hiring team.
  ok(await alex.patch(`/users/${id.tess}`, { active: false }));
  refused(await tess.post(`/reviews/${forTess}/answer`, { answer: 'good_to_go' }), 401);
  let shown = (await reviewsOf(marcus, app.lena)).reviews.find((r) => r.id === forTess);
  assert.deepEqual([shown.open, shown.reviewer_name, shown.reviewer_can_answer, shown.can_cancel], [true, 'Tess Gray', false, true]);
  const { token } = ok(await alex.post('/invites', { role: 'client', email: 'tess@agency.example', client_id: kestrel }));
  const tessAtClient = session(server.base);
  ok(await tessAtClient.post(`/invites/${token}/accept`, { name: 'Tess Gray', password: 'demo1234' }));
  refused(await tessAtClient.post(`/reviews/${forTess}/answer`, { answer: 'good_to_go' }), 403);
  refused(await tessAtClient.get('/reviews'), 403);
  assert.equal('reviews' in ok(await tessAtClient.get('/nav')), false);
  shown = (await reviewsOf(marcus, app.lena)).reviews.find((r) => r.id === forTess);
  assert.deepEqual([shown.open, shown.reviewer_can_answer], [true, false]);
  // Nor can she be asked again.
  refused(await ask(marcus, app.ivo, id.tess), 400, /Choose somebody who is active on your team/);

  // Vic is removed from the database outright: the request stays, with nobody, and nobody can answer it.
  assert.ok(vic);
  write('DELETE FROM users WHERE id = ?', id.vic);
  shown = (await reviewsOf(marcus, app.lena)).reviews.find((r) => r.id === forVic);
  assert.deepEqual([shown.open, shown.reviewer_id, shown.reviewer_name, shown.reviewer_can_answer, shown.can_cancel], [true, null, null, false, true]);
  // Both are taken back by whoever asked; an admin could as well.
  ok(await marcus.post(`/reviews/${forTess}/cancel`));
  ok(await alex.post(`/reviews/${forVic}/cancel`));

  // Whoever asked is removed: the request is kept with nobody as the asker, and Orla can still answer it.
  const temp = await join('recruiter', 'Sam Short', 'sam@agency.example');
  id = await userIds();
  const fromSam = ok(await ask(temp, app.nora, id.orla, 'From Sam')).id;
  write('DELETE FROM users WHERE id = ?', id.sam);
  const orphan = (await inbox(orla)).waiting.find((r) => r.id === fromSam);
  assert.deepEqual([orphan.asked_by, orphan.asked_by_name], [null, null]);
  ok(await orla.post(`/reviews/${fromSam}/answer`, { answer: 'not_a_fit' }));
  ok(await orla.post(`/reviews/${forOrla}/answer`, { answer: 'not_a_fit', comment: 'Not senior enough' }));
  assert.equal((await inbox(priya)).answers.some((r) => r.id === forOrla), true);
});

// ---------- a client's user ----------

test('a client’s user is refused on every route of this, and sent nothing of it anywhere: not a request, a note, an answer, a count or a name', async () => {
  // Requests about a Kestrel candidate that Maya can open, asked of Orla: one answered with a comment, and one open
  // with a note.
  const asked = (await inbox(orla)).waiting.find((r) => r.application_id === app.ivo);
  ok(await orla.post(`/reviews/${asked.id}/answer`, { answer: 'not_a_fit', comment: 'A comment Maya must never read' }));
  const req = ok(await ask(alex, app.ivo, id.orla, 'A note Maya must never read')).id;
  assert.equal(ok(await maya.get(`/applications/${app.ivo}`)).candidate.name, 'Ivo Interview', 'she can open the candidate');

  for (const [method, pathname] of [['get', `/applications/${app.ivo}/reviews`], ['post', `/applications/${app.ivo}/reviews`], ['get', '/reviews'], ['get', `/reviews?client_id=${kestrel}`],
    ['post', `/reviews/${req}/answer`], ['post', `/reviews/${req}/cancel`], ['post', `/reviews/${req}/done`], ['post', '/reviews/999999/answer']]) {
    const answer = method === 'get' ? await maya.get(pathname) : await maya.post(pathname, { reviewer_id: id.priya, answer: 'good_to_go' });
    refused(answer, 403, /Only the agency team can do this/);
    assert.equal(JSON.stringify(answer.body).includes('Orla'), false);
  }
  const sent = {};
  for (const pathname of ['/nav', `/nav?client_id=${kestrel}`, '/me', '/dashboard', '/jobs', `/jobs/${job.sales}`, `/applications?job_id=${job.sales}`, '/applications', `/applications/${app.ivo}`,
    '/users', `/users?client_id=${kestrel}`, '/interviews', '/reports', '/clients', `/clients/${kestrel}`, '/templates', '/owners']) {
    const answer = await maya.get(pathname);
    assert.equal(answer.status, 200, pathname);
    sent[pathname] = JSON.stringify(answer.body);
  }
  for (const [pathname, body] of Object.entries(sent)) {
    // The team's names are in the lists of people a client's user is given (/users, /owners), as they always were.
    // Orla's is in nothing else, so anywhere else it could only be there as somebody asked to review.
    const names = ['/users', `/users?client_id=${kestrel}`, '/owners'].includes(pathname) ? [] : ['Orla', 'Quillfeather'];
    for (const word of ['Maya must never read', ...names, 'team_review', 'reviewer', 'asked_by', 'to_review', '"reviews"', 'good_to_go', 'not_a_fit', 'Good to go', 'Not a fit']) {
      assert.equal(body.includes(word), false, `${pathname} mentions ${word}`);
    }
  }
  // The agency's own count is there for the agency.
  assert.ok((await nav(orla)).reviews >= 1);
});

test('nothing about a review is written to the tables the live release reads for clients, nor to applications or candidates', async () => {
  const columns = (table) => rows(`SELECT name FROM pragma_table_info('${table}')`).map((c) => c.name);
  for (const table of ['applications', 'candidates']) for (const name of columns(table)) assert.equal(/team|reviewer|asked/.test(name), false, `${table}.${name}`);
  const texts = rows(`SELECT detail AS t FROM activities UNION ALL SELECT detail FROM agency_activities UNION ALL SELECT body FROM emails UNION ALL SELECT subject FROM emails
    UNION ALL SELECT body FROM agency_emails UNION ALL SELECT body FROM notes`).map((r) => r.t || '');
  for (const words of [NOTE, COMMENT, 'Maya must never read', 'asked you to review', 'Orla']) assert.equal(texts.some((t) => t.includes(words)), false, words);
  assert.ok(rows('SELECT COUNT(*) AS n FROM team_reviews')[0].n > 5, 'they are all in their own table');
});

// ---------- what happens around a request ----------

test('folding two entries in The Book into one moves the requests with it, taking back an open one that the kept entry already has', async () => {
  const keptId = await add({ name: 'Ruth Merge', email: 'ruth@mail.example' });
  const goingId = await add({ name: 'Ruth Merge', email: 'ruth.other@mail.example' });
  const [kept, going] = [keptId, goingId].map((a) => rows('SELECT candidate_id FROM applications WHERE id = ?', a)[0].candidate_id);
  const onKept = ok(await ask(alex, keptId, id.priya, 'On the kept entry')).id;
  const twin = ok(await ask(marcus, goingId, id.priya, 'The same person asked again, on the other entry')).id;
  const moves = ok(await ask(alex, goingId, id.orla, 'Only on the other entry')).id;
  const answered = ok(await ask(alex, goingId, id.marcus)).id;
  ok(await marcus.post(`/reviews/${answered}/answer`, { answer: 'good_to_go' }));

  ok(await alex.post(`/candidates/${going}/merge`, { into: kept }));
  assert.deepEqual(rows('SELECT id FROM applications WHERE id = ?', goingId), [], 'the other entry is gone');
  const now = rows('SELECT id, application_id, cancelled_at IS NOT NULL AS cancelled, cancelled_by FROM team_reviews WHERE id IN (?, ?, ?, ?) ORDER BY id', onKept, twin, moves, answered);
  // The second open one to Priya is taken back, by whoever merged them, and kept in the history so Marcus can see it.
  assert.deepEqual(now, [{ id: onKept, application_id: keptId, cancelled: 0, cancelled_by: null }, { id: twin, application_id: keptId, cancelled: 1, cancelled_by: id.alex },
    { id: moves, application_id: keptId, cancelled: 0, cancelled_by: null }, { id: answered, application_id: keptId, cancelled: 0, cancelled_by: null }]);
  const history = (await reviewsOf(marcus, keptId)).reviews.find((r) => r.id === twin);
  assert.deepEqual([history.open, history.asked_by_name, history.note, history.cancelled_by_name], [false, 'Marcus Bell', 'The same person asked again, on the other entry', 'Alex Morgan']);
  assert.deepEqual((await inbox(priya)).waiting.filter((r) => r.name === 'Ruth Merge').map((r) => [r.id, r.application_id]), [[onKept, keptId]]);
  assert.deepEqual((await inbox(orla)).waiting.filter((r) => r.name === 'Ruth Merge').map((r) => r.application_id), [keptId]);
  assert.equal(rows('SELECT COUNT(*) AS n FROM team_reviews WHERE application_id NOT IN (SELECT id FROM applications)')[0].n, 0, 'nothing points at nothing');
});

test('an entry joined to the application a client’s record has in the job takes its requests there; going back to The Book keeps them', async () => {
  // Kestrel has Jo in Head of Sales already; The Book has an entry for Jo, under the same address.
  const there = await add({ job_id: job.sales, name: 'Jo Joined', email: 'jo@mail.example' });
  const entry = await add({ name: 'Jo Joined', email: 'jo@mail.example' });
  const onEntry = ok(await ask(alex, entry, id.marcus, 'Asked while Jo was in The Book')).id;
  const twin = ok(await ask(alex, entry, id.priya)).id;
  const onThere = ok(await ask(marcus, there, id.priya)).id;
  const record = rows('SELECT candidate_id FROM applications WHERE id = ?', there)[0].candidate_id;
  const joined = ok(await alex.post(`/applications/${entry}/add-to-job`, { job_id: job.sales, into: record }));
  assert.deepEqual([joined.id, joined.merged], [there, true]);
  assert.deepEqual(rows('SELECT id, application_id, cancelled_by FROM team_reviews WHERE id IN (?, ?, ?) ORDER BY id', onEntry, twin, onThere),
    [{ id: onEntry, application_id: there, cancelled_by: null }, { id: twin, application_id: there, cancelled_by: id.alex }, { id: onThere, application_id: there, cancelled_by: null }]);
  // Still nothing for Maya, though the application is her company's.
  assert.equal(JSON.stringify(ok(await maya.get(`/applications/${there}`))).includes('Asked while Jo was in The Book'), false);

  // Somebody from The Book put on a job and then taken off it goes back with their requests: they are about the person.
  const sid = await add({ name: 'Sid Back', email: 'sid@mail.example' });
  const aboutSid = ok(await ask(alex, sid, id.priya, 'About Sid')).id;
  assert.equal(ok(await alex.post(`/applications/${sid}/add-to-job`, { job_id: job.designer })).id, sid);
  assert.equal((await inbox(priya, `?client_id=${lumen}`)).waiting.some((r) => r.id === aboutSid), true, 'on the job, listed under its client');
  const back = ok(await alex.del(`/applications/${sid}`));
  assert.deepEqual([back.returned, back.id], [true, sid]);
  const after = (await inbox(priya, `?client_id=${kestrel}`)).waiting.find((r) => r.id === aboutSid);
  assert.deepEqual([after.application_id, after.job_id], [sid, null], 'back in The Book, on no job, listed in every view');
  ok(await priya.post(`/reviews/${aboutSid}/answer`, { answer: 'good_to_go' }));
});

test('“Delete all data on this person”, removing them from a job and deleting a job all take their requests with them', async () => {
  const gone = await add({ job_id: job.designer, name: 'Gil Gone', email: 'gil@mail.example' });
  const asked = ok(await ask(alex, gone, id.priya, 'Gil')).id;
  const cand = rows('SELECT candidate_id FROM applications WHERE id = ?', gone)[0].candidate_id;
  ok(await alex.del(`/candidates/${cand}`));
  assert.deepEqual(rows('SELECT id FROM team_reviews WHERE id = ?', asked), []);
  assert.equal((await inbox(priya)).waiting.some((r) => r.id === asked), false);

  const removed = await add({ job_id: job.designer, name: 'Rae Removed', email: 'rae@mail.example' });
  const aboutRae = ok(await ask(alex, removed, id.priya)).id;
  ok(await alex.del(`/applications/${removed}`));
  assert.deepEqual(rows('SELECT id FROM team_reviews WHERE id = ?', aboutRae), []);

  const temp = ok(await alex.post('/jobs', { client_id: lumen, title: 'Short-lived job', status: 'open' })).id;
  const inIt = await add({ job_id: temp, name: 'Kit Kept', email: 'kit@mail.example' });
  const aboutKit = ok(await ask(alex, inIt, id.marcus)).id;
  ok(await alex.del(`/jobs/${temp}`));
  assert.deepEqual(rows('SELECT id FROM team_reviews WHERE id = ?', aboutKit), []);
  assert.equal(rows('SELECT COUNT(*) AS n FROM team_reviews WHERE application_id NOT IN (SELECT id FROM applications)')[0].n, 0);
  // Somebody not signed in is told to sign in, as on every route behind the sign-in.
  refused(await session(server.base).get('/reviews'), 401);
});
