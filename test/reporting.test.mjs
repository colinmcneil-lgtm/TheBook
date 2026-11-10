// Reporting, end to end: the Individual and Clients reports, the moments they are built from, and the day counting
// starts. Run with `npm test`.
//
// One long story is acted out against The Book's real API on a throwaway data folder, through the same routes the
// screens, the board and the browser extension use, and every number on both reports is checked along the way. The
// reports count nothing before a start date and have a "last 12 months", so the story has to happen over more than a
// year: the API is started with one extra route (see reporting-server.mjs) that tells the reporting module what time
// it is. Everything else in the server keeps the real clock.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { session, sleep, tempDir, PORTS } from './oracle-helpers.mjs';
import { putJson } from './phone-helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Two ports the other test files leave free: the ones after the workspace tests' (see workspace.test.mjs).
const PORT = PORTS.main + 13, UPGRADE_PORT = PORTS.main + 14;

async function startApi({ port, dataDir }) {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'test/reporting-server.mjs'], {
    // TZ is passed on, so that running the tests with TZ set shows the start day does not depend on where the server is.
    cwd: ROOT, env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test', PORT: String(port), DATA_DIR: dataDir, ...(process.env.TZ ? { TZ: process.env.TZ } : {}) }, stdio: ['ignore', 'pipe', 'pipe'],
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

// Counting starts on Monday 16 November 2026 at midnight in Toronto, which is 05:00 UTC (Toronto is on winter time).
const START = '2026-11-16T05:00:00.000Z';
/** Noon in Toronto on the nth day after the start: day(1) is Tuesday 17 November 2026. */
const day = (n) => new Date(Date.UTC(2026, 10, 16 + n, 17)).toISOString();
const DAY = 86400000;

let server, dataDir;
let olive, priya, sam, nia, maya, carl;         // the admin, three recruiters, and a hiring manager at Lumen and at Finch
let lumen, kestrel, finch, dormant;             // clients
const jobs = {}, apps = {};                     // job ids and application ids, by a short name

/** Tell the reporting module what time it is. */
async function clock(iso) {
  const res = await fetch(`${server.base}/test/clock`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ now: iso }) });
  assert.equal(res.status, 200);
}
const ok = (res) => { assert.equal(res.status, 200, JSON.stringify(res.body)); return res.body; };
const put = async (who, pathname, json) => ok(await putJson(who, server.base, pathname, json));
const stagesOf = async (jobId, who = olive) => Object.fromEntries(ok(await who.get(`/jobs/${jobId}`)).stages.map((s) => [s.name, s.id]));
const openJob = async (clientId, title, extra = {}) => ok(await olive.post('/jobs', { client_id: clientId, title, status: 'open', ...extra })).id;
/** Add someone to a job the way the forms and the browser extension do: a form with fields, optionally straight into a stage. */
const add = async (who, jobId, name, stageId) =>
  ok(await who.upload('/applications', { job_id: jobId, name, email: `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@mail.example`, stage_id: stageId })).id;
const submit = async (who, appId) => ok(await who.post(`/applications/${appId}/submit`, { note: 'Strong on the brief and realistic on salary. Worth meeting.' }));
const move = async (who, appId, stageId) => ok(await who.post(`/applications/${appId}/move`, { stage_id: stageId }));
const schedule = async (who, appId) => ok(await who.post('/interviews', { application_id: appId, title: 'First meeting', starts_at: new Date(Date.now() + 3 * DAY).toISOString() }));
const offer = async (who, appId, salary, status) => put(who, `/applications/${appId}/offer`, { salary, status });

const individual = async (who = olive, query = '') => ok(await who.get(`/reports/individual${query}`));
/** One recruiter's line of the Individual report: [submissions, interviews, ratio, placements]. */
const line = (report, name) => { const r = name ? report.rows.find((x) => x.name === name) : report.totals; return r ? [r.submissions, r.interviews, r.ratio, r.placements] : undefined; };
const clients = async (query = '', who = olive) => ok(await who.get(`/reports/clients${query}`));
const clientRow = (report, name) => report.rows.find((r) => r.name === name);
const names = (report) => report.rows.map((r) => r.name);
const NOTHING = { reqs: 0, reqs_12m: 0, submissions: 0, interviews: 0, interview_pct: null, reqs_filled: 0, placement_pct: null, placements: 0, fills: 0, time_to_fill: null, billings: [], billings_12m: [], avg_fee: [] };
/** A client's row without the parts that only say who the client is. */
const figures = (report, name) => { const { id, name: _, brand_color, currency, status, ...rest } = clientRow(report, name); return rest; };

before(async () => {
  dataDir = tempDir('reporting');
  server = await startApi({ port: PORT, dataDir });
  await clock('2026-11-10T15:00:00.000Z'); // the Tuesday before counting starts
  olive = session(server.base);
  ok(await olive.post('/setup', { agencyName: 'Harbour Talent', name: 'Olive Admin', email: 'olive@agency.example', password: 'demo1234' }));
  const client = async (fields) => ok(await olive.post('/clients', fields)).id;
  lumen = await client({ name: 'Lumen', engagement_model: 'per_hire', fee_percent: 20, currency: 'CAD' });
  kestrel = await client({ name: 'Kestrel', engagement_model: 'hybrid', monthly_retainer: 3000, fee_percent: 15, currency: 'USD' });
  finch = await client({ name: 'Finch', engagement_model: 'retainer', monthly_retainer: 5000, currency: 'CAD' });
  dormant = await client({ name: 'Dormant', engagement_model: 'per_hire', fee_percent: 20, currency: 'CAD' });
  const join = async (role, name, email, extra = {}) => {
    const { token } = ok(await olive.post('/invites', { role, email, ...extra }));
    const person = session(server.base);
    ok(await person.post(`/invites/${token}/accept`, { name, password: 'demo1234' }));
    return person;
  };
  priya = await join('recruiter', 'Priya Nair', 'priya@agency.example');
  sam = await join('recruiter', 'Sam Ode', 'sam@agency.example');
  nia = await join('recruiter', 'Nia New', 'nia@agency.example');
  maya = await join('client', 'Maya Okonkwo', 'maya@lumen.example', { client_id: lumen });
  carl = await join('client', 'Carl Finch', 'carl@finch.example', { client_id: finch });
});

after(async () => {
  await server?.stop();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

// ---------- before the start ----------

test('before the start date nothing is recorded, and both reports say when counting begins', async () => {
  assert.deepEqual(ok(await olive.get('/reports/start')), { date: '2026-11-16', time_zone: 'America/Toronto', at: START, started: false });

  // A whole search happens the week before: opened, a candidate submitted, interviewed, offered and hired.
  jobs.old = await openJob(lumen, 'Old search');
  jobs.planned = ok(await olive.post('/jobs', { client_id: lumen, title: 'Planned search', status: 'draft' })).id;
  const old = await stagesOf(jobs.old);
  apps.pat = await add(olive, jobs.old, 'Pat Early');
  await submit(olive, apps.pat);
  await move(olive, apps.pat, old['Hiring manager interview']);
  await schedule(olive, apps.pat);
  await offer(olive, apps.pat, 90000, 'accepted');
  await move(olive, apps.pat, old.Hired);
  // And one candidate is submitted but goes no further yet.
  apps.quinn = await add(priya, jobs.old, 'Quinn Early');
  await submit(priya, apps.quinn);

  const people = await individual();
  assert.equal(people.start.started, false);
  assert.deepEqual(people.rows, []);
  assert.deepEqual(line(people), [0, 0, null, 0]);
  const companies = await clients();
  assert.equal(companies.start.started, false);
  assert.deepEqual(names(companies), ['Dormant', 'Finch', 'Kestrel', 'Lumen']);
  for (const name of names(companies)) assert.deepEqual(figures(companies, name), NOTHING);
  assert.equal(ok(await olive.get(`/applications/${apps.pat}`)).placement, null); // hired, but before counting: nothing to correct

  // One millisecond before midnight in Toronto is still before the start.
  await clock('2026-11-16T04:59:59.999Z');
  apps.rae = await add(priya, jobs.old, 'Rae Edge');
  await submit(priya, apps.rae);
  assert.equal((await individual()).start.started, false);

  // Midnight itself counts.
  await clock(START);
  apps.sol = await add(priya, jobs.old, 'Sol Edge');
  await submit(priya, apps.sol);
  const first = await individual();
  assert.equal(first.start.started, true);
  assert.deepEqual(first.rows.map((r) => r.name), ['Priya Nair']);
  assert.deepEqual(line(first, 'Priya Nair'), [1, 0, 0, 0]);
  assert.deepEqual(line(first), [1, 0, 0, 0]);
});

test('what happened before the start is not made up for by doing it again afterwards', async () => {
  await clock(day(1));
  const old = await stagesOf(jobs.old);
  // Quinn was first submitted last week. Sending them again, booking an interview and moving them on count for nothing.
  await submit(priya, apps.quinn);
  await schedule(priya, apps.quinn);
  await move(priya, apps.quinn, old['Hiring manager interview']);
  // Pat was hired last week. Rejecting and returning them does not turn that into a placement.
  ok(await olive.post(`/applications/${apps.pat}/reject`, { reason: 'Clicked by mistake' }));
  ok(await olive.post(`/applications/${apps.pat}/restore`));
  assert.equal(ok(await olive.get(`/applications/${apps.pat}`)).application.status, 'hired');
  assert.equal(ok(await olive.get(`/applications/${apps.pat}`)).placement, null);

  assert.deepEqual(line(await individual()), [1, 0, 0, 0]);
  // The submission made at midnight counts for Lumen although its search was opened too early to count as a req.
  assert.deepEqual(figures(await clients(), 'Lumen'), { ...NOTHING, submissions: 1, interview_pct: 0 });
});

// ---------- searches ----------

test('a search counts from the first time its job becomes open, however that happens', async () => {
  await clock(day(1));
  jobs.backend = await openJob(lumen, 'Backend Engineer');                    // created open, one opening
  jobs.designer = await openJob(lumen, 'Designer', { openings: 2 });          // two openings
  ok(await olive.patch(`/jobs/${jobs.planned}/status`, { status: 'open' }));  // a draft from last week, opened now: counts from now
  jobs.sales = ok(await olive.post('/jobs', { client_id: kestrel, title: 'Head of Sales', status: 'draft' })).id;
  await put(olive, `/jobs/${jobs.sales}`, { title: 'Head of Sales', status: 'open' }); // opened from the job form
  jobs.ops = await openJob(finch, 'Ops Lead', { interview_stages: [{ name: 'Recruiter screen' }, { name: 'Hiring manager interview', with_client: false }, { name: 'Final interview' }] });
  jobs.coordinator = await openJob(finch, 'Coordinator');
  // Pausing and reopening is not a second kickoff, and reopening last week's search does not make it count.
  for (const id of [jobs.backend, jobs.old]) {
    ok(await olive.patch(`/jobs/${id}/status`, { status: 'paused' }));
    ok(await olive.patch(`/jobs/${id}/status`, { status: 'open' }));
  }
  await put(olive, `/jobs/${jobs.designer}`, { title: 'Designer', status: 'open', openings: 2 }); // saved again while open

  const report = await clients();
  assert.deepEqual(names(report).map((n) => [n, clientRow(report, n).reqs, clientRow(report, n).reqs_12m]), [['Lumen', 3, 3], ['Finch', 2, 2], ['Kestrel', 1, 1], ['Dormant', 0, 0]]);
  assert.equal(clientRow(report, 'Lumen').placement_pct, 0); // three opened, none filled
  assert.equal(report.since_12m, START);                      // "last 12 months" never reaches back before the start
});

test('each interview stage says whether it is an interview with the client', async () => {
  const ticks = async (jobId, who = olive) => ok(await who.get(`/jobs/${jobId}`)).stages.filter((s) => s.kind === 'interview').map((s) => [s.name, s.with_client]);
  // On by default; off for a stage the agency holds itself, going by its name.
  assert.deepEqual(await ticks(jobs.backend), [['Recruiter screen', 0], ['Hiring manager interview', 1], ['Final interview', 1]]);
  // The form's tick wins over the name, either way.
  assert.deepEqual(await ticks(jobs.ops), [['Recruiter screen', 0], ['Hiring manager interview', 0], ['Final interview', 1]]);
  jobs.ticks = ok(await olive.post('/jobs', { client_id: dormant, title: 'Tick test', status: 'draft',
    interview_stages: [{ name: 'Agency chat' }, { name: 'Phone screening' }, { name: 'Team lunch' }, { name: 'Recruiter intro', with_client: true }] })).id;
  assert.deepEqual(await ticks(jobs.ticks), [['Agency chat', 0], ['Phone screening', 0], ['Team lunch', 1], ['Recruiter intro', 1]]);
  // Saving the job form: a renamed stage keeps its tick unless the form sends another, and a new stage goes by its name.
  const s = ok(await olive.get(`/jobs/${jobs.ticks}`)).stages.filter((x) => x.kind === 'interview');
  await put(olive, `/jobs/${jobs.ticks}`, { title: 'Tick test', status: 'draft', interview_stages: [
    { id: s[0].id, name: 'First chat' }, { id: s[2].id, name: 'Team lunch', with_client: false }, { id: s[3].id, name: 'Recruiter intro' }, { name: 'Screening call' }, { name: 'Panel' }] });
  assert.deepEqual(await ticks(jobs.ticks), [['First chat', 0], ['Team lunch', 0], ['Recruiter intro', 1], ['Screening call', 0], ['Panel', 1]]);
  // The tick is the agency's business: the client's hiring team is not sent it.
  for (const stage of ok(await maya.get(`/jobs/${jobs.backend}`)).stages) assert.equal('with_client' in stage, false);
});

// ---------- submissions and first interviews ----------

test('submissions are counted once, for whoever submitted the candidate first', async () => {
  const backend = await stagesOf(jobs.backend), designer = await stagesOf(jobs.designer), sales = await stagesOf(jobs.sales), ops = await stagesOf(jobs.ops);
  await clock(day(1));
  apps.ana = await add(priya, jobs.backend, 'Ana One');
  await move(priya, apps.ana, backend['Recruiter screen']); // the agency's own stage: not an interview with the client
  await submit(priya, apps.ana);
  apps.ben = await add(priya, jobs.backend, 'Ben Two');
  await submit(priya, apps.ben);
  assert.deepEqual(line(await individual(), 'Priya Nair'), [3, 0, 0, 0]);

  await clock(day(2));
  // The client approves Ana, which moves her to the next interview stage: her first interview with the client.
  ok(await maya.post(`/applications/${apps.ana}/review`, { decision: 'approved' }));
  // Cy is added by the browser extension's route straight into a stage with the client, and submitted while sitting
  // there: the interview counts from the submission.
  apps.cy = await add(priya, jobs.designer, 'Cy Three', designer['Hiring manager interview']);
  assert.deepEqual(line(await individual(), 'Priya Nair'), [3, 1, 33.3, 0]); // in the stage, but not submitted yet
  await submit(priya, apps.cy);
  // Di is interviewed without ever being submitted: not counted, because the ratio is interviews out of submissions.
  apps.di = await add(priya, jobs.designer, 'Di Four');
  await move(priya, apps.di, designer['Hiring manager interview']);
  await schedule(priya, apps.di);
  // Eli is submitted and then only reaches the recruiter's own screen.
  apps.eli = await add(priya, jobs.designer, 'Eli Five');
  await submit(priya, apps.eli);
  await move(priya, apps.eli, designer['Recruiter screen']);
  assert.deepEqual(line(await individual(), 'Priya Nair'), [5, 2, 40, 0]);

  await clock(day(3));
  // Submitting Ana again and booking her an interview add nothing: one submission and one first interview each.
  await submit(priya, apps.ana);
  await schedule(priya, apps.ana);
  // Ben is sent again by somebody else. The submission stays Priya's, and so will his first interview tomorrow.
  await submit(sam, apps.ben);
  apps.flo = await add(sam, jobs.sales, 'Flo Six');
  await submit(sam, apps.flo);
  apps.gus = await add(sam, jobs.sales, 'Gus Seven');
  await submit(sam, apps.gus);
  apps.hal = await add(sam, jobs.ops, 'Hal Eight');
  await submit(sam, apps.hal);
  await move(sam, apps.hal, ops['Hiring manager interview']); // on this job that stage is not ticked as being with the client
  assert.deepEqual(line(await individual(), 'Priya Nair'), [5, 2, 40, 0]);
  assert.deepEqual(line(await individual(), 'Sam Ode'), [3, 0, 0, 0]);

  await clock(day(4));
  await schedule(priya, apps.ben);                              // an interview booked in The Book, before any move
  await move(sam, apps.hal, ops['Final interview']);            // now a stage with the client
  await clock(day(5));
  // The board: several cards dropped at once. Ben's move comes after his interview was booked, so it adds nothing.
  await Promise.all([move(priya, apps.ben, backend['Hiring manager interview']), move(sam, apps.flo, sales['Final interview'])]);

  const report = await individual();
  assert.deepEqual(report.rows.map((r) => r.name), ['Priya Nair', 'Sam Ode']); // most submissions first; Olive and Nia have nothing recorded
  assert.deepEqual(line(report, 'Priya Nair'), [5, 3, 60, 0]);
  assert.deepEqual(line(report, 'Sam Ode'), [3, 2, 66.7, 0]);
  assert.deepEqual(line(report), [8, 5, 62.5, 0]);
  const companies = await clients();
  assert.deepEqual(['Lumen', 'Kestrel', 'Finch'].map((n) => { const r = clientRow(companies, n); return [r.submissions, r.interviews, r.interview_pct]; }), [[5, 3, 60], [2, 1, 50], [1, 1, 100]]);

  // Each moment was written down when it happened, once, with the candidate's name as it was then.
  const db = new DatabaseSync(path.join(dataDir, 'app.db'), { readOnly: true });
  const moments = db.prepare(`SELECT candidate_name AS name, kind, at FROM report_events WHERE application_id IS NOT NULL ORDER BY at, id`).all().map((e) => `${e.name}: ${e.kind} ${e.at}`);
  db.close();
  assert.deepEqual(moments, [
    `Sol Edge: submission ${START}`,
    `Ana One: submission ${day(1)}`, `Ben Two: submission ${day(1)}`,
    `Ana One: first_interview ${day(2)}`, `Cy Three: submission ${day(2)}`, `Cy Three: first_interview ${day(2)}`, `Eli Five: submission ${day(2)}`,
    `Flo Six: submission ${day(3)}`, `Gus Seven: submission ${day(3)}`, `Hal Eight: submission ${day(3)}`,
    `Ben Two: first_interview ${day(4)}`, `Hal Eight: first_interview ${day(4)}`,
    `Flo Six: first_interview ${day(5)}`,
  ]);
});

// ---------- placements ----------

test('a hire is a placement for whoever owns the candidate at that moment, with the fee as it stood', async () => {
  const backend = await stagesOf(jobs.backend), designer = await stagesOf(jobs.designer), sales = await stagesOf(jobs.sales), ops = await stagesOf(jobs.ops);
  const sam_id = ok(await sam.get('/me')).user.id, olive_id = ok(await olive.get('/me')).user.id;
  const placement = async (appId) => ok(await olive.get(`/applications/${appId}`)).placement;

  // Flo at Kestrel: the offer is accepted on day 8 and she is marked hired on day 9.
  await clock(day(8));
  await offer(sam, apps.flo, 200000, 'accepted');
  await clock(day(9));
  await move(sam, apps.flo, sales.Hired);
  assert.deepEqual(await placement(apps.flo), { at: day(9), fee: 30000, currency: 'USD', fee_edited: false, salary: 200000, fee_percent: 15, credited_to: 'Sam Ode' });
  assert.deepEqual(figures(await clients(), 'Kestrel'), {
    reqs: 1, reqs_12m: 1, submissions: 2, interviews: 1, interview_pct: 50, reqs_filled: 1, placement_pct: 100, placements: 1, fills: 1,
    time_to_fill: 7, // kickoff on day 1 to the accepted offer on day 8, not to the hire on day 9
    billings: [{ currency: 'USD', amount: 30000 }], billings_12m: [{ currency: 'USD', amount: 30000 }], avg_fee: [{ currency: 'USD', amount: 30000 }],
  });

  // Ana at Lumen: Priya submitted her, but Sam owns her by the time she is hired, so the placement is Sam's.
  await clock(day(10));
  await offer(priya, apps.ana, 100000, 'accepted');
  await clock(day(11));
  ok(await olive.patch(`/applications/${apps.ana}`, { owner_id: sam_id }));
  await clock(day(12));
  await move(olive, apps.ana, backend.Hired);
  assert.deepEqual(await placement(apps.ana), { at: day(12), fee: 20000, currency: 'CAD', fee_edited: false, salary: 100000, fee_percent: 20, credited_to: 'Sam Ode' });
  // Changing the owner after the fact moves no credit.
  ok(await olive.patch(`/applications/${apps.ana}`, { owner_id: olive_id }));
  assert.equal((await placement(apps.ana)).credited_to, 'Sam Ode');
  assert.deepEqual(line(await individual(), 'Sam Ode'), [3, 2, 66.7, 2]);
  assert.deepEqual(line(await individual(), 'Priya Nair'), [5, 3, 60, 0]); // her submission and interview for Ana stay hers

  // A hired candidate who is rejected stops counting; returned to the pipeline, the same placement counts again.
  await clock(day(13));
  ok(await sam.post(`/applications/${apps.flo}/reject`, { reason: 'Did not start' }));
  assert.equal(await placement(apps.flo), null);
  assert.deepEqual(figures(await clients(), 'Kestrel'), { ...NOTHING, reqs: 1, reqs_12m: 1, submissions: 2, interviews: 1, interview_pct: 50, placement_pct: 0 });
  await clock(day(14));
  ok(await sam.post(`/applications/${apps.flo}/restore`));
  assert.deepEqual(await placement(apps.flo), { at: day(9), fee: 30000, currency: 'USD', fee_edited: false, salary: 200000, fee_percent: 15, credited_to: 'Sam Ode' });
  // The same for a withdrawal.
  ok(await sam.post(`/applications/${apps.flo}/withdraw`, { reason: 'Changed their mind' }));
  assert.equal(clientRow(await clients(), 'Kestrel').placements, 0);
  ok(await sam.post(`/applications/${apps.flo}/restore`));
  assert.equal(clientRow(await clients(), 'Kestrel').placements, 1);

  // Hal at Finch, a retainer client: the offer was sent but never marked accepted, so the search is filled on the
  // day of the hire, and there is no fee to record.
  await clock(day(15));
  await offer(sam, apps.hal, 60000, 'sent');
  await move(sam, apps.hal, ops.Hired);
  assert.deepEqual(await placement(apps.hal), { at: day(15), fee: null, currency: 'CAD', fee_edited: false, salary: 60000, fee_percent: 0, credited_to: 'Sam Ode' });

  // Gus is marked hired and then moved back to Offer: the hire is undone and the placement is gone.
  await clock(day(16));
  await move(sam, apps.gus, sales.Hired);
  let kestrelNow = await clients();
  assert.equal(clientRow(kestrelNow, 'Kestrel').placements, 2);
  assert.deepEqual(kestrelNow.missing_fees, [{ application_id: apps.gus, candidate_name: 'Gus Seven', client_name: 'Kestrel' }]); // hired with no offer at a client that pays per hire
  assert.deepEqual(line(await individual(), 'Sam Ode'), [3, 2, 66.7, 4]);
  await clock(day(17));
  await move(sam, apps.gus, sales.Offer);
  kestrelNow = await clients();
  assert.equal(clientRow(kestrelNow, 'Kestrel').placements, 1);
  assert.deepEqual(kestrelNow.missing_fees, []);
  assert.equal(await placement(apps.gus), null);

  // Somebody applies on the careers page and the client's own hiring manager marks them hired. Nobody at the agency
  // owned or submitted them, so the placement is credited to nobody.
  await clock(day(18));
  const form = new FormData();
  for (const [k, v] of Object.entries({ name: 'Ivy Ten', email: 'ivy.ten@mail.example', consent: 'yes' })) form.append(k, v);
  const slug = ok(await olive.get(`/clients/${finch}`)).client.slug;
  assert.equal((await fetch(`${server.base}/api/public/careers/${slug}/jobs/${jobs.coordinator}/apply`, { method: 'POST', body: form })).status, 200);
  apps.ivy = ok(await olive.get(`/applications?job_id=${jobs.coordinator}`))[0].id;
  await move(carl, apps.ivy, (await stagesOf(jobs.coordinator)).Hired);
  assert.deepEqual(await placement(apps.ivy), { at: day(18), fee: null, currency: 'CAD', fee_edited: false, salary: null, fee_percent: 0, credited_to: null });

  // Cy at Lumen is hired with no offer on record: no fee can be worked out, and the Clients report says so.
  await clock(day(20));
  await move(priya, apps.cy, designer.Hired);
  let report = await clients();
  assert.deepEqual(report.missing_fees, [{ application_id: apps.cy, candidate_name: 'Cy Three', client_name: 'Lumen' }]);
  // The Designer search has two openings and one hire: not filled yet. Backend Engineer (one opening, Ana) is.
  assert.deepEqual([clientRow(report, 'Lumen').reqs_filled, clientRow(report, 'Lumen').placement_pct, clientRow(report, 'Lumen').placements], [1, 33.3, 2]);
  assert.deepEqual(clientRow(report, 'Lumen').billings, [{ currency: 'CAD', amount: 20000 }]);
  // The fee is entered by hand on the hired candidate.
  assert.deepEqual((await put(priya, `/applications/${apps.cy}/placement-fee`, { fee: 15000 })).placement, { at: day(20), fee: 15000, currency: 'CAD', fee_edited: true, salary: null, fee_percent: 20, credited_to: 'Priya Nair' });
  assert.equal((await putJson(priya, server.base, `/applications/${apps.cy}/placement-fee`, { fee: 'lots' })).status, 400);
  assert.equal((await putJson(priya, server.base, `/applications/${apps.cy}/placement-fee`, { fee: -5 })).status, 400);
  assert.equal((await putJson(priya, server.base, `/applications/${apps.di}/placement-fee`, { fee: 100 })).status, 404); // Di was never hired

  // Jo is added by the extension's route straight into Hired: the second opening is filled.
  await clock(day(21));
  apps.jo = await add(priya, jobs.designer, 'Jo Nine', designer.Hired);
  assert.deepEqual(await placement(apps.jo), { at: day(21), fee: null, currency: 'CAD', fee_edited: false, salary: null, fee_percent: 20, credited_to: 'Priya Nair' });
  // The offer is filled in the next day: the fee that could not be worked out at the hire is worked out now.
  await clock(day(22));
  await offer(priya, apps.jo, 50000, 'accepted');
  assert.deepEqual(await placement(apps.jo), { at: day(21), fee: 10000, currency: 'CAD', fee_edited: false, salary: 50000, fee_percent: 20, credited_to: 'Priya Nair' });

  // The client's terms are edited afterwards: nothing that was recorded changes.
  await clock(day(23));
  await put(olive, `/clients/${lumen}`, { name: 'Lumen', engagement_model: 'per_hire', fee_percent: 25, currency: 'CAD' });
  await offer(olive, apps.ana, 100000, 'accepted'); // saving the offer again does not rework a fee that was worked out at the hire
  assert.equal((await placement(apps.ana)).fee, 20000);
  // A fee corrected by hand, on a placement whose fee was worked out.
  await put(olive, `/applications/${apps.flo}/placement-fee`, { fee: 28000 });
  await offer(sam, apps.flo, 210000, 'accepted'); // nor does a later change to the offer touch a fee somebody entered
  assert.deepEqual(await placement(apps.flo), { at: day(9), fee: 28000, currency: 'USD', fee_edited: true, salary: 200000, fee_percent: 15, credited_to: 'Sam Ode' });
  await put(olive, `/applications/${apps.flo}/placement-fee`, { fee: 30000 });
});

test('the whole picture after five weeks: every number on both reports', async () => {
  await clock(day(25));
  const people = await individual();
  assert.deepEqual(people.rows.map((r) => [r.name, ...line(people, r.name)]), [
    ['Priya Nair', 5, 3, 60, 2],     // submitted Sol, Ana, Ben, Cy, Eli; interviews for Ana, Cy, Ben; placed Cy and Jo
    ['Sam Ode', 3, 2, 66.7, 3],      // submitted Flo, Gus, Hal; interviews for Hal, Flo; placed Flo, Ana (owned at the hire) and Hal
    ['No recruiter', 0, 0, null, 1], // Ivy, hired by the client with nobody at the agency owning her
  ]);
  assert.deepEqual(line(people), [8, 5, 62.5, 6]);
  assert.deepEqual([people.period, people.from, people.to], ['all', START, day(25)]);

  const report = await clients();
  assert.deepEqual(figures(report, 'Lumen'), {
    reqs: 3, reqs_12m: 3,                                  // Backend Engineer, Designer, Planned search; not the search opened the week before
    submissions: 5, interviews: 3, interview_pct: 60,
    reqs_filled: 2, placement_pct: 66.7,                   // Backend Engineer (1 of 1) and Designer (2 of 2); Planned search is unfilled
    placements: 3, fills: 3, time_to_fill: 16,             // Ana 9 days (offer accepted day 10), Cy 19 and Jo 20 (no accepted offer when hired)
    billings: [{ currency: 'CAD', amount: 45000 }], billings_12m: [{ currency: 'CAD', amount: 45000 }], avg_fee: [{ currency: 'CAD', amount: 15000 }],
  });
  assert.deepEqual(figures(report, 'Kestrel'), {
    reqs: 1, reqs_12m: 1, submissions: 2, interviews: 1, interview_pct: 50, reqs_filled: 1, placement_pct: 100, placements: 1, fills: 1, time_to_fill: 7,
    billings: [{ currency: 'USD', amount: 30000 }], billings_12m: [{ currency: 'USD', amount: 30000 }], avg_fee: [{ currency: 'USD', amount: 30000 }],
  });
  assert.deepEqual(figures(report, 'Finch'), {
    reqs: 2, reqs_12m: 2, submissions: 1, interviews: 1, interview_pct: 100, reqs_filled: 2, placement_pct: 100, placements: 2, fills: 2,
    time_to_fill: 15.5,                                    // Hal 14 days, Ivy 17
    billings: [], billings_12m: [], avg_fee: [],           // a retainer client: placements, but no placement fees
  });
  assert.deepEqual(figures(report, 'Dormant'), NOTHING);
  assert.equal(report.mixed_currencies, true);
  assert.deepEqual(report.missing_fees, []);
});

// ---------- sorting ----------

test('clients sort by any metric, high to low or low to high, with nothing-to-show last either way', async () => {
  const order = async (sort, dir) => { const r = await clients(`?sort=${sort}&dir=${dir}`); assert.deepEqual([r.sort, r.dir], [sort, dir]); return names(r); };
  assert.deepEqual(await order('reqs', 'desc'), ['Lumen', 'Finch', 'Kestrel', 'Dormant']);
  assert.deepEqual(await order('reqs', 'asc'), ['Kestrel', 'Finch', 'Lumen', 'Dormant']);
  assert.deepEqual(await order('reqs_12m', 'desc'), ['Lumen', 'Finch', 'Kestrel', 'Dormant']);
  assert.deepEqual(await order('interview_pct', 'desc'), ['Finch', 'Lumen', 'Kestrel', 'Dormant']);
  assert.deepEqual(await order('interview_pct', 'asc'), ['Kestrel', 'Lumen', 'Finch', 'Dormant']);
  assert.deepEqual(await order('placement_pct', 'desc'), ['Finch', 'Kestrel', 'Lumen', 'Dormant']); // a tie stays in name order
  assert.deepEqual(await order('placement_pct', 'asc'), ['Lumen', 'Finch', 'Kestrel', 'Dormant']);
  assert.deepEqual(await order('time_to_fill', 'desc'), ['Lumen', 'Finch', 'Kestrel', 'Dormant']);
  assert.deepEqual(await order('time_to_fill', 'asc'), ['Kestrel', 'Finch', 'Lumen', 'Dormant']);
  // Mixed currencies: the figures are compared as written (45,000 CAD against 30,000 USD), and the answer says so.
  assert.deepEqual(await order('billings', 'desc'), ['Lumen', 'Kestrel', 'Dormant', 'Finch']);
  assert.deepEqual(await order('billings', 'asc'), ['Kestrel', 'Lumen', 'Dormant', 'Finch']);
  assert.deepEqual(await order('billings_12m', 'asc'), ['Kestrel', 'Lumen', 'Dormant', 'Finch']);
  assert.deepEqual(await order('avg_fee', 'desc'), ['Kestrel', 'Lumen', 'Dormant', 'Finch']);
  assert.deepEqual(await order('avg_fee', 'asc'), ['Lumen', 'Kestrel', 'Dormant', 'Finch']);
  // With nothing asked for, or nonsense: total reqs, high to low.
  for (const query of ['', '?sort=fee_percent&dir=sideways']) {
    const r = await clients(query);
    assert.deepEqual([r.sort, r.dir, names(r)], ['reqs', 'desc', ['Lumen', 'Finch', 'Kestrel', 'Dormant']]);
  }
  // Scoped to one client, as the workspace's client switcher does.
  assert.deepEqual(names(await clients(`?client_id=${kestrel}`)), ['Kestrel']);
  assert.equal((await clients(`?client_id=${kestrel}`)).mixed_currencies, false);
});

test('recruiters sort by any column, and a ratio with no submissions behind it goes last either way', async () => {
  const order = async (sort, dir) => (await individual(olive, `?sort=${sort}&dir=${dir}`)).rows.map((r) => r.name);
  assert.deepEqual(await order('name', 'asc'), ['No recruiter', 'Priya Nair', 'Sam Ode']);
  assert.deepEqual(await order('name', 'desc'), ['Sam Ode', 'Priya Nair', 'No recruiter']);
  assert.deepEqual(await order('submissions', 'asc'), ['No recruiter', 'Sam Ode', 'Priya Nair']); // nought is a number: it sorts as one
  assert.deepEqual(await order('interviews', 'desc'), ['Priya Nair', 'Sam Ode', 'No recruiter']);
  assert.deepEqual(await order('placements', 'desc'), ['Sam Ode', 'Priya Nair', 'No recruiter']);
  assert.deepEqual(await order('placements', 'asc'), ['No recruiter', 'Priya Nair', 'Sam Ode']);
  assert.deepEqual(await order('ratio', 'desc'), ['Sam Ode', 'Priya Nair', 'No recruiter']);
  assert.deepEqual(await order('ratio', 'asc'), ['Priya Nair', 'Sam Ode', 'No recruiter']);        // no ratio at all: last both ways
  // Scoped to one client: only what happened there.
  const atLumen = await individual(olive, `?client_id=${lumen}`);
  assert.deepEqual(atLumen.rows.map((r) => [r.name, ...line(atLumen, r.name)]), [['Priya Nair', 5, 3, 60, 2], ['Sam Ode', 0, 0, null, 1]]);
});

// ---------- who may see what ----------

test('a recruiter sees only their own row, and only an admin can move the start date', async () => {
  for (const [who, name, numbers] of [[priya, 'Priya Nair', [5, 3, 60, 2]], [sam, 'Sam Ode', [3, 2, 66.7, 3]], [nia, 'Nia New', [0, 0, null, 0]]]) {
    const report = await individual(who);
    assert.deepEqual(report.rows.map((r) => r.name), [name]);
    assert.deepEqual(line(report, name), numbers);
    assert.equal(report.totals, null);
  }
  // The Clients report is for the whole agency team.
  assert.equal(clientRow(await clients('', priya), 'Lumen').reqs, 3);
  assert.equal(ok(await priya.get('/reports/start')).date, '2026-11-16');
  assert.equal((await putJson(priya, server.base, '/reports/start', { date: '2026-12-01' })).status, 403);
  assert.equal(ok(await priya.get('/reports/start')).date, '2026-11-16');
});

test('client users are refused all of it, and none of it reaches them through what they already see', async () => {
  for (const pathname of ['/reports/individual', '/reports/clients', '/reports/start', '/reports/individual?period=month', `/reports/clients?client_id=${lumen}`]) {
    const res = await maya.get(pathname);
    assert.equal(res.status, 403, pathname);
    assert.deepEqual(res.body, { error: 'Only the agency team can do this.' });
  }
  assert.equal((await putJson(maya, server.base, '/reports/start', { date: '2026-01-01' })).status, 403);
  assert.equal((await putJson(maya, server.base, `/applications/${apps.ana}/placement-fee`, { fee: 1 })).status, 403);
  assert.equal(ok(await olive.get(`/applications/${apps.ana}`)).placement.fee, 20000);
  // Ana's profile as her hiring manager sees it: no placement, no fee, no tick on the stages.
  const profile = ok(await maya.get(`/applications/${apps.ana}`));
  assert.equal('placement' in profile, false);
  assert.equal('fee_percent' in profile.client, false);
  assert.equal(JSON.stringify(profile).includes('with_client'), false);
  assert.deepEqual(Object.keys(profile.offer), ['id', 'application_id', 'salary', 'start_date', 'status', 'notes', 'created_at', 'updated_at']); // the offer as it always was
  assert.equal(JSON.stringify(profile).includes('20000'), false);
  // Moving a candidate answers with the stage, without the tick.
  const moved = ok(await maya.post(`/applications/${apps.ben}/move`, { stage_id: (await stagesOf(jobs.backend))['Final interview'] }));
  assert.equal('with_client' in moved.stage, false);
  assert.equal(moved.stage.name, 'Final interview');
});

test('the overview report that was already there answers as it did', async () => {
  const report = ok(await olive.get(`/reports?job_id=${jobs.backend}`));
  assert.deepEqual(Object.keys(report), ['totals', 'funnel', 'sources', 'weeks', 'openRoles', 'hires', 'revenue']);
  assert.deepEqual(report.totals, { applicants: 2, interviewed: 2, hires: 1, avg_days_to_hire: 0, offer_acceptance: 100 });
  assert.deepEqual(report.funnel, [{ label: 'Applied', count: 2 }, { label: 'Recruiter screen', count: 2 }, { label: 'Hiring manager interview', count: 2 },
    { label: 'Final interview', count: 2 }, { label: 'Offer', count: 1 }, { label: 'Hired', count: 1 }]);
  assert.deepEqual(report.sources, [{ source: 'agency_sourced', label: 'Agency sourced', applicants: 2, interviewed: 2, hired: 1 }]);
  assert.equal(report.weeks.length, 12);
  assert.equal(report.weeks.reduce((n, w) => n + w.count, 0), 2);
  assert.deepEqual(report.openRoles, [{ id: jobs.backend, title: 'Backend Engineer', client_name: 'Lumen', openings: 1, hires: 1, days_open: 0, new_applicants: 0, interviewing: 1, offers: 0 }]);
  // It still works the fee out from the client's terms as they are today (25% now), which is why the new reports keep their own record (20,000).
  const { applied_at, hired_at, ...hire } = report.hires[0];
  assert.deepEqual(hire, { id: apps.ana, name: 'Ana One', job_title: 'Backend Engineer', client_name: 'Lumen', currency: 'CAD', source: 'Agency sourced', days_to_hire: 0, fee: 25000, salary: 100000 });
  assert.equal(report.hires.length, 1);
  assert.deepEqual([...report.revenue].sort((a, b) => a.currency.localeCompare(b.currency)),
    [{ currency: 'CAD', monthly_retainers: 5000, placement_fees: 25000 }, { currency: 'USD', monthly_retainers: 3000, placement_fees: 0 }]);
  // And for the client's hiring team: the same, without the money.
  const theirs = ok(await maya.get(`/reports?job_id=${jobs.backend}`));
  assert.deepEqual(Object.keys(theirs), ['totals', 'funnel', 'sources', 'weeks', 'openRoles', 'hires']);
  assert.deepEqual(theirs.totals, report.totals);
  assert.deepEqual(Object.keys(theirs.hires[0]).sort(), ['applied_at', 'client_name', 'currency', 'days_to_hire', 'hired_at', 'id', 'job_title', 'name', 'source']);
});

// ---------- deleting and merging ----------

test('deleting a candidate or a job removes what was recorded for them; merging two records keeps it', async () => {
  await clock(day(26));
  // Delete a person: Eli (submitted, never interviewed).
  const eli = ok(await olive.get(`/applications/${apps.eli}`)).candidate.id;
  ok(await olive.del(`/candidates/${eli}`));
  assert.deepEqual(line(await individual(), 'Priya Nair'), [4, 3, 75, 2]);
  // Remove one application: Sol (submitted at midnight on the first day).
  ok(await olive.del(`/applications/${apps.sol}`));
  assert.deepEqual(line(await individual(), 'Priya Nair'), [3, 3, 100, 2]);
  assert.deepEqual([clientRow(await clients(), 'Lumen').submissions, clientRow(await clients(), 'Lumen').interview_pct], [3, 100]);

  // A search that runs its whole course and is then deleted: opened, a candidate submitted, interviewed and hired.
  jobs.temp = await openJob(lumen, 'Temp search');
  apps.kit = await add(sam, jobs.temp, 'Kit Temp');
  await submit(sam, apps.kit);
  await schedule(sam, apps.kit);
  await offer(sam, apps.kit, 40000, 'accepted');
  await clock(day(27));
  await move(sam, apps.kit, (await stagesOf(jobs.temp)).Hired);
  let lumenNow = clientRow(await clients(), 'Lumen');
  assert.deepEqual([lumenNow.reqs, lumenNow.reqs_filled, lumenNow.placements, lumenNow.billings], [4, 3, 4, [{ currency: 'CAD', amount: 55000 }]]); // 25% of 40,000, the terms as they are now
  assert.deepEqual(line(await individual(), 'Sam Ode'), [4, 3, 75, 4]);
  ok(await olive.del(`/jobs/${jobs.temp}`));
  lumenNow = clientRow(await clients(), 'Lumen');
  assert.deepEqual([lumenNow.reqs, lumenNow.reqs_filled, lumenNow.placements, lumenNow.billings], [3, 2, 3, [{ currency: 'CAD', amount: 45000 }]]);
  assert.deepEqual(line(await individual(), 'Sam Ode'), [3, 2, 66.7, 3]);

  // Ben turns out to be on file twice. His record with the submission and the interview is merged into the other one.
  const ben = ok(await olive.get(`/applications/${apps.ben}`)).candidate.id;
  const twin = await add(olive, jobs.designer, 'Benjamin Two');
  const kept = ok(await olive.get(`/applications/${twin}`)).candidate.id;
  ok(await olive.post(`/candidates/${ben}/merge`, { into: kept }));
  assert.equal(ok(await olive.get(`/applications/${apps.ben}`)).candidate.name, 'Benjamin Two');
  assert.deepEqual(line(await individual(), 'Priya Nair'), [3, 3, 100, 2]);
  // And the other way round: a record with nothing recorded is merged into one with a placement.
  const cy = ok(await olive.get(`/applications/${apps.cy}`)).candidate.id;
  const extra = await add(olive, jobs.planned, 'Cyrus Three');
  ok(await olive.post(`/candidates/${ok(await olive.get(`/applications/${extra}`)).candidate.id}/merge`, { into: cy }));
  assert.deepEqual(line(await individual(), 'Priya Nair'), [3, 3, 100, 2]);
  assert.deepEqual(clientRow(await clients(), 'Lumen').billings, [{ currency: 'CAD', amount: 45000 }]);
  assert.deepEqual(line(await individual()), [6, 5, 83.3, 6]);
});

// ---------- the start date ----------

test('an admin can move the start date: later hides what came before it, and moving it back shows it again', async () => {
  await clock(day(40));
  assert.equal((await putJson(olive, server.base, '/reports/start', { date: '16 November' })).status, 400);
  assert.equal((await putJson(olive, server.base, '/reports/start', { date: '2026-02-30' })).status, 400);
  assert.equal((await putJson(olive, server.base, '/reports/start', {})).status, 400);

  // A date that has not come yet: no numbers at all.
  assert.deepEqual(await put(olive, '/reports/start', { date: '2027-01-01' }), { date: '2027-01-01', time_zone: 'America/Toronto', at: '2027-01-01T05:00:00.000Z', started: false });
  assert.deepEqual((await individual()).rows, []);
  for (const name of ['Lumen', 'Kestrel', 'Finch', 'Dormant']) assert.deepEqual(figures(await clients(), name), NOTHING);
  assert.equal(ok(await olive.get(`/applications/${apps.ana}`)).placement, null);

  // 1 December 2026: only what happened from that day on. Every submission and every kickoff was in November.
  await put(olive, '/reports/start', { date: '2026-12-01' });
  const people = await individual();
  assert.deepEqual(people.rows.map((r) => [r.name, ...line(people, r.name)]), [['No recruiter', 0, 0, null, 1], ['Priya Nair', 0, 0, null, 2], ['Sam Ode', 0, 0, null, 1]]);
  assert.equal(people.from, '2026-12-01T05:00:00.000Z');
  // Lumen's two December placements are billed, but belong to no search that counts: no fill rate and no time to fill.
  assert.deepEqual(figures(await clients(), 'Lumen'), { ...NOTHING, placements: 2, billings: [{ currency: 'CAD', amount: 25000 }], billings_12m: [{ currency: 'CAD', amount: 25000 }], avg_fee: [{ currency: 'CAD', amount: 12500 }] });
  assert.equal(ok(await olive.get(`/applications/${apps.ana}`)).placement, null);       // hired on 28 November
  assert.equal(ok(await olive.get(`/applications/${apps.cy}`)).placement.fee, 15000);   // hired on 6 December

  // Back to the day counting really began: everything is as it was.
  await put(olive, '/reports/start', { date: '2026-11-16' });
  assert.deepEqual(line(await individual()), [6, 5, 83.3, 6]);
  assert.equal(clientRow(await clients(), 'Lumen').reqs, 3);
  // Earlier than that brings nothing back: the week before was never written down.
  await put(olive, '/reports/start', { date: '2026-11-01' });
  assert.deepEqual(line(await individual()), [6, 5, 83.3, 6]);
  assert.equal(clientRow(await clients(), 'Lumen').reqs, 3);
  await put(olive, '/reports/start', { date: '2026-11-16' });
});

// ---------- periods and the last 12 months ----------

test('each period of the Individual report, and the last 12 months of the Clients report', async () => {
  const at = async (iso, name) => { await clock(iso); const id = await add(sam, jobs.account, name); await submit(sam, id); return id; };
  // A second search at Kestrel, opened on 1 March 2027, and six submissions by Sam spread over the year.
  await clock('2027-03-01T17:00:00.000Z');
  jobs.account = await openJob(kestrel, 'Account Executive');
  await at('2027-03-01T17:00:00.000Z', 'March One');
  await at('2027-10-15T17:00:00.000Z', 'October One');
  await at('2027-11-25T17:00:00.000Z', 'November One');
  await at('2027-12-01T04:30:00.000Z', 'Last Night');        // half past eleven at night on 30 November in Toronto
  await at('2027-12-01T05:30:00.000Z', 'First Morning');     // half past midnight on 1 December
  apps.dec = await at('2027-12-05T17:00:00.000Z', 'December One');
  await schedule(sam, apps.dec);
  await clock('2027-12-08T17:00:00.000Z');
  await offer(sam, apps.dec, 100000, 'accepted');
  await clock('2027-12-10T17:00:00.000Z');
  await move(sam, apps.dec, (await stagesOf(jobs.account)).Hired);

  await clock('2027-12-20T17:00:00.000Z'); // noon in Toronto on Monday 20 December 2027
  const period = async (id) => { const r = await individual(olive, `?period=${id}`); return [r.period, r.from, line(r, 'Sam Ode'), line(r, 'Priya Nair'), line(r)]; };
  assert.deepEqual(await period('all'), ['all', START, [9, 3, 33.3, 4], [3, 3, 100, 2], [12, 6, 50, 7]]);
  assert.deepEqual(await period('12m'), ['12m', '2026-12-20T17:00:00.000Z', [6, 1, 16.7, 1], [0, 0, null, 0], [6, 1, 16.7, 1]]);
  assert.deepEqual(await period('90d'), ['90d', '2027-09-21T17:00:00.000Z', [5, 1, 20, 1], [0, 0, null, 0], [5, 1, 20, 1]]);
  assert.deepEqual(await period('30d'), ['30d', '2027-11-20T17:00:00.000Z', [4, 1, 25, 1], [0, 0, null, 0], [4, 1, 25, 1]]);
  assert.deepEqual(await period('month'), ['month', '2027-12-01T05:00:00.000Z', [2, 1, 50, 1], [0, 0, null, 0], [2, 1, 50, 1]]); // the month starts at midnight in Toronto
  assert.deepEqual(await period('fortnight'), await period('all'));
  // Everyone with anything recorded is listed whatever the period, and an empty ratio sorts last both ways.
  for (const dir of ['desc', 'asc']) assert.deepEqual((await individual(olive, `?period=month&sort=ratio&dir=${dir}`)).rows.map((r) => r.name), ['Sam Ode', 'No recruiter', 'Priya Nair']);
  assert.deepEqual(line(await individual(sam, '?period=month'), 'Sam Ode'), [2, 1, 50, 1]);

  const report = await clients('?sort=reqs_12m&dir=asc');
  assert.equal(report.since_12m, '2026-12-20T17:00:00.000Z');
  assert.deepEqual(names(report), ['Kestrel', 'Dormant', 'Finch', 'Lumen']); // only Kestrel opened a search in the last 12 months
  assert.deepEqual(figures(report, 'Kestrel'), {
    reqs: 2, reqs_12m: 1, submissions: 8, interviews: 2, interview_pct: 25, reqs_filled: 2, placement_pct: 100, placements: 2, fills: 2,
    time_to_fill: 144.5, // 7 days for Head of Sales; 282 for Account Executive, from 1 March to the offer accepted on 8 December
    billings: [{ currency: 'USD', amount: 45000 }], billings_12m: [{ currency: 'USD', amount: 15000 }], avg_fee: [{ currency: 'USD', amount: 22500 }],
  });
  const lumenNow = figures(report, 'Lumen');
  assert.deepEqual([lumenNow.reqs, lumenNow.reqs_12m, lumenNow.billings, lumenNow.billings_12m], [3, 0, [{ currency: 'CAD', amount: 45000 }], []]);
  assert.deepEqual(names(await clients('?sort=billings_12m&dir=desc')), ['Kestrel', 'Dormant', 'Finch', 'Lumen']);

  // The client's currency is changed afterwards: what was billed stays in the currency it was recorded in.
  await put(olive, `/clients/${kestrel}`, { name: 'Kestrel', engagement_model: 'hybrid', monthly_retainer: 3000, fee_percent: 15, currency: 'CAD' });
  const changed = clientRow(await clients(), 'Kestrel');
  assert.deepEqual([changed.currency, changed.billings], ['CAD', [{ currency: 'USD', amount: 45000 }]]);
});

// ---------- restarting and upgrading ----------

test('restarting the server changes nothing that was recorded', async () => {
  const snapshot = async () => {
    await clock('2027-12-20T17:00:00.000Z');
    const { to, ...people } = await individual();
    const { to: _, ...companies } = await clients();
    return { people, companies, ticks: ok(await olive.get(`/jobs/${jobs.ticks}`)).stages.map((s) => [s.name, s.with_client]) };
  };
  const recorded = await snapshot();
  await server.stop();
  server = await startApi({ port: PORT, dataDir });
  assert.deepEqual(await snapshot(), recorded);
});

test('a database from before reporting gains the new parts on start, and its existing rows are left alone', async () => {
  // Make a database as the version before this one left it: start once, then take away everything reporting added.
  const dir = tempDir('reporting-upgrade');
  let api = await startApi({ port: UPGRADE_PORT, dataDir: dir });
  try {
    const admin = session(api.base);
    ok(await admin.post('/setup', { agencyName: 'Older Agency', name: 'Olive Admin', email: 'olive@agency.example', password: 'demo1234' }));
    const clientId = ok(await admin.post('/clients', { name: 'Lumen', engagement_model: 'per_hire', fee_percent: 20, currency: 'CAD' })).id;
    const jobId = ok(await admin.post('/jobs', { client_id: clientId, title: 'Engineer', status: 'open',
      interview_stages: [{ name: 'Recruiter screen' }, { name: 'AGENCY interview' }, { name: 'Pre-screening' }, { name: 'Hiring manager interview' }, { name: 'Final interview' }] })).id;
    const appId = ok(await admin.upload('/applications', { job_id: jobId, name: 'Ana One', email: 'ana@mail.example' })).id;
    ok(await admin.post(`/applications/${appId}/submit`, { note: 'Worth meeting.' }));
    ok(await putJson(admin, api.base, `/applications/${appId}/offer`, { salary: 90000, status: 'accepted' }));
    await api.stop();

    const file = path.join(dir, 'app.db');
    let db = new DatabaseSync(file);
    db.exec('DROP TABLE report_events; ALTER TABLE stages DROP COLUMN with_client; ALTER TABLE offers DROP COLUMN accepted_at;');
    const dump = (d) => Object.fromEntries(['clients', 'jobs', 'candidates', 'applications', 'stage_history', 'activities', 'users', 'settings']
      .map((t) => [t, d.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()]));
    const old = { tables: dump(db), stages: db.prepare('SELECT * FROM stages ORDER BY id').all(), offers: db.prepare('SELECT * FROM offers').all() };
    db.close();

    // The new version starts on it.
    api = await startApi({ port: UPGRADE_PORT, dataDir: dir });
    await api.stop();
    db = new DatabaseSync(file);
    assert.deepEqual(dump(db), old.tables);
    assert.deepEqual(db.prepare('SELECT id, job_id, name, kind, position FROM stages ORDER BY id').all(), old.stages); // every stage as it was
    assert.deepEqual(db.prepare('SELECT id, application_id, salary, start_date, status, notes, created_at, updated_at FROM offers').all(), old.offers);
    assert.equal(db.prepare('SELECT accepted_at FROM offers').get().accepted_at, null);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM report_events').get().n, 0);                                       // nothing made up from the old rows
    // Existing interview stages get the same defaults a new job would.
    const ticks = () => db.prepare(`SELECT name, with_client FROM stages WHERE kind = 'interview' ORDER BY position`).all().map((s) => [s.name, s.with_client]);
    assert.deepEqual(ticks(), [['Recruiter screen', 0], ['AGENCY interview', 0], ['Pre-screening', 0], ['Hiring manager interview', 1], ['Final interview', 1]]);
    // Somebody then ticks one by hand; starting again must not put the default back.
    db.exec(`UPDATE stages SET with_client = 1 WHERE name = 'Pre-screening'`);
    db.close();
    api = await startApi({ port: UPGRADE_PORT, dataDir: dir });
    await api.stop();
    db = new DatabaseSync(file);
    assert.deepEqual(ticks(), [['Recruiter screen', 0], ['AGENCY interview', 0], ['Pre-screening', 1], ['Hiring manager interview', 1], ['Final interview', 1]]);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM report_events').get().n, 0);
    db.close();
  } finally {
    await api.stop().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
