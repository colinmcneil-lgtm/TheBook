// To do, end to end: each person's own lists of jobs to work on and people to prep and debrief, the two pickers
// beside them, and what The Book puts on the people lists by itself from scheduled interviews. Run with `npm test`.
//
// A story is acted out against The Book's real API on a throwaway data folder. People go on To prep seven days
// before an interview and on To debrief when it has ended, so the API is started with one extra route (see
// todos-server.mjs) that tells the to-do module what time it is. Everything else in the server keeps the real clock.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { session, sleep, tempDir, PORTS } from './oracle-helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The two ports kept for this file (see PORT_PLAN in oracle-helpers.mjs for who uses which).
const PORT = PORTS.todos, UPGRADE_PORT = PORTS.todos + 1;
const DAY = 86400000, HOUR = 3600000, MINUTE = 60000;

async function startApi({ port, dataDir }) {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'test/todos-server.mjs'], {
    cwd: ROOT, env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test', PORT: String(port), DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  for (let waited = 0; !output.includes('is running on'); waited += 50) {
    if (child.exitCode !== null || waited > 15000) throw new Error(`The API did not start:\n${output}`);
    await sleep(50);
  }
  return { base: `http://127.0.0.1:${port}`, output: () => output, stop: async () => { child.kill('SIGTERM'); await exited; } };
}

let server, dataDir;
let T0;                                   // the moment the story starts: a little after the server first ran
let olive, priya, sam, maya;              // the admin, two recruiters, and a hiring manager at Lumen
let lumen, kestrel;                       // clients
const jobs = {}, stages = {};             // job ids, and each job's stage ids by name

/** The time `days` (and a bit) after the story started. */
const at = (days, extra = 0) => new Date(T0 + days * DAY + extra).toISOString();
/** Tell the to-do module what time it is. */
async function clock(iso) {
  const res = await fetch(`${server.base}/test/clock`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ now: iso }) });
  assert.equal(res.status, 200);
}
const ok = (res) => { assert.equal(res.status, 200, JSON.stringify(res.body)); return res.body; };
const refused = (res, status, words) => { assert.equal(res.status, status, JSON.stringify(res.body)); if (words) assert.match(res.body.error, words); };
const lists = async (who) => ok(await who.get('/todos'));
const titles = (list) => list.open.map((x) => x.title ?? x.name);
const doneTitles = (list) => list.done.map((x) => x.title ?? x.name);
const menuCount = async (who) => ok(await who.get('/nav')).todo;
const addJob = async (who, jobId, extra = {}) => ok(await who.post('/todos', { kind: 'job', job_id: jobId, ...extra })).id;
const addPerson = async (who, kind, appId, extra = {}) => ok(await who.post('/todos', { kind, application_id: appId, ...extra })).id;
const tick = async (who, id, extra = {}) => ok(await who.patch(`/todos/${id}`, { done: true, ...extra }));
const untick = async (who, id) => ok(await who.patch(`/todos/${id}`, { done: false }));
const remove = async (who, id) => ok(await who.del(`/todos/${id}`));
/** Add someone to a job the way the forms do. They belong to whoever adds them. */
const candidate = async (who, job, name, stage) =>
  ok(await who.upload('/applications', { job_id: jobs[job], name, email: `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@mail.example`, stage_id: stage ? stages[job][stage] : undefined })).id;
const schedule = async (who, appId, startsAt, extra = {}) =>
  ok(await who.post('/interviews', { application_id: appId, title: 'Hiring manager interview', starts_at: startsAt, duration_min: 60, ...extra })).id;
/** Read the database file directly, for what no route shows. */
function rows(sql, ...params) {
  const db = new DatabaseSync(path.join(dataDir, 'app.db'), { readOnly: true });
  try { return db.prepare(sql).all(...params); } finally { db.close(); }
}
/** Change the database behind the server's back, for a state no route can produce (a job with no account executive). */
function write(sql, ...params) {
  const db = new DatabaseSync(path.join(dataDir, 'app.db'));
  try { db.exec('PRAGMA foreign_keys = ON'); return db.prepare(sql).run(...params); } finally { db.close(); }
}
/** Somebody invited by Olive accepts and is signed in. A deactivated person invited again comes back this way too. */
async function join(role, name, email, extra = {}) {
  const { token } = ok(await olive.post('/invites', { role, email, ...extra }));
  const person = session(server.base);
  ok(await person.post(`/invites/${token}/accept`, { name, password: 'demo1234' }));
  return person;
}
/** A person's user id. */
const idOf = async (who) => ok(await who.get('/me')).user.id;

before(async () => {
  dataDir = tempDir('todos');
  server = await startApi({ port: PORT, dataDir });
  T0 = Math.floor(Date.now() / MINUTE) * MINUTE + 5 * MINUTE;
  await clock(at(0));
  olive = session(server.base);
  ok(await olive.post('/setup', { agencyName: 'Harbour Talent', name: 'Olive Admin', email: 'olive@agency.example', password: 'demo1234' }));
  lumen = ok(await olive.post('/clients', { name: 'Lumen' })).id;
  kestrel = ok(await olive.post('/clients', { name: 'Kestrel' })).id;
  priya = await join('recruiter', 'Priya Nair', 'priya@agency.example');
  sam = await join('recruiter', 'Sam Ode', 'sam@agency.example');
  maya = await join('client', 'Maya Okonkwo', 'maya@lumen.example', { client_id: lumen });
  const job = async (key, clientId, title, status = 'open') => {
    jobs[key] = ok(await olive.post('/jobs', { client_id: clientId, title, status })).id;
    stages[key] = Object.fromEntries(ok(await olive.get(`/jobs/${jobs[key]}`)).stages.map((s) => [s.name, s.id]));
  };
  await job('backend', lumen, 'Backend Engineer');
  await job('designer', lumen, 'Product Designer');
  await job('sales', kestrel, 'Head of Sales');
  await job('analyst', kestrel, 'Data Analyst', 'paused');
  await job('planned', kestrel, 'Planned search', 'draft');
  // Prep and debrief go to the job's account executive, and only when a job has none to the recruiter who owns the
  // candidate, then to whoever scheduled the interview. Most of the story below is about that fallback (who owns a
  // candidate, who scheduled what), so its jobs are left with no account executive: an older workspace's jobs, say,
  // or those of somebody who left. The account executive's own part is told in its section further down.
  write(`UPDATE jobs SET account_executive_id = NULL WHERE id IN (${Object.values(jobs).join(', ')})`);
});

after(async () => {
  await server?.stop();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

// ---------- who may use it ----------

test('client users are refused on every route and are told nothing about it', async () => {
  const id = await addJob(olive, jobs.backend);
  for (const call of [
    () => maya.get('/todos'), () => maya.get('/todos/jobs'), () => maya.get('/todos/people'), () => maya.get('/todos/people?whose=all&q=a'),
    () => maya.post('/todos', { kind: 'job', job_id: jobs.backend }), () => maya.patch(`/todos/${id}`, { done: true }), () => maya.patch(`/todos/${id}`, { note: 'x' }),
    () => maya.post(`/todos/${id}/move`, { position: 0 }), () => maya.del(`/todos/${id}`),
  ]) refused(await call(), 403, /Only the agency team/);
  // Nothing was changed by any of that, and the hiring team's menu counts carry nothing about to-do lists.
  assert.deepEqual(titles((await lists(olive)).job), ['Backend Engineer']);
  assert.equal('todo' in ok(await maya.get('/nav')), false);
  assert.equal(await menuCount(olive), 1);
  // Nor is it open to somebody who is not signed in.
  const nobody = session(server.base);
  refused(await nobody.get('/todos'), 401);
  refused(await nobody.post('/todos', { kind: 'job', job_id: jobs.backend }), 401);
  await remove(olive, id);
});

// ---------- jobs to work on ----------

test('jobs are picked from the open jobs, in the order they are put, each with a note', async () => {
  assert.deepEqual(await lists(priya), { job: { open: [], done: [] }, prep: { open: [], done: [] }, debrief: { open: [], done: [] }, counts: { job: 0, prep: 0, debrief: 0, total: 0 } });

  // The picker: every open job, and only open ones, by client and title.
  const picker = ok(await priya.get('/todos/jobs'));
  assert.deepEqual(picker.map((j) => `${j.client_name}: ${j.title}`), ['Kestrel: Head of Sales', 'Lumen: Backend Engineer', 'Lumen: Product Designer']);
  assert.ok(picker.every((j) => j.on_list === false && j.in_pipeline === 0 && j.opened_at));
  assert.deepEqual(ok(await priya.get('/todos/jobs?q=design')).map((j) => j.title), ['Product Designer']);
  assert.deepEqual(ok(await priya.get('/todos/jobs?q=kestrel')).map((j) => j.title), ['Head of Sales']); // the client's name counts too
  assert.deepEqual(ok(await priya.get(`/todos/jobs?client_id=${lumen}`)).map((j) => j.title), ['Backend Engineer', 'Product Designer']);
  assert.deepEqual(ok(await priya.get(`/todos/jobs?client_id=${lumen}&q=sales`)), []);

  // Added with the button they go to the end; dragged in they go where they were dropped.
  const backend = await addJob(priya, jobs.backend);
  const sales = await addJob(priya, jobs.sales, { note: '  find 5 more\nby Friday  ' });
  const designer = await addJob(priya, jobs.designer, { position: 0 });
  let mine = await lists(priya);
  assert.deepEqual(titles(mine.job), ['Product Designer', 'Backend Engineer', 'Head of Sales']);
  assert.deepEqual(mine.counts, { job: 3, prep: 0, debrief: 0, total: 3 });
  assert.equal(mine.job.open[2].note, 'find 5 more by Friday'); // one line
  const item = mine.job.open[1];
  assert.deepEqual({ id: item.id, job_id: item.job_id, status: item.status, client_name: item.client_name, in_pipeline: item.in_pipeline, note: item.note, done_at: item.done_at },
    { id: backend, job_id: jobs.backend, status: 'open', client_name: 'Lumen', in_pipeline: 0, note: null, done_at: null });
  assert.deepEqual(ok(await priya.get('/todos/jobs')).filter((j) => j.on_list).map((j) => j.title).sort(), ['Backend Engineer', 'Head of Sales', 'Product Designer']);

  // A job is on a list once; a job that does not exist, or a list that does not, is refused.
  refused(await priya.post('/todos', { kind: 'job', job_id: jobs.backend }), 409, /Backend Engineer is already on your list/);
  refused(await priya.post('/todos', { kind: 'job', job_id: 999999 }), 404, /no longer in The Book/);
  refused(await priya.post('/todos', { kind: 'chores', job_id: jobs.backend }), 400);
  refused(await priya.post('/todos', { job_id: jobs.backend }), 400);

  // The note can be changed and cleared.
  ok(await priya.patch(`/todos/${backend}`, { note: 'Two more senior profiles' }));
  assert.equal((await lists(priya)).job.open[1].note, 'Two more senior profiles');
  ok(await priya.patch(`/todos/${backend}`, { note: '' }));
  assert.equal((await lists(priya)).job.open[1].note, null);
  ok(await priya.patch(`/todos/${sales}`, { note: 'x'.repeat(500) }));
  assert.equal((await lists(priya)).job.open[2].note.length, 300);
  ok(await priya.patch(`/todos/${sales}`, { note: 'find 5 more by Friday' }));

  // Ordering: to the top, to the end (a place past the end is the end), and somewhere in between.
  ok(await priya.post(`/todos/${sales}/move`, { position: 0 }));
  assert.deepEqual(titles((await lists(priya)).job), ['Head of Sales', 'Product Designer', 'Backend Engineer']);
  ok(await priya.post(`/todos/${sales}/move`, { position: 99 }));
  assert.deepEqual(titles((await lists(priya)).job), ['Product Designer', 'Backend Engineer', 'Head of Sales']);
  ok(await priya.post(`/todos/${designer}/move`, { position: 1 }));
  assert.deepEqual(titles((await lists(priya)).job), ['Backend Engineer', 'Product Designer', 'Head of Sales']);
  ok(await priya.post(`/todos/${designer}/move`, { position: 1 })); // where it already is
  assert.deepEqual(titles((await lists(priya)).job), ['Backend Engineer', 'Product Designer', 'Head of Sales']);
  refused(await priya.post(`/todos/${designer}/move`, { position: -1 }), 400);
  refused(await priya.post(`/todos/${designer}/move`, {}), 400);
  refused(await priya.post('/todos/999999/move', { position: 0 }), 404);
});

test('ticking moves a job to Done, un-ticking puts it back, and done items leave the page after seven days', async () => {
  const [backend, designer, sales] = (await lists(priya)).job.open.map((x) => x.id);
  await tick(priya, designer);
  let mine = await lists(priya);
  assert.deepEqual(titles(mine.job), ['Backend Engineer', 'Head of Sales']);
  assert.deepEqual(doneTitles(mine.job), ['Product Designer']);
  assert.equal(mine.job.done[0].done_at, at(0));
  assert.equal(mine.counts.total, 2);
  assert.equal(await menuCount(priya), 2);
  // Ticking what is ticked changes nothing, a done job cannot be moved, and only yes or no is taken for done.
  await clock(at(0, HOUR));
  await tick(priya, designer);
  assert.equal((await lists(priya)).job.done[0].done_at, at(0));
  refused(await priya.post(`/todos/${designer}/move`, { position: 0 }), 400, /Un-tick it/);
  refused(await priya.patch(`/todos/${designer}`, { done: 'yes' }), 400);
  // A job that is done can be picked again, and then the done one cannot be un-ticked on top of it.
  assert.equal(ok(await priya.get('/todos/jobs?q=designer'))[0].on_list, false);
  const again = await addJob(priya, jobs.designer);
  refused(await priya.patch(`/todos/${designer}`, { done: false }), 409, /already on your list again/);
  await remove(priya, again);

  // Un-ticked, it goes back on the list, at the end.
  await tick(priya, backend);
  assert.deepEqual(doneTitles((await lists(priya)).job), ['Backend Engineer', 'Product Designer']); // newest first
  await untick(priya, designer);
  mine = await lists(priya);
  assert.deepEqual(titles(mine.job), ['Head of Sales', 'Product Designer']);
  assert.deepEqual(doneTitles(mine.job), ['Backend Engineer']);
  assert.equal(await menuCount(priya), 2);

  // Seven days on, the done job is no longer shown. It is still in the database, and can no longer be seen to un-tick.
  await clock(at(7, HOUR - MINUTE));
  assert.deepEqual(doneTitles((await lists(priya)).job), ['Backend Engineer']);
  await clock(at(7, HOUR + MINUTE));
  mine = await lists(priya);
  assert.deepEqual(doneTitles(mine.job), []);
  assert.deepEqual(titles(mine.job), ['Head of Sales', 'Product Designer']);
  assert.equal(rows('SELECT done_at FROM todos WHERE id = ?', backend)[0].done_at, at(0, HOUR));
  await clock(at(0, 2 * HOUR));
  await untick(priya, backend);
  ok(await priya.post(`/todos/${backend}/move`, { position: 0 }));
  ok(await priya.post(`/todos/${sales}/move`, { position: 2 }));
  assert.deepEqual(titles((await lists(priya)).job), ['Backend Engineer', 'Product Designer', 'Head of Sales']);
});

test('one person cannot read or change another person\'s list, whatever ids they send', async () => {
  const mine = await lists(priya);
  const [backend, designer] = mine.job.open.map((x) => x.id);
  // Sam's list is his own: empty, though Priya's has three jobs on it.
  assert.deepEqual((await lists(sam)).counts, { job: 0, prep: 0, debrief: 0, total: 0 });
  assert.equal(await menuCount(sam), 0);
  assert.ok(ok(await sam.get('/todos/jobs')).every((j) => !j.on_list));
  // Every way of changing an item answers as if Priya's did not exist, for a recruiter and for the admin alike.
  for (const who of [sam, olive]) {
    refused(await who.patch(`/todos/${backend}`, { note: 'mine now' }), 404, /no longer on your list/);
    assert.deepEqual((await who.patch(`/todos/${backend}`, { note: 'mine now' })).body, (await who.patch('/todos/999999', { note: 'mine now' })).body); // the same answer as for a number that does not exist
    refused(await who.patch(`/todos/${backend}`, { done: true }), 404);
    refused(await who.patch(`/todos/${backend}`, { done: true, debrief: 'What she said' }), 404);
    refused(await who.post(`/todos/${designer}/move`, { position: 0 }), 404);
    refused(await who.del(`/todos/${backend}`), 404);
  }
  assert.deepEqual(await lists(priya), mine);
  // The same job can be on both their lists, each with its own note and place.
  const sams = await addJob(sam, jobs.backend, { note: 'Sam\'s own note' });
  assert.deepEqual((await lists(sam)).job.open.map((x) => [x.title, x.note]), [['Backend Engineer', 'Sam\'s own note']]);
  assert.equal((await lists(priya)).job.open[0].note, null);
  refused(await priya.del(`/todos/${sams}`), 404);
  await tick(sam, sams);
  assert.deepEqual(await lists(priya), mine);
  assert.equal(await menuCount(priya), 3);
  assert.equal(await menuCount(sam), 0);
});

test('a job taken off the list is gone from it and can be picked again', async () => {
  const before = await lists(priya);
  const sales = before.job.open[2].id;
  await remove(priya, sales);
  assert.deepEqual(titles((await lists(priya)).job), ['Backend Engineer', 'Product Designer']);
  assert.equal(await menuCount(priya), 2);
  // Removed is removed: it cannot be changed any more, and the row is kept.
  refused(await priya.patch(`/todos/${sales}`, { note: 'back?' }), 404);
  refused(await priya.del(`/todos/${sales}`), 404);
  assert.equal(rows('SELECT removed_at FROM todos WHERE id = ?', sales)[0].removed_at, at(0, 2 * HOUR));
  assert.equal(ok(await priya.get('/todos/jobs?q=sales'))[0].on_list, false);
  await addJob(priya, jobs.sales, { note: 'find 5 more by Friday' });
  assert.deepEqual(titles((await lists(priya)).job), ['Backend Engineer', 'Product Designer', 'Head of Sales']);
});

test('a job that is closed stays on the list and says so; a job that is deleted takes its items with it', async () => {
  const extra = ok(await olive.post('/jobs', { client_id: kestrel, title: 'Depot Lead', status: 'open' })).id;
  const mine = await addJob(priya, extra);
  await addJob(sam, extra);
  ok(await olive.patch(`/jobs/${extra}/status`, { status: 'closed' }));
  const closed = (await lists(priya)).job.open.find((x) => x.id === mine);
  assert.equal(closed.status, 'closed');                        // still there, for its owner to tick or take off
  assert.deepEqual(ok(await priya.get('/todos/jobs?q=depot')), []); // and no longer offered among the open jobs
  await tick(priya, mine);
  ok(await olive.del(`/jobs/${extra}`));
  assert.deepEqual(titles((await lists(priya)).job), ['Backend Engineer', 'Product Designer', 'Head of Sales']);
  assert.deepEqual(doneTitles((await lists(priya)).job), []);
  assert.deepEqual(titles((await lists(sam)).job), []);
  assert.equal(rows('SELECT COUNT(*) AS n FROM todos WHERE job_id = ?', extra)[0].n, 0);
  assert.equal(await menuCount(priya), 3);
});

// ---------- people to prep and to debrief ----------

const apps = {};

test('the people picker lists candidates at interview in open jobs: the person\'s own, or everyone\'s, or anyone by name', async () => {
  apps.ana = await candidate(priya, 'backend', 'Ana Reyes', 'Hiring manager interview');
  apps.ben = await candidate(priya, 'designer', 'Ben Okoro', 'Recruiter screen');
  apps.cy = await candidate(sam, 'sales', 'Cy Marsh', 'Final interview');
  apps.dee = await candidate(priya, 'backend', 'Dee Applied');                              // not at interview yet
  apps.eli = await candidate(priya, 'analyst', 'Eli Paused', 'Hiring manager interview');   // the job is paused
  apps.flo = await candidate(priya, 'sales', 'Flo Offer', 'Offer');                         // past interviews
  apps.gus = await candidate(sam, 'backend', 'Gus Rejected', 'Final interview');
  ok(await sam.post(`/applications/${apps.gus}/reject`, { reason: 'Not enough relevant experience' }));

  const names = (list) => list.map((p) => p.name);
  const own = ok(await priya.get('/todos/people'));
  assert.deepEqual(names(own), ['Ana Reyes', 'Ben Okoro']);
  const ana = own[0];
  assert.deepEqual({ application_id: ana.application_id, job_id: ana.job_id, job_title: ana.job_title, client_name: ana.client_name, stage_name: ana.stage_name, stage_kind: ana.stage_kind,
    owner_name: ana.owner_name, next_interview: ana.next_interview, last_interview: ana.last_interview, on_prep: ana.on_prep, on_debrief: ana.on_debrief },
  { application_id: apps.ana, job_id: jobs.backend, job_title: 'Backend Engineer', client_name: 'Lumen', stage_name: 'Hiring manager interview', stage_kind: 'interview',
    owner_name: 'Priya Nair', next_interview: null, last_interview: null, on_prep: false, on_debrief: false });
  assert.deepEqual(names(ok(await sam.get('/todos/people'))), ['Cy Marsh']);
  assert.deepEqual(names(ok(await olive.get('/todos/people'))), []);                         // the admin owns nobody
  assert.deepEqual(names(ok(await priya.get('/todos/people?whose=all'))), ['Ana Reyes', 'Ben Okoro', 'Cy Marsh']);
  assert.deepEqual(names(ok(await olive.get('/todos/people?whose=all'))), ['Ana Reyes', 'Ben Okoro', 'Cy Marsh']);

  // The search box finds anyone by name: somebody else's, not at interview, in a paused job, even rejected.
  assert.deepEqual(names(ok(await priya.get('/todos/people?q=cy'))), ['Cy Marsh']);
  assert.deepEqual(names(ok(await priya.get('/todos/people?q=applied'))), ['Dee Applied']);
  assert.deepEqual(names(ok(await priya.get('/todos/people?q=paused'))), ['Eli Paused']);
  assert.deepEqual(ok(await priya.get('/todos/people?q=gus')).map((p) => [p.name, p.status]), [['Gus Rejected', 'rejected']]);
  assert.deepEqual(names(ok(await priya.get('/todos/people?q=zzz'))), []);
});

test('a person is put on To prep and To debrief by hand, can be on both, and each item shows who and what it is about', async () => {
  const prep = await addPerson(priya, 'prep', apps.ben, { note: 'Send the portfolio brief' });
  await addPerson(priya, 'debrief', apps.ben);
  await addPerson(priya, 'prep', apps.cy);                       // somebody Sam owns: found by search, added to her own list
  await addPerson(priya, 'prep', apps.dee, { position: 0 });
  let mine = await lists(priya);
  assert.deepEqual(titles(mine.prep), ['Dee Applied', 'Ben Okoro', 'Cy Marsh']);
  assert.deepEqual(titles(mine.debrief), ['Ben Okoro']);
  assert.deepEqual(mine.counts, { job: 3, prep: 3, debrief: 1, total: 7 });
  assert.equal(await menuCount(priya), 7);
  const { id, ...ben } = mine.prep.open[1];
  assert.equal(id, prep);
  assert.deepEqual(ben, { kind: 'prep', note: 'Send the portfolio brief', done_at: null, application_id: apps.ben, status: 'active', candidate_id: ben.candidate_id, name: 'Ben Okoro', photo: null,
    job_id: jobs.designer, job_title: 'Product Designer', client_name: 'Lumen', brand_color: ben.brand_color, stage_name: 'Recruiter screen', stage_kind: 'interview', auto: false, auto_done: false, interview: null });
  // The picker says which lists each person is already on.
  assert.deepEqual(ok(await priya.get('/todos/people')).map((p) => [p.name, p.on_prep, p.on_debrief]), [['Ana Reyes', false, false], ['Ben Okoro', true, true]]);
  assert.deepEqual(ok(await sam.get('/todos/people')).map((p) => [p.name, p.on_prep, p.on_debrief]), [['Cy Marsh', false, false]]); // on Priya's list, not on Sam's
  // Once on each list; somebody who does not exist is refused.
  refused(await priya.post('/todos', { kind: 'prep', application_id: apps.ben }), 409, /Ben Okoro is already on this list/);
  refused(await priya.post('/todos', { kind: 'debrief', application_id: 999999 }), 404, /no longer in The Book/);
  refused(await priya.post('/todos', { kind: 'prep', job_id: jobs.backend }), 404);

  // Ordering, ticking and removing work as they do for jobs, each list on its own.
  ok(await priya.post(`/todos/${prep}/move`, { position: 0 }));
  assert.deepEqual(titles((await lists(priya)).prep), ['Ben Okoro', 'Dee Applied', 'Cy Marsh']);
  await tick(priya, prep);
  mine = await lists(priya);
  assert.deepEqual([titles(mine.prep), doneTitles(mine.prep), titles(mine.debrief)], [['Dee Applied', 'Cy Marsh'], ['Ben Okoro'], ['Ben Okoro']]);
  await untick(priya, prep);
  assert.deepEqual(titles((await lists(priya)).prep), ['Dee Applied', 'Cy Marsh', 'Ben Okoro']);
  for (const item of (await lists(priya)).prep.open) await remove(priya, item.id);
  await remove(priya, (await lists(priya)).debrief.open[0].id);
  assert.deepEqual((await lists(priya)).counts, { job: 3, prep: 0, debrief: 0, total: 3 });
});

// ---------- what The Book adds by itself ----------

/** A person's two people lists in short: who is to prep, who is to debrief. */
const people = async (who) => { const mine = await lists(who); return { prep: titles(mine.prep), debrief: titles(mine.debrief) }; };

test('on a job with no account executive, a scheduled interview puts the candidate on their owner\'s To prep list from seven days before it starts', async () => {
  await clock(at(1));
  // Ana belongs to Priya. Sam schedules her interview for ten days from the start of the story.
  const start = at(10);
  apps.anaInterview = await schedule(sam, apps.ana, start);
  assert.deepEqual(await people(priya), { prep: [], debrief: [] });      // more than seven days away
  await clock(at(3, -MINUTE));
  assert.deepEqual(await people(priya), { prep: [], debrief: [] });
  await clock(at(3));                                                     // seven days before, to the minute
  const mine = await lists(priya);
  assert.deepEqual(titles(mine.prep), ['Ana Reyes']);
  const item = mine.prep.open[0];
  assert.equal(item.auto, true);
  assert.deepEqual(item.interview, { id: apps.anaInterview, title: 'Hiring manager interview', kind: 'video', starts_at: start, duration_min: 60, status: 'scheduled' });
  assert.equal(await menuCount(priya), 4);
  // It went to the owner, not to the person who scheduled it, and it is there once however often anybody looks.
  assert.deepEqual(await people(sam), { prep: [], debrief: [] });
  await lists(priya); await menuCount(sam); await lists(olive);
  assert.deepEqual(await people(priya), { prep: ['Ana Reyes'], debrief: [] });
  assert.equal(ok(await priya.get('/todos/people'))[0].next_interview, start);
  assert.equal(ok(await priya.get('/todos/people'))[0].on_prep, true);
});

test('with no account executive and no owner the person who scheduled it gets the item; scheduled by the client with no owner, nobody does', async () => {
  // Hal is added by Priya, who then hands him back to nobody. Sam schedules his interview for tomorrow.
  apps.hal = await candidate(priya, 'designer', 'Hal Unowned', 'Hiring manager interview');
  ok(await priya.patch(`/applications/${apps.hal}`, { owner_id: null }));
  await schedule(sam, apps.hal, at(4));
  assert.deepEqual(await people(sam), { prep: ['Hal Unowned'], debrief: [] });
  assert.deepEqual(await people(priya), { prep: ['Ana Reyes'], debrief: [] });
  // Ida has no owner either, and it is the client's hiring manager who books her in.
  apps.ida = await candidate(priya, 'designer', 'Ida Clientbooked', 'Hiring manager interview');
  ok(await priya.patch(`/applications/${apps.ida}`, { owner_id: null }));
  await schedule(maya, apps.ida, at(4));
  for (const who of [priya, sam, olive]) assert.ok(!(await people(who)).prep.includes('Ida Clientbooked'));
  assert.equal(rows('SELECT COUNT(*) AS n FROM todos WHERE application_id = ?', apps.ida)[0].n, 0);
  // When somebody takes her on, she goes on their list.
  ok(await olive.patch(`/applications/${apps.ida}`, { owner_id: ok(await olive.get('/me')).user.id }));
  assert.deepEqual(await people(olive), { prep: ['Ida Clientbooked'], debrief: [] });
  // And when a candidate changes hands, the item The Book added changes lists with them.
  ok(await olive.patch(`/applications/${apps.hal}`, { owner_id: ok(await priya.get('/me')).user.id }));
  assert.deepEqual(await people(sam), { prep: [], debrief: [] });
  // He goes above Ana, not under her: his interview is on day 4 and hers on day 10.
  assert.deepEqual(await people(priya), { prep: ['Hal Unowned', 'Ana Reyes'], debrief: [] });
});

test('a moved interview keeps its item, which shows the new time; moved more than a week away, the item waits', async () => {
  const later = at(9, 3 * HOUR);
  ok(await sam.patch(`/interviews/${apps.anaInterview}`, { starts_at: later }));
  let mine = await lists(priya);
  assert.deepEqual(titles(mine.prep), ['Hal Unowned', 'Ana Reyes']);
  assert.equal(mine.prep.open[1].interview.starts_at, later);
  // A note written on it, and the place the person put it in, survive the move.
  const ana = mine.prep.open[1].id;
  ok(await priya.patch(`/todos/${ana}`, { note: 'Walk her through the system design round' }));
  ok(await priya.post(`/todos/${ana}/move`, { position: 0 }));
  ok(await sam.patch(`/interviews/${apps.anaInterview}`, { starts_at: at(9) }));
  mine = await lists(priya);
  assert.deepEqual(mine.prep.open.map((x) => [x.name, x.note, x.interview.starts_at]), [['Ana Reyes', 'Walk her through the system design round', at(9)], ['Hal Unowned', null, at(4)]]);
  // Put off to a month away: nothing to prepare for yet. Brought back within the week: on the list again, the same
  // item with the note still on it, and after Hal, whose interview is sooner.
  ok(await sam.patch(`/interviews/${apps.anaInterview}`, { starts_at: at(30) }));
  assert.deepEqual(await people(priya), { prep: ['Hal Unowned'], debrief: [] });
  assert.equal(await menuCount(priya), 4);                                   // three jobs and Hal: an item set aside is not counted
  refused(await priya.patch(`/todos/${ana}`, { note: 'Still mine?' }), 404);  // nor can it be changed while it is off the list
  ok(await sam.patch(`/interviews/${apps.anaInterview}`, { starts_at: at(9) }));
  mine = await lists(priya);
  assert.deepEqual(mine.prep.open.map((x) => [x.id, x.name, x.note, x.auto]), [[mine.prep.open[0].id, 'Hal Unowned', null, true], [ana, 'Ana Reyes', 'Walk her through the system design round', true]]);
});

test('a cancelled interview takes its item with it, and a rejected candidate\'s too; an item added by hand stays', async () => {
  ok(await sam.patch(`/interviews/${apps.anaInterview}`, { status: 'cancelled' }));
  assert.deepEqual(await people(priya), { prep: ['Hal Unowned'], debrief: [] });
  ok(await sam.patch(`/interviews/${apps.anaInterview}`, { status: 'scheduled' }));   // back on, and the note with it
  assert.deepEqual((await lists(priya)).prep.open.map((x) => [x.name, x.note]), [['Hal Unowned', null], ['Ana Reyes', 'Walk her through the system design round']]);

  // Jo was put on the list by hand before any interview existed. Scheduling one gives her item its time; cancelling
  // it leaves the item, without a time.
  apps.jo = await candidate(priya, 'backend', 'Jo Byhand', 'Recruiter screen');
  const byHand = await addPerson(priya, 'prep', apps.jo);
  const interview = await schedule(priya, apps.jo, at(5));
  let jo = (await lists(priya)).prep.open.find((x) => x.id === byHand);
  assert.deepEqual([jo.auto, jo.interview.starts_at], [false, at(5)]);
  assert.deepEqual((await people(priya)).prep, ['Hal Unowned', 'Ana Reyes', 'Jo Byhand']);   // once, not twice
  ok(await priya.patch(`/interviews/${interview}`, { status: 'cancelled' }));
  jo = (await lists(priya)).prep.open.find((x) => x.id === byHand);
  assert.equal(jo.interview, null);
  await remove(priya, byHand);

  // Rejecting a candidate cancels what is coming up for them, and the item goes with it.
  apps.kit = await candidate(priya, 'backend', 'Kit Rejected', 'Final interview');
  await schedule(priya, apps.kit, at(6));
  assert.ok((await people(priya)).prep.includes('Kit Rejected'));
  ok(await priya.post(`/applications/${apps.kit}/reject`, { reason: 'Stronger candidates in process' }));
  assert.deepEqual(await people(priya), { prep: ['Hal Unowned', 'Ana Reyes'], debrief: [] });
});

test('an item the person took off or ticked is not put back for the same interview', async () => {
  let mine = await lists(priya);
  const hal = mine.prep.open.find((x) => x.name === 'Hal Unowned'), ana = mine.prep.open.find((x) => x.name === 'Ana Reyes');
  await remove(priya, hal.id);
  await tick(priya, ana.id);
  for (let n = 0; n < 3; n++) { await menuCount(priya); await lists(sam); }
  assert.deepEqual(await people(priya), { prep: [], debrief: [] });
  // Not when the interview is moved either, or cancelled and put back.
  ok(await sam.patch(`/interviews/${apps.anaInterview}`, { starts_at: at(8) }));
  ok(await sam.patch(`/interviews/${apps.anaInterview}`, { status: 'cancelled' }));
  ok(await sam.patch(`/interviews/${apps.anaInterview}`, { status: 'scheduled', starts_at: at(9) }));
  await clock(at(4, -HOUR));
  mine = await lists(priya);
  assert.deepEqual([titles(mine.prep), doneTitles(mine.prep)], [[], ['Ana Reyes']]);
  // Un-ticked by hand, it is hers again and still about that interview.
  await untick(priya, ana.id);
  mine = await lists(priya);
  assert.deepEqual(mine.prep.open.map((x) => [x.name, x.interview.starts_at]), [['Ana Reyes', at(9)]]);
  // A second interview for the same candidate is a new one: Hal, taken off for the first, is back for the next.
  await clock(at(4, 2 * HOUR));                                           // Hal's first interview (day 4, one hour) is over
  await schedule(priya, apps.hal, at(6));
  mine = await lists(priya);
  assert.deepEqual(mine.prep.open.map((x) => [x.name, x.interview.starts_at]), [['Hal Unowned', at(6)], ['Ana Reyes', at(9)]]);   // soonest interview first
  assert.deepEqual(titles(mine.debrief), ['Hal Unowned']);               // and the first is to debrief
});

test('when an interview has ended the candidate goes on To debrief, and their prep comes off as done', async () => {
  // Hal's first interview ended at day 4 plus one hour: to the minute.
  await clock(at(4, 2 * HOUR));
  let mine = await lists(priya);
  const debrief = mine.debrief.open[0];
  assert.deepEqual([debrief.name, debrief.auto, debrief.interview.starts_at, debrief.interview.status], ['Hal Unowned', true, at(4), 'scheduled']);
  assert.deepEqual(await people(sam), { prep: [], debrief: [] });       // the owner's list, not the scheduler's

  // Ana's is on day 9. During it she is still to prep; a minute after it ends she is to debrief and the prep is done.
  await clock(at(9, 30 * MINUTE));
  // (Hal's second interview, on day 6, has passed by now: his prep for it is done, and he is to debrief once, not twice.)
  assert.deepEqual(await people(priya), { prep: ['Ana Reyes'], debrief: ['Hal Unowned'] });
  await clock(at(9, HOUR));
  mine = await lists(priya);
  assert.deepEqual(titles(mine.prep), []);
  assert.deepEqual(mine.prep.done.map((x) => [x.name, x.done_at]), [['Ana Reyes', at(9, HOUR)], ['Hal Unowned', at(9, 30 * MINUTE)]]); // ticked when The Book next looked
  assert.deepEqual(titles(mine.debrief), ['Hal Unowned', 'Ana Reyes']);
  assert.equal(mine.debrief.open[1].interview.id, apps.anaInterview);
  assert.equal(mine.debrief.open[0].interview.starts_at, at(6));          // Hal's debrief is about his latest interview
  // A prep un-ticked after its interview is the person's own item from then on, and stays.
  const anaPrep = mine.prep.done.find((x) => x.name === 'Ana Reyes');
  await untick(priya, anaPrep.id);
  mine = await lists(priya);
  assert.deepEqual(mine.prep.open.map((x) => [x.name, x.auto, x.interview]), [['Ana Reyes', false, null]]);
  await remove(priya, anaPrep.id);
});

test('an interview that was missed and then moved is to prepare for again, and its debrief goes', async () => {
  // Lou's interview passes with nobody touching The Book: prep done by itself, debrief added.
  await clock(at(10));
  apps.lou = await candidate(priya, 'designer', 'Lou Postponed', 'Final interview');
  const interview = await schedule(priya, apps.lou, at(11));
  assert.ok((await people(priya)).prep.includes('Lou Postponed'));
  await clock(at(11, 2 * HOUR));
  let mine = await lists(priya);
  assert.ok(doneTitles(mine.prep).includes('Lou Postponed') && titles(mine.debrief).includes('Lou Postponed'));
  // Then somebody records that it was put off until day 13.
  ok(await priya.patch(`/interviews/${interview}`, { starts_at: at(13) }));
  mine = await lists(priya);
  assert.ok(titles(mine.prep).includes('Lou Postponed') && !doneTitles(mine.prep).includes('Lou Postponed'));
  assert.ok(!titles(mine.debrief).includes('Lou Postponed'));
  // A scorecard handed in marks the interview completed, which ends it as far as the lists go.
  ok(await priya.post(`/interviews/${interview}/scorecard`, { recommendation: 'yes' }));
  mine = await lists(priya);
  assert.ok(!titles(mine.prep).includes('Lou Postponed') && titles(mine.debrief).includes('Lou Postponed'));
  await remove(priya, mine.debrief.open.find((x) => x.name === 'Lou Postponed').id);
});

test('an interview that ended more than a week ago, or before To do was first used, puts nobody on a list', async () => {
  // Recorded after the fact with a time before this workspace first ran To do.
  apps.max = await candidate(priya, 'designer', 'Max Longago', 'Final interview');
  await schedule(priya, apps.max, new Date(T0 - 2 * DAY).toISOString());
  // And one that ended eight days before "now" in the story.
  apps.nia = await candidate(priya, 'designer', 'Nia Lastweek', 'Final interview');
  await schedule(priya, apps.nia, at(3));
  const mine = await people(priya);
  assert.ok(!mine.debrief.includes('Max Longago') && !mine.debrief.includes('Nia Lastweek'));
  assert.ok(!mine.prep.includes('Max Longago') && !mine.prep.includes('Nia Lastweek'));
});

test('what the candidate said at a debrief is saved on their profile as an agency-only note the client never sees', async () => {
  let mine = await lists(priya);
  const hal = mine.debrief.open.find((x) => x.name === 'Hal Unowned'), ana = mine.debrief.open.find((x) => x.name === 'Ana Reyes');
  const said = 'Liked the team.\nWorried about the commute; wants two days at home.';
  const answer = await tick(priya, ana.id, { debrief: said });
  assert.ok(answer.note_id);
  mine = await lists(priya);
  assert.deepEqual(doneTitles(mine.debrief), ['Ana Reyes']);
  // On her profile, for the agency: private, under Priya's name.
  const forAgency = ok(await sam.get(`/applications/${apps.ana}`)).notes;
  assert.deepEqual(forAgency.map((n) => [n.id, n.body, n.private, n.user_name]), [[answer.note_id, `Debrief after Hiring manager interview:\n${said}`, 1, 'Priya Nair']]);
  // The client's hiring manager can open the same candidate and sees no note, and nothing on the history about it.
  const forClient = ok(await maya.get(`/applications/${apps.ana}`));
  assert.deepEqual(forClient.notes, []);
  assert.ok(!JSON.stringify(forClient).includes('commute'));
  assert.ok(!JSON.stringify(ok(await maya.get('/dashboard'))).includes('commute'));
  // Ticked with nothing typed, no note is made. Nor for a prep, or a job, whatever is sent with it.
  await tick(priya, hal.id, { debrief: '   ' });
  const prep = await addPerson(priya, 'prep', apps.hal);
  await tick(priya, prep, { debrief: 'Not a debrief' });
  const job = (await lists(priya)).job.open[0].id;
  await tick(priya, job, { debrief: 'Not a debrief either' });
  await untick(priya, job);
  ok(await priya.post(`/todos/${job}/move`, { position: 0 }));
  assert.deepEqual(ok(await sam.get(`/applications/${apps.hal}`)).notes, []);
  assert.equal(rows('SELECT COUNT(*) AS n FROM notes')[0].n, 1);
  // Un-ticking the debrief keeps the note; ticking again with more adds a second one.
  await untick(priya, ana.id);
  await tick(priya, ana.id, { debrief: 'Called back: she accepts.' });
  assert.deepEqual(ok(await sam.get(`/applications/${apps.ana}`)).notes.map((n) => n.private), [1, 1]);
  // Ticked on the phone, and the notes then typed into a page on the laptop that still showed it un-ticked: the
  // item is already done when the words arrive, and they are saved all the same.
  const late = await tick(priya, ana.id, { debrief: 'Typed up afterwards: start date is the 1st.' });
  assert.ok(late.note_id);
  const notes = ok(await sam.get(`/applications/${apps.ana}`)).notes;
  assert.equal(notes.length, 3);
  assert.deepEqual(notes.find((n) => n.id === late.note_id).body, 'Debrief after Hiring manager interview:\nTyped up afterwards: start date is the 1st.');
  assert.deepEqual(ok(await maya.get(`/applications/${apps.ana}`)).notes, []);
  // Sent a second time (the answer was lost on the way back and she pressed again), the same words are one note.
  assert.equal((await tick(priya, ana.id, { debrief: 'Typed up afterwards: start date is the 1st.' })).note_id, late.note_id);
  // Ticking what is ticked with nothing typed still makes no note, and says so by sending no note back.
  assert.equal('note_id' in (await tick(priya, ana.id)), false);
  assert.equal(ok(await sam.get(`/applications/${apps.ana}`)).notes.length, 3);
});

test('two interviews in one week put a candidate on To prep once, for the next one', async () => {
  await clock(at(12));
  apps.ola = await candidate(priya, 'sales', 'Ola Twice', 'Hiring manager interview');
  const second = await schedule(priya, apps.ola, at(15));
  const first = await schedule(priya, apps.ola, at(13, HOUR));
  let mine = await lists(priya);
  let ola = mine.prep.open.filter((x) => x.name === 'Ola Twice');
  assert.deepEqual(ola.map((x) => x.interview.id), [first]);
  await tick(priya, ola[0].id);                                          // prepared for the first
  assert.ok(!(await people(priya)).prep.includes('Ola Twice'));          // the second does not jump in while the first is still to come
  await clock(at(13, 3 * HOUR));
  mine = await lists(priya);
  ola = mine.prep.open.filter((x) => x.name === 'Ola Twice');
  assert.deepEqual(ola.map((x) => x.interview.id), [second]);
  assert.deepEqual(mine.debrief.open.filter((x) => x.name === 'Ola Twice').map((x) => x.interview.id), [first]);
});

test('the count in the menu is what is still to do on the person\'s own three lists', async () => {
  for (const who of [olive, priya, sam]) {
    const mine = await lists(who);
    assert.equal(mine.counts.total, mine.job.open.length + mine.prep.open.length + mine.debrief.open.length);
    assert.equal(await menuCount(who), mine.counts.total);
    // The same whichever client the workspace is showing: the list is the person's, not the client's.
    assert.equal(ok(await who.get(`/nav?client_id=${kestrel}`)).todo, mine.counts.total);
  }
  const before = await menuCount(priya);
  const id = await addJob(priya, ok(await olive.post('/jobs', { client_id: lumen, title: 'Counted', status: 'open' })).id);
  assert.equal(await menuCount(priya), before + 1);
  await tick(priya, id);
  assert.equal(await menuCount(priya), before);
  await untick(priya, id);
  assert.equal(await menuCount(priya), before + 1);
  await remove(priya, id);
  assert.equal(await menuCount(priya), before);
});

// ---------- candidates and jobs going away ----------

test('merging two records of one person keeps their items; deleting a candidate or a job removes them', async () => {
  // Pat was sourced, then applied on her own: two records at Lumen, each in a different job, both on Priya's lists.
  apps.pat = await candidate(priya, 'backend', 'Pat Sourced', 'Hiring manager interview');
  apps.pat2 = await candidate(priya, 'designer', 'Patricia Applied', 'Recruiter screen');
  await schedule(priya, apps.pat, at(14));
  await addPerson(priya, 'debrief', apps.pat2, { note: 'Ask about the other offer' });
  const candidateOf = async (appId) => ok(await priya.get(`/applications/${appId}`)).candidate.id;
  const [from, into] = [await candidateOf(apps.pat), await candidateOf(apps.pat2)];
  let mine = await lists(priya);
  assert.ok(titles(mine.prep).includes('Pat Sourced') && titles(mine.debrief).includes('Patricia Applied'));
  ok(await priya.post(`/candidates/${from}/merge`, { into }));
  mine = await lists(priya);
  const prep = mine.prep.open.find((x) => x.application_id === apps.pat), debrief = mine.debrief.open.find((x) => x.application_id === apps.pat2);
  assert.deepEqual([prep.name, prep.candidate_id, prep.interview.starts_at], ['Patricia Applied', into, at(14)]);   // the kept record's name
  assert.deepEqual([debrief.name, debrief.note], ['Patricia Applied', 'Ask about the other offer']);

  // Erasing her removes both items, from the list and from the database.
  const count = await menuCount(priya);
  ok(await priya.del(`/candidates/${into}`));
  mine = await lists(priya);
  assert.ok(!titles(mine.prep).includes('Patricia Applied') && !titles(mine.debrief).includes('Patricia Applied'));
  assert.equal(await menuCount(priya), count - 2);
  assert.equal(rows('SELECT COUNT(*) AS n FROM todos WHERE application_id IN (?, ?)', apps.pat, apps.pat2)[0].n, 0);

  // Removing somebody from a job removes that job's items for them.
  await addPerson(priya, 'prep', apps.cy);
  ok(await sam.del(`/applications/${apps.cy}`));
  assert.ok(!(await people(priya)).prep.includes('Cy Marsh'));

  // Deleting a job removes it from every list, with the people who were on a list because of it.
  await addJob(sam, jobs.sales);
  assert.ok((await people(priya)).prep.includes('Ola Twice') && titles((await lists(priya)).job).includes('Head of Sales'));
  ok(await olive.del(`/jobs/${jobs.sales}`));
  mine = await lists(priya);
  assert.ok(!titles(mine.job).includes('Head of Sales') && !titles(mine.prep).includes('Ola Twice') && !titles(mine.debrief).includes('Ola Twice'));
  assert.deepEqual(titles((await lists(sam)).job), []);
  assert.equal(rows('SELECT COUNT(*) AS n FROM todos t LEFT JOIN jobs j ON j.id = t.job_id LEFT JOIN applications a ON a.id = t.application_id WHERE j.id IS NULL AND a.id IS NULL')[0].n, 0);
  assert.equal(await menuCount(priya), (await lists(priya)).counts.total);
});

// ---------- the order people are added in, and what is kept when The Book takes somebody off ----------

const cast = ['Quin Later', 'Rae Sooner', 'Sol Soonest', 'Tess Byhand', 'Uma Today'];
/** One person's item on one of somebody's lists, by name. */
const itemOf = async (who, kind, name) => (await lists(who))[kind].open.find((x) => x.name === name);

test('somebody The Book adds to To prep goes above the people whose interviews are later than theirs', async () => {
  await clock(at(20));
  for (const name of cast) apps[name] = await candidate(priya, 'backend', name, 'Hiring manager interview');
  // The story has left other people on Priya's list by now: only these five are looked at.
  const prep = async () => (await lists(priya)).prep.open.filter((x) => cast.includes(x.name)).map((x) => x.name);
  // Booked in any order, they stand in the order of their interviews, soonest first.
  await schedule(priya, apps['Quin Later'], at(25));
  await schedule(priya, apps['Rae Sooner'], at(22));
  await schedule(priya, apps['Sol Soonest'], at(21));
  assert.deepEqual(await prep(), ['Sol Soonest', 'Rae Sooner', 'Quin Later']);
  // The order the person chose is kept: somebody put at the top by hand, with no interview, stays there, and
  // somebody moved to the top stays above the rest. A new arrival goes above the first one whose interview is later.
  await addPerson(priya, 'prep', apps['Tess Byhand'], { position: 0 });
  ok(await priya.post(`/todos/${(await itemOf(priya, 'prep', 'Sol Soonest')).id}/move`, { position: 99 }));
  assert.deepEqual(await prep(), ['Tess Byhand', 'Rae Sooner', 'Quin Later', 'Sol Soonest']);
  await schedule(priya, apps['Uma Today'], at(20, 2 * HOUR));
  assert.deepEqual(await prep(), ['Tess Byhand', 'Uma Today', 'Rae Sooner', 'Quin Later', 'Sol Soonest']);
  // To debrief is the other way about: whoever has waited longest stays first, and a new one goes last.
  await clock(at(20, 4 * HOUR));
  const debrief = (await lists(priya)).debrief.open;
  assert.equal(debrief.at(-1).name, 'Uma Today');
});

test('an item The Book takes off keeps its note for when the same interview brings it back', async () => {
  const rae = await itemOf(priya, 'prep', 'Rae Sooner');
  ok(await priya.patch(`/todos/${rae.id}`, { note: 'Send her the case study' }));
  // Rae is handed to Sam: she leaves Priya's list for his. Priya's note is hers and does not go with the candidate.
  ok(await olive.patch(`/applications/${apps['Rae Sooner']}`, { owner_id: await idOf(sam) }));
  assert.equal(await itemOf(priya, 'prep', 'Rae Sooner'), undefined);
  const sams = await itemOf(sam, 'prep', 'Rae Sooner');
  assert.deepEqual([sams.note, sams.auto], [null, true]);
  ok(await sam.patch(`/todos/${sams.id}`, { note: 'Ask about notice period' }));
  // Handed back, Priya has the same item again with her note on it, and Sam's is off his list.
  ok(await olive.patch(`/applications/${apps['Rae Sooner']}`, { owner_id: await idOf(priya) }));
  const back = await itemOf(priya, 'prep', 'Rae Sooner');
  assert.deepEqual([back.id, back.note, back.auto], [rae.id, 'Send her the case study', true]);
  assert.equal(await itemOf(sam, 'prep', 'Rae Sooner'), undefined);
  assert.equal(await menuCount(sam), (await lists(sam)).counts.total);
  // While it is off his list Sam cannot reach it, and neither can anybody else.
  for (const who of [sam, priya, olive]) refused(await who.patch(`/todos/${sams.id}`, { note: 'x' }), 404);
  // What a person took off themselves is another matter: it stays off, wherever the candidate goes and comes back from.
  await remove(priya, rae.id);
  ok(await olive.patch(`/applications/${apps['Rae Sooner']}`, { owner_id: await idOf(sam) }));
  assert.equal((await itemOf(sam, 'prep', 'Rae Sooner')).note, 'Ask about notice period');   // his own, back with its note
  ok(await olive.patch(`/applications/${apps['Rae Sooner']}`, { owner_id: await idOf(priya) }));
  assert.equal(await itemOf(priya, 'prep', 'Rae Sooner'), undefined);
  // One row each, however often she changed hands: nothing was deleted and nothing was added twice.
  assert.equal(rows(`SELECT COUNT(*) AS n FROM todos WHERE application_id = ? AND kind = 'prep'`, apps['Rae Sooner'])[0].n, 2);
});

test('a debrief un-ticked after its interview was moved to a later time stays on the list', async () => {
  await clock(at(21, 2 * HOUR));                                           // Sol's interview (day 21, one hour) is over
  const sol = await itemOf(priya, 'debrief', 'Sol Soonest');
  assert.equal(sol.auto, true);
  await tick(priya, sol.id, { debrief: 'Went well, she thinks.' });
  // It then turns out the interview was put off until day 23, and Priya un-ticks the debrief to keep it in view.
  ok(await priya.patch(`/interviews/${sol.interview.id}`, { starts_at: at(23) }));
  await untick(priya, sol.id);
  for (let n = 0; n < 3; n++) {                                           // still there however often anybody looks
    const item = await itemOf(priya, 'debrief', 'Sol Soonest');
    assert.deepEqual([item?.id, item?.auto, item?.interview], [sol.id, false, null]);   // her own item now, with no interview held yet
    await menuCount(sam);
  }
  // When the moved interview has been held it is about that one, and she is on the list once.
  await clock(at(23, 2 * HOUR));
  const after = (await lists(priya)).debrief.open.filter((x) => x.name === 'Sol Soonest');
  assert.deepEqual(after.map((x) => [x.id, x.interview.id, x.interview.starts_at]), [[sol.id, sol.interview.id, at(23)]]);
});

test('an interview that ended while nobody opened The Book is still to debrief when somebody next does', async () => {
  // Quin's interview is on day 25. The office shuts on day 24 and nobody opens The Book again until day 36.
  await clock(at(24));
  assert.ok(await itemOf(priya, 'prep', 'Quin Later'));
  await clock(at(36));
  let mine = await lists(priya);
  const quin = mine.debrief.open.find((x) => x.name === 'Quin Later');
  assert.deepEqual([quin?.auto, quin?.interview.starts_at], [true, at(25)]);
  // Her prep was never ticked by Priya. The Book ticked it because the interview had passed, and the list says so;
  // one Priya ticks herself is marked as hers.
  assert.equal(mine.prep.open.some((x) => x.name === 'Quin Later'), false);
  assert.equal(mine.prep.done.find((x) => x.name === 'Quin Later').auto_done, true);
  await tick(priya, (await itemOf(priya, 'prep', 'Tess Byhand')).id);
  assert.equal((await lists(priya)).prep.done.find((x) => x.name === 'Tess Byhand').auto_done, false);
  // An un-ticked debrief stays until its owner deals with it, however long that is.
  await clock(at(45));
  for (let n = 0; n < 2; n++) assert.equal((await itemOf(priya, 'debrief', 'Quin Later')).id, quin.id);
  assert.equal(await menuCount(priya), (await lists(priya)).counts.total);
  // An interview recorded after the fact, which ended over a week before, is not chased: somebody was looking then.
  apps.vic = await candidate(priya, 'backend', 'Vic Recorded', 'Final interview');
  await schedule(priya, apps.vic, at(30));
  assert.equal(await itemOf(priya, 'debrief', 'Vic Recorded'), undefined);
  // Nor is one that ended more than a month before The Book was next opened. Its prep is still ticked off.
  apps.wes = await candidate(priya, 'backend', 'Wes Longshut', 'Final interview');
  await schedule(priya, apps.wes, at(46));
  assert.ok(await itemOf(priya, 'prep', 'Wes Longshut'));
  await clock(at(78));
  mine = await lists(priya);
  assert.equal(mine.debrief.open.some((x) => x.name === 'Wes Longshut'), false);
  assert.equal(mine.prep.open.some((x) => x.name === 'Wes Longshut'), false);
  assert.deepEqual(rows('SELECT kind, auto_done, done_at IS NOT NULL AS done FROM todos WHERE application_id = ?', apps.wes).map((r) => ({ ...r })), [{ kind: 'prep', auto_done: 1, done: 1 }]);
});

// ---------- the job's account executive ----------

const ids = {};                           // user ids, by first name
/** Who has an application open on a list, read straight from the database: [who, list, added by The Book]. */
const openRows = (appId) => rows(
  `SELECT u.email, t.kind, t.auto FROM todos t JOIN users u ON u.id = t.user_id WHERE t.application_id = ? AND t.done_at IS NULL AND t.removed_at IS NULL ORDER BY u.email, t.kind`, appId)
  .map((r) => [r.email.split('@')[0], r.kind, r.auto]);
/** A new open job at Lumen with this account executive. */
async function aeJob(key, title, accountExecutive) {
  jobs[key] = ok(await olive.post('/jobs', { client_id: lumen, title, status: 'open', account_executive_id: accountExecutive })).id;
  stages[key] = Object.fromEntries(ok(await olive.get(`/jobs/${jobs[key]}`)).stages.map((s) => [s.name, s.id]));
}
/** Hand a job to another account executive, as the job form does. */
const handOver = async (key, title, accountExecutive) => ok(await olive.putJson(`/jobs/${jobs[key]}`, { title, status: 'open', account_executive_id: accountExecutive }));

test('the account executive of the job gets the prep, and the debrief when the interview has ended, not the recruiter who owns the candidate', async () => {
  await clock(at(80));
  for (const [name, who] of Object.entries({ olive, priya, sam })) ids[name] = await idOf(who);
  // Ari is Priya's candidate, on a job Sam is the account executive of. Priya books the interview.
  await aeJob('ops', 'Operations Lead', ids.sam);
  apps.ari = await candidate(priya, 'ops', 'Ari Prepped', 'Hiring manager interview');
  await schedule(priya, apps.ari, at(82));
  assert.deepEqual(openRows(apps.ari), [['sam', 'prep', 1]]);             // at once, before anybody opens a list
  assert.ok((await people(sam)).prep.includes('Ari Prepped'));
  assert.ok(!(await people(priya)).prep.includes('Ari Prepped'));
  // When it has ended, Sam's prep is ticked by The Book and Ari is on Sam's To debrief, still not on Priya's.
  await clock(at(82, 2 * HOUR));
  const sams = await lists(sam);
  assert.ok(titles(sams.debrief).includes('Ari Prepped'));
  assert.equal(sams.prep.done.find((x) => x.name === 'Ari Prepped').auto_done, true);
  const priyas = await people(priya);
  assert.ok(!priyas.prep.includes('Ari Prepped') && !priyas.debrief.includes('Ari Prepped'));
  assert.deepEqual(openRows(apps.ari), [['sam', 'debrief', 1]]);
  // What Sam types at the debrief is saved on Ari's profile as an agency-only note under his name, as before.
  const answer = await tick(sam, sams.debrief.open.find((x) => x.name === 'Ari Prepped').id, { debrief: 'Keen; could start in March.' });
  assert.deepEqual(ok(await priya.get(`/applications/${apps.ari}`)).notes.map((n) => [n.id, n.body, n.private, n.user_name]),
    [[answer.note_id, 'Debrief after Hiring manager interview:\nKeen; could start in March.', 1, 'Sam Ode']]);
  assert.deepEqual(ok(await maya.get(`/applications/${apps.ari}`)).notes, []);
});

test('an account executive who also owns the candidate has one item, not two; the candidate handed to another recruiter, it stays with the account executive', async () => {
  await aeJob('ux', 'UX Researcher', ids.priya);
  apps.bo = await candidate(priya, 'ux', 'Bo Samehands', 'Hiring manager interview');
  await schedule(sam, apps.bo, at(83));
  assert.deepEqual(openRows(apps.bo), [['priya', 'prep', 1]]);
  // Sam takes Bo on as his candidate. The job is still Priya's, and so is Bo's prep.
  ok(await olive.patch(`/applications/${apps.bo}`, { owner_id: ids.sam }));
  await lists(sam);
  assert.deepEqual(openRows(apps.bo), [['priya', 'prep', 1]]);
  await clock(at(83, 2 * HOUR));
  assert.deepEqual((await people(priya)).debrief.filter((n) => n === 'Bo Samehands'), ['Bo Samehands']);
  assert.deepEqual(openRows(apps.bo), [['priya', 'debrief', 1]]);
  assert.equal(rows('SELECT COUNT(*) AS n FROM todos WHERE application_id = ?', apps.bo)[0].n, 2);   // her prep, ticked, and her debrief
});

test('a job with no account executive falls back to the recruiter who owns the candidate, then to whoever scheduled the interview', async () => {
  // Olive's job to begin with: she has both to prep.
  await aeJob('qa', 'QA Engineer', ids.olive);
  apps.cal = await candidate(priya, 'qa', 'Cal Owned', 'Hiring manager interview');
  apps.dot = await candidate(priya, 'qa', 'Dot Unowned', 'Hiring manager interview');
  ok(await priya.patch(`/applications/${apps.dot}`, { owner_id: null }));
  await schedule(sam, apps.cal, at(85));
  await schedule(sam, apps.dot, at(85));
  assert.deepEqual([openRows(apps.cal), openRows(apps.dot)], [[['olive', 'prep', 1]], [['olive', 'prep', 1]]]);
  // With no account executive (the state an older workspace can be in), Cal goes to Priya, who owns him, and Dot,
  // whom nobody owns, to Sam, who booked her in.
  write('UPDATE jobs SET account_executive_id = NULL WHERE id = ?', jobs.qa);
  await menuCount(olive);
  assert.deepEqual([openRows(apps.cal), openRows(apps.dot)], [[['priya', 'prep', 1]], [['sam', 'prep', 1]]]);
});

test('an account executive who is deactivated, or comes back as one of a client\'s users, no longer has the prep: it goes to the recruiter at once', async () => {
  let rob = await join('recruiter', 'Rob Leaving', 'rob@agency.example');
  ids.rob = await idOf(rob);
  await aeJob('data', 'Data Engineer', ids.rob);
  apps.eve = await candidate(priya, 'data', 'Eve Handed', 'Hiring manager interview');
  await schedule(priya, apps.eve, at(86));
  const robs = await itemOf(rob, 'prep', 'Eve Handed');
  ok(await rob.patch(`/todos/${robs.id}`, { note: 'Ask about her notice' }));
  // Deactivated: Priya, who owns Eve, has her to prep, straight away.
  ok(await olive.patch(`/users/${ids.rob}`, { active: false }));
  assert.deepEqual(openRows(apps.eve), [['priya', 'prep', 1]]);
  // Invited back to the team, Rob has her again: the same item, with his note.
  rob = await join('recruiter', 'Rob Leaving', 'rob@agency.example');
  assert.deepEqual(openRows(apps.eve), [['rob', 'prep', 1]]);
  assert.deepEqual([(await itemOf(rob, 'prep', 'Eve Handed')).id, (await itemOf(rob, 'prep', 'Eve Handed')).note], [robs.id, 'Ask about her notice']);
  // Deactivated again and invited back as one of Lumen's hiring team, he is nobody's account executive: the job has
  // none now, and Eve stays with Priya.
  ok(await olive.patch(`/users/${ids.rob}`, { active: false }));
  await join('client', 'Rob Leaving', 'rob@agency.example', { client_id: lumen });
  assert.equal(rows('SELECT account_executive_id FROM jobs WHERE id = ?', jobs.data)[0].account_executive_id, null);
  assert.deepEqual(openRows(apps.eve), [['priya', 'prep', 1]]);
  await lists(priya);
  assert.deepEqual(openRows(apps.eve), [['priya', 'prep', 1]]);
});

test('handing a job on moves its open prep and debrief items at once, however old the debrief; hand-added and ticked items stay, and handing it back brings the first person\'s back', async () => {
  await clock(at(90));
  await aeJob('mobile', 'Mobile Engineer', ids.sam);
  const cast2 = { fay: 'Fay Debriefed', gil: 'Gil Coming', hana: 'Hana Ticked', ian: 'Ian Removed', jay: 'Jay Byhand' };
  for (const [key, name] of Object.entries(cast2)) apps[key] = await candidate(priya, 'mobile', name, 'Hiring manager interview');
  // Fay's interview was on day 90, and Sam never got round to her debrief.
  await schedule(priya, apps.fay, at(90, HOUR));
  await clock(at(90, 3 * HOUR));
  const fay = await itemOf(sam, 'debrief', 'Fay Debriefed');
  ok(await sam.patch(`/todos/${fay.id}`, { note: 'Call Fay back' }));
  // Eleven days later, three more are booked in. Sam prepares Hana and takes Ian off his list; Jay he added himself.
  await clock(at(101));
  await schedule(priya, apps.gil, at(103));
  await schedule(priya, apps.hana, at(103));
  await schedule(priya, apps.ian, at(104));
  await addPerson(sam, 'prep', apps.jay, { note: 'My own' });
  const gil = await itemOf(sam, 'prep', 'Gil Coming');
  ok(await sam.patch(`/todos/${gil.id}`, { note: 'Send Gil the brief' }));
  await tick(sam, (await itemOf(sam, 'prep', 'Hana Ticked')).id);
  await remove(sam, (await itemOf(sam, 'prep', 'Ian Removed')).id);
  assert.ok(await itemOf(sam, 'debrief', 'Fay Debriefed'));                 // still waiting, eleven days on

  // The job goes to Priya. Before anybody opens a list, the database already says so.
  await handOver('mobile', 'Mobile Engineer', ids.priya);
  assert.deepEqual(openRows(apps.fay), [['priya', 'debrief', 1]]);
  assert.deepEqual(openRows(apps.gil), [['priya', 'prep', 1]]);
  assert.deepEqual(openRows(apps.hana), [['priya', 'prep', 1]]);          // hers to prepare now; Sam's tick stays his
  assert.deepEqual(openRows(apps.ian), [['priya', 'prep', 1]]);
  assert.deepEqual(openRows(apps.jay), [['sam', 'prep', 0]]);             // added by hand: stays where it is
  const samsRows = (appId) => rows('SELECT id, kind, note, done_at IS NOT NULL AS done, auto_done, removed_at IS NOT NULL AS removed, set_aside FROM todos WHERE application_id = ? AND user_id = ?', appId, ids.sam).map((r) => ({ ...r }));
  assert.deepEqual(samsRows(apps.fay).filter((r) => r.kind === 'debrief'), [{ id: fay.id, kind: 'debrief', note: 'Call Fay back', done: 0, auto_done: 0, removed: 1, set_aside: 1 }]);
  assert.deepEqual(samsRows(apps.hana).map((r) => [r.done, r.auto_done, r.removed]), [[1, 0, 0]]);
  // The count in the menu agrees, and the lists show it.
  const priyas = await lists(priya);
  assert.equal(await menuCount(priya), priyas.counts.total);
  for (const name of ['Gil Coming', 'Hana Ticked', 'Ian Removed']) assert.ok(titles(priyas.prep).includes(name), name);
  assert.ok(titles(priyas.debrief).includes('Fay Debriefed'));
  assert.ok(!titles((await lists(sam)).debrief).includes('Fay Debriefed'));

  // Handed back to Sam: his Fay and Gil come back as they were, notes and all. Hana he prepared and Ian he took off:
  // neither is put back on his list for that interview. Priya's are set aside.
  await handOver('mobile', 'Mobile Engineer', ids.sam);
  for (let n = 0; n < 2; n++) {                                           // and the same once anybody has looked
    assert.deepEqual([openRows(apps.fay), openRows(apps.gil), openRows(apps.hana), openRows(apps.ian), openRows(apps.jay)],
      [[['sam', 'debrief', 1]], [['sam', 'prep', 1]], [], [], [['sam', 'prep', 0]]]);
    await lists(sam); await lists(priya);
  }
  assert.deepEqual([(await itemOf(sam, 'debrief', 'Fay Debriefed')).id, (await itemOf(sam, 'debrief', 'Fay Debriefed')).note], [fay.id, 'Call Fay back']);
  assert.deepEqual([(await itemOf(sam, 'prep', 'Gil Coming')).id, (await itemOf(sam, 'prep', 'Gil Coming')).note], [gil.id, 'Send Gil the brief']);
});

test('a job whose account executive changed without the job form (straight in the database) is put right the next time anybody looks', async () => {
  write('UPDATE jobs SET account_executive_id = ? WHERE id = ?', ids.priya, jobs.mobile);
  assert.deepEqual(openRows(apps.gil), [['sam', 'prep', 1]]);             // nobody has looked yet
  await menuCount(olive);
  assert.deepEqual(openRows(apps.gil), [['priya', 'prep', 1]]);
  await handOver('mobile', 'Mobile Engineer', ids.sam);
  assert.deepEqual(openRows(apps.gil), [['sam', 'prep', 1]]);
});

// ---------- starting on a live database ----------

test('starting on a database from before To do adds the table and leaves every existing row as it was; starting again changes nothing', async () => {
  const dir = tempDir('todos-upgrade');
  let api = await startApi({ port: UPGRADE_PORT, dataDir: dir });
  try {
    // A small workspace with a job, a candidate and an interview coming up.
    const owner = session(api.base);
    ok(await owner.post('/setup', { agencyName: 'Harbour Talent', name: 'Olive Admin', email: 'olive@agency.example', password: 'demo1234' }));
    const client = ok(await owner.post('/clients', { name: 'Lumen' })).id;
    const job = ok(await owner.post('/jobs', { client_id: client, title: 'Backend Engineer', status: 'open' })).id;
    const app = ok(await owner.upload('/applications', { job_id: job, name: 'Ana Reyes', email: 'ana@mail.example' })).id;
    ok(await owner.post('/interviews', { application_id: app, title: 'First meeting', starts_at: new Date(Date.now() + 2 * DAY).toISOString() }));
    await api.stop();

    // Make it the database an earlier version left: no to-do table, and no note of when To do first ran.
    const file = path.join(dir, 'app.db');
    let db = new DatabaseSync(file);
    db.exec(`DROP TABLE todos; DELETE FROM settings WHERE key LIKE 'todos_%';`);
    const dump = () => Object.fromEntries(['settings', 'clients', 'users', 'jobs', 'stages', 'candidates', 'applications', 'stage_history', 'activities', 'notes', 'interviews', 'interview_panel', 'report_events']
      .map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()]));
    const old = dump();
    db.close();

    api = await startApi({ port: UPGRADE_PORT, dataDir: dir });
    await api.stop();
    db = new DatabaseSync(file);
    const since = db.prepare(`SELECT value FROM settings WHERE key = 'todos_since'`).get().value;
    assert.ok(Math.abs(Date.now() - new Date(since)) < 60000);
    const settled = dump();
    assert.deepEqual({ ...settled, settings: settled.settings.filter((s) => !s.key.startsWith('todos_')) }, old);   // one setting added; nothing else touched
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM todos').get().n, 0);                                     // nothing is put on a list just by starting
    const shape = () => db.prepare(`SELECT name, sql FROM sqlite_master WHERE tbl_name = 'todos' ORDER BY name`).all();
    const made = shape();
    assert.deepEqual(made.map((x) => x.name), ['idx_todos_application', 'idx_todos_interview', 'idx_todos_job', 'idx_todos_job_once', 'idx_todos_list', 'idx_todos_person_once', 'todos']);
    db.close();

    // The first look at the list fills it from the interview that is coming up. Starting again changes nothing.
    api = await startApi({ port: UPGRADE_PORT, dataDir: dir });
    const again = session(api.base);
    ok(await again.post('/login', { email: 'olive@agency.example', password: 'demo1234' }));
    const first = ok(await again.get('/todos'));
    assert.deepEqual(first.prep.open.map((x) => [x.name, x.auto]), [['Ana Reyes', true]]);
    await api.stop();
    api = await startApi({ port: UPGRADE_PORT, dataDir: dir });
    const third = session(api.base);
    ok(await third.post('/login', { email: 'olive@agency.example', password: 'demo1234' }));
    assert.deepEqual(ok(await third.get('/todos')), first);
    await api.stop();
    db = new DatabaseSync(file);
    assert.deepEqual(shape(), made);
    assert.equal(db.prepare(`SELECT value FROM settings WHERE key = 'todos_since'`).get().value, since);        // noted once, not again
    const final = dump();
    assert.deepEqual({ ...final, settings: final.settings.filter((s) => !s.key.startsWith('todos_')) }, old);
    db.close();
  } finally {
    await api.stop().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('going live: prep and debrief items The Book had put on a recruiter\'s list move to the job\'s account executive at the first start, the recruiter\'s set aside with their notes; starting again changes nothing', async () => {
  const dir = tempDir('todos-account-executive');
  let api = await startApi({ port: UPGRADE_PORT, dataDir: dir });
  try {
    // Olive's job (she made it, so she is its account executive), and five of Priya's candidates on it.
    const admin = session(api.base);
    ok(await admin.post('/setup', { agencyName: 'Harbour Talent', name: 'Olive Admin', email: 'olive@agency.example', password: 'demo1234' }));
    const client = ok(await admin.post('/clients', { name: 'Lumen' })).id;
    const { token } = ok(await admin.post('/invites', { role: 'recruiter', email: 'priya@agency.example' }));
    const recruiter = session(api.base);
    ok(await recruiter.post(`/invites/${token}/accept`, { name: 'Priya Nair', password: 'demo1234' }));
    const job = ok(await admin.post('/jobs', { client_id: client, title: 'Backend Engineer', status: 'open' })).id;
    const now = Date.now();
    const app = {}, interview = {};
    for (const [key, name, startsIn] of [['ana', 'Ana Coming', DAY], ['ben', 'Ben Longago', -10 * DAY], ['cy', 'Cy Lastweek', -2 * DAY], ['dee', 'Dee Ticked', DAY], ['eli', 'Eli Byhand', 2 * DAY]]) {
      app[key] = ok(await recruiter.upload('/applications', { job_id: job, name, email: `${key}@mail.example` })).id;
      interview[key] = ok(await recruiter.post('/interviews', { application_id: app[key], title: 'First meeting', starts_at: new Date(now + startsIn).toISOString(), duration_min: 60 })).id;
    }
    await api.stop();

    // Make it what the version before this one left: To do in use for a month, looked at a moment ago, and every
    // item on Priya's list, as the recruiter who owns them. Ana to prep, with a note; Ben to debrief after an
    // interview ten days ago, never done, with a note; Cy's prep ticked by The Book and Cy to debrief; Dee's prep
    // ticked by Priya herself; Eli put on by hand.
    const file = path.join(dir, 'app.db');
    let db = new DatabaseSync(file);
    const iso = (ms) => new Date(ms).toISOString();
    const priya = db.prepare(`SELECT id FROM users WHERE email = 'priya@agency.example'`).get().id;
    db.exec(`DELETE FROM todos; DELETE FROM settings WHERE key = 'todos_account_executive_moved'`);
    db.prepare(`UPDATE settings SET value = ? WHERE key = 'todos_since'`).run(iso(now - 30 * DAY));
    db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('todos_seen', ?)`).run(iso(now - MINUTE));
    const put = db.prepare('INSERT INTO todos (user_id, kind, application_id, interview_id, note, position, auto, auto_done, done_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const made = iso(now - 12 * DAY);
    put.run(priya, 'prep', app.ana, interview.ana, 'Send Ana the brief', 0, 1, 0, null, made);
    put.run(priya, 'debrief', app.ben, interview.ben, 'Call Ben back', 0, 1, 0, null, made);
    put.run(priya, 'prep', app.cy, interview.cy, null, 0, 1, 1, iso(now - 2 * DAY + HOUR), made);
    put.run(priya, 'debrief', app.cy, interview.cy, null, 1, 1, 0, null, made);
    put.run(priya, 'prep', app.dee, interview.dee, null, 0, 1, 0, iso(now - HOUR), made);
    put.run(priya, 'prep', app.eli, interview.eli, 'My own', 1, 0, 0, null, made);
    db.close();

    const everything = () => {
      const read = new DatabaseSync(file, { readOnly: true });
      try {
        return read.prepare(`SELECT u.email, t.kind, t.application_id, t.note, t.auto, t.auto_done, t.done_at IS NOT NULL AS done, t.removed_at IS NOT NULL AS removed, t.set_aside
          FROM todos t JOIN users u ON u.id = t.user_id ORDER BY t.application_id, t.kind, u.email`).all()
          .map((r) => [r.email.split('@')[0], r.kind, Object.keys(app).find((k) => app[k] === r.application_id), r.note, `auto ${r.auto}`,
            r.done ? (r.auto_done ? 'ticked by The Book' : 'ticked') : r.removed ? (r.set_aside ? 'set aside' : 'taken off') : 'open']);
      } finally { read.close(); }
    };
    const expected = [
      ['olive', 'prep', 'ana', null, 'auto 1', 'open'],
      ['priya', 'prep', 'ana', 'Send Ana the brief', 'auto 1', 'set aside'],
      ['olive', 'debrief', 'ben', null, 'auto 1', 'open'],                    // ten days old, and still moved: it was never done
      ['priya', 'debrief', 'ben', 'Call Ben back', 'auto 1', 'set aside'],
      ['olive', 'debrief', 'cy', null, 'auto 1', 'open'],
      ['priya', 'debrief', 'cy', null, 'auto 1', 'set aside'],
      ['priya', 'prep', 'cy', null, 'auto 1', 'ticked by The Book'],
      ['olive', 'prep', 'dee', null, 'auto 1', 'open'],                       // hers to do now; Priya's tick stays hers
      ['priya', 'prep', 'dee', null, 'auto 1', 'ticked'],
      ['olive', 'prep', 'eli', null, 'auto 1', 'open'],                       // her interview is within the week: Olive's to prep
      ['priya', 'prep', 'eli', 'My own', 'auto 0', 'open'],                   // added by hand: where it was
    ];

    // The new version starts. Before anybody opens a list, the open items The Book added are where they belong.
    // Dee and Eli had none open (one ticked, one added by hand), so nothing moved for them: Olive's own prep for
    // each comes with the first look, as any prep that is due does.
    api = await startApi({ port: UPGRADE_PORT, dataDir: dir });
    assert.deepEqual(everything(), expected.filter(([who, , key]) => !(who === 'olive' && ['dee', 'eli'].includes(key))));
    const olive2 = session(api.base);
    ok(await olive2.post('/login', { email: 'olive@agency.example', password: 'demo1234' }));
    const first = ok(await olive2.get('/todos'));
    assert.deepEqual([titles(first.prep).sort(), titles(first.debrief).sort()], [['Ana Coming', 'Dee Ticked', 'Eli Byhand'], ['Ben Longago', 'Cy Lastweek']]);
    assert.deepEqual(everything(), expected);                                 // and looking at the lists leaves Ben's debrief with Olive
    await api.stop();
    db = new DatabaseSync(file, { readOnly: true });
    const done = db.prepare(`SELECT value FROM settings WHERE key = 'todos_account_executive_moved'`).get().value;
    db.close();

    // Started again, nothing changes: not the items, not the note that it was done.
    api = await startApi({ port: UPGRADE_PORT, dataDir: dir });
    assert.deepEqual(everything(), expected);
    const again = session(api.base);
    ok(await again.post('/login', { email: 'olive@agency.example', password: 'demo1234' }));
    assert.deepEqual(ok(await again.get('/todos')), first);
    await api.stop();
    db = new DatabaseSync(file, { readOnly: true });
    assert.equal(db.prepare(`SELECT value FROM settings WHERE key = 'todos_account_executive_moved'`).get().value, done);
    db.close();
  } finally {
    await api.stop().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
