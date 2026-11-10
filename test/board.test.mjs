// Our job board, end to end: the agency's confidential posts, the check that keeps the client out of them, the
// public board and its feed, applying, the e-mails that follow, and who may show the board inside their website.
// Run with `npm test`.
//
// A story is acted out against the real server on a throwaway data folder, with stand-ins for the two outside
// services it talks to: the AI service that drafts an advert, and the mail service (so the whole text of every
// e-mail a candidate is sent can be read). Neither real service is called, so nothing here shows what the model
// itself would write. The board's pages inside a real browser, and inside another website's page, are not driven
// here: that was done by hand while the board was built (see the README).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { startServer, session, tempDir, until, PORTS, FIXTURES } from './oracle-helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Four ports the other test files leave free (see oracle-helpers.mjs for who uses which).
const PORT = PORTS.main + 5, UPGRADE_PORT = PORTS.main + 6, AI_PORT = PORTS.main + 7, MAIL_PORT = PORTS.main + 8;
// The pages themselves are only there once the front end has been built; the headers they are sent with always are.
const BUILT = fs.existsSync(path.join(ROOT, 'dist', 'index.html'));

const listen = (server, port) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
const close = (server) => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });

const DRAFT = {
  title: 'Senior Backend Engineer',
  description: 'Our client is a growing health-technology company.\n\nWhat you will do\n• Build and run backend services',
  removed: ['The company’s name and its product names', 'The number of clinics, now “several hundred”'],
};
/** Stand-in for the AI service's POST /v1/messages. `mode` chooses the answer; every request is kept, with its headers. */
async function aiStandIn(port) {
  const state = { mode: 'ok', requests: [] };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      state.requests.push({ headers: req.headers, body: JSON.parse(raw) });
      const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'request-id': 'req_stub' }); res.end(JSON.stringify(value)); };
      const base = { id: 'msg_stub', type: 'message', role: 'assistant', model: 'stub', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } };
      if (state.mode === 'key') return send(401, { type: 'error', error: { type: 'authentication_error', message: 'stub' } });
      if (state.mode === 'refuse') return send(200, { ...base, content: [], stop_reason: 'refusal' });
      // A draft that did not do its job: the employer is still named in it.
      const draft = state.mode === 'leaky' ? { ...DRAFT, description: `${DRAFT.description}\n• Join the team at Lumen Health` } : DRAFT;
      send(200, { ...base, content: [{ type: 'text', text: JSON.stringify(draft) }], stop_reason: 'end_turn' });
    });
  });
  await listen(server, port);
  return Object.assign(state, { url: `http://127.0.0.1:${port}`, stop: () => close(server) });
}
/** Stand-in for the mail service. Every e-mail the server hands over is kept whole: { from, to, subject, text }. */
async function mailStandIn(port) {
  const sent = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => { sent.push(JSON.parse(raw)); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"id":"stub"}'); });
  });
  await listen(server, port);
  return { sent, url: `http://127.0.0.1:${port}/emails`, to: (address) => sent.filter((m) => m.to.includes(address)), stop: () => close(server) };
}

let ai, mail, server, dataDir;
let alex, priya, maya, hana;     // the admin, a recruiter, a hiring manager at Lumen Health, and one at North
let lumen, north;                // client ids
let job, northJob;               // job ids
let token, northToken;           // the two posts' public addresses
let careersBefore;               // what the client's own careers routes said before any post existed
let visitor = 0;
/** Each visitor to the public pages comes from an address of their own, so the limit on applications counts them apart. */
const someone = () => `198.51.${Math.floor(++visitor / 250)}.${visitor % 250 + 1}`;

const ok = (res) => { assert.equal(res.status, 200, JSON.stringify(res.body)); return res.body; };
const refused = (res, status, words) => { assert.equal(res.status, status, JSON.stringify(res.body)); if (words) assert.match(res.body.error, words); };
/** A visitor's request to a public address: no cookie, no sign-in. */
async function visit(pathname, { method = 'GET', body, ip = someone() } = {}) {
  const res = await fetch(`${server.base}${pathname}`, { method, body, headers: { 'X-Forwarded-For': ip }, redirect: 'manual' });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : await res.text() };
}
/** Fill in and send the board's application form. */
function apply(to, fields = {}, { ip, file } = {}) {
  const data = new FormData();
  for (const [name, value] of Object.entries({ name: 'Dana Whitlock', email: 'dana@mail.example', consent: 'yes', ...fields })) if (value !== undefined) data.append(name, String(value));
  if (file) data.append('resume', new Blob([file.bytes]), file.name);
  return visit(`/api/public/board/posts/${to}/apply`, { method: 'POST', body: data, ip });
}
/** Read or change the database file directly, for what no route shows and for changes no route makes. */
function database(work) {
  const db = new DatabaseSync(path.join(dataDir, 'app.db'));
  db.exec('PRAGMA busy_timeout = 3000; PRAGMA foreign_keys = ON;');
  try { return work(db); } finally { db.close(); }
}
const rows = (sql, ...params) => database((db) => db.prepare(sql).all(...params).map((row) => ({ ...row })));
const post = (who, jobId) => who.get(`/jobs/${jobId}/board`).then(ok);
const save = (who, jobId, fields) => who.putJson(`/jobs/${jobId}/board`, fields).then(ok);
const check = (jobId, fields) => alex.post(`/jobs/${jobId}/board/check`, { title: 'Engineer', location: 'Toronto', description: 'A good job.', ...fields }).then(ok);
const onTheBoard = async () => ok(await visit('/api/public/board')).posts.map((p) => p.token);

// The client's own advert names the client throughout, as a client's advert does.
const ADVERT = `Lumen Health builds scheduling software used by more than 400 clinics. We are a team of 85 in Toronto.

What you will do
• Own the services behind the Lumen booking engine
• Work with Maya Okonkwo, our VP Engineering

Find out more at https://www.lumenhealth.example/careers`;
// The agency's own advert for the same job. Nothing in it points to Lumen Health, and it is full of things that
// only look like trouble: a degree written with dots, tools named with dots, "volume next", figures with commas.
const CLEAN = `Our client is a growing health-technology company whose software helps clinics run to time.

What you will do
• Design, build and run backend services in TypeScript and Postgres
• Mentor other engineers, and tomorrow's leaders

What we are looking for
• Five or more years building backend systems. A B.Sc. or M.Eng. helps, e.g. in computing
• Node.js and ASP.NET are both welcome. Volume next year will double; 37.5hrs a week
• Salary 85,000 - 105,000 plus a bonus of 10% in 2026-2027`;
const GOOD = { enabled: true, title: 'Senior Backend Engineer', location: 'Greater Toronto Area', description: CLEAN, show_salary: true };

before(async () => {
  ai = await aiStandIn(AI_PORT);
  mail = await mailStandIn(MAIL_PORT);
  dataDir = tempDir('board');
  server = await startServer({ port: PORT, dataDir, env: {
    ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: ai.url, BOARD_AI_TIMEOUT_MS: '2000',
    RESEND_API_KEY: 'test-key', RESEND_API_URL: mail.url, MAIL_FROM: 'Harbour Talent <jobs@harbourtalent.example>',
    TRUST_PROXY: '1', APP_URL: 'https://book.harbourtalent.example',
  } });
  alex = session(server.base);
  ok(await alex.post('/setup', { agencyName: 'Harbour Talent', name: 'Alex Morgan', email: 'alex@harbourtalent.example', password: 'demo1234' }));
  // The client and the job are given numbers that could not be mistaken for anything else, so that the public
  // answers can be searched for them: a placeholder takes the number before, and is then removed.
  database((db) => db.exec(`INSERT INTO clients (id, name, slug, created_at) VALUES (73900, 'Placeholder', 'placeholder', '2026-11-01T00:00:00.000Z');
    INSERT INTO jobs (id, client_id, title, created_at) VALUES (48210, 73900, 'Placeholder', '2026-11-01T00:00:00.000Z');`));
  lumen = ok(await alex.post('/clients', { name: 'Lumen Health', website: 'https://www.lumenhealth.example', brand_color: '#0b6e99', currency: 'CAD', tagline: 'Helping clinics run on time.',
    about: 'Lumen Health builds scheduling software used by more than 400 clinics.', privacy_url: 'https://www.lumenhealth.example/privacy' })).id;
  assert.equal(lumen, 73901);
  north = ok(await alex.post('/clients', { name: 'North', website: 'https://getnorthgear.example', currency: 'CAD' })).id;
  ok(await alex.putJson(`/clients/${north}`, { name: 'North', slug: 'nrth-jobs', website: 'https://getnorthgear.example', currency: 'CAD' }));
  const join = async (role, name, email, extra = {}) => {
    const { token: invite } = ok(await alex.post('/invites', { role, email, ...extra }));
    const person = session(server.base);
    ok(await person.post(`/invites/${invite}/accept`, { name, password: 'demo1234' }));
    return person;
  };
  priya = await join('recruiter', 'Priya Nair', 'priya@harbourtalent.example');
  maya = await join('client', 'Maya Okonkwo', 'maya@lumenhealth.example', { client_id: lumen });
  await join('client', 'Tom Reilly', 'tom@brightclinicgroup.example', { client_id: lumen });
  hana = await join('client', 'Hana Sørensen', 'hana@getnorthgear.example', { client_id: north });
  const mayaId = ok(await alex.get(`/users?client_id=${lumen}`)).find((u) => u.name === 'Maya Okonkwo').id;
  job = ok(await alex.post('/jobs', { client_id: lumen, title: 'Senior Backend Engineer, Scheduling', status: 'open', location: 'Toronto', work_mode: 'hybrid', salary_min: 85000, salary_max: 105000,
    hiring_manager_id: mayaId, description: ADVERT, questions: [{ label: 'Do you have the right to work in Canada?', type: 'yesno', required: true }] })).id;
  assert.equal(job, 48211);
  database((db) => db.exec('DELETE FROM jobs WHERE id = 48210; DELETE FROM clients WHERE id = 73900;'));
  northJob = ok(await alex.post('/jobs', { client_id: north, title: 'Supply Chain Planner', status: 'open', work_mode: 'onsite', employment_type: 'contract', description: 'Plan the stock behind North’s range.' })).id;
  careersBefore = { page: ok(await visit('/api/public/careers/lumen-health')), job: ok(await visit(`/api/public/careers/lumen-health/jobs/${job}`)) };
});
after(async () => {
  await server?.stop();
  await ai?.stop();
  await mail?.stop();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

// ---------- the check ----------

test('a job with no post yet offers one to fill in: the job’s title, and nothing else from the client', async () => {
  const view = await post(alex, job);
  assert.deepEqual(view.post, { exists: false, enabled: false, title: 'Senior Backend Engineer, Scheduling', location: '', description: '', show_salary: false, token: null, posted_at: null, updated_at: null, updated_by_name: null });
  assert.deepEqual(view.state, { live: false, reason: 'off', says: 'Not public: the post is switched off.' });
  assert.equal(view.applied, 0);
  // What the check will look for is said in plain words.
  assert.deepEqual(view.check.looked_for, ['the client’s name, Lumen Health', '“lumen”, from the name', 'Maya Okonkwo, who has a login at the client', 'Tom Reilly, who has a login at the client',
    'the e-mail domain @brightclinicgroup.example', 'any link, e-mail address or phone number']);
  assert.deepEqual(await onTheBoard(), []);
});

test('the check finds the client however it is written', async () => {
  const cases = [
    ['the name', 'Join Lumen Health today', 'name'],
    ['the name in capitals', 'JOIN LUMEN HEALTH TODAY', 'name'],
    ['the name in small letters', 'join lumen health today', 'name'],
    ['the name with accents', 'Join Lümén Héalth today', 'name'],
    ['the name in wide letters', 'Join Ｌｕｍｅｎ Ｈｅａｌｔｈ today', 'name'],
    ['the name run together', 'Join LumenHealth today', 'name'],
    ['the name inside a longer word', 'See #teamlumenhealth for more', 'name'],
    ['the name split by dots', 'Join L.u.m.e.n H.e.a.l.t.h today', 'name'],
    ['the name split by a dash', 'Join Lumen-Health today', 'name'],
    ['the name split by an underscore', 'Join Lumen_Health today', 'name'],
    ['the name split by a slash and spaces', 'Join Lumen / Health today', 'name'],
    ['the careers address, which is the name with a dash', 'See lumen-health for more', 'name'],
    ['a word of the name', 'Lumen is growing fast', 'word'],
    ['a word of the name in small letters', 'the lumen team is growing', 'word'],
    ['a word of the name spelt out with dashes', 'The team at L-u-m-e-n is growing', 'word'],
    ['a word of the name with spaces between the letters', 'The team at L u m e n is growing', 'word'],
    ['a word of the name with an ending', 'All Lumens welcome', 'word'],
    ['a word of the name at the end of a joined word', 'Welcome to TeamLumen', 'word'],
    ['a word of the name with its accent changed', 'Lùmen is growing', 'word'],
    ['somebody with a login at the client', 'You will report to Maya Okonkwo', 'person'],
    ['their name in capitals', 'MAYA OKONKWO leads the team', 'person'],
    ['their name split by punctuation', 'Reporting to Maya.Okonkwo', 'person'],
    ['a surname alone', 'Ask for Reilly at reception', 'person'],
    ['a first name alone', 'Maya leads the team', 'person'],
    ['the hiring manager, by her first name', 'Your manager will be Maya', 'person'],
    ['the domain of their e-mail addresses', 'Part of the brightclinicgroup family', 'email_domain'],
    ['that domain written as words', 'Part of Bright Clinic Group', 'email_domain'],
    ['an e-mail address, whoever it belongs to', 'Write to jobs@somewhere.example', 'email'],
    ['a link', 'Apply at https://example.org/apply', 'link'],
    ['a link that starts with www', 'See www.example.org', 'link'],
    ['a web address with nothing in front of it', 'See example.org/jobs', 'link'],
    ['the client’s website', 'More at lumenhealth.example', 'link'],
    ['a phone number', 'Call (416) 555-0199 to apply', 'phone'],
    ['a phone number written another way', 'Call +44 20 7946 0991', 'phone'],
  ];
  for (const [what, description, kind] of cases) {
    const result = await check(job, { description });
    assert.equal(result.ok, false, what);
    const found = result.problems.find((p) => p.kind === kind);
    assert.ok(found, `${what}: ${JSON.stringify(result.problems)}`);
    assert.equal(found.field, 'description');
    assert.match(found.message, /the advert text/, what);           // every find is told in a sentence that says where it is
  }
  // The title and the location are searched as well as the text.
  const elsewhere = await check(job, { title: 'Engineer at Lumen', location: 'Lumen HQ, Toronto' });
  assert.deepEqual(elsewhere.problems.map((p) => [p.kind, p.field, p.found]), [['word', 'title', 'Lumen'], ['word', 'location', 'Lumen']]);
  assert.match(elsewhere.problems[0].message, /^“Lumen” reads as part of the client’s name \(Lumen Health\)\. It is in the title: “at Lumen”\.$/);
  // A whole name spelt out, a link and an address are never a false alarm, so they cannot be overruled.
  for (const description of ['Join Lumen Health today', 'Join LumenHealth today', 'See www.example.org', 'Write to jobs@somewhere.example', 'You will report to Maya Okonkwo', 'Part of the brightclinicgroup family']) {
    assert.ok((await check(job, { description })).problems.every((p) => p.can_overrule === false), description);
  }
  // Nothing typed is a problem of its own: the post needs a title, a location and a text.
  const empty = ok(await alex.post(`/jobs/${job}/board/check`, { title: '', location: ' ', description: '' }));
  assert.deepEqual(empty.problems.map((p) => [p.kind, p.field]), [['missing', 'title'], ['missing', 'location'], ['missing', 'description']]);
});

test('the careers address and the website are found when they are not the name, and a name with a letter no accent comes off', async () => {
  const cases = [
    ['the careers address', 'See nrth-jobs for details', 'slug'],
    ['the careers address run together', 'See nrthjobs for details', 'slug'],
    ['the name in the website', 'Shop at the getnorthgear store', 'website'],
    ['somebody’s name with its ø written as o', 'You will work for Hana Sorensen', 'person'],
    ['the surname alone, written either way', 'Ask for Sørensen', 'person'],
  ];
  for (const [what, description, kind] of cases) {
    const result = await check(northJob, { description });
    assert.ok(result.problems.some((p) => p.kind === kind), `${what}: ${JSON.stringify(result.problems)}`);
  }
});

test('the check leaves alone what only looks like trouble', async () => {
  const result = await check(job, GOOD);
  assert.deepEqual(result.problems, []);
  assert.equal(result.ok, true);
  // A word that is in the client's name only as a kind of company ("Health") is not looked for on its own, and a
  // first name written as an ordinary word ("tomorrow", "may") is not somebody's name.
  for (const description of ['A health company that cares about your health.', 'You may start tomorrow. The volume next month is high.', 'We illuminate the way.']) {
    assert.deepEqual((await check(job, { description })).problems, [], description);
  }
});

// ---------- going public, and the word an admin may overrule ----------

test('a post cannot go public while the check finds anything', async () => {
  const view = await save(priya, job, { ...GOOD, description: `${CLEAN}\n• Join the team at Lumen Health` });
  assert.equal(view.post.enabled, true);
  assert.deepEqual(view.state, { live: false, reason: 'problems', says: 'Not public: the check found something that has to go first.' });
  assert.deepEqual(view.check.problems.map((p) => p.found), ['Lumen Health']);
  token = view.post.token;
  assert.match(token, /^[a-f0-9]{18}$/);
  assert.deepEqual(await onTheBoard(), []);
  refused(await visit(`/api/public/board/posts/${token}`), 404);
});

test('with the client taken out, the post goes public', async () => {
  const view = await save(priya, job, GOOD);
  assert.deepEqual(view.state, { live: true, reason: null, says: null });
  assert.equal(view.post.token, token);                                  // the address does not change when the post is edited
  assert.equal(view.post.updated_by_name, 'Priya Nair');
  assert.deepEqual(view.log.map((l) => [l.kind, l.user_name]), [['published', 'Priya Nair']]);
  assert.deepEqual(await onTheBoard(), [token]);
});

test('a client whose name is an ordinary word: an admin may overrule the one word, and it is on record', async () => {
  const text = 'Our client sells outdoor clothing across Europe and North America.';
  let view = await save(priya, northJob, { enabled: true, title: 'Supply Chain Planner', location: 'West of the city', description: text, show_salary: false });
  northToken = view.post.token;
  assert.equal(view.state.reason, 'problems');
  assert.deepEqual(view.check.problems.map((p) => [p.kind, p.found, p.phrase, p.can_overrule]), [['name', 'North', 'and North America', true]]);
  const [alarm] = view.check.problems;
  // Only an admin may say it is a false alarm.
  refused(await priya.post(`/jobs/${northJob}/board/overrules`, { word: alarm.word, key: alarm.key }), 403, /admin/);
  refused(await hana.post(`/jobs/${northJob}/board/overrules`, { word: alarm.word, key: alarm.key }), 403);
  assert.deepEqual(await onTheBoard(), [token]);
  // A word the check did not find cannot be overruled, and neither can the name where it is not written.
  refused(await alex.post(`/jobs/${northJob}/board/overrules`, { word: 'north', key: 'join north today' }), 409, /does not find that word/);
  refused(await alex.post(`/jobs/${northJob}/board/overrules`, { word: 'europe', key: 'across europe and' }), 409);

  view = ok(await alex.post(`/jobs/${northJob}/board/overrules`, { word: alarm.word, key: alarm.key }));
  assert.deepEqual(view.check.problems, []);
  assert.deepEqual(view.check.overruled.map((o) => [o.found, o.phrase, o.by]), [['North', 'and North America', 'Alex Morgan']]);
  assert.equal(view.state.live, true);
  assert.deepEqual(view.log.map((l) => [l.kind, l.detail, l.user_name]), [['published', null, 'Alex Morgan'], ['overruled', '“North” in “and North America”', 'Alex Morgan']]);
  assert.deepEqual((await onTheBoard()).sort(), [token, northToken].sort());

  // The overrule holds for that word in those surroundings only. The name anywhere else is found again, and the post comes down.
  view = await save(priya, northJob, { enabled: true, title: 'Supply Chain Planner', location: 'West of the city', description: `${text} Join North today. Our northern stores are busy.`, show_salary: false });
  assert.deepEqual(view.check.problems.map((p) => [p.found, p.phrase]), [['North', 'Join North today'], ['northern', 'Our northern stores']]);
  assert.deepEqual(view.check.overruled.map((o) => o.phrase), ['and North America']);
  assert.equal(view.state.live, false);
  assert.deepEqual(await onTheBoard(), [token]);
  view = await save(priya, northJob, { enabled: true, title: 'Supply Chain Planner', location: 'West of the city', description: text, show_salary: false });
  assert.equal(view.state.live, true);

  // Withdrawn, it is a problem again; overruled again, it is public again.
  view = ok(await alex.del(`/jobs/${northJob}/board/overrules/${view.check.overruled[0].id}`));
  assert.equal(view.state.live, false);
  assert.deepEqual(view.check.problems.map((p) => p.phrase), ['and North America']);
  view = ok(await alex.post(`/jobs/${northJob}/board/overrules`, { word: alarm.word, key: alarm.key }));
  assert.equal(view.state.live, true);
  assert.deepEqual(rows('SELECT word, phrase, shown FROM board_overrules'), [{ word: 'north', phrase: 'and north america', shown: 'and North America' }]);
});

test('the same text as the client’s public advert is warned about, but does not stop the post', async () => {
  const copied = await check(job, { ...GOOD, title: 'Senior Backend Engineer, Scheduling', description: `${CLEAN}\nWe are a team of 85 in Toronto.` });
  assert.equal(copied.ok, true);
  assert.deepEqual(copied.warnings.map((w) => w.kind), ['same_text', 'same_listing']);
  assert.match(copied.warnings[0].message, /^One sentence of this advert is word for word the same as on Lumen Health’s own careers page, which is public: “We are a team of 85 in Toronto\.”/);
  assert.match(copied.warnings[1].message, /^The title and the salary range are the same as on Lumen Health’s own careers page/);
  assert.equal(copied.client_advert_public, true);
  assert.deepEqual((await check(job, GOOD)).warnings, []);
});

// ---------- what the public is given ----------

test('the public routes give the allowed fields and nothing else', async () => {
  const list = ok(await visit('/api/public/board'));
  assert.deepEqual(Object.keys(list), ['board', 'posts']);
  assert.deepEqual(list.board, { name: 'Harbour Talent', intro: 'Roles we are recruiting for on behalf of our clients. The employer’s name is kept confidential until we have spoken.', color: '#0c505d', logo: null, privacy_url: null });
  const today = new Date().toISOString().slice(0, 10);
  const mine = list.posts.find((p) => p.token === token);
  assert.deepEqual(mine, { token, title: 'Senior Backend Engineer', location: 'Greater Toronto Area', work_mode: 'hybrid', employment_type: 'full_time', salary: { min: 85000, max: 105000, currency: 'CAD' }, posted: today });
  // A post that does not show the salary gives none, and the working pattern and contract are the job's.
  assert.deepEqual(list.posts.find((p) => p.token === northToken), { token: northToken, title: 'Supply Chain Planner', location: 'West of the city', work_mode: 'onsite', employment_type: 'contract', salary: null, posted: today });

  const one = ok(await visit(`/api/public/board/posts/${token}`));
  assert.deepEqual(Object.keys(one), ['board', 'post']);
  assert.deepEqual(one.board, list.board);
  assert.deepEqual(one.post, { ...mine, description: CLEAN });

  const feed = ok(await visit('/board/feed.json'));
  assert.deepEqual(feed, ok(await visit('/api/public/board/feed')));
  assert.deepEqual(Object.keys(feed), ['board', 'posts']);
  assert.deepEqual(feed.board, { name: 'Harbour Talent', url: 'https://book.harbourtalent.example/board' });
  assert.deepEqual(feed.posts.find((p) => p.id === token), { id: token, url: `https://book.harbourtalent.example/board/${token}`, title: 'Senior Backend Engineer', location: 'Greater Toronto Area',
    working_pattern: 'Hybrid', contract: 'Full-time', salary: { min: 85000, max: 105000, currency: 'CAD' }, posted: today, text: CLEAN });
  // Any website may read the feed, and nothing keeps a copy of it.
  const answer = await visit('/board/feed.json');
  assert.equal(answer.headers.get('access-control-allow-origin'), '*');
  assert.equal(answer.headers.get('cache-control'), 'no-store');
});

test('nothing in any public answer points to the client or the job', async () => {
  // Everything about Lumen Health and the job that the public must not see: the name and its parts, the careers
  // address, the colour, the numbers of the client and the job, the people, the job's own title and the client's advert.
  const secrets = [/lumen/i, /0b6e99/i, /73901/, /48211/, /okonkwo/i, /reilly/i, /maya/i, /brightclinic/i, /Scheduling/, /400 clinics/, /careers\//, /client_id|job_id|created_by|hiring_manager|brand_color/];
  const answers = {
    list: JSON.stringify(ok(await visit('/api/public/board'))),
    post: JSON.stringify(ok(await visit(`/api/public/board/posts/${token}`))),
    feed: JSON.stringify(ok(await visit('/board/feed.json'))),
    page: (await visit('/board')).body,
    postPage: (await visit(`/board/${token}`)).body,
    embedded: (await visit(`/board/${token}?embed=1`)).body,
  };
  for (const [name, body] of Object.entries(answers)) for (const secret of secrets) assert.doesNotMatch(body, secret, `${name} gives away ${secret}`);
  // The only numbers anywhere in the data are the two ends of the salary.
  const numbers = [];
  const walk = (value) => { if (typeof value === 'number') numbers.push(value); else if (value && typeof value === 'object') Object.values(value).forEach(walk); };
  walk(ok(await visit('/api/public/board')));
  walk(ok(await visit('/board/feed.json')));
  assert.deepEqual([...new Set(numbers)].sort(), [105000, 85000]);
});

test('a post’s address is chance alone, and no public route knows a job by its number', async () => {
  assert.match(token, /^[a-f0-9]{18}$/);
  assert.match(northToken, /^[a-f0-9]{18}$/);
  assert.notEqual(token, northToken);
  // The job's number is not an address on the board, and the token is not an address on the client's careers page.
  for (const guess of [job, String(job).padStart(18, '0'), crypto.createHash('sha256').update(String(job)).digest('hex').slice(0, 18), crypto.createHash('md5').update(String(job)).digest('hex').slice(0, 18)]) {
    assert.notEqual(guess, token);
    refused(await visit(`/api/public/board/posts/${guess}`), 404);
  }
  refused(await visit(`/api/public/careers/lumen-health/jobs/${token}`), 404);
  refused(await visit(`/api/public/board/posts/${token}/job`), 401);       // there is no such address: like any other, it asks for a sign-in
  // Signed out, the agency's own routes say nothing either.
  refused(await visit(`/api/jobs/${job}/board`), 401);
  refused(await visit('/api/board/posts'), 401);
});

test('the client’s own careers routes are as they were, and say nothing of the post', async () => {
  const page = ok(await visit('/api/public/careers/lumen-health')), theirs = ok(await visit(`/api/public/careers/lumen-health/jobs/${job}`));
  assert.deepEqual(page, careersBefore.page);
  assert.deepEqual(theirs, careersBefore.job);
  for (const body of [JSON.stringify(page), JSON.stringify(theirs)]) {
    assert.ok(!body.includes(token));
    assert.doesNotMatch(body, /board|confidential|our_website|Greater Toronto Area/i);
  }
  assert.equal(theirs.job.questions.length, 1);   // the client's questions are still asked on the client's own form
});

// ---------- applying ----------

test('applying with a résumé: it lands on the job, from “Our website”, owned by nobody, and the recruiter sees it in the inbox', async () => {
  const answer = await apply(token, { name: 'Dana Whitlock', email: 'dana@mail.example', phone: '(416) 555-0101', linkedin: 'linkedin.com/in/dana-whitlock', cover_note: 'I would like to hear more.' },
    { file: { name: 'Dana Whitlock.pdf', bytes: Buffer.from('%PDF-1.4 a résumé') } });
  assert.deepEqual([answer.status, answer.body], [200, { ok: true }]);
  const inbox = ok(await priya.get('/applications?status=active&stage_kind=applied&sort=oldest'));
  const dana = inbox.find((a) => a.name === 'Dana Whitlock');
  assert.deepEqual([dana.job_id, dana.source, dana.owner_id, dana.stage_kind, dana.has_resume], [job, 'our_website', null, 'applied', 1]);
  const profile = ok(await priya.get(`/applications/${dana.id}`));
  assert.equal(profile.candidate.phone, '(416) 555-0101');
  assert.equal(profile.candidate.linkedin, 'https://www.linkedin.com/in/dana-whitlock');
  assert.equal(profile.application.cover_note, 'I would like to hear more.');
  assert.deepEqual(profile.application.answers, []);                      // the client's questions were not asked
  assert.ok(profile.application.consent_at);
  assert.deepEqual(profile.activities.map((a) => a.detail), ['Applied via the agency’s website']);
  // The agency is told that they came through the post, under which title, and that they do not know who the client is.
  assert.deepEqual(profile.board, { title: 'Senior Backend Engineer', client_known: false, client_known_at: null, client_known_by_name: null });
  const file = await priya.get(`/applications/${dana.id}/resume`);
  assert.equal(file.status, 200);
  assert.equal(file.body.toString(), '%PDF-1.4 a résumé');
  assert.equal((await post(priya, job)).applied, 1);
});

test('the confirmation is the agency’s own, and its whole text is free of the client', async () => {
  const [sent, ...more] = mail.to('dana@mail.example');
  assert.deepEqual(more, []);
  assert.equal(sent.from, 'Harbour Talent <jobs@harbourtalent.example>');
  assert.equal(sent.subject, 'Thanks for applying through Harbour Talent');
  assert.equal(sent.text, 'Hi Dana,\n\nThanks for applying through Harbour Talent for the Senior Backend Engineer role. We have your application and one of our recruiters will read it shortly.\n\n'
    + 'We are recruiting for this role on behalf of a client, and the employer’s name is kept confidential at this stage. If your experience looks like a match, we will be in touch to talk it through and tell you more.\n\nBest,\nHarbour Talent');
  // Not the client, and not the job's own title, which says more than the public one.
  for (const part of [sent.subject, sent.text]) assert.doesNotMatch(part, /lumen|scheduling|maya|okonkwo/i);
  // It is kept on the candidate like any other e-mail.
  const dana = ok(await priya.get('/applications?q=Dana')).find((a) => a.name === 'Dana Whitlock');
  assert.deepEqual(ok(await priya.get(`/applications/${dana.id}`)).emails.map((e) => [e.subject, e.delivery]), [['Thanks for applying through Harbour Talent', 'sent']]);
});

test('applying without a résumé, and what the form refuses', async () => {
  assert.deepEqual((await apply(token, { name: 'Jonas Brandt', email: 'jonas@mail.example' })).body, { ok: true });
  const jonas = ok(await priya.get('/applications?q=Jonas')).find((a) => a.name === 'Jonas Brandt');
  assert.deepEqual([jonas.source, jonas.owner_id, jonas.has_resume], ['our_website', null, 0]);

  refused(await apply(token, { name: 'No Consent', email: 'no.consent@mail.example', consent: 'no' }), 400, /confirm that we may process/);
  refused(await apply(token, { name: 'No Consent', email: 'no.consent@mail.example', consent: undefined }), 400, /confirm that we may process/);
  refused(await apply(token, { name: '', email: 'nobody@mail.example' }), 400, /name and a valid email/);
  refused(await apply(token, { name: 'Bad Address', email: 'not an address' }), 400, /name and a valid email/);
  refused(await apply(token, { name: 'See www.spam.example', email: 'spam@mail.example' }), 400);
  // A file that is not a document, and one that is too large.
  refused(await apply(token, { name: 'Bad File', email: 'bad.file@mail.example' }, { file: { name: 'resume.exe', bytes: Buffer.from('MZ') } }), 400, /Résumé must be a PDF, Word, RTF or text file/);
  refused(await apply(token, { name: 'Bad File', email: 'bad.file@mail.example' }, { file: { name: 'photo.png', bytes: Buffer.from('PNG') } }), 400, /Résumé must be/);
  refused(await apply(token, { name: 'Big File', email: 'big.file@mail.example' }, { file: { name: 'resume.pdf', bytes: Buffer.alloc(8 * 1024 * 1024 + 1) } }), 400, /larger than 8 MB/);
  // A form filled in by a bot (the hidden box has something in it) is thanked and thrown away.
  assert.deepEqual((await apply(token, { name: 'A Bot', email: 'bot@mail.example', company_website: 'https://spam.example' })).body, { ok: true });
  // None of those left a candidate, an e-mail or a file behind.
  assert.deepEqual(rows(`SELECT name FROM candidates WHERE client_id = ? ORDER BY id`, lumen).map((c) => c.name), ['Dana Whitlock', 'Jonas Brandt']);
  for (const address of ['no.consent@mail.example', 'bad.file@mail.example', 'big.file@mail.example', 'bot@mail.example']) assert.deepEqual(mail.to(address), []);
  await until(() => fs.readdirSync(path.join(dataDir, 'uploads')).length, (n) => n === 1);   // Dana's résumé and nothing else (a file that is not kept is removed a moment later)
});

test('one address can only send so many applications in ten minutes', async () => {
  const ip = someone();
  for (let n = 0; n < 10; n++) refused(await apply(token, { name: '', email: 'x' }, { ip }), 400);
  refused(await apply(token, { name: 'One Too Many', email: 'one.too.many@mail.example' }, { ip }), 429, /Too many attempts/);
  // Somebody else is not held up by it.
  assert.equal((await apply(token, { name: 'Elena Fontaine', email: 'elena@mail.example' })).status, 200);
});

test('somebody who applies twice is answered the same both times, and is in the job once', async () => {
  const again = await apply(token, { name: 'Dana W', email: 'DANA@mail.example' });
  assert.deepEqual(again.body, { ok: true });
  assert.equal(rows(`SELECT COUNT(*) AS n FROM applications a JOIN candidates c ON c.id = a.candidate_id WHERE c.email = 'dana@mail.example'`)[0].n, 1);
  assert.equal(mail.to('dana@mail.example').length, 2);                    // and gets the same confirmation: no different answer to learn from
  const dana = ok(await priya.get('/applications?q=Dana')).find((a) => a.name === 'Dana Whitlock');
  assert.deepEqual(ok(await priya.get(`/applications/${dana.id}`)).activities.map((a) => a.detail), ['Applied again, through the agency’s website', 'Applied via the agency’s website']);
});

test('the client’s hiring team sees the applicant like any other, and nothing about the post', async () => {
  const theirs = ok(await maya.get(`/applications?job_id=${job}&status=all`));
  const dana = theirs.find((a) => a.name === 'Dana Whitlock');
  assert.equal(dana.source, 'our_website');
  const profile = ok(await maya.get(`/applications/${dana.id}`));
  assert.equal('board' in profile, false);
  assert.doesNotMatch(JSON.stringify(profile), /board|client_known|Greater Toronto Area/);
  // The post's title and where it is shown are not in what a client user is sent about the job either.
  const theirJob = JSON.stringify(ok(await maya.get(`/jobs/${job}`)));
  assert.ok(!theirJob.includes(token));
  assert.doesNotMatch(theirJob, /board|Greater Toronto Area/);
  // In their reports the source reads as the agency's website, not as theirs.
  assert.deepEqual(ok(await maya.get('/reports')).sources.map((s) => [s.source, s.label]), [['our_website', 'Agency website']]);
  assert.deepEqual(ok(await priya.get(`/reports?client_id=${lumen}`)).sources.map((s) => [s.source, s.label]), [['our_website', 'Our website']]);
});

test('the source “Our website” is only ever an application made on the board', async () => {
  const added = ok(await priya.upload('/applications', { job_id: job, name: 'Added By Hand', email: 'by.hand@mail.example', source: 'our_website' }));
  const profile = ok(await priya.get(`/applications/${added.id}`));
  assert.equal(profile.application.source, 'agency_sourced');
  assert.equal(profile.board, null);
});

// ---------- what a candidate who came through the post is sent afterwards ----------

test('what The Book sends by itself does not name the client until the candidate knows who it is', async () => {
  const elena = ok(await priya.get('/applications?q=Elena')).find((a) => a.name === 'Elena Fontaine');
  mail.sent.length = 0;
  // An interview invitation: the title she applied under, "our client" for the company.
  let answer = ok(await priya.post('/interviews', { application_id: elena.id, title: 'First call', starts_at: new Date(Date.now() + 86400000).toISOString(), notify: true, time_label: 'Tuesday at 10', location: 'By phone' }));
  assert.equal(answer.notice, undefined);
  assert.equal(mail.sent.length, 1);
  assert.equal(mail.sent[0].subject, 'Interview for Senior Backend Engineer at our client');
  assert.match(mail.sent[0].text, /interview for the Senior Backend Engineer role at our client\./);
  assert.doesNotMatch(`${mail.sent[0].subject}\n${mail.sent[0].text}`, /lumen|scheduling/i);
  // One that would name the client all the same (here, where the interview is) is not sent, and the recruiter is told why.
  answer = ok(await priya.post('/interviews', { application_id: elena.id, title: 'On site', starts_at: new Date(Date.now() + 2 * 86400000).toISOString(), notify: true, location: 'Lumen Health, 12 King Street' }));
  assert.match(answer.notice, /^The e-mail was not sent: it names the client, and this candidate applied through your confidential post/);
  assert.equal(mail.sent.length, 1);
  // The hiring team's own click is held back the same way, and they are told nothing about the post.
  answer = ok(await maya.patch(`/interviews/${answer.id}`, { starts_at: new Date(Date.now() + 3 * 86400000).toISOString(), location: 'Lumen Health, 12 King Street', notify: true }));
  assert.equal(answer.notice, 'The e-mail was not sent. Your recruiter will be in touch with the candidate.');
  assert.equal(mail.sent.length, 1);
  // The rejection e-mail.
  answer = ok(await priya.post(`/applications/${elena.id}/reject`, { reason: 'Other', send_email: true }));
  assert.equal(answer.notice, undefined);
  assert.equal(mail.sent[1].subject, 'Your application for Senior Backend Engineer at our client');
  assert.doesNotMatch(mail.sent[1].text, /lumen|scheduling/i);
  ok(await priya.post(`/applications/${elena.id}/restore`));

  // Ticked "Knows who the client is": from then on she is written to like anybody else, and it is on her history for the agency only.
  refused(await maya.putJson(`/applications/${elena.id}/client-known`, { known: true }), 403);
  const facts = ok(await priya.putJson(`/applications/${elena.id}/client-known`, { known: true }));
  assert.deepEqual([facts.client_known, facts.client_known_by_name], [true, 'Priya Nair']);
  ok(await priya.post(`/applications/${elena.id}/reject`, { reason: 'Other', send_email: true }));
  assert.equal(mail.sent[2].subject, 'Your application for Senior Backend Engineer, Scheduling at Lumen Health');
  assert.ok(ok(await priya.get(`/applications/${elena.id}`)).activities.some((a) => a.type === 'board' && a.detail === 'Marked as knowing who the client is'));
  assert.ok(!ok(await maya.get(`/applications/${elena.id}`)).activities.some((a) => a.type === 'board'));
  assert.ok(!ok(await maya.get('/dashboard')).recent.some((a) => a.type === 'board'));
  // Unticked again, the guard is back.
  assert.equal(ok(await priya.putJson(`/applications/${elena.id}/client-known`, { known: false })).client_known, false);
  // The tick is for people who came through a post, nobody else.
  const byHand = ok(await priya.get('/applications?q=Added')).find((a) => a.name === 'Added By Hand');
  refused(await priya.putJson(`/applications/${byHand.id}/client-known`, { known: true }), 400, /did not apply through a confidential post/);
});

test('an e-mail written by hand that names the client is only sent once the recruiter has seen the warning', async () => {
  const jonas = ok(await priya.get('/applications?q=Jonas')).find((a) => a.name === 'Jonas Brandt');
  mail.sent.length = 0;
  // The form asks as the recruiter types.
  assert.deepEqual(ok(await priya.post(`/applications/${jonas.id}/emails/check`, { subject: 'Next steps', body: 'We would like to speak to you.' })), { names_client: false });
  assert.deepEqual(ok(await priya.post(`/applications/${jonas.id}/emails/check`, { subject: 'Next steps', body: 'The team at LUMEN would like to speak to you.' })), { names_client: true });
  refused(await maya.post(`/applications/${jonas.id}/emails/check`, { subject: 'x', body: 'Lumen' }), 403);
  // A message that does not name the client goes as usual.
  assert.equal(ok(await priya.post(`/applications/${jonas.id}/emails`, { subject: 'Next steps', body: 'We would like to speak to you.' })).delivery, 'sent');
  // One that does is refused until the recruiter says to send it anyway.
  const named = { subject: 'Next steps with Lumen Health', body: 'The team at Lumen Health would like to speak to you.' };
  const answer = await priya.post(`/applications/${jonas.id}/emails`, named);
  refused(answer, 409, /^This candidate applied through your confidential post and has not been told who the client is\. This message names Lumen Health\.$/);
  assert.equal(answer.body.code, 'names_client');
  assert.equal(mail.sent.length, 1);
  assert.equal(ok(await priya.post(`/applications/${jonas.id}/emails`, { ...named, names_client_ok: true })).delivery, 'sent');
  assert.equal(mail.sent.length, 2);
  // He has now been told, so the tick is made for the recruiter, and nothing warns after that.
  const profile = ok(await priya.get(`/applications/${jonas.id}`));
  assert.equal(profile.board.client_known, true);
  assert.equal(profile.activities.find((a) => a.type === 'board').detail, 'Told who the client is, by e-mail');
  assert.deepEqual(ok(await priya.post(`/applications/${jonas.id}/emails/check`, named)), { names_client: false });
  assert.equal(ok(await priya.post(`/applications/${jonas.id}/emails`, named)).delivery, 'sent');
});

test('if the confirmation template is ever edited to name the client, the wording The Book came with is sent instead', async () => {
  const templates = ok(await alex.get('/templates'));
  const mine = templates.find((t) => t.key === 'board_application_received');
  assert.equal(mine.name, 'Application received (our job board)');
  ok(await alex.putJson(`/templates/${mine.id}`, { name: mine.name, subject: 'Thanks for applying to Lumen Health', body: 'Hi {{candidate_first_name}}, the team at Lumen will read it.' }));
  ok(await apply(token, { name: 'Grace Adeyemi', email: 'grace@mail.example' }));
  const [sent] = mail.to('grace@mail.example');
  assert.equal(sent.subject, 'Thanks for applying through Harbour Talent');
  assert.doesNotMatch(sent.text, /lumen/i);
  // An edit that keeps the client out is used as written.
  ok(await alex.putJson(`/templates/${mine.id}`, { name: mine.name, subject: 'We have your application, {{candidate_first_name}}', body: 'Thank you for applying for {{job_title}} through {{agency_name}}.' }));
  ok(await apply(token, { name: 'Hugo Castillo', email: 'hugo@mail.example' }));
  assert.deepEqual(mail.to('hugo@mail.example').map((m) => [m.subject, m.text]), [['We have your application, Hugo', 'Thank you for applying for Senior Backend Engineer through Harbour Talent.']]);
  ok(await alex.putJson(`/templates/${mine.id}`, mine));
});

test('somebody who came through the post and then applies on the client’s careers page is answered as a new applicant there', async () => {
  // Grace does not know the two adverts are one job. If the careers page stayed silent, as it does for anybody
  // else who is already in the job, the missing confirmation would tell her.
  mail.sent.length = 0;
  const form = new FormData();
  for (const [name, value] of Object.entries({ name: 'Grace Adeyemi', email: 'grace@mail.example', consent: 'yes', answers: JSON.stringify({ [careersBefore.job.job.questions[0].id]: 'Yes' }) })) form.append(name, value);
  assert.deepEqual((await visit(`/api/public/careers/lumen-health/jobs/${job}/apply`, { method: 'POST', body: form })).body, { ok: true });
  assert.deepEqual(mail.sent.map((m) => m.subject), ['We received your application for Senior Backend Engineer, Scheduling']);
  assert.equal(rows(`SELECT COUNT(*) AS n FROM applications a JOIN candidates c ON c.id = a.candidate_id WHERE c.email = 'grace@mail.example'`)[0].n, 1);
  // Somebody the agency added by hand, who applies there again, gets no second confirmation, as before.
  const again = new FormData();
  for (const [name, value] of Object.entries({ name: 'Added By Hand', email: 'by.hand@mail.example', consent: 'yes', answers: JSON.stringify({ [careersBefore.job.job.questions[0].id]: 'Yes' }) })) again.append(name, value);
  assert.deepEqual((await visit(`/api/public/careers/lumen-health/jobs/${job}/apply`, { method: 'POST', body: again })).body, { ok: true });
  assert.equal(mail.sent.length, 1);
});

// ---------- coming down ----------

test('a later edit to the post that names the client takes it down until it is fixed', async () => {
  let view = await save(priya, job, { ...GOOD, location: 'Near the Lumen office' });
  assert.equal(view.state.live, false);
  assert.deepEqual([view.log[0].kind, view.log[0].user_name], ['taken_down', null]);   // The Book took it down, nobody switched it off
  assert.match(view.log[0].detail, /^The check found: “Lumen” reads as part of the client’s name/);
  assert.deepEqual(await onTheBoard(), [northToken]);
  refused(await visit(`/api/public/board/posts/${token}`), 404);
  refused(await apply(token, { name: 'Too Late', email: 'too.late@mail.example' }), 404);
  view = await save(priya, job, GOOD);
  assert.equal(view.state.live, true);
  assert.deepEqual((await onTheBoard()).sort(), [token, northToken].sort());
});

test('a change to the job takes the post down: closed or paused, it is not advertised', async () => {
  const closed = ok(await alex.patch(`/jobs/${job}/status`, { status: 'paused' }));
  assert.match(closed.board_notice, /^The confidential post for this job is no longer public/);
  assert.deepEqual(await onTheBoard(), [northToken]);
  assert.deepEqual((await post(alex, job)).state, { live: false, reason: 'job_not_open', says: 'Not public: the job is not open. A post is only public while its job is.' });
  refused(await apply(token, { name: 'Too Late', email: 'too.late@mail.example' }), 404);
  assert.equal(ok(await alex.patch(`/jobs/${job}/status`, { status: 'open' })).board_notice, undefined);
  assert.deepEqual((await onTheBoard()).sort(), [token, northToken].sort());
  // The same through the job's own form.
  const theJob = ok(await alex.get(`/jobs/${job}`)).job;
  assert.match(ok(await alex.putJson(`/jobs/${job}`, { ...theJob, status: 'closed' })).board_notice, /no longer public/);
  assert.deepEqual(await onTheBoard(), [northToken]);
  ok(await alex.putJson(`/jobs/${job}`, { ...theJob, status: 'open' }));
  assert.deepEqual((await onTheBoard()).sort(), [token, northToken].sort());
});

test('a change to the client takes the post down when the post now gives it away', async () => {
  const client = ok(await alex.get(`/clients/${lumen}`)).client;
  // Renamed to something that is in the advert.
  const renamed = ok(await alex.putJson(`/clients/${lumen}`, { ...client, name: 'Postgres Works' }));
  assert.match(renamed.board_notice, /^A confidential post for this client is no longer public/);
  assert.deepEqual(await onTheBoard(), [northToken]);
  const view = await post(priya, job);
  assert.equal(view.state.reason, 'problems');
  assert.deepEqual(view.check.problems.map((p) => [p.kind, p.found]), [['word', 'Postgres']]);
  // Named back, the post is public again with nobody having to touch it: the switch was never turned off.
  assert.equal(ok(await alex.putJson(`/clients/${lumen}`, client)).board_notice, undefined);
  assert.deepEqual((await onTheBoard()).sort(), [token, northToken].sort());
  // A new website whose name is in the advert does the same.
  ok(await alex.putJson(`/clients/${lumen}`, { ...client, website: 'https://typescript.example' }));
  assert.deepEqual(await onTheBoard(), [northToken]);
  ok(await alex.putJson(`/clients/${lumen}`, client));
  assert.deepEqual((await onTheBoard()).sort(), [token, northToken].sort());
});

test('somebody new at the client, or a changed name, is looked for at once', async () => {
  // "Mentor" opens a line of the advert. Somebody of that name joins Lumen's hiring team.
  const { token: invite } = ok(await alex.post('/invites', { role: 'client', email: 'avery@lumenhealth.example', client_id: lumen }));
  ok(await session(server.base).post(`/invites/${invite}/accept`, { name: 'Avery Mentor', password: 'demo1234' }));
  assert.deepEqual(await onTheBoard(), [northToken]);
  assert.deepEqual((await post(priya, job)).check.problems.map((p) => [p.kind, p.found]), [['person', 'Mentor']]);
  const avery = ok(await alex.get(`/users?client_id=${lumen}`)).find((u) => u.name === 'Avery Mentor');
  ok(await alex.patch(`/users/${avery.id}`, { name: 'Avery Stone' }));
  assert.deepEqual((await onTheBoard()).sort(), [token, northToken].sort());
});

test('whatever changes the client, the public is never shown a post that would fail the check as things stand', async () => {
  // A change made straight in the database, which no route was told about.
  database((db) => db.prepare(`UPDATE clients SET name = 'Backend Health' WHERE id = ?`).run(lumen));
  assert.deepEqual(await onTheBoard(), [northToken]);
  refused(await visit(`/api/public/board/posts/${token}`), 404);
  assert.ok(!ok(await visit('/board/feed.json')).posts.some((p) => p.id === token));
  refused(await apply(token, { name: 'Too Late', email: 'too.late@mail.example' }), 404);
  assert.equal((await visit(`/board/${token}`)).status, BUILT ? 404 : (await visit('/board/000000000000000000')).status);
  database((db) => db.prepare(`UPDATE clients SET name = 'Lumen Health' WHERE id = ?`).run(lumen));
  assert.deepEqual((await onTheBoard()).sort(), [token, northToken].sort());
  assert.deepEqual(mail.to('too.late@mail.example'), []);
});

test('a token that was never a post, one that is switched off, one that came down and one whose job is gone all answer the same', async () => {
  // A third job with a post that is public, then deleted with its job.
  const gone = ok(await alex.post('/jobs', { client_id: north, title: 'Warehouse Lead', status: 'open' })).id;
  const goneToken = (await save(alex, gone, { enabled: true, title: 'Warehouse Lead', location: 'West of the city', description: 'Lead a small warehouse team.', show_salary: false })).post.token;
  assert.ok((await onTheBoard()).includes(goneToken));
  ok(await alex.del(`/jobs/${gone}`));
  // The North post is switched off; the Lumen post is taken down by the check.
  assert.equal((await save(alex, northJob, { enabled: false, title: 'Supply Chain Planner', location: 'West of the city', description: 'Our client sells outdoor clothing across Europe and North America.', show_salary: false })).state.reason, 'off');
  assert.equal((await save(alex, job, { ...GOOD, title: 'Engineer at Lumen Health' })).state.reason, 'problems');
  assert.deepEqual(await onTheBoard(), []);

  const never = crypto.randomBytes(9).toString('hex');
  const tokens = { never, malformed: 'not-a-token', short: 'abc', switchedOff: northToken, takenDown: token, jobDeleted: goneToken };
  const first = await visit(`/api/public/board/posts/${never}`);
  assert.deepEqual([first.status, first.body], [404, { error: 'This role is no longer open.' }]);
  const firstApply = await apply(never, { name: 'Dana Whitlock', email: 'someone.else@mail.example' });
  assert.deepEqual([firstApply.status, firstApply.body], [404, { error: 'This role is no longer open.' }]);
  const firstPage = await visit(`/board/${never}`);
  for (const [why, t] of Object.entries(tokens)) {
    const read = await visit(`/api/public/board/posts/${t}`);
    assert.deepEqual([read.status, read.body], [first.status, first.body], why);
    const sent = await apply(t, { name: 'Dana Whitlock', email: 'someone.else@mail.example' });
    assert.deepEqual([sent.status, sent.body], [firstApply.status, firstApply.body], why);
    const page = await visit(`/board/${t}`);
    assert.deepEqual([page.status, page.body], [firstPage.status, firstPage.body], why);
  }
  if (BUILT) assert.equal(firstPage.status, 404);
  assert.deepEqual(mail.to('someone.else@mail.example'), []);

  // Back on, both are public again at the addresses they always had.
  await save(alex, northJob, { enabled: true, title: 'Supply Chain Planner', location: 'West of the city', description: 'Our client sells outdoor clothing across Europe and North America.', show_salary: false });
  await save(alex, job, GOOD);
  assert.deepEqual((await onTheBoard()).sort(), [token, northToken].sort());
});

// ---------- the list of posts, and who may see any of this ----------

test('every post is listed for the agency, with what the public sees it as and how many applied', async () => {
  const list = ok(await priya.get('/board/posts'));
  assert.deepEqual(list.map((p) => [p.job_id, p.title, p.client_name, p.live, p.enabled, p.applied, p.token]).sort((a, b) => a[0] - b[0]),
    [[job, 'Senior Backend Engineer', 'Lumen Health', 1, 1, 5, token], [northJob, 'Supply Chain Planner', 'North', 1, 1, 0, northToken]].sort((a, b) => a[0] - b[0]));
});

test('a client’s hiring team is refused on every one of the agency’s routes, and a recruiter on the admin’s', async () => {
  const fields = { enabled: true, title: 'x', location: 'y', description: 'z' };
  const dana = ok(await priya.get('/applications?q=Dana')).find((a) => a.name === 'Dana Whitlock');
  const attempts = [
    () => maya.get(`/jobs/${job}/board`), () => maya.putJson(`/jobs/${job}/board`, fields), () => maya.post(`/jobs/${job}/board/check`, fields), () => maya.post(`/jobs/${job}/board/draft`),
    () => maya.post(`/jobs/${job}/board/overrules`, { word: 'x', key: 'x' }), () => maya.del(`/jobs/${job}/board/overrules/1`), () => maya.get('/board/posts'),
    () => maya.get('/board/settings'), () => maya.putJson('/board/settings', { name: 'Mine' }), () => maya.put('/board/logo', Buffer.from('a picture')), () => maya.del('/board/logo'),
    () => maya.putJson(`/applications/${dana.id}/client-known`, { known: true }), () => maya.post(`/applications/${dana.id}/emails/check`, { subject: 'x', body: 'y' }),
  ];
  for (const attempt of attempts) refused(await attempt(), 403);
  assert.equal((await post(alex, job)).post.title, 'Senior Backend Engineer');   // and nothing was changed
  // A recruiter writes posts, but the board's settings, its logo and overruling a word are an admin's.
  refused(await priya.putJson('/board/settings', { name: 'Mine' }), 403, /admin/);
  refused(await priya.del('/board/logo'), 403, /admin/);
  refused(await priya.post(`/jobs/${northJob}/board/overrules`, { word: 'north', key: 'and north america' }), 403, /admin/);
  // And nobody who is signed out gets anything.
  for (const pathname of [`/api/jobs/${job}/board`, '/api/board/posts', '/api/board/settings']) refused(await visit(pathname), 401);
});

// ---------- drafting ----------

test('“Draft it for me” asks the AI service for a rewrite, and what comes back is checked like anything else', async () => {
  ai.requests.length = 0;
  const draft = ok(await priya.post(`/jobs/${job}/board/draft`));
  assert.deepEqual(draft, DRAFT);
  assert.equal(ai.requests.length, 1);
  const { headers, body } = ai.requests[0];
  assert.match(headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
  assert.equal(body.max_tokens, 16000);
  assert.equal(body.fallbacks, 'default');
  assert.equal(body.output_config.effort, 'medium');
  assert.deepEqual(Object.keys(body.output_config.format.schema.properties), ['title', 'description', 'removed']);
  assert.match(body.system, /The employer must stay confidential/);
  // The job's own advert goes, and what identifies the employer, so that it can be kept out.
  const [{ content }] = body.messages;
  assert.match(content, /<job_advert>\nSenior Backend Engineer, Scheduling\n\nLumen Health builds scheduling software/);
  assert.match(content, /<employer>\nName: Lumen Health\nWebsite: https:\/\/www\.lumenhealth\.example\nPeople: .*Maya Okonkwo/);
  // Nothing was saved: the recruiter reads a draft first.
  assert.equal((await post(priya, job)).post.description, CLEAN);

  // The draft is a help, not the safeguard. One that still names the employer is stopped by the check like any other text.
  ai.mode = 'leaky';
  const leaky = ok(await priya.post(`/jobs/${job}/board/draft`));
  assert.match(leaky.description, /Lumen Health/);
  const view = await save(priya, job, { ...GOOD, title: leaky.title, description: leaky.description });
  assert.equal(view.state.live, false);
  assert.deepEqual(view.check.problems.map((p) => p.found), ['Lumen Health']);
  assert.deepEqual(await onTheBoard(), [northToken]);
  await save(priya, job, GOOD);

  // When the service does not help, the recruiter is told in a sentence and nothing is changed.
  ai.mode = 'key';
  refused(await priya.post(`/jobs/${job}/board/draft`), 502, /The AI key set for this workspace was rejected, so nothing was drafted/);
  ai.mode = 'refuse';
  refused(await priya.post(`/jobs/${job}/board/draft`), 502, /declined to rewrite this advert/);
  ai.mode = 'ok';
  // A job with no advert of its own has nothing to rewrite.
  const bare = ok(await alex.post('/jobs', { client_id: north, title: 'Shop Assistant', status: 'draft' })).id;
  refused(await priya.post(`/jobs/${bare}/board/draft`), 400, /has no advert to rewrite/);
});

// ---------- the board's settings, and which websites may show it ----------

/** The frame rule on an answer: who may show it inside their page, and whether the old header that says "nobody" is there. */
const frameRule = (res) => ({ ancestors: /frame-ancestors ([^;]*)/.exec(res.headers.get('content-security-policy') || '')?.[1] ?? null, denied: res.headers.get('x-frame-options') });

// Without the built front end there is no page to send, and the server's answer to that carries headers of its own.
const BOARD_PAGES = (t) => (BUILT ? ['/board', '/board/', `/board/${t}`, `/board/${t}?embed=1`, '/board?embed=1', '/board/000000000000000000', '/board/feed.json'] : ['/board/feed.json']);

test('the board’s pages, and only they, may be shown inside the websites the agency lists', async () => {
  const board = "'self' https://otterbrook.ca https://www.otterbrook.ca";   // to begin with
  for (const pathname of BOARD_PAGES(token)) {
    assert.deepEqual(frameRule(await visit(pathname)), { ancestors: board, denied: null }, pathname);
  }
  // Every other page still refuses to be shown inside any page at all: the workspace, sign-in, a client's careers
  // page, addresses that only start like the board's, and the data routes.
  const pages = BUILT ? ['/', '/login', '/jobs', `/jobs/${job}`, '/settings', '/careers/lumen-health', `/careers/lumen-health/${job}`, '/boardroom', '/boards', '/Board', '/x/board', '/assets/missing.js'] : [];
  for (const pathname of [...pages, '/api/me', '/api/public/board', `/api/public/board/posts/${token}`, '/api/board/settings', '/api/public/careers/lumen-health']) {
    assert.deepEqual(frameRule(await visit(pathname)), { ancestors: "'none'", denied: 'DENY' }, pathname);
  }
});

test('an admin chooses the name, the look and the websites; what is not a website’s address is refused', async () => {
  const start = ok(await priya.get('/board/settings'));
  assert.deepEqual(start, { name: 'Harbour Talent', intro: 'Roles we are recruiting for on behalf of our clients. The employer’s name is kept confidential until we have spoken.', color: '#0c505d', logo: null, privacy_url: null,
    sites: ['https://otterbrook.ca', 'https://www.otterbrook.ca'], address: 'https://book.harbourtalent.example', live: 2 });
  const fields = { name: 'Harbour Talent Careers', intro: 'Roles we are filling now.', color: '#7C3AED', privacy_url: 'harbourtalent.example/privacy', sites: 'otterbrook.ca\nhttps://www.otterbrook.ca/jobs\nhttp://127.0.0.1:5650' };
  for (const [sites, what] of [['http://evil.example', 'plain http'], ['*', 'everything'], ['https://*.example.com', 'a pattern'], ['javascript:alert(1)', 'not a website'], ["otterbrook.ca; script-src 'unsafe-inline'", 'a second rule'], ['nonsense', 'a word']]) {
    refused(await alex.putJson('/board/settings', { ...fields, sites }), 400, /is not a website’s address/);
    assert.deepEqual(ok(await alex.get('/board/settings')).sites, start.sites, what);
  }
  refused(await alex.putJson('/board/settings', { ...fields, name: ' ' }), 400, /Give the board a name/);
  refused(await alex.putJson('/board/settings', { ...fields, color: 'red' }), 400, /colour/);
  refused(await alex.putJson('/board/settings', { ...fields, privacy_url: 'javascript:alert(1)' }), 400, /privacy notice link/);
  const saved = ok(await alex.putJson('/board/settings', fields));
  assert.deepEqual(saved, { ...start, name: 'Harbour Talent Careers', intro: 'Roles we are filling now.', color: '#7c3aed', privacy_url: 'https://harbourtalent.example/privacy',
    sites: ['https://otterbrook.ca', 'https://www.otterbrook.ca', 'http://127.0.0.1:5650'] });
  // The public board, the frame rule and the confirmation all follow.
  assert.deepEqual(ok(await visit('/api/public/board')).board, { name: 'Harbour Talent Careers', intro: 'Roles we are filling now.', color: '#7c3aed', logo: null, privacy_url: 'https://harbourtalent.example/privacy' });
  for (const pathname of BOARD_PAGES(token)) assert.deepEqual(frameRule(await visit(pathname)), { ancestors: "'self' https://otterbrook.ca https://www.otterbrook.ca http://127.0.0.1:5650", denied: null }, pathname);
  assert.deepEqual(frameRule(await visit('/api/me')), { ancestors: "'none'", denied: 'DENY' });
  ok(await apply(token, { name: 'Imani Okafor', email: 'imani@mail.example' }));
  assert.equal(mail.to('imani@mail.example')[0].subject, 'Thanks for applying through Harbour Talent Careers');
  // With no website listed, the board can still be linked to, and is shown inside nobody's page but its own.
  ok(await alex.putJson('/board/settings', { ...fields, sites: '' }));
  assert.deepEqual(frameRule(await visit('/board/feed.json')), { ancestors: "'self'", denied: null });
  ok(await alex.putJson('/board/settings', fields));
});

test('the logo is a real picture or it is not kept', async () => {
  // The smallest file that says, in the way a PNG does, that it is a 64 by 64 picture.
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.from([0, 0, 0, 64, 0, 0, 0, 64, 8, 6, 0, 0, 0]), Buffer.alloc(8)]);
  const putLogo = async (name, bytes) => {
    const form = new FormData();
    form.append('photo', new Blob([bytes]), name);
    const res = await fetch(`${server.base}/api/board/logo`, { method: 'PUT', headers: { Cookie: alex.cookie() }, body: form });
    return { status: res.status, body: await res.json() };
  };
  refused(await putLogo('logo.png', Buffer.from('not a picture at all')), 400, /not a JPEG, PNG or WebP image/);
  refused(await putLogo('logo.svg', Buffer.from('<svg/>')), 400);
  refused(await visit('/api/public/board/logo'), 404);
  const { logo } = ok(await putLogo('logo.png', png));
  assert.match(logo, /^[a-f0-9]{8}$/);
  assert.equal(ok(await visit('/api/public/board')).board.logo, logo);
  const picture = await fetch(`${server.base}/api/public/board/logo?v=${logo}`);
  assert.deepEqual([picture.status, picture.headers.get('content-type')], [200, 'image/png']);
  assert.deepEqual(Buffer.from(await picture.arrayBuffer()), png);
  ok(await alex.del('/board/logo'));
  refused(await visit('/api/public/board/logo'), 404);
  await until(() => fs.readdirSync(path.join(dataDir, 'uploads')).length, (n) => n === 1);   // still only Dana's résumé
});

test('the pages tell search engines and link previews about the agency and the role, and nobody else', { skip: BUILT ? false : 'the front end has not been built (npm run build)' }, async () => {
  const list = await visit('/board');
  assert.equal(list.status, 200);
  assert.match(list.body, /<title>Jobs \| Harbour Talent Careers<\/title>/);
  assert.match(list.body, /<meta property="og:site_name" content="Harbour Talent Careers" \/>/);
  assert.match(list.body, /<meta name="description" content="Roles we are filling now\." \/>/);
  assert.match(list.body, /<link rel="canonical" href="https:\/\/book\.harbourtalent\.example\/board" \/>/);
  assert.doesNotMatch(list.body, /noindex|application\/ld\+json/);

  const page = await visit(`/board/${token}`);
  assert.equal(page.status, 200);
  assert.match(page.body, /<title>Senior Backend Engineer \| Harbour Talent Careers<\/title>/);
  assert.match(page.body, /<meta property="og:title" content="Senior Backend Engineer \| Harbour Talent Careers" \/>/);
  assert.match(page.body, new RegExp(`<link rel="canonical" href="https://book\\.harbourtalent\\.example/board/${token}" />`));
  const data = JSON.parse(/<script type="application\/ld\+json" id="board-job-data">(.*?)<\/script>/s.exec(page.body)[1]);
  assert.deepEqual(Object.keys(data), ['@context', '@type', 'title', 'description', 'datePosted', 'employmentType', 'hiringOrganization', 'jobLocation', 'baseSalary', 'directApply', 'url']);
  assert.equal(data['@type'], 'JobPosting');
  assert.deepEqual(data.hiringOrganization, { '@type': 'Organization', name: 'Harbour Talent Careers', url: 'https://book.harbourtalent.example/board' });   // the agency is the organisation hiring
  assert.match(data.description, /^<p>Harbour Talent Careers is recruiting for this role on behalf of a client\. The employer is confidential\.<\/p><p>Our client is a growing health-technology company/);
  assert.deepEqual(data.jobLocation, { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: 'Greater Toronto Area' } });
  assert.deepEqual(data.baseSalary, { '@type': 'MonetaryAmount', currency: 'CAD', value: { '@type': 'QuantitativeValue', minValue: 85000, maxValue: 105000, unitText: 'YEAR' } });
  assert.equal(data.employmentType, 'FULL_TIME');
  assert.doesNotMatch(page.body, /lumen|73901|48211|0b6e99/i);
  // Shown inside another website's page it is the same page again, so only the board's own address is listed.
  assert.match((await visit(`/board/${token}?embed=1`)).body, /<meta name="robots" content="noindex" \/>/);
  // An address that is not a post is not listed, and says nothing.
  const missing = await visit('/board/000000000000000000');
  assert.equal(missing.status, 404);
  assert.match(missing.body, /<title>Jobs \| Harbour Talent Careers<\/title>/);
  assert.match(missing.body, /noindex/);
  assert.doesNotMatch(missing.body, /ld\+json/);
  // Text typed into a post cannot break out of the page it is written into.
  await save(alex, northJob, { enabled: true, title: 'Planner </title><script>alert(1)</script>', location: 'West of the city', description: 'A job. </script><script>alert(2)</script> "quoted" & more.', show_salary: false });
  const odd = await visit(`/board/${northToken}`);
  assert.doesNotMatch(odd.body, /<script>alert/);
  assert.match(odd.body, /<title>Planner &lt;\/title&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt; \| Harbour Talent Careers<\/title>/);
  assert.equal(JSON.parse(/id="board-job-data">(.*?)<\/script>/s.exec(odd.body)[1]).title, 'Planner </title><script>alert(1)</script>');
  await save(alex, northJob, { enabled: true, title: 'Supply Chain Planner', location: 'West of the city', description: 'Our client sells outdoor clothing across Europe and North America.', show_salary: false });
});

// ---------- starting on a live database ----------

test('starting on a database made by the live code adds the board’s tables and leaves every existing row and table as it was; starting again changes nothing', async () => {
  const dir = tempDir('board-upgrade');
  const file = path.join(dir, 'app.db');
  const T = '2026-11-01T15:00:00.000Z';
  const hash = (password) => { const salt = crypto.randomBytes(16).toString('hex'); return `${salt}:${crypto.scryptSync(password, salt, 32).toString('hex')}`; };
  // The database as the live code makes it, with a small workspace in it.
  let db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(fs.readFileSync(path.join(FIXTURES, 'live-schema.sql'), 'utf8'));
  const run = (sql, ...values) => db.prepare(sql).run(...values);
  for (const [key, value] of [['agency_name', 'Harbour Talent'], ['links_normalised', '1'], ['activity_types_v2', '1'], ['reports_start', '2026-11-16'], ['client_photos', '1']]) run('INSERT INTO settings (key, value) VALUES (?, ?)', key, value);
  run(`INSERT INTO clients (id, name, slug, website, created_at) VALUES (1, 'Kestrel Logistics', 'kestrel-logistics', 'https://kestrel.example', ?)`, T);
  run(`INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (1, 'alex@agency.example', ?, 'Alex Morgan', 'admin', ?)`, hash('demo1234'), T);
  run(`INSERT INTO users (id, email, password_hash, name, role, client_id, created_at) VALUES (2, 'ruth@kestrel.example', ?, 'Ruth Calloway', 'client', 1, ?)`, hash('demo1234'), T);
  run(`INSERT INTO jobs (id, client_id, title, description, status, created_by, created_at, opened_at) VALUES (1, 1, 'Head of Sales', 'Lead the Kestrel sales team.', 'open', 1, ?, ?)`, T, T);
  run(`INSERT INTO stages (id, job_id, name, kind, position) VALUES (1, 1, 'Applied', 'applied', 0), (2, 1, 'Interview', 'interview', 1), (3, 1, 'Offer', 'offer', 2), (4, 1, 'Hired', 'hired', 3)`);
  run(`INSERT INTO candidates (id, client_id, name, email, created_at) VALUES (1, 1, 'Dana Whitlock', 'dana@mail.example', ?)`, T);
  run(`INSERT INTO applications (id, candidate_id, job_id, stage_id, source, applied_at, stage_entered_at, updated_at) VALUES (1, 1, 1, 1, 'careers_page', ?, ?, ?)`, T, T, T);
  run(`INSERT INTO activities (application_id, type, detail, created_at) VALUES (1, 'applied', 'Applied via careers page', ?)`, T);
  run(`INSERT INTO email_templates (key, name, subject, body) VALUES ('application_received', 'Application received', 'Edited by the agency', 'Their own words.'), ('rejection', 'Not moving forward', 's', 'b'), ('interview_invite', 'Interview invitation', 's', 'b'), (NULL, 'A template of their own', 's', 'b')`);
  const TABLES = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all().map((t) => t.name);
  const objects = () => Object.fromEntries(db.prepare(`SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'`).all().map((o) => [o.name, o.sql]));
  // The sign-ins, and the list of candidates whose names are still to be filed for looking up, are the server's own housekeeping.
  const dump = () => Object.fromEntries(TABLES.filter((t) => !['sessions', 'candidate_name_dirty', 'candidate_name_keys', 'candidate_phone_keys'].includes(t)).map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()]));
  const before = { objects: objects(), rows: dump() };
  db.close();

  const NEW = ['board_applications', 'board_log', 'board_overrules', 'board_posts'];
  let api = await startServer({ port: UPGRADE_PORT, dataDir: dir });
  try {
    await api.stop();
    db = new DatabaseSync(file);
    const after = { objects: objects(), rows: dump() };
    // Every table, index and trigger that was there is still there, exactly as it was written.
    for (const [name, sql] of Object.entries(before.objects)) assert.equal(after.objects[name], sql, `${name} was changed or dropped`);
    // What is new: the board's four tables and their indexes, and nothing else.
    const added = Object.keys(after.objects).filter((name) => !(name in before.objects)).sort();
    assert.deepEqual(added, ['idx_board_applications_post', 'idx_board_log_post', ...NEW].sort());
    for (const table of NEW) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
    // Every row is as it was. One template is added: the board's own confirmation. The agency's edited templates are untouched.
    const template = after.rows.email_templates.find((t) => t.key === 'board_application_received');
    assert.equal(template.subject, 'Thanks for applying through {{agency_name}}');
    const settled = { ...after.rows, email_templates: after.rows.email_templates.filter((t) => t !== template) };
    // The reports and To do note the day they first ran on a workspace; those notes are theirs, not the board's.
    const own = (s) => /^(reports_|todos_)/.test(s.key);
    assert.deepEqual({ ...settled, settings: settled.settings.filter((s) => !own(s)) }, { ...before.rows, settings: before.rows.settings.filter((s) => !own(s)) });
    assert.ok(!after.rows.settings.some((s) => s.key.startsWith('board_')));   // the board's settings are only written when an admin saves them
    db.close();

    // Starting again changes nothing more.
    api = await startServer({ port: UPGRADE_PORT, dataDir: dir });
    await api.stop();
    db = new DatabaseSync(file);
    assert.deepEqual(objects(), after.objects);
    assert.deepEqual(dump(), after.rows);
    db.close();

    // And the board works on it: a post is written for the job that was already there, goes public, and takes an application.
    api = await startServer({ port: UPGRADE_PORT, dataDir: dir });
    const owner = session(api.base);
    ok(await owner.post('/login', { email: 'alex@agency.example', password: 'demo1234' }));
    const stopped = ok(await owner.putJson('/jobs/1/board', { enabled: true, title: 'Head of Sales', location: 'North of England', description: 'Lead the Kestrel sales team.', show_salary: false }));
    assert.deepEqual(stopped.check.problems.map((p) => p.found), ['Kestrel']);
    // This server has no AI key: the recruiter is told to write the advert themselves.
    assert.equal(stopped.ai, false);
    const noDraft = await owner.post('/jobs/1/board/draft');
    assert.equal(noDraft.status, 409);
    assert.match(noDraft.body.error, /AI drafting is not connected to this workspace/);
    const live = ok(await owner.putJson('/jobs/1/board', { enabled: true, title: 'Head of Sales', location: 'North of England', description: 'Lead a sales team of eight at a same-day delivery business.', show_salary: false }));
    assert.equal(live.state.live, true);
    const form = new FormData();
    for (const [name, value] of Object.entries({ name: 'Jonas Brandt', email: 'jonas@mail.example', consent: 'yes' })) form.append(name, value);
    const sent = await fetch(`${api.base}/api/public/board/posts/${live.post.token}/apply`, { method: 'POST', body: form });
    assert.equal(sent.status, 200);
    const people = ok(await owner.get('/applications?job_id=1&status=all'));
    assert.deepEqual(people.map((a) => [a.name, a.source]).sort(), [['Dana Whitlock', 'careers_page'], ['Jonas Brandt', 'our_website']]);
    // With no mail service connected the confirmation is kept on the candidate, marked as not sent, and still names nobody but the agency.
    const jonas = ok(await owner.get(`/applications/${people.find((a) => a.name === 'Jonas Brandt').id}`));
    assert.deepEqual(jonas.emails.map((e) => [e.subject, e.delivery]), [['Thanks for applying through Harbour Talent', 'not_configured']]);
    assert.doesNotMatch(jonas.emails[0].body, /kestrel/i);
    // Somebody who was in the job before the board existed is not somebody who came through a post.
    assert.equal(ok(await owner.get('/applications/1')).board, null);
  } finally {
    await api.stop().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
