// Account executives and the dashboard's job board, end to end. Every job belongs to an account executive: the
// agency user who created it, until it is handed to somebody else. Run with `npm test`.
//
// One real server on a throwaway data folder, and a second one started on a database as the version before this
// one made it (test/fixtures/before-account-executive-schema.sql), to show what starting does to a database that
// is already in use. Two states cannot be reached through the app and are written straight into the database: a
// person removed outright (the app only ever deactivates people) and a job that has no account executive.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer, session, tempDir, PORTS, FIXTURES } from './oracle-helpers.mjs';
import { look } from './metaview-helpers.mjs';

const PORT = PORTS.accountExecutive, OLD_PORT = PORTS.accountExecutiveOld;

let server, dataDir, oldDir, stoppedDir;
let alex, priya, marcus, dana, maya; // the admin, three recruiters, and somebody on Kestrel's hiring team
let id;                              // each person's user id, by first name
let kestrel, lumen;                  // the two clients
const job = {};                      // the jobs made below, by a short name

const put = (who, pathname, json) => who.putJson(pathname, json);
const jobOf = async (who, jobId) => (await who.get(`/jobs/${jobId}`)).body.job;
const board = async (who, query = '') => (await who.get(`/dashboard${query}`)).body.board;
/** A board as names and job titles, in the order it was sent: [['Priya Nair', ['Head of Sales']], ...]. */
const shape = (columns) => columns.map((c) => [c.name, c.jobs.map((j) => j.title)]);
/** Change the server's database behind its back, for the two states no route can produce. */
function write(dir, sql, ...values) {
  const db = new DatabaseSync(path.join(dir, 'app.db'));
  try { db.exec('PRAGMA foreign_keys = ON'); return db.prepare(sql).run(...values); } finally { db.close(); }
}
const join = async (role, name, email, extra = {}) => {
  const { token } = (await alex.post('/invites', { role, email, ...extra })).body;
  const person = session(server.base);
  assert.equal((await person.post(`/invites/${token}/accept`, { name, password: 'demo1234' })).status, 200);
  return person;
};
const newJob = async (who, title, clientId, extra = {}) => {
  const made = await who.post('/jobs', { client_id: clientId, title, status: 'open', description: 'A role.', ...extra });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  return made.body.id;
};
const userIds = async () => Object.fromEntries((await alex.get('/users')).body.map((u) => [u.name.split(' ')[0].toLowerCase(), u.id]));

before(async () => {
  dataDir = tempDir('account-executive');
  server = await startServer({ port: PORT, dataDir });
  alex = session(server.base);
  assert.equal((await alex.post('/setup', { agencyName: 'Harbour Talent', name: 'Alex Morgan', email: 'alex@agency.example', password: 'demo1234' })).status, 200);
  kestrel = (await alex.post('/clients', { name: 'Kestrel Logistics', brand_color: '#b45309' })).body.id;
  lumen = (await alex.post('/clients', { name: 'Lumen Health', brand_color: '#0b6e99' })).body.id;
  priya = await join('recruiter', 'Priya Nair', 'priya@agency.example');
  marcus = await join('recruiter', 'Marcus Bell', 'marcus@agency.example');
  dana = await join('recruiter', 'Dana Frost', 'dana@agency.example');
  maya = await join('client', 'Maya Okonkwo', 'maya@kestrel.example', { client_id: kestrel });
  id = await userIds();

  // Each person creates their own jobs, so each is the account executive of what they made.
  job.sales = await newJob(priya, 'Head of Sales', kestrel, { openings: 2, interview_stages: [{ name: 'Recruiter screen' }, { name: 'Final interview' }] });
  job.analyst = await newJob(priya, 'Data Analyst', kestrel, { status: 'paused' });
  job.designer = await newJob(marcus, 'Product Designer', lumen);
  job.coordinator = await newJob(marcus, 'Operations Coordinator', lumen, { status: 'draft' });
  job.finance = await newJob(alex, 'Finance Manager', kestrel, { status: 'closed' });
  job.depot = await newJob(alex, 'Depot Operations Lead', kestrel);
  job.nurse = await newJob(dana, 'Nurse Lead', lumen, { status: 'draft' });
  job.clinic = await newJob(alex, 'Clinic Manager', lumen);
  job.accounts = await newJob(priya, 'Account Manager', kestrel);
  // A job from before account executives whose creator is not known has nobody. And Priya's newest job is made
  // the one that has been open longest.
  write(dataDir, 'UPDATE jobs SET account_executive_id = NULL, created_by = NULL WHERE id = ?', job.clinic);
  write(dataDir, `UPDATE jobs SET opened_at = '2026-01-05T09:00:00.000Z' WHERE id = ?`, job.accounts);

  // Head of Sales has people at every point: one new, two at interview, one at offer, one hired, and two who have left.
  const stages = (await alex.get(`/jobs/${job.sales}`)).body.stages;
  const stage = (name) => stages.find((s) => s.name === name).id;
  const add = async (name, stageName) => (await alex.upload('/applications', { job_id: job.sales, name, email: `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@mail.example`, ...(stageName ? { stage_id: stage(stageName) } : {}) })).body.id;
  await add('Anna Applied');
  await add('Ivo Interview', 'Recruiter screen');
  await add('Fay Final', 'Final interview');
  await add('Otto Offer', 'Offer');
  await add('Hana Hired', 'Hired');
  assert.equal((await alex.post(`/applications/${await add('Rex Rejected', 'Final interview')}/reject`, { reason: 'Not a match' })).status, 200);
  assert.equal((await alex.post(`/applications/${await add('Wim Withdrawn', 'Offer')}/withdraw`, {})).status, 200);
});

after(async () => {
  await server?.stop();
  for (const dir of [dataDir, oldDir, stoppedDir]) if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- the job board ----------

test('the job board has a column for each account executive with an open job: your own first, the others by name, jobs with nobody last', async () => {
  const hers = await board(priya);
  assert.deepEqual(shape(hers), [
    ['Priya Nair', ['Account Manager', 'Head of Sales']], // the job open longest is at the top
    ['Alex Morgan', ['Depot Operations Lead']],
    ['Marcus Bell', ['Product Designer']],
    [null, ['Clinic Manager']],
  ]);
  assert.deepEqual(hers.map((c) => [c.id, c.you, c.active]), [[id.priya, true, 1], [id.alex, false, 1], [id.marcus, false, 1], [null, false, null]]);
  // The same board for somebody else starts with their own column.
  assert.deepEqual(shape(await board(alex)).map(([name]) => name), ['Alex Morgan', 'Marcus Bell', 'Priya Nair', null]);
  assert.deepEqual(shape(await board(marcus)).map(([name]) => name), ['Marcus Bell', 'Alex Morgan', 'Priya Nair', null]);
  // Dana's only job is a draft, so she has no column; and a closed job is on nobody's.
  assert.equal(hers.some((c) => c.id === id.dana), false);
  assert.equal(JSON.stringify(hers).includes('Finance Manager'), false);
});

test('a card on the board says how long the job has been open, its openings and how many are filled, and who is in the pipeline, at interview and at offer', async () => {
  const card = (await board(priya))[0].jobs.find((j) => j.id === job.sales);
  const { opened_at, ...rest } = card;
  assert.deepEqual(rest, { id: job.sales, title: 'Head of Sales', status: 'open', client_id: kestrel, client_name: 'Kestrel Logistics', brand_color: '#b45309',
    openings: 2, hires: 1, in_pipeline: 4, interviewing: 2, offers: 1 });
  assert.ok(Date.now() - new Date(opened_at).getTime() < 60000, 'it was opened a moment ago');
  // A job nobody has applied to counts nought everywhere.
  const empty = (await board(priya))[0].jobs.find((j) => j.id === job.accounts);
  assert.deepEqual([empty.openings, empty.hires, empty.in_pipeline, empty.interviewing, empty.offers, empty.opened_at], [1, 0, 0, 0, 0, '2026-01-05T09:00:00.000Z']);
});

test('the switch adds paused and draft jobs to the board, after the open ones, and never closed ones', async () => {
  const all = await board(priya, '?board=all');
  assert.deepEqual(shape(all), [
    ['Priya Nair', ['Account Manager', 'Head of Sales', 'Data Analyst']],
    ['Alex Morgan', ['Depot Operations Lead']],
    ['Dana Frost', ['Nurse Lead']],
    ['Marcus Bell', ['Product Designer', 'Operations Coordinator']],
    [null, ['Clinic Manager']],
  ]);
  assert.deepEqual(all.flatMap((c) => c.jobs).filter((j) => j.status !== 'open').map((j) => [j.title, j.status, j.opened_at === null]),
    [['Data Analyst', 'paused', true], ['Nurse Lead', 'draft', true], ['Operations Coordinator', 'draft', true]]);
  // Anything other than "all" is the board of open jobs.
  assert.deepEqual(shape(await board(priya, '?board=closed')), shape(await board(priya)));
});

test('the board follows the client chosen in the sidebar, and a person with no jobs at that client has no column', async () => {
  assert.deepEqual(shape(await board(priya, `?client_id=${lumen}`)), [['Marcus Bell', ['Product Designer']], [null, ['Clinic Manager']]]);
  assert.deepEqual(shape(await board(priya, `?client_id=${lumen}&board=all`)), [['Dana Frost', ['Nurse Lead']], ['Marcus Bell', ['Product Designer', 'Operations Coordinator']], [null, ['Clinic Manager']]]);
  assert.deepEqual(shape(await board(priya, `?client_id=${kestrel}`)), [['Priya Nair', ['Account Manager', 'Head of Sales']], ['Alex Morgan', ['Depot Operations Lead']]]);
  // The "No account executive" column is only there when a job in view has nobody.
  assert.equal((await board(alex, `?client_id=${kestrel}&board=all`)).some((c) => c.id === null), false);
});

test('somebody deactivated keeps their column, marked, until their jobs are handed on; somebody removed outright leaves their jobs with nobody', async () => {
  const tess = await join('recruiter', 'Tess Gray', 'tess@agency.example');
  const tessId = (await userIds()).tess;
  const warehouse = await newJob(tess, 'Warehouse Supervisor', kestrel);
  assert.deepEqual(shape(await board(alex)).find(([name]) => name === 'Tess Gray'), ['Tess Gray', ['Warehouse Supervisor']]);

  assert.equal((await alex.patch(`/users/${tessId}`, { active: false })).status, 200);
  const column = (await board(alex)).find((c) => c.id === tessId);
  assert.deepEqual([column.name, column.active, column.jobs.map((j) => j.title)], ['Tess Gray', 0, ['Warehouse Supervisor']]);
  assert.equal((await jobOf(alex, warehouse)).account_executive_active, 0);

  write(dataDir, 'DELETE FROM users WHERE id = ?', tessId);
  const after = await board(alex);
  assert.equal(after.some((c) => c.id === tessId), false);
  assert.deepEqual(after.at(-1).jobs.map((j) => j.title).sort(), ['Clinic Manager', 'Warehouse Supervisor']);
  const now = await jobOf(alex, warehouse);
  assert.deepEqual([now.account_executive_id, now.account_executive_name, now.created_by], [null, null, tessId], 'who created it is still recorded');
  // An admin gives such a job to somebody, and it moves to their column.
  assert.equal((await put(alex, `/jobs/${warehouse}`, { title: 'Warehouse Supervisor', status: 'open', account_executive_id: id.marcus })).status, 200);
  assert.deepEqual(shape(await board(alex)).find(([name]) => name === 'Marcus Bell'), ['Marcus Bell', ['Product Designer', 'Warehouse Supervisor']]);
  assert.equal((await put(alex, `/jobs/${warehouse}`, { title: 'Warehouse Supervisor', status: 'closed' })).status, 200); // out of the way of the tests below
});

// ---------- who the account executive is, and who can change it ----------

test('a new job’s account executive is whoever created it', async () => {
  for (const [who, jobId, name] of [[priya, job.sales, 'priya'], [marcus, job.designer, 'marcus'], [alex, job.depot, 'alex']]) {
    const made = await jobOf(who, jobId);
    assert.deepEqual([made.account_executive_id, made.created_by], [id[name], id[name]]);
    assert.equal(made.account_executive_name, made.created_by_name);
  }
  assert.equal((await jobOf(marcus, job.sales)).account_executive_name, 'Priya Nair', 'the rest of the team can see whose job it is');
  assert.equal((await priya.get('/jobs')).body.find((j) => j.id === job.depot).account_executive_name, 'Alex Morgan');
});

test('a recruiter cannot make somebody else the account executive of a new job; an admin can', async () => {
  const before = (await alex.get('/jobs')).body.length;
  const refused = await priya.post('/jobs', { client_id: kestrel, title: 'Not hers to give', account_executive_id: id.marcus });
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /Only an admin can make somebody else the account executive/);
  assert.equal((await alex.get('/jobs')).body.length, before, 'nothing was created');
  // Naming herself, or nobody, is the same as leaving it out.
  for (const named of [id.priya, String(id.priya), '', null]) {
    const own = await newJob(priya, 'Her own', kestrel, { status: 'closed', account_executive_id: named });
    assert.equal((await jobOf(priya, own)).account_executive_id, id.priya, JSON.stringify(named));
  }
  // An admin creates a job for Marcus: it is Marcus's job, and the admin is still recorded as having created it.
  const forMarcus = await jobOf(alex, await newJob(alex, 'Made for Marcus', lumen, { status: 'closed', account_executive_id: id.marcus }));
  assert.deepEqual([forMarcus.account_executive_id, forMarcus.account_executive_name, forMarcus.created_by, forMarcus.created_by_name], [id.marcus, 'Marcus Bell', id.alex, 'Alex Morgan']);
});

test('only somebody active on the agency team can be an account executive', async () => {
  assert.equal((await alex.patch(`/users/${id.dana}`, { active: false })).status, 200);
  const before = (await alex.get('/jobs')).body.length;
  // A client's user, somebody deactivated, nobody at all, and things that are not a person.
  for (const named of [id.maya, id.dana, 999999, 'abc', 0, -1]) {
    const made = await alex.post('/jobs', { client_id: kestrel, title: 'For nobody real', account_executive_id: named });
    assert.equal(made.status, 400, JSON.stringify(named));
    assert.match(made.body.error, /Choose an account executive from the people active on your team/);
    const handed = await put(alex, `/jobs/${job.depot}`, { title: 'Depot Operations Lead', status: 'open', account_executive_id: named });
    assert.equal(handed.status, 400, JSON.stringify(named));
  }
  // Only a whole number, or the digits a form sends, names a person. Things that could be read as somebody's number
  // (true as 1, a list holding one number, a number with a fraction) are refused as well, whoever they would have meant.
  for (const named of [true, false, [id.priya], [id.alex], [String(id.priya)], { id: id.priya }, id.priya + 0.4, `${id.priya}.0`, ` ${id.priya}`, '1e0', '0x1']) {
    const made = await alex.post('/jobs', { client_id: kestrel, title: 'For nobody real', account_executive_id: named });
    assert.equal(made.status, 400, JSON.stringify(named));
    assert.match(made.body.error, /Choose an account executive from the people active on your team/);
    const handed = await put(alex, `/jobs/${job.depot}`, { title: 'Depot Operations Lead', status: 'open', account_executive_id: named });
    assert.equal(handed.status, 400, JSON.stringify(named));
    assert.match(handed.body.error, /Choose an account executive from the people active on your team/);
  }
  // A job cannot be left with nobody either.
  for (const named of ['', null]) assert.equal((await put(alex, `/jobs/${job.depot}`, { title: 'Depot Operations Lead', status: 'open', account_executive_id: named })).status, 400, JSON.stringify(named));
  assert.equal((await alex.get('/jobs')).body.length, before, 'nothing was created');
  assert.equal((await jobOf(alex, job.depot)).account_executive_id, id.alex, 'and the job is still whose it was');
  // Dana's own job stays hers while she is deactivated: saving it does not ask for a new account executive.
  assert.equal((await put(alex, `/jobs/${job.nurse}`, { title: 'Nurse Lead', status: 'draft', account_executive_id: id.dana })).status, 200);
  assert.equal((await jobOf(alex, job.nurse)).account_executive_id, id.dana);
});

test('a job is handed on by its account executive or an admin, and by nobody else', async () => {
  const fields = { title: 'Product Designer', status: 'open', description: 'A role.' };
  // Priya is on the team but it is not her job.
  const refused = await put(priya, `/jobs/${job.designer}`, { ...fields, account_executive_id: id.priya });
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /Only this job’s account executive, or an admin, can hand it to somebody else/);
  assert.equal((await jobOf(alex, job.designer)).account_executive_id, id.marcus);
  // She can still edit the job itself: a save that does not name anybody, or names whoever has it, changes nothing about that.
  assert.equal((await put(priya, `/jobs/${job.designer}`, { ...fields, department: 'Product' })).status, 200);
  assert.equal((await put(priya, `/jobs/${job.designer}`, { ...fields, department: 'Product', account_executive_id: String(id.marcus) })).status, 200);
  assert.deepEqual([(await jobOf(alex, job.designer)).account_executive_id, (await jobOf(alex, job.designer)).department], [id.marcus, 'Product']);

  // Marcus hands it to Priya. From then on it is hers to hand on, not his, although he created it.
  assert.equal((await put(marcus, `/jobs/${job.designer}`, { ...fields, account_executive_id: id.priya })).status, 200);
  let now = await jobOf(alex, job.designer);
  assert.deepEqual([now.account_executive_id, now.account_executive_name, now.created_by, now.created_by_name], [id.priya, 'Priya Nair', id.marcus, 'Marcus Bell']);
  assert.equal((await put(marcus, `/jobs/${job.designer}`, { ...fields, account_executive_id: id.marcus })).status, 403);
  // A form he had open from before the hand-over still saves, as the form leaves out an account executive nobody
  // changed in it: his edit goes in and the job stays Priya's.
  assert.equal((await put(marcus, `/jobs/${job.designer}`, { ...fields, department: 'Design' })).status, 200);
  assert.deepEqual([(await jobOf(alex, job.designer)).account_executive_id, (await jobOf(alex, job.designer)).department], [id.priya, 'Design']);
  assert.deepEqual(shape(await board(priya, `?client_id=${lumen}`))[0], ['Priya Nair', ['Product Designer']]);

  // An admin can give any job to anybody on the team.
  assert.equal((await put(alex, `/jobs/${job.designer}`, { ...fields, account_executive_id: id.marcus })).status, 200);
  now = await jobOf(alex, job.designer);
  assert.deepEqual([now.account_executive_id, now.created_by], [id.marcus, id.marcus]);
  // A job with nobody is the admins' to give: a recruiter cannot take it.
  assert.equal((await put(priya, `/jobs/${job.clinic}`, { title: 'Clinic Manager', status: 'open', account_executive_id: id.priya })).status, 403);
  assert.equal((await put(priya, `/jobs/${job.clinic}`, { title: 'Clinic Manager', status: 'open', account_executive_id: '' })).status, 200, 'saving it as it is, with nobody, is not a hand-over');
  assert.equal((await jobOf(alex, job.clinic)).account_executive_id, null);
});

test('the brief belongs to the account executive: they and an admin edit it, and the creator no longer does once the job is handed on', async () => {
  const fields = { title: 'Operations Coordinator', status: 'draft' };
  const briefOf = async () => { const j = await jobOf(alex, job.coordinator); return [j.brief.about, j.ideal_profile]; };
  // Marcus created the job, so it starts as his.
  assert.equal((await put(marcus, `/jobs/${job.coordinator}/brief`, { brief: { about: 'Written by Marcus' }, ideal_profile: 'Organised' })).status, 200);
  const notHers = await put(priya, `/jobs/${job.coordinator}/brief`, { brief: { about: 'Written by Priya' } });
  assert.equal(notHers.status, 403);
  assert.match(notHers.body.error, /Only this job’s account executive, or an admin, can edit its brief/);
  assert.deepEqual(await briefOf(), ['Written by Marcus', 'Organised']);

  // He hands it to Priya: now she can, and he cannot, by either road (the brief page, or the profile sent with the job form).
  assert.equal((await put(marcus, `/jobs/${job.coordinator}`, { ...fields, account_executive_id: id.priya })).status, 200);
  assert.equal((await put(marcus, `/jobs/${job.coordinator}/brief`, { brief: { about: 'Marcus again' } })).status, 403);
  assert.equal((await put(marcus, `/jobs/${job.coordinator}`, { ...fields, ideal_profile: 'Changed by its creator' })).status, 200);
  assert.deepEqual(await briefOf(), ['Written by Marcus', 'Organised'], 'the job saved, and the profile was left alone');
  assert.equal((await put(priya, `/jobs/${job.coordinator}/brief`, { brief: { about: 'Written by Priya' } })).status, 200);
  assert.equal((await put(priya, `/jobs/${job.coordinator}`, { ...fields, ideal_profile: 'Changed by the account executive' })).status, 200);
  assert.deepEqual(await briefOf(), ['Written by Priya', 'Changed by the account executive']);
  // An admin always can. And a job with nobody is only an admin's to write.
  assert.equal((await put(alex, `/jobs/${job.coordinator}/brief`, { brief: { about: 'Written by an admin' } })).status, 200);
  assert.equal((await briefOf())[0], 'Written by an admin');
  assert.equal((await put(priya, `/jobs/${job.clinic}/brief`, { brief: { about: 'Nobody’s job' } })).status, 403);
  assert.equal((await put(alex, `/jobs/${job.clinic}/brief`, { brief: { about: 'Nobody’s job' } })).status, 200);
  assert.equal((await put(alex, `/jobs/${job.coordinator}`, { ...fields, account_executive_id: id.marcus })).status, 200); // back as it was
});

// ---------- the Jobs page ----------

test('the Jobs list can be narrowed to one account executive, or to the jobs that have nobody', async () => {
  const titles = async (who, query) => (await who.get(`/jobs${query}`)).body.map((j) => j.title).sort();
  // Every status, not only the open ones.
  assert.deepEqual(await titles(alex, `?account_executive=${id.priya}`), ['Account Manager', 'Data Analyst', 'Head of Sales', 'Her own', 'Her own', 'Her own', 'Her own']);
  assert.deepEqual(await titles(alex, `?account_executive=${id.marcus}&client_id=${lumen}`), ['Made for Marcus', 'Operations Coordinator', 'Product Designer']);
  assert.deepEqual(await titles(marcus, `?account_executive=${id.marcus}&client_id=${kestrel}`), ['Warehouse Supervisor']);
  assert.deepEqual(await titles(priya, '?account_executive=none'), ['Clinic Manager']);
  assert.deepEqual(await titles(priya, `?account_executive=none&client_id=${kestrel}`), []);
  assert.deepEqual(await titles(priya, '?account_executive=nobody-at-all'), []);
  for (const j of (await priya.get(`/jobs?account_executive=${id.priya}`)).body) assert.deepEqual([j.account_executive_id, j.account_executive_name], [id.priya, 'Priya Nair']);

  // What the filter offers: everyone active on the team, anybody deactivated who still has jobs in view, and how many jobs have nobody.
  const offered = (await priya.get('/account-executives')).body;
  assert.deepEqual(offered.people.map((p) => [p.name, p.active]), [['Alex Morgan', 1], ['Marcus Bell', 1], ['Priya Nair', 1], ['Dana Frost', 0]]);
  assert.equal(offered.none, 1);
  assert.deepEqual((await priya.get(`/account-executives?client_id=${kestrel}`)).body, { people: offered.people.slice(0, 3), none: 0 }, 'Dana has no job at Kestrel');
});

// ---------- the client's hiring team ----------

test('a client’s user is sent no job board and nothing about who the account executive is, anywhere', async () => {
  // Marcus is given Kestrel's Depot job, which Alex created. Nothing else connects him to Kestrel: he added nobody
  // there and is no job's hiring manager. So his name in anything Maya is sent could only be there as an account
  // executive, and Alex's on that job only as its creator.
  assert.equal((await put(alex, `/jobs/${job.depot}`, { title: 'Depot Operations Lead', status: 'open', account_executive_id: id.marcus })).status, 200);
  const application = (await alex.get(`/applications?job_id=${job.sales}`)).body[0].id;
  const answers = {};
  for (const pathname of ['/dashboard', '/dashboard?board=all', `/dashboard?client_id=${lumen}&board=all`, '/jobs', '/jobs?status=open', `/jobs/${job.depot}`, `/jobs/${job.sales}`,
    `/jobs?account_executive=${id.marcus}`, '/jobs?account_executive=none', `/applications?job_id=${job.sales}`, `/applications/${application}`, '/reports', `/reports?job_id=${job.depot}`, '/nav', '/me', '/clients']) {
    const answer = await maya.get(pathname);
    assert.equal(answer.status, 200, pathname);
    answers[pathname] = JSON.stringify(answer.body);
  }
  // The careers pages are open to anybody.
  const slug = (await alex.get(`/clients/${kestrel}`)).body.client.slug;
  for (const pathname of [`/public/careers/${slug}`, `/public/careers/${slug}/jobs/${job.depot}`, `/public/careers/${slug}/jobs/${job.sales}`]) {
    const answer = await session(server.base).get(pathname);
    assert.equal(answer.status, 200, pathname);
    answers[pathname] = JSON.stringify(answer.body);
  }
  for (const [pathname, sent] of Object.entries(answers)) {
    for (const word of ['account_executive', 'created_by', 'Marcus', '"board"']) assert.equal(sent.includes(word), false, `${pathname} mentions ${word}`);
  }
  // Her dashboard and her jobs are otherwise what they were: the open jobs of her own company.
  assert.deepEqual((await maya.get('/dashboard')).body.jobs.map((j) => j.title).sort(), ['Account Manager', 'Depot Operations Lead', 'Head of Sales']);
  assert.deepEqual(Object.keys((await maya.get('/dashboard')).body).sort(), ['jobs', 'recent', 'stale', 'stats', 'upcoming']);
  // The filter is ignored for her, so it cannot be used to work out whose job is whose.
  assert.equal(answers[`/jobs?account_executive=${id.marcus}`], answers['/jobs']);
  assert.equal(answers['/jobs?account_executive=none'], answers['/jobs']);
  // And the routes that are about account executives are closed to her.
  assert.equal((await maya.get('/account-executives')).status, 403);
  assert.equal((await put(maya, `/jobs/${job.depot}`, { title: 'Depot Operations Lead', status: 'open', account_executive_id: id.priya })).status, 403);
  assert.equal((await maya.post('/jobs', { client_id: kestrel, title: 'Hers', account_executive_id: id.priya })).status, 403);
  assert.equal((await jobOf(alex, job.depot)).account_executive_id, id.marcus);
  // The agency, asking for the same things, is sent them.
  assert.equal((await alex.get(`/jobs/${job.depot}`)).body.job.account_executive_name, 'Marcus Bell');
  assert.ok(Array.isArray((await alex.get('/dashboard')).body.board));
});

test('somebody who comes back as a client’s user is no longer anybody’s account executive', async () => {
  assert.equal((await jobOf(alex, job.nurse)).account_executive_id, id.dana);
  // Dana was deactivated above. She is invited again at the same address, this time onto Lumen's hiring team.
  const { token } = (await alex.post('/invites', { role: 'client', email: 'dana@agency.example', client_id: lumen })).body;
  const back = session(server.base);
  assert.equal((await back.post(`/invites/${token}/accept`, { name: 'Dana Frost', password: 'demo1234' })).status, 200);
  assert.equal((await back.get('/me')).body.user.role, 'client');
  const now = await jobOf(alex, job.nurse);
  assert.deepEqual([now.account_executive_id, now.account_executive_name, now.created_by], [null, null, id.dana]);
  assert.equal(JSON.stringify((await back.get(`/jobs/${job.nurse}`)).body).includes('account_executive'), false);
  assert.equal((await put(back, `/jobs/${job.nurse}/brief`, { brief: { about: 'Dana, from the client' } })).status, 403);
});

// ---------- a database that was in use before ----------

const T = '2026-10-20T15:00:00.000Z';
const hash = (password) => { const salt = crypto.randomBytes(16).toString('hex'); return `${salt}:${crypto.scryptSync(password, salt, 32).toString('hex')}`; };
/** Every table's rows, and every table, index and trigger as it is written. */
const everything = (dir) => look(dir, (all) => {
  const objects = all(`SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY name`);
  return { objects: Object.fromEntries(objects.map((o) => [o.name, o.sql])), rows: Object.fromEntries(objects.filter((o) => o.type === 'table').map((o) => [o.name, all(`SELECT * FROM ${o.name} ORDER BY rowid`)])) };
});

/** A database as the version before this one left it: people, clients, jobs with every kind of creator, and candidates in them. */
function oldDatabase(dir) {
  const db = new DatabaseSync(path.join(dir, 'app.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(fs.readFileSync(path.join(FIXTURES, 'before-account-executive-schema.sql'), 'utf8'));
  const run = (sql, ...values) => db.prepare(sql).run(...values);
  for (const [key, value] of [['agency_name', 'Harbour Talent'], ['links_normalised', '1'], ['activity_types_v2', '1']]) run('INSERT INTO settings (key, value) VALUES (?, ?)', key, value);
  run(`INSERT INTO email_templates (key, name, subject, body) VALUES ('rejection', 'Not moving forward', 'Their own wording', 'Edited by the agency.')`);
  run(`INSERT INTO clients (id, name, slug, created_at) VALUES (1, 'Kestrel Logistics', 'kestrel-logistics', ?), (2, 'Lumen Health', 'lumen-health', ?)`, T, T);
  const person = (userId, email, name, role, clientId = null, active = 1) =>
    run('INSERT INTO users (id, email, password_hash, name, role, client_id, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', userId, email, hash('demo1234'), name, role, clientId, active, T);
  person(1, 'alex@agency.example', 'Alex Morgan', 'admin');
  person(2, 'priya@agency.example', 'Priya Nair', 'recruiter');
  person(3, 'maya@kestrel.example', 'Maya Okonkwo', 'client', 1);
  person(4, 'dana@agency.example', 'Dana Frost', 'recruiter', null, 0); // has left: deactivated, still on file
  // Person 9 was removed outright long ago; only the number is left on the job they created.
  const made = (jobId, clientId, title, status, createdBy, brief = '{}') =>
    run(`INSERT INTO jobs (id, client_id, title, status, description, ideal_profile, brief, hiring_manager_id, openings, created_by, created_at, opened_at)
         VALUES (?, ?, ?, ?, 'The advert.', 'The profile.', ?, 3, 2, ?, ?, ?)`, jobId, clientId, title, status, brief, createdBy, T, status === 'draft' ? null : T);
  made(1, 1, 'Head of Sales', 'open', 1, '{"about":"Why it is open.","must_haves":["Has led a team"]}');
  made(2, 1, 'Data Analyst', 'paused', 2);
  made(3, 2, 'Clinic Manager', 'open', null);      // nobody is recorded as creating it
  made(4, 1, 'Depot Operations Lead', 'open', 3);  // created by somebody on the client's team
  made(5, 2, 'Nurse Lead', 'open', 9);             // created by somebody who has been removed
  made(6, 2, 'Product Designer', 'closed', 4);     // created by a recruiter who has since been deactivated
  made(7, 2, 'Finance Manager', 'draft', 2);
  run(`INSERT INTO stages (id, job_id, name, kind, position) VALUES (1, 1, 'Applied', 'applied', 0), (2, 1, 'Recruiter screen', 'interview', 1), (3, 1, 'Offer', 'offer', 2), (4, 1, 'Hired', 'hired', 3)`);
  run(`INSERT INTO candidates (id, client_id, name, email, created_at) VALUES (1, 1, 'Ivo Interview', 'ivo@mail.example', ?), (2, 1, 'Hana Hired', 'hana@mail.example', ?)`, T, T);
  run(`INSERT INTO applications (id, candidate_id, job_id, stage_id, status, applied_at, stage_entered_at, updated_at, owner_id) VALUES (1, 1, 1, 2, 'active', ?, ?, ?, 2), (2, 2, 1, 4, 'hired', ?, ?, ?, 2)`, T, T, T, T, T, T);
  db.close();
}

test('starting on a database from before fills in each job’s account executive from who created it, and changes nothing else', async () => {
  oldDir = tempDir('before-account-executive');
  oldDatabase(oldDir);
  const before = everything(oldDir);
  assert.equal(before.objects.jobs.includes('account_executive'), false, 'the database really is from before');

  let old = await startServer({ port: OLD_PORT, dataDir: oldDir });
  await old.stop();
  const first = everything(oldDir);
  // The creator, when they are still on file and on the agency's team (deactivated or not); otherwise nobody.
  assert.deepEqual(first.rows.jobs.map((j) => [j.id, j.created_by, j.account_executive_id]), [[1, 1, 1], [2, 2, 2], [3, null, null], [4, 3, null], [5, 9, null], [6, 4, 4], [7, 2, 2]]);
  // Everything else about every job is as it was, who created it included.
  assert.deepEqual(first.rows.jobs.map(({ account_executive_id, ...rest }) => rest), before.rows.jobs);
  // The jobs table gained that one column at its end. Every other table, index and trigger is written as it was, and no row in any of them changed.
  const columnsBefore = /\(([\s\S]*)\)/.exec(before.objects.jobs)[1], columnsNow = /\(([\s\S]*)\)/.exec(first.objects.jobs)[1];
  assert.ok(columnsNow.startsWith(columnsBefore) && /^,\s*account_executive_id INTEGER REFERENCES users\(id\) ON DELETE SET NULL$/.test(columnsNow.slice(columnsBefore.length)), 'jobs was changed by more than its one new column');
  // (Two tables are written again by another change, so that somebody can be saved to The Book without a job: a
  // candidate no longer has to have a client, nor an application a job and a stage, and an application has one new
  // column. Nothing else about the two is different; test/pool-upgrade.test.mjs is about that upgrade.)
  const rebuilt = (table) => before.objects[table].replace(`CREATE TABLE ${table} (`, `CREATE TABLE "${table}" (`);
  const expected = { ...before.objects,
    candidates: rebuilt('candidates').replace('client_id INTEGER NOT NULL REFERENCES', 'client_id INTEGER REFERENCES'),
    applications: rebuilt('applications').replace('job_id INTEGER NOT NULL REFERENCES', 'job_id INTEGER REFERENCES').replace('stage_id INTEGER NOT NULL REFERENCES', 'stage_id INTEGER REFERENCES')
      .replace('owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,', 'owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL, general_until TEXT,') };
  for (const [name, sql] of Object.entries(expected)) if (name !== 'jobs') assert.equal(first.objects[name], sql, `${name} was changed or dropped`);
  // (The agency's public jobs page came after the fixture was made: its own tables and indexes, all named board_, are
  // new and are covered by its own upgrade test. So are the tables and indexes of people saved without a job, which
  // are listed here, and every table among them is empty. Nothing else may appear.)
  const notTheBoards = (name) => !/^(idx_)?board_/.test(name);
  const THE_BOOKS = ['agency_activities', 'agency_emails', 'earlier_resumes', 'idx_agency_activities_app', 'idx_agency_emails_app', 'idx_apps_general', 'idx_candidates_general_email', 'idx_earlier_resumes_app'];
  assert.deepEqual(Object.keys(first.objects).filter(notTheBoards).sort(), [...Object.keys(before.objects), ...THE_BOOKS].sort(), 'nothing was added beside the column');
  for (const table of THE_BOOKS.filter((name) => first.rows[name])) assert.deepEqual(first.rows[table], [], `${table} is empty`);
  // (Starting also does what it did before this version: it notes when the server first ran and files candidates' names for looking up.)
  const STARTING_WRITES = ['jobs', 'settings', 'candidate_name_keys', 'candidate_name_dirty', 'candidate_phone_keys'];
  // (The agency's public jobs page adds one e-mail template of its own on start; the templates that were there are untouched.)
  const theBoards = (row) => row.key === 'board_application_received';
  // (The one column applications gained for people saved without a job is empty in the rows that were there.)
  const plain = (value) => JSON.parse(JSON.stringify(value));
  for (const [table, rows] of Object.entries(before.rows)) {
    if (STARTING_WRITES.includes(table)) continue;
    assert.deepEqual(plain(table === 'email_templates' ? first.rows[table].filter((row) => !theBoards(row)) : first.rows[table]),
      plain(table === 'applications' ? rows.map((row) => ({ ...row, general_until: null })) : rows), `rows in ${table} changed`);
  }
  for (const row of before.rows.settings) assert.deepEqual(first.rows.settings.find((s) => s.key === row.key), row, `the setting ${row.key} changed`);

  // Somebody takes a job on, and the server is started again: nothing is filled in a second time.
  old = await startServer({ port: OLD_PORT, dataDir: oldDir });
  try {
    const admin = session(old.base);
    assert.equal((await admin.post('/login', { email: 'alex@agency.example', password: 'demo1234' })).status, 200);
    assert.deepEqual(shape((await admin.get('/dashboard?board=all')).body.board), [
      ['Alex Morgan', ['Head of Sales']], ['Priya Nair', ['Data Analyst', 'Finance Manager']], [null, ['Clinic Manager', 'Depot Operations Lead', 'Nurse Lead']]]);
    assert.deepEqual((await admin.get('/jobs/6')).body.job.account_executive_name, 'Dana Frost');
    assert.equal((await put(admin, '/jobs/3', { title: 'Clinic Manager', status: 'open', account_executive_id: 2 })).status, 200);
    assert.equal((await put(admin, '/jobs/2', { title: 'Data Analyst', status: 'paused', account_executive_id: 1 })).status, 200);
    assert.equal((await admin.post('/logout')).status, 200);
  } finally { await old.stop(); }
  const second = everything(oldDir);
  assert.deepEqual(second.rows.jobs.map((j) => [j.id, j.created_by, j.account_executive_id]), [[1, 1, 1], [2, 2, 1], [3, null, 2], [4, 3, null], [5, 9, null], [6, 4, 4], [7, 2, 2]]);

  old = await startServer({ port: OLD_PORT, dataDir: oldDir });
  await old.stop();
  const third = everything(oldDir);
  assert.deepEqual(third.rows.jobs, second.rows.jobs, 'a job handed on, and a job with nobody, are left as they are');
  assert.deepEqual(third.objects, second.objects);
  for (const [table, rows] of Object.entries(second.rows)) assert.deepEqual(third.rows[table], rows, `starting again changed rows in ${table}`);
});

test('a start that is stopped between adding the column and filling it leaves neither done, and the next start does both', async () => {
  const dir = stoppedDir = tempDir('before-account-executive-stopped');
  oldDatabase(dir);
  // The server cannot be stopped at an exact moment from outside, so the database is made to stop it there: any
  // change to a job fails, which is what filling in the account executives is. Adding the column is not a change to a job.
  const change = (sql) => { const db = new DatabaseSync(path.join(dir, 'app.db')); try { db.exec(sql); } finally { db.close(); } };
  change(`CREATE TRIGGER stopped_here BEFORE UPDATE ON jobs BEGIN SELECT RAISE(ABORT, 'stopped here'); END`);
  await assert.rejects(startServer({ port: OLD_PORT, dataDir: dir }), /stopped here/);
  const stopped = everything(dir);
  assert.equal(stopped.objects.jobs.includes('account_executive'), false, 'the column was left behind without being filled');

  change('DROP TRIGGER stopped_here');
  const again = await startServer({ port: OLD_PORT, dataDir: dir });
  await again.stop();
  assert.deepEqual(everything(dir).rows.jobs.map((j) => [j.id, j.created_by, j.account_executive_id]), [[1, 1, 1], [2, 2, 2], [3, null, null], [4, 3, null], [5, 9, null], [6, 4, 4], [7, 2, 2]]);
});
