// People in The Book without a job, end to end: The Book's real API on a throwaway data folder. Run with `npm test`.
//
// A person can be saved with no job chosen. They get an entry with no job and no stage, which belongs to the agency
// alone, and which becomes a job's application when they are put on one. These tests add such people, do everything
// a profile allows to them, check that everything about jobs, clients and the hiring team's view carries on as if
// they were not there, and then put them on jobs.
//
// Metaview is the stand-in (test/metaview-standin.mjs), holding only the conversations these tests put in it: the
// real Metaview is never read. The screens are not driven here.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { session, tempDir, until, RECORDING, PORTS as SHARED } from './oracle-helpers.mjs';
import { startBook, connect } from './metaview-helpers.mjs';
import { metaviewStandIn } from './metaview-standin.mjs';

// Four ports, the ones kept for this file (see PORT_PLAN in oracle-helpers.mjs): the server and the stand-in for
// Metaview, and a second server with e-mail delivery connected and the stand-in for its mail provider. With
// POOL_TEST_PORT set, four in a row from it instead.
const OWN_PORT = Number(process.env.POOL_TEST_PORT) || 0;
const PORTS = OWN_PORT
  ? { api: OWN_PORT, metaview: OWN_PORT + 1, mailApi: OWN_PORT + 2, mail: OWN_PORT + 3 }
  : { api: SHARED.pool, metaview: SHARED.pool + 1, mailApi: SHARED.poolMail, mail: SHARED.poolMail + 1 };
const NEEDS_JOB = { error: 'Add them to a job first.' };
// A real picture, one pixel square: the workspace reads a photo's own size and refuses a file that only starts like one.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const resume = (text, name = 'resume.pdf') => ({ name, bytes: Buffer.from(text) });

let api, metaview, dataDir;
let alex, dana, sam, maya, noor;          // the owner, two recruiters, and a hiring manager at each of two clients
const client = {}, job = {}, app = {};    // ids, by a short name
const book = {};                          // the entries of people saved without a job, by a short name
let baseline;                             // what the lists about jobs and clients answered before anyone was saved without a job

const put = (who, pathname, json) => who.putJson(pathname, json);
const detail = async (who, id) => (await who.get(`/applications/${id}`)).body;
const list = async (who, query = '') => (await who.get(`/applications${query}`)).body;
const uploads = () => fs.readdirSync(path.join(dataDir, 'uploads')).sort();
/** The files in another server's uploads folder (see meeting()). */
const uploadsOf = (m) => fs.readdirSync(path.join(m.dir, 'uploads')).filter((name) => fs.statSync(path.join(m.dir, 'uploads', name)).isFile());
/** A history line and an e-mail as they read, whichever table they are kept in (the numbers differ between the two). */
const line = (a) => [a.type, a.detail, a.created_at, a.user_name];
const mail = (e) => [e.subject, e.body, e.to_email, e.delivery, e.created_at, e.sent_by_name];
/** Read the server's database directly, for things no route shows. */
function db(query, ...params) {
  const database = new DatabaseSync(path.join(dataDir, 'app.db'), { readOnly: true });
  try { return database.prepare(query).all(...params).map((row) => ({ ...row })); } finally { database.close(); }
}
/** Save somebody with no job chosen and return the whole answer. */
const save = (who, fields) => who.upload('/applications', fields);
/** Save somebody with no job chosen, and return their entry's id. */
async function saved(who, fields) {
  const made = await save(who, fields);
  assert.equal(made.status, 200, JSON.stringify(made.body));
  assert.equal(made.body.general, true);
  return made.body.id;
}
const addToJob = (who, id, body) => who.post(`/applications/${id}/add-to-job`, body);
/** Everything about jobs, clients and the pipeline that must not notice people saved without a job. */
async function jobsAndClients() {
  const out = {};
  for (const [name, who] of [['alex', alex], ['maya', maya]]) {
    for (const route of ['/jobs', '/clients', '/dashboard', '/reports', `/reports?job_id=${job.accountant}`, '/nav', '/interviews', '/applications?general=0', `/applications?job_id=${job.accountant}`,
      `/applications?client_id=${client.maple}`, '/applications?stage_kind=applied', `/owners?client_id=${client.maple}`, `/clients/${client.maple}`, `/jobs/${job.accountant}`]) {
      out[`${name} ${route}`] = (await who.get(route)).body;
    }
  }
  return out;
}

before(async () => {
  dataDir = tempDir('pool');
  // A Metaview with nothing in it: each test adds the conversations it is about. Nothing is read until a test connects it.
  metaview = await metaviewStandIn(PORTS.metaview, { count: 0 });
  api = await startBook({ port: PORTS.api, dataDir, standIn: metaview });

  alex = session(api.base);
  assert.equal((await alex.post('/setup', { agencyName: 'Harbour Talent', name: 'Alex Morgan', email: 'alex@agency.example', password: 'demo1234' })).status, 200);
  client.maple = (await alex.post('/clients', { name: 'Maple Freight', engagement_model: 'per_hire', fee_percent: 20 })).body.id;
  client.northline = (await alex.post('/clients', { name: 'Northline Dental' })).body.id;
  const join = async (role, name, email, extra = {}) => {
    const { token } = (await alex.post('/invites', { role, email, ...extra })).body;
    const person = session(api.base);
    assert.equal((await person.post(`/invites/${token}/accept`, { name, password: 'demo1234' })).status, 200);
    return person;
  };
  dana = await join('recruiter', 'Dana Recruiter', 'dana@agency.example');
  sam = await join('recruiter', 'Sam Okoro', 'sam@agency.example');
  maya = await join('client', 'Maya Okonkwo', 'maya@maple.example', { client_id: client.maple });
  noor = await join('client', 'Noor Haddad', 'noor@northline.example', { client_id: client.northline });
  const newJob = async (clientId, title) => (await alex.post('/jobs', { client_id: clientId, title, status: 'open' })).body.id;
  job.accountant = await newJob(client.maple, 'Senior Accountant');
  job.payroll = await newJob(client.maple, 'Payroll Specialist');
  job.hygienist = await newJob(client.northline, 'Hygienist');
  job.temp = await newJob(client.northline, 'Temp Receptionist');
  const add = async (by, jobId, fields) => {
    const made = await by.upload('/applications', { job_id: jobId, ...fields });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    assert.equal(made.body.general, false);
    return made.body.id;
  };
  // A pipeline with something in every list: an interview booked, someone put to the hiring team, a hire with an offer.
  app.kevin = await add(dana, job.accountant, { name: 'Kevin Tremblay', email: 'kevin.tremblay@example.com', phone: '(416) 555-0142', linkedin: 'https://www.linkedin.com/in/kevin-tremblay' });
  app.priya = await add(dana, job.payroll, { name: 'Priya Nair', email: 'priya.nair@example.org', linkedin: 'https://www.linkedin.com/in/priya-nair' });
  app.omar = await add(sam, job.hygienist, { name: 'Omar Haddad', email: 'omar@example.com' });
  app.onlyTemp = await add(sam, job.temp, { name: 'Tess Only-Temp', email: 'tess@example.com', resume: resume('Tess, receptionist'), photo: { name: 'tess.png', bytes: PNG } });
  const { stages } = (await alex.get(`/jobs/${job.accountant}`)).body;
  job.accountantStages = stages;
  assert.equal((await dana.post(`/applications/${app.kevin}/move`, { stage_id: stages[1].id })).status, 200);
  assert.equal((await dana.post('/interviews', { application_id: app.kevin, title: 'Recruiter screen', starts_at: '2099-03-01T15:00:00.000Z', panel: [] })).status, 200);
  assert.equal((await dana.post(`/applications/${app.kevin}/submit`, { note: 'Strong on month-end close.' })).status, 200);
  const hygienistStages = (await alex.get(`/jobs/${job.hygienist}`)).body.stages;
  assert.equal((await put(sam, `/applications/${app.omar}/offer`, { salary: 70000, status: 'accepted' })).status, 200);
  assert.equal((await sam.post(`/applications/${app.omar}/move`, { stage_id: hygienistStages.at(-1).id })).status, 200);
  baseline = await jobsAndClients();
});

after(async () => {
  await api?.stop();
  await metaview?.stop();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

// ---------- saving somebody without a job ----------
test('a person can be saved with no job: with a name and an address only, with everything, and with a résumé and a photo', async () => {
  const minimal = await save(dana, { name: 'Ana Ruiz', email: ' Ana.Ruiz@Example.com ' });
  assert.equal(minimal.status, 200, JSON.stringify(minimal.body));
  assert.deepEqual(minimal.body, { id: minimal.body.id, known: false, merged: false, name: 'Ana Ruiz', general: true });
  book.ana = minimal.body.id;

  // A stage chosen on the form means nothing without a job, and is ignored. An empty job is the same as none.
  book.bruno = await saved(sam, {
    job_id: '', stage_id: job.accountantStages[2].id, name: 'Bruno Okafor', email: 'bruno@example.com', phone: '(416) 555-0177', linkedin: 'https://ca.linkedin.com/in/Bruno-Okafor/?utm_source=share',
    location: 'Toronto', current_title: 'Controller', current_company: 'Varsity Freight', source: 'linkedin', note: 'Met at the logistics meet-up.', note_private: 'false',
  });
  book.cleo = await saved(dana, { name: 'Cleo Marchetti', linkedin: 'https://www.linkedin.com/in/cleo-marchetti', resume: resume('Cleo, accountant', 'Cleo CV.pdf'), photo: { name: 'cleo.png', bytes: PNG } });

  const ana = await detail(dana, book.ana);
  assert.equal(ana.application.general, true);
  assert.deepEqual([ana.job, ana.client, ana.stages, ana.interviews, ana.offer, ana.others, ana.duplicates], [null, null, [], [], null, [], []]);
  assert.deepEqual({ job: ana.application.job_id, stage: ana.application.stage_id, status: ana.application.status, source: ana.application.source, owner: ana.application.owner_name, resume: ana.application.resume_file },
    { job: null, stage: null, status: 'active', source: 'agency_sourced', owner: 'Dana Recruiter', resume: null });
  assert.deepEqual({ name: ana.candidate.name, email: ana.candidate.email, client: ana.candidate.client_id }, { name: 'Ana Ruiz', email: 'ana.ruiz@example.com', client: null });
  assert.deepEqual(ana.activities.map((a) => [a.type, a.detail, a.user_name]), [['added', 'Added to The Book (agency sourced)', 'Dana Recruiter']]);

  const bruno = await detail(sam, book.bruno);
  assert.deepEqual({ ...bruno.candidate, id: 0, created_at: '' }, {
    id: 0, client_id: null, name: 'Bruno Okafor', email: 'bruno@example.com', phone: '(416) 555-0177', linkedin: 'https://www.linkedin.com/in/bruno-okafor', location: 'Toronto',
    current_title: 'Controller', current_company: 'Varsity Freight', created_at: '', photo: null,
  });
  assert.equal(bruno.application.source, 'linkedin');
  assert.equal(bruno.application.owner_name, 'Sam Okoro');
  assert.deepEqual(bruno.activities.map((a) => a.detail), ['Added to The Book (linkedin)']);
  // A note on somebody who is on no job is the agency's own, whatever the form said.
  assert.deepEqual(bruno.notes.map((n) => [n.body, n.private, n.user_name]), [['Met at the logistics meet-up.', 1, 'Sam Okoro']]);
  assert.deepEqual(db('SELECT COUNT(*) AS n FROM stage_history WHERE application_id = ?', book.bruno), [{ n: 0 }]);

  const cleo = await detail(dana, book.cleo);
  assert.equal(cleo.application.resume_name, 'Cleo CV.pdf');
  assert.match(cleo.candidate.photo, /^[a-f0-9]{8}$/);
  const file = await dana.get(`/applications/${book.cleo}/resume`);
  assert.equal(file.status, 200);
  assert.equal(file.body.toString(), 'Cleo, accountant');
  assert.match(file.headers.get('content-disposition'), /attachment; filename="Cleo CV.pdf"/);
  const photo = await dana.get(`/candidates/${cleo.candidate.id}/photo`);
  assert.equal(photo.status, 200);
  assert.equal(photo.headers.get('content-type'), 'image/png');
});

test('what a job needs is still asked for: a name, a way to tell the person apart, and a job that exists if one is named', async () => {
  assert.deepEqual((await save(dana, { email: 'nameless@example.com' })).body, { error: 'A name is required.' });
  assert.deepEqual((await save(dana, { name: 'No Contact' })).body, { error: 'Add an email address or a profile link, so this person can be told apart from others.' });
  assert.deepEqual((await save(dana, { name: 'Bad Address', email: 'not an address' })).body, { error: 'That email address does not look right.' });
  const gone = await save(dana, { job_id: 99999, name: 'No Such Job', email: 'nosuchjob@example.com' });
  assert.equal(gone.status, 400);
  assert.deepEqual(gone.body, { error: 'That job was not found. It may have been removed.' });
  // A file that came with a refused request is not left behind.
  const before_ = uploads();
  assert.equal((await save(dana, { email: 'nameless@example.com', resume: resume('x'), photo: { name: 'x.png', bytes: PNG } })).status, 400);
  assert.deepEqual(await until(async () => uploads(), (now_) => now_.length === before_.length), before_);
  assert.equal(db(`SELECT COUNT(*) AS n FROM candidates WHERE email IN ('nameless@example.com', 'nosuchjob@example.com')`)[0].n, 0);
});

test('saving the same person again makes nothing new: found by e-mail address, or by LinkedIn link', async () => {
  const people = db('SELECT COUNT(*) AS n FROM candidates')[0].n, entries = db('SELECT COUNT(*) AS n FROM applications')[0].n;
  // By address, typed differently, by somebody else, with a résumé, a photo, a note and details the record lacked.
  const again = await save(sam, { name: 'Ana Ruiz Ortega', email: 'ANA.RUIZ@example.com', phone: '613 555 0190', current_title: 'Payroll Lead', resume: resume('Ana, payroll', 'Ana.docx'), photo: { name: 'ana.png', bytes: PNG }, note: 'Open to contract work.' });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.deepEqual(again.body, { id: book.ana, known: true, merged: true, name: 'Ana Ruiz', general: true, resume: 'added' });
  let ana = await detail(dana, book.ana);
  assert.deepEqual({ phone: ana.candidate.phone, title: ana.candidate.current_title, resume: ana.application.resume_name, owner: ana.application.owner_name },
    { phone: '613 555 0190', title: 'Payroll Lead', resume: 'Ana.docx', owner: 'Dana Recruiter' });
  assert.match(ana.candidate.photo, /^[a-f0-9]{8}$/);
  assert.deepEqual(ana.notes.map((n) => [n.body, n.private]), [['Open to contract work.', 1]]);
  assert.deepEqual(ana.activities.map((a) => a.detail), ['Saved to The Book again, with their résumé', 'Added to The Book (agency sourced)']);
  assert.equal((await dana.get(`/applications/${book.ana}/resume`)).body.toString(), 'Ana, payroll');

  // A newer résumé becomes the one on the profile. The one they had is not deleted: it is kept as an earlier résumé,
  // which the agency can still download, and the answer and the history both say so.
  const withOld = uploads();
  const newer = await save(dana, { name: 'Ana Ruiz', email: 'ana.ruiz@example.com', resume: resume('Ana, payroll, second version', 'Ana v2.pdf') });
  assert.deepEqual(newer.body, { id: book.ana, known: true, merged: true, name: 'Ana Ruiz', general: true, resume: 'replaced' });
  assert.equal((await dana.get(`/applications/${book.ana}/resume`)).body.toString(), 'Ana, payroll, second version');
  assert.equal(uploads().length, withOld.length + 1);
  assert.deepEqual(uploads().filter((f) => !withOld.includes(f)).length, 1);
  ana = await detail(dana, book.ana);
  assert.equal(ana.activities[0].detail, 'Saved to The Book again, with a newer résumé. The one they had (Ana.docx) is kept under Earlier résumés');
  assert.deepEqual(ana.earlier_resumes.map((r) => r.name), ['Ana.docx']);
  const earlier = await dana.get(`/applications/${book.ana}/resumes/${ana.earlier_resumes[0].id}`);
  assert.equal(earlier.status, 200);
  assert.equal(earlier.body.toString(), 'Ana, payroll');
  assert.match(earlier.headers.get('content-disposition'), /attachment; filename="Ana.docx"/);
  // An earlier résumé is asked for through the entry it belongs to, and by the agency only.
  assert.equal((await dana.get(`/applications/${book.cleo}/resumes/${ana.earlier_resumes[0].id}`)).status, 404);
  assert.equal((await maya.get(`/applications/${book.ana}/resumes/${ana.earlier_resumes[0].id}`)).status, 403);
  // The very same file sent again changes nothing and keeps nothing twice.
  const same = await save(dana, { name: 'Ana Ruiz', email: 'ana.ruiz@example.com', resume: resume('Ana, payroll, second version', 'Ana v2 (copy).pdf') });
  assert.equal(same.body.resume, 'unchanged');
  await until(async () => uploads(), (now_) => now_.length === withOld.length + 1);
  ana = await detail(dana, book.ana);
  assert.deepEqual([ana.application.resume_name, ana.earlier_resumes.length, ana.activities[0].detail], ['Ana v2.pdf', 1, 'Saved to The Book again, with the résumé they already had']);

  // By LinkedIn link, however it was copied, when the name could be the same person's.
  const byLink = await save(dana, { name: 'Cleo M. Marchetti', linkedin: 'http://uk.linkedin.com/in/CLEO-marchetti/details/experience/', email: 'cleo@example.com' });
  assert.deepEqual(byLink.body, { id: book.cleo, known: true, merged: true, name: 'Cleo Marchetti', general: true });
  const cleo = await detail(dana, book.cleo);
  assert.equal(cleo.candidate.email, 'cleo@example.com');                 // the address the record was missing
  assert.equal(cleo.application.resume_name, 'Cleo CV.pdf');              // nothing sent, nothing replaced
  assert.deepEqual(cleo.activities.map((a) => a.detail).slice(0, 2).sort(), ['Recognised as Cleo Marchetti by LinkedIn link and added to their existing record', 'Saved to The Book again']);

  assert.equal(db('SELECT COUNT(*) AS n FROM candidates')[0].n, people);
  assert.equal(db('SELECT COUNT(*) AS n FROM applications')[0].n, entries);
  ana = await detail(dana, book.ana);
  assert.equal(ana.candidate.name, 'Ana Ruiz');
});

test('a LinkedIn link that is on somebody else\'s entry is put to the recruiter, not joined', async () => {
  const clash = await save(dana, { name: 'Dmitri Volkov', linkedin: 'https://www.linkedin.com/in/cleo-marchetti' });
  assert.equal(clash.status, 409);
  assert.equal(clash.body.code, 'link_conflict');
  assert.equal(clash.body.error, "This LinkedIn link is already on Cleo Marchetti's record. Open their record, or check the link.");
  assert.deepEqual(clash.body.matches, [{ application_id: book.cleo, job_id: null, job_title: null, client_name: null, name: 'Cleo Marchetti', general: true }]);
  assert.equal(db(`SELECT COUNT(*) AS n FROM candidates WHERE name = 'Dmitri Volkov'`)[0].n, 0);
});

test('an e-mail address that is on somebody else\'s entry is put to the recruiter too, so their résumé, photo and note are not written over', async () => {
  const before_ = { files: uploads(), ana: await detail(dana, book.ana) };
  const clash = await save(dana, { name: 'Tom Other', email: 'ana.ruiz@example.com', resume: resume('Tom, not Ana', 'Tom.pdf'), photo: { name: 'tom.png', bytes: PNG }, note: 'This is about Tom.' });
  assert.equal(clash.status, 409);
  assert.equal(clash.body.code, 'link_conflict');
  assert.equal(clash.body.error, "This email address is already on Ana Ruiz's entry in The Book. Open their entry, or check the address.");
  assert.deepEqual(clash.body.matches, [{ application_id: book.ana, job_id: null, job_title: null, client_name: null, name: 'Ana Ruiz', general: true }]);
  await until(async () => uploads(), (now_) => now_.length === before_.files.length);   // what was uploaded with the refused save is not kept
  assert.deepEqual(uploads(), before_.files);
  assert.deepEqual(await detail(dana, book.ana), before_.ana);
  assert.equal(db(`SELECT COUNT(*) AS n FROM candidates WHERE name = 'Tom Other'`)[0].n, 0);
});

test('somebody who is on a client\'s job can be saved to The Book as well: each keeps a record of its own', async () => {
  // Kevin is in Maple's pipeline. Saved with no job, he gets an entry that belongs to no client.
  const made = await save(dana, { name: 'Kevin Tremblay', email: 'kevin.tremblay@example.com', linkedin: 'https://www.linkedin.com/in/kevin-tremblay', phone: '(416) 555-0142' });
  assert.deepEqual(made.body, { id: made.body.id, known: false, merged: false, name: 'Kevin Tremblay', general: true });
  book.kevin = made.body.id;
  assert.notEqual(book.kevin, app.kevin);
  assert.equal((await detail(dana, book.kevin)).candidate.client_id, null);
  assert.equal((await detail(dana, app.kevin)).candidate.client_id, client.maple);
  // Somebody added to a job under Ana's address but a plainly different name does not move Ana's entry (the address
  // may be mistyped): the client gets a record of its own, and Ana stays in The Book as she was.
  const anaAtNorthline = await dana.upload('/applications', { job_id: job.temp, name: 'Anneli Rautio', email: 'ana.ruiz@example.com' });
  assert.deepEqual(anaAtNorthline.body, { id: anaAtNorthline.body.id, known: false, merged: false, name: 'Anneli Rautio', general: false });
  app.anaTemp = anaAtNorthline.body.id;
  assert.equal((await detail(dana, book.ana)).application.general, true);
});

// ---------- finding them ----------
test('the list of candidates has them, can show only them or leave them out, and never shows them for one job or one client', async () => {
  const everyone = await list(alex);
  const inBook = everyone.filter((r) => r.general);
  assert.deepEqual(inBook.map((r) => r.id).sort((a, b) => a - b), [book.ana, book.bruno, book.cleo, book.kevin].sort((a, b) => a - b));
  assert.deepEqual(everyone.filter((r) => !r.general).map((r) => r.id).sort((a, b) => a - b), [app.kevin, app.priya, app.omar, app.onlyTemp, app.anaTemp].sort((a, b) => a - b));
  const row = inBook.find((r) => r.id === book.bruno);
  assert.deepEqual({ ...row, applied_at: '', stage_entered_at: '', updated_at: '', candidate_id: 0 }, {
    id: book.bruno, status: 'active', source: 'linkedin', rating: null, applied_at: '', stage_entered_at: '', updated_at: '', review_status: null, stage_id: null, reject_reason: null, hired_at: null,
    has_resume: 0, owner_id: row.owner_id, owner_name: 'Sam Okoro', candidate_id: 0, name: 'Bruno Okafor', email: 'bruno@example.com', current_title: 'Controller', current_company: 'Varsity Freight',
    location: 'Toronto', photo: null, job_id: null, job_title: null, client_id: null, client_name: null, brand_color: null, stage_name: null, stage_kind: null, stage_position: null, general: true, next_interview: null,
  });
  const ids = async (query) => (await list(alex, query)).map((r) => r.id).sort((a, b) => a - b);
  const bookIds = [book.ana, book.bruno, book.cleo, book.kevin].sort((a, b) => a - b);
  assert.deepEqual(await ids('?general=1'), bookIds);
  assert.deepEqual((await list(alex, '?general=0')).filter((r) => r.general), []);
  assert.equal((await list(alex, '?general=0')).length, 5);
  assert.deepEqual((await list(alex, `?client_id=${client.maple}`)).filter((r) => r.general), []);
  assert.deepEqual(await ids(`?client_id=${client.maple}&general=1`), []);
  assert.deepEqual(await ids(`?job_id=${job.accountant}`), [app.kevin]);
  assert.deepEqual(await ids(`?job_id=${job.accountant}&general=1`), []);
  // The other filters work on them like on anyone: status, owner, search. A stage is something they do not have.
  assert.deepEqual(await ids('?general=1&status=active'), bookIds);
  assert.deepEqual(await ids('?general=1&status=rejected'), []);
  assert.deepEqual(await ids('?general=1&stage_kind=applied'), []);
  assert.deepEqual(await ids('?general=1&q=varsity'), [book.bruno]);
  assert.deepEqual(await ids('?q=kevin'), [app.kevin, book.kevin].sort((a, b) => a - b));
  assert.deepEqual((await list(sam, '?general=1&owner=me')).map((r) => r.id), [book.bruno]);
  assert.deepEqual((await list(alex, '?general=1&sort=oldest')).map((r) => r.id), [book.ana, book.bruno, book.cleo, book.kevin]);
  assert.deepEqual((await list(alex, '?general=1')).map((r) => r.id), [book.kevin, book.cleo, book.bruno, book.ana]);
});

test('the extension\'s "already in your workspace" look-up finds them, with no job to name', async () => {
  const byLink = (await dana.get(`/candidates/lookup?linkedin=${encodeURIComponent('https://www.linkedin.com/in/cleo-marchetti/')}`)).body;
  assert.deepEqual(byLink, [{ application_id: book.cleo, status: 'active', name: 'Cleo Marchetti', job_id: null, job_title: null, client_name: null, stage_name: null, general: true }]);
  // Someone who is both in a pipeline and in The Book comes back once for each.
  const kevin = (await dana.get('/candidates/lookup?email=kevin.tremblay@example.com')).body;
  assert.deepEqual(kevin.map((k) => [k.application_id, k.general, k.job_title, k.client_name, k.stage_name]).sort(),
    [[app.kevin, false, 'Senior Accountant', 'Maple Freight', 'Recruiter screen'], [book.kevin, true, null, null, null]].sort());
  assert.deepEqual((await dana.get('/candidates/lookup?email=nobody@example.com')).body, []);
});

// ---------- what can and cannot be done to them ----------
test('everything that needs a job says so, and changes nothing', async () => {
  const id = book.bruno;
  const before_ = db('SELECT * FROM applications WHERE id = ?', id);
  const refused = [
    await dana.post(`/applications/${id}/move`, { stage_id: job.accountantStages[1].id }),
    await dana.post(`/applications/${id}/reject`, { reason: 'No', send_email: true }),
    await dana.post(`/applications/${id}/restore`),
    await dana.post(`/applications/${id}/withdraw`, { reason: 'Changed their mind' }),
    await dana.post(`/applications/${id}/submit`, { note: 'Worth meeting.' }),
    await dana.post(`/applications/${id}/review`, { decision: 'approved' }),
    await dana.post('/interviews', { application_id: id, title: 'Screen', starts_at: '2099-03-01T15:00:00.000Z' }),
    await put(dana, `/applications/${id}/offer`, { salary: 90000, status: 'sent' }),
    await dana.patch(`/applications/${id}`, { rating: 4 }),
    // A rating sent together with something that is allowed: nothing of the request is applied.
    await dana.patch(`/applications/${id}`, { rating: 4, owner_id: null }),
  ];
  for (const answer of refused) {
    assert.equal(answer.status, 400, JSON.stringify(answer.body));
    assert.deepEqual(answer.body, NEEDS_JOB);
  }
  assert.deepEqual(db('SELECT * FROM applications WHERE id = ?', id), before_);
  for (const table of ['interviews', 'offers', 'stage_history', 'emails']) assert.equal(db(`SELECT COUNT(*) AS n FROM ${table} WHERE application_id = ?`, id)[0].n, 0, table);
  assert.deepEqual((await detail(dana, id)).activities.map((a) => a.detail), ['Added to The Book (linkedin)']);
});

test('what a profile allows works: notes, an e-mail, editing details, the owner, the résumé, the photo', async () => {
  const id = book.bruno;
  // Notes are the agency's own on such an entry, ticked or not.
  const note = await dana.post(`/applications/${id}/notes`, { body: 'Called; back from leave in March.', private: false });
  assert.equal(note.status, 200);
  assert.deepEqual((await detail(dana, id)).notes.map((n) => [n.body, n.private]).sort(), [['Called; back from leave in March.', 1], ['Met at the logistics meet-up.', 1]]);
  assert.equal((await dana.del(`/notes/${note.body.id}`)).status, 200);

  const mail = await dana.post(`/applications/${id}/emails`, { subject: 'Keeping in touch', body: 'Hi Bruno,\n\nGood to meet you.' });
  assert.equal(mail.status, 200);
  assert.equal(mail.body.delivery, 'not_configured');   // no mail provider in the tests: it is kept on the record and marked as not sent
  assert.deepEqual((await detail(dana, id)).emails.map((e) => [e.to_email, e.subject, e.sent_by_name]), [['bruno@example.com', 'Keeping in touch', 'Dana Recruiter']]);
  assert.deepEqual((await dana.post(`/applications/${book.cleo}/emails`, { subject: 'x', body: 'y' })).status, 200);

  // Editing details. An address is unique among people saved without a job; the same address on a client's record is no obstacle.
  const fields = { name: 'Bruno Okafor', email: 'bruno@example.com', phone: '(416) 555-0177', linkedin: 'https://www.linkedin.com/in/bruno-okafor', location: 'Hamilton', current_title: 'Finance Director', current_company: 'Varsity Freight' };
  assert.equal((await dana.patch(`/applications/${id}`, { candidate: fields })).status, 200);
  assert.deepEqual([(await detail(dana, id)).candidate.location, (await detail(dana, id)).candidate.current_title], ['Hamilton', 'Finance Director']);
  const taken = await dana.patch(`/applications/${id}`, { candidate: { ...fields, email: 'ana.ruiz@example.com' } });
  assert.equal(taken.status, 400);
  assert.deepEqual(taken.body, { error: 'Someone else saved to The Book without a job already uses that email.' });
  assert.equal((await dana.patch(`/applications/${id}`, { candidate: { ...fields, email: 'omar@example.com' } })).status, 200);
  assert.equal((await dana.patch(`/applications/${id}`, { candidate: fields })).status, 200);
  assert.deepEqual((await dana.patch(`/applications/${id}`, { candidate: { ...fields, email: '', linkedin: '' } })).body, { error: 'Keep an email address or a profile link, so this person can be told apart from others.' });

  // The owner.
  const samId = db(`SELECT id FROM users WHERE email = 'sam@agency.example'`)[0].id, danaId = db(`SELECT id FROM users WHERE email = 'dana@agency.example'`)[0].id;
  assert.equal((await alex.patch(`/applications/${id}`, { owner_id: danaId })).status, 200);
  assert.equal((await detail(alex, id)).application.owner_name, 'Dana Recruiter');
  assert.equal((await alex.patch(`/applications/${id}`, { owner_id: null })).status, 200);
  assert.equal((await detail(alex, id)).application.owner_name, null);
  assert.deepEqual((await list(alex, '?general=1&owner=none')).map((r) => r.id), [id]);
  assert.equal((await alex.patch(`/applications/${id}`, { owner_id: samId })).status, 200);
  assert.deepEqual((await detail(alex, id)).activities.slice(0, 3).map((a) => a.detail), ['Assigned to Sam Okoro', 'Owner removed', 'Assigned to Dana Recruiter']);
  assert.deepEqual((await alex.patch(`/applications/${id}`, { owner_id: db(`SELECT id FROM users WHERE email = 'maya@maple.example'`)[0].id })).body, { error: 'Choose someone on your own team as the owner.' });

  // The photo: added, shown, replaced, removed.
  const candidateId = (await detail(dana, id)).candidate.id;
  const withPhoto = await dana.upload(`/candidates/${candidateId}/photo`, { photo: { name: 'bruno.png', bytes: PNG } });
  assert.equal(withPhoto.status, 404);                    // the route is a PUT; sent properly below
  const form = new FormData();
  form.append('photo', new Blob([PNG]), 'bruno.png');
  const sent = await fetch(`${api.base}/api/candidates/${candidateId}/photo`, { method: 'PUT', headers: { Cookie: dana.cookie() }, body: form });
  assert.equal(sent.status, 200);
  assert.equal((await dana.get(`/candidates/${candidateId}/photo`)).status, 200);
  assert.match((await list(dana, '?general=1&q=bruno'))[0].photo, /^[a-f0-9]{8}$/);
  assert.equal((await dana.del(`/candidates/${candidateId}/photo`)).status, 200);
  assert.equal((await dana.get(`/candidates/${candidateId}/photo`)).status, 404);
  // No résumé on this one, and the route says so.
  assert.deepEqual((await dana.get(`/applications/${id}/resume`)).body, { error: 'No résumé on file.' });
});

test('everyone who owns somebody in The Book is offered as an owner, even after they have left', async () => {
  const lena = session(api.base);
  const { token } = (await alex.post('/invites', { role: 'recruiter', email: 'lena@agency.example' })).body;
  assert.equal((await lena.post(`/invites/${token}/accept`, { name: 'Lena Fischer', password: 'demo1234' })).status, 200);
  book.eve = await saved(lena, { name: 'Eve Lindqvist', email: 'eve@example.com' });
  const lenaId = db(`SELECT id FROM users WHERE email = 'lena@agency.example'`)[0].id;
  assert.equal((await alex.patch(`/users/${lenaId}`, { active: false })).status, 200);
  // Lena owns nobody in any job. With no client chosen she is still listed, so her people can be found and reassigned.
  assert.deepEqual((await alex.get('/owners')).body.find((o) => o.id === lenaId), { id: lenaId, name: 'Lena Fischer', active: 0 });
  assert.equal((await alex.get(`/owners?client_id=${client.maple}`)).body.some((o) => o.id === lenaId), false);
  assert.equal((await maya.get('/owners')).body.some((o) => o.id === lenaId), false);
  assert.deepEqual((await list(alex, `?general=1&owner=${lenaId}`)).map((r) => r.id), [book.eve]);
});

// ---------- calls, and conversations in Metaview ----------
test('a call in Otterview can be put on somebody who is on no job, and its summary saved on their profile', async () => {
  const uploaded = await dana.upload('/oracle/calls/upload', { audio: { name: 'call.webm', bytes: RECORDING }, consent: 'true', application_id: book.cleo });
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
  const callId = uploaded.body.id;
  book.cleoCall = callId;
  let call = (await dana.get(`/oracle/calls/${callId}`)).body;
  assert.equal(call.call.application_id, book.cleo);
  assert.equal(call.candidate.name, 'Cleo Marchetti');
  assert.deepEqual(call.application, { id: book.cleo, job_id: null, job_title: null, client_name: null, status: 'active', review_status: null, sent_submission: null, sent_at: null });
  assert.deepEqual(call.applications, [{ id: book.cleo, job_id: null, job_title: null, client_name: null, status: 'active' }]);
  const row = (await dana.get('/oracle/calls')).body.find((c) => c.id === callId);
  assert.deepEqual([row.candidate_name, row.application_id, row.job_id, row.job_title, row.client_name], ['Cleo Marchetti', book.cleo, null, null, null]);
  assert.deepEqual((await dana.get(`/oracle/calls?application_id=${book.cleo}`)).body.map((c) => c.id), [callId]);
  // They belong to no client, so the call stays in the list whichever client is chosen in the sidebar.
  assert.equal((await dana.get(`/oracle/calls?client_id=${client.northline}`)).body.some((c) => c.id === callId), true);
  assert.match((await detail(dana, book.cleo)).activities[0].detail, /^Call added, /);

  // Notes written by hand, saved on the profile as an agency-only note.
  assert.equal((await dana.patch(`/oracle/calls/${callId}`, { notes: 'Wants a move into a controller role.' })).status, 200);
  assert.equal((await dana.post(`/oracle/calls/${callId}/save-note`)).status, 200);
  assert.deepEqual((await detail(dana, book.cleo)).notes.map((n) => [n.body, n.private]), [['Notes from Call with Cleo Marchetti\n\nWants a move into a controller role.', 1]]);
  // A write-up for a hiring team has nobody to go to yet.
  const draft = await dana.post(`/oracle/calls/${callId}/submission`);
  assert.equal(draft.status, 400);
  assert.deepEqual(draft.body, NEEDS_JOB);

  // A call recorded with nobody chosen can be added to them afterwards, and taken off again.
  const loose = (await dana.upload('/oracle/calls/upload', { audio: { name: 'call.webm', bytes: RECORDING }, consent: 'true' })).body.id;
  assert.equal((await dana.patch(`/oracle/calls/${loose}`, { application_id: book.ana })).status, 200);
  call = (await dana.get(`/oracle/calls/${loose}`)).body;
  assert.deepEqual([call.candidate.name, call.call.application_id, call.application.job_title], ['Ana Ruiz', book.ana, null]);
  assert.equal((await dana.patch(`/oracle/calls/${loose}`, { application_id: null })).status, 200);
  assert.equal((await dana.del(`/oracle/calls/${loose}`)).status, 200);
});

test('a conversation in Metaview is matched to somebody who is on no job, listed on their profile, and brought in onto their entry', async () => {
  // Nothing is brought in by itself until the end of this test, so that what a match says can be looked at first.
  assert.equal((await put(alex, '/metaview/settings', { auto: false })).status, 200);
  const talk = (title, person, more = {}) => metaview.add({ person, title, channel: 'Zoom', ...more });
  const intro = talk('Intro call', { name: 'Bruno', email: 'bruno@example.com' });
  const coffee = talk('Coffee', { name: 'Cleo Marchetti' });
  const ringBack = talk('Ring back', { name: 'Ana Ruiz', phone: '+16135550190' });
  talk('Call Eve', { name: 'Eve' });
  talk('Catch up', { name: 'Kevin Tremblay' });
  const planning = talk('Planning', { name: 'Somebody Unknown' });
  await connect(alex);
  const listed = async (query = '') => (await dana.get(`/metaview/calls${query}`)).body;
  const all = await until(() => listed(), (page) => page.total === 6);
  const call = (title, page = all) => page.calls.find((c) => c.title === title);
  const shape = (m) => m && [m.application_id, m.name, m.job_title, m.client_name, m.how];
  assert.deepEqual(shape(call('Intro call').match), [book.bruno, 'Bruno Okafor', null, null, 'email']);
  assert.deepEqual(shape(call('Coffee').match), [book.cleo, 'Cleo Marchetti', null, null, 'name']);
  assert.deepEqual(shape(call('Ring back').match), [book.ana, 'Ana Ruiz', null, null, 'phone']);
  // A first name alone is only ever offered.
  assert.equal(call('Call Eve').match, null);
  assert.deepEqual(call('Call Eve').suggestions.map(shape), [[book.eve, 'Eve Lindqvist', null, null, 'name']]);
  // Kevin is on file twice, at a client and in The Book, and in progress in both: which is meant is the recruiter's call.
  assert.equal(call('Catch up').match, null);
  assert.deepEqual(call('Catch up').suggestions.map(shape).sort(), [[app.kevin, 'Kevin Tremblay', 'Senior Accountant', 'Maple Freight', 'name'], [book.kevin, 'Kevin Tremblay', null, null, 'name']].sort());
  assert.equal(call('Planning').match, null);
  assert.deepEqual((await listed('?show=unmatched')).calls.map((c) => c.title).sort(), ['Call Eve', 'Catch up', 'Planning']);

  // Their profile's Calls tab asks for the conversations that are theirs and not in The Book yet.
  const bruno = (await detail(dana, book.bruno)).candidate.id;
  const waiting = await listed(`?candidate_id=${bruno}&show=new`);
  assert.deepEqual(waiting.calls.map((c) => [c.id, c.match.candidate_id, c.call_id]), [[intro.id, bruno, null]]);

  // Brought in from their profile, it is a call in Otterview on their entry, with a line in their history.
  const opened = await dana.post(`/metaview/calls/${intro.id}/open`, { application_id: book.bruno });
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  const calls = (await dana.get(`/oracle/calls?application_id=${book.bruno}`)).body;
  assert.deepEqual(calls.map((c) => [c.id, c.source, c.candidate_name, c.job_title, c.client_name, c.title]), [[opened.body.call_id, 'metaview', 'Bruno Okafor', null, null, 'Intro call']]);
  assert.equal((await detail(dana, book.bruno)).activities.some((a) => a.type === 'call'), true);
  assert.deepEqual(shape(call('Intro call', await listed()).match), [book.bruno, 'Bruno Okafor', null, null, 'email']);
  book.brunoCall = opened.body.call_id;

  // A conversation that names nobody on file can be put on somebody who is on no job by hand.
  const chosen = await dana.post(`/metaview/calls/${planning.id}/open`, { application_id: book.eve });
  assert.equal(chosen.status, 200, JSON.stringify(chosen.body));
  assert.deepEqual(shape(call('Planning', await listed()).match), [book.eve, 'Eve Lindqvist', null, null, 'chosen']);
  book.planning = planning.id;

  // With "bring calls in by themselves" on, a conversation that an address ties to them alone arrives on their entry unasked.
  const later = talk('Follow-up', { name: 'Bruno Okafor', email: 'bruno@example.com' });
  assert.equal((await put(alex, '/metaview/settings', { auto: true })).status, 200);
  assert.equal((await dana.post('/metaview/refresh')).status, 202);
  const both = await until(async () => (await dana.get(`/oracle/calls?application_id=${book.bruno}`)).body, (rows) => rows.length === 2);
  assert.deepEqual(both.map((c) => [c.title, c.source, c.job_title]).sort(), [['Follow-up', 'metaview', null], ['Intro call', 'metaview', null]]);
  // By their number and by their name, the other two came in as well: each was certainly one person.
  const arrived = await until(() => listed('?show=new'), (page) => !page.calls.some((c) => c.title === 'Ring back'));
  assert.deepEqual(arrived.calls.map((c) => c.title).sort(), ['Call Eve', 'Catch up', 'Coffee']);
  assert.equal((await put(alex, '/metaview/settings', { auto: false })).status, 200);
  assert.ok(later.id && coffee.id && ringBack.id);
});

// ---------- the agency's alone ----------
test('a client user sees none of it, on any route', async () => {
  const cleo = (await detail(dana, book.cleo)).candidate.id;
  for (const who of [maya, noor]) {
    // The lists: no such people, however they are asked for.
    for (const query of ['', '?general=1', '?general=0', '?status=active', '?q=cleo', '?q=bruno', `?owner=${db(`SELECT id FROM users WHERE email = 'sam@agency.example'`)[0].id}`, '?sort=oldest', `?client_id=${client.northline}&general=1`]) {
      const rows = await list(who, query);
      assert.deepEqual(rows.filter((r) => r.general || r.job_id == null), [], query);
    }
    assert.deepEqual(await list(who, '?general=1'), []);
    // Their entries do not exist as far as a client user can tell.
    const notFound = [
      await who.get(`/applications/${book.cleo}`), await who.get(`/applications/${book.cleo}/resume`), await who.get(`/candidates/${cleo}/photo`),
      await who.patch(`/applications/${book.cleo}`, { rating: 3 }), await who.patch(`/applications/${book.cleo}`, { candidate: { name: 'X', email: 'x@example.com' } }),
      await who.post(`/applications/${book.cleo}/notes`, { body: 'hello' }), await who.post(`/applications/${book.cleo}/emails`, { subject: 's', body: 'b' }),
      await who.post(`/applications/${book.cleo}/move`, { stage_id: 1 }), await who.post(`/applications/${book.cleo}/reject`, {}), await who.post(`/applications/${book.cleo}/restore`),
      await who.post(`/applications/${book.cleo}/withdraw`, {}), await who.post(`/applications/${book.cleo}/review`, { decision: 'approved' }),
      await who.post('/interviews', { application_id: book.cleo, title: 'x', starts_at: '2099-03-01T15:00:00.000Z' }),
    ];
    for (const answer of notFound) {
      assert.equal(answer.status, 404, JSON.stringify(answer.body));
      assert.deepEqual(answer.body, { error: 'Not found' });
    }
    // What only the agency may do is refused before anything is looked up.
    const agencyOnly = [
      await who.upload('/applications', { name: 'From A Client', email: 'fromclient@example.com' }), await who.post(`/applications/${book.cleo}/add-to-job`, { job_id: job.accountant }),
      await who.post(`/applications/${book.cleo}/submit`, { note: 'x' }), await put(who, `/applications/${book.cleo}/offer`, { salary: 1 }), await who.del(`/applications/${book.cleo}`),
      await who.del(`/candidates/${cleo}`), await who.del(`/candidates/${cleo}/photo`), await who.post(`/candidates/${cleo}/merge`, { into: 1 }),
      await who.get('/candidates/lookup?email=cleo@example.com'), await who.get('/metaview/calls'), await who.get('/oracle/calls'), await who.get(`/oracle/calls/${book.cleoCall}`),
      await who.get(`/oracle/calls/${book.cleoCall}/audio`), await who.get(`/oracle/calls?application_id=${book.cleo}`), await who.get(`/metaview/calls?candidate_id=${cleo}&show=new`),
      await who.post(`/metaview/calls/${book.planning}/open`, { application_id: book.cleo }), await who.get('/metaview/status'),
    ];
    for (const answer of agencyOnly) {
      assert.equal(answer.status, 403, JSON.stringify(answer.body));
      assert.deepEqual(answer.body, { error: 'Only the agency team can do this.' });
    }
    // Nothing about them in what a client user is shown of the workspace.
    const everything = JSON.stringify([await who.get('/dashboard'), await who.get('/reports'), await who.get('/nav'), await who.get('/jobs'), await who.get('/clients'), await who.get('/interviews'),
      await who.get('/owners'), await who.get('/users'), await list(who)].map((r) => r.body ?? r));
    for (const name of ['Bruno', 'Cleo', 'Ana Ruiz Ortega', 'Eve Lindqvist', 'The Book']) assert.equal(everything.includes(name), false, name);
  }
  assert.equal(db(`SELECT COUNT(*) AS n FROM candidates WHERE email = 'fromclient@example.com'`)[0].n, 0);
  assert.equal((await detail(dana, book.cleo)).notes.length, 1);
  // Someone who is not signed in gets nowhere either.
  const stranger = session(api.base);
  for (const answer of [await stranger.get(`/applications/${book.cleo}`), await stranger.get('/applications?general=1'), await stranger.get(`/applications/${book.cleo}/resume`), await stranger.get(`/candidates/${cleo}/photo`)]) {
    assert.equal(answer.status, 401);
  }
});

test('jobs, clients, the dashboard, reports and the inbox answer exactly as they did before anyone was saved without a job', async () => {
  const now_ = await jobsAndClients();
  // Everything the hiring team at Maple sees, and everything the agency sees about Maple and its jobs, is word for word the same.
  for (const key of Object.keys(baseline)) {
    if (key.startsWith('maya ') || key.includes(`job_id=${job.accountant}`) || key.includes(`client_id=${client.maple}`) || key.endsWith(`/clients/${client.maple}`) || key.endsWith(`/jobs/${job.accountant}`)) {
      assert.deepEqual(now_[key], baseline[key], key);
    }
  }
  // One thing was done to a job since: Ana was added to Temp Receptionist the ordinary way, as a record of that
  // client. Across all clients, the agency's figures differ by that one application and by nothing else.
  const stats = (answers) => answers['alex /dashboard'].stats;
  assert.deepEqual(stats(now_), { ...stats(baseline), active_candidates: stats(baseline).active_candidates + 1, new_applicants: stats(baseline).new_applicants + 1 });
  assert.equal(now_['alex /reports'].totals.applicants, baseline['alex /reports'].totals.applicants + 1);
  assert.deepEqual(now_['alex /reports'].funnel.map((f) => f.count), baseline['alex /reports'].funnel.map((f, i) => f.count + (i === 0 ? 1 : 0)));
  assert.deepEqual(now_['alex /nav'], { ...baseline['alex /nav'], new_applicants: baseline['alex /nav'].new_applicants + 1 });
  assert.equal(now_['alex /applications?general=0'].length, baseline['alex /applications?general=0'].length + 1);
  assert.deepEqual(now_['alex /applications?stage_kind=applied'].map((r) => r.id).sort(), [...baseline['alex /applications?stage_kind=applied'].map((r) => r.id), app.anaTemp].sort());
  // Nobody saved without a job is in the dashboard's feed, its lists, or any job's or client's counts.
  const text_ = JSON.stringify([now_['alex /dashboard'], now_['alex /reports'], now_['alex /jobs'], now_['alex /clients'], now_['alex /interviews']]);
  for (const name of ['Bruno', 'Cleo', 'Eve Lindqvist', 'The Book']) assert.equal(text_.includes(name), false, name);
  const counts = (answers) => answers['alex /jobs'].map((j) => [j.id, j.total_applicants, j.active_candidates, j.new_applicants, j.interviewing, j.offers, j.hires]);
  assert.deepEqual(counts(now_).filter(([id]) => id !== job.temp), counts(baseline).filter(([id]) => id !== job.temp));
  assert.deepEqual(now_['alex /clients'].find((c) => c.id === client.maple), baseline['alex /clients'].find((c) => c.id === client.maple));
});

test('removing a job takes the people who were only in it, and leaves everyone saved without a job alone', async () => {
  const inBook = (await list(alex, '?general=1')).map((r) => r.id).sort((a, b) => a - b);
  const filesBefore = uploads();
  const tess = db('SELECT c.id, c.photo_file, a.resume_file FROM candidates c JOIN applications a ON a.candidate_id = c.id WHERE a.id = ?', app.onlyTemp)[0];
  assert.equal((await dana.del(`/jobs/${job.temp}`)).status, 403);     // only an admin removes a job
  assert.equal((await alex.del(`/jobs/${job.temp}`)).status, 200);
  await until(async () => uploads(), (now_) => !now_.includes(tess.photo_file) && !now_.includes(tess.resume_file));
  // Tess and Ana's record at that client went with the job, with Tess's files. Nothing else did.
  assert.equal(db('SELECT COUNT(*) AS n FROM candidates WHERE id = ?', tess.id)[0].n, 0);
  assert.equal(db(`SELECT COUNT(*) AS n FROM candidates WHERE email = 'ana.ruiz@example.com' AND client_id IS NOT NULL`)[0].n, 0);
  assert.deepEqual(uploads(), filesBefore.filter((f) => f !== tess.photo_file && f !== tess.resume_file));
  assert.deepEqual((await list(alex, '?general=1')).map((r) => r.id).sort((a, b) => a - b), inBook);
  const ana = await detail(dana, book.ana);
  assert.equal(ana.candidate.email, 'ana.ruiz@example.com');
  assert.equal((await dana.get(`/applications/${book.ana}/resume`)).body.toString(), 'Ana, payroll, second version');
  assert.equal((await dana.get(`/candidates/${ana.candidate.id}/photo`)).status, 200);
  assert.equal((await dana.get(`/oracle/calls/${book.cleoCall}`)).body.call.application_id, book.cleo);
});

// ---------- two entries of one person ----------
test('two entries that turn out to be one person are pointed out and can be merged into one', async () => {
  // Fay was saved from her profile, and again from an e-mail introduction, with nothing to connect the two.
  const first = await saved(dana, { name: 'Fay Adeyemi', linkedin: 'https://www.linkedin.com/in/fay-adeyemi', resume: resume('Fay, first', 'Fay.pdf'), note: 'From her profile.' });
  const second = await saved(sam, { name: 'Fay A.', email: 'fay@example.com', phone: '905 555 0133', resume: resume('Fay, second', 'Fay 2.pdf'), photo: { name: 'fay.png', bytes: PNG }, note: 'Introduced by e-mail.' });
  assert.notEqual(first, second);
  const call = (await dana.upload('/oracle/calls/upload', { audio: { name: 'call.webm', bytes: RECORDING }, consent: 'true', application_id: second })).body.id;
  // Her link is added to the second entry by hand, and each now shows the other as a possible duplicate.
  assert.equal((await dana.patch(`/applications/${second}`, { candidate: { name: 'Fay A.', email: 'fay@example.com', phone: '905 555 0133', linkedin: 'linkedin.com/in/fay-adeyemi' } })).status, 200);
  const one = await detail(dana, first), two = await detail(dana, second);
  assert.deepEqual(one.duplicates, [{ candidate_id: two.candidate.id, name: 'Fay A.', application_id: second, job_title: null, stage_name: null, status: 'active' }]);
  assert.deepEqual(two.duplicates.map((d) => d.application_id), [first]);
  // Kevin's two records share a link as well, but one is a client's and one is not: they are not offered to each other.
  assert.deepEqual((await detail(dana, book.kevin)).duplicates, []);
  assert.deepEqual((await detail(dana, app.kevin)).duplicates, []);
  const across = await dana.post(`/candidates/${(await detail(dana, book.kevin)).candidate.id}/merge`, { into: (await detail(dana, app.kevin)).candidate.id });
  assert.equal(across.status, 400);
  assert.match(across.body.error, /^One of these is in The Book without a job and the other is on a client’s record\./);

  const filesBefore = uploads();
  const merged = await dana.post(`/candidates/${two.candidate.id}/merge`, { into: one.candidate.id });
  assert.equal(merged.status, 200, JSON.stringify(merged.body));
  assert.deepEqual(merged.body, { ok: true, id: one.candidate.id });
  // One person, one entry: the one that was kept, with what was on both.
  assert.equal((await dana.get(`/applications/${second}`)).status, 404);
  assert.deepEqual(db('SELECT id FROM applications WHERE candidate_id = ?', one.candidate.id), [{ id: first }]);
  assert.equal(db('SELECT COUNT(*) AS n FROM candidates WHERE id = ?', two.candidate.id)[0].n, 0);
  const fay = await detail(dana, first);
  assert.deepEqual({ name: fay.candidate.name, email: fay.candidate.email, phone: fay.candidate.phone, link: fay.candidate.linkedin, client: fay.candidate.client_id },
    { name: 'Fay Adeyemi', email: 'fay@example.com', phone: '905 555 0133', link: 'https://www.linkedin.com/in/fay-adeyemi', client: null });
  assert.match(fay.candidate.photo, /^[a-f0-9]{8}$/);
  assert.equal(fay.application.general, true);
  assert.equal(fay.application.owner_name, 'Dana Recruiter');
  assert.deepEqual(fay.notes.map((n) => n.body).sort(), ['From her profile.', 'Introduced by e-mail.']);
  assert.deepEqual(fay.activities.map((a) => a.detail).sort(), ['Added to The Book (agency sourced)', 'Added to The Book (agency sourced)', 'Call added, 9 sec', "Merged with Fay A.'s record. That record also had: name Fay A."].sort());
  assert.deepEqual(fay.duplicates, []);
  // The kept entry keeps its own résumé, and the other is kept as an earlier résumé: no file is dropped. The call is on the kept entry.
  assert.equal((await dana.get(`/applications/${first}/resume`)).body.toString(), 'Fay, first');
  assert.deepEqual(fay.earlier_resumes.map((r) => r.name), ['Fay 2.pdf']);
  assert.equal((await dana.get(`/applications/${first}/resumes/${fay.earlier_resumes[0].id}`)).body.toString(), 'Fay, second');
  assert.deepEqual(uploads(), filesBefore);
  assert.deepEqual((await dana.get(`/oracle/calls?application_id=${first}`)).body.map((c) => c.id), [call]);
  assert.equal((await dana.get(`/oracle/calls/${call}`)).body.candidate.id, one.candidate.id);
  book.fay = first;
});

// ---------- removing them ----------
test('removing their entry removes the person, with their résumé, photo and recorded calls', async () => {
  const id = await saved(dana, { name: 'Gil Removed', email: 'gil@example.com', resume: resume('Gil'), photo: { name: 'gil.png', bytes: PNG } });
  const before_ = uploads();
  const candidateId = (await detail(dana, id)).candidate.id;
  const call = (await dana.upload('/oracle/calls/upload', { audio: { name: 'call.webm', bytes: RECORDING }, consent: 'true', application_id: id })).body.id;
  assert.equal(uploads().length, before_.length + 1);
  // Two conversations with them in Metaview: one brought in as a call on their entry, one still only listed.
  const inMetaview = [metaview.add({ person: { name: 'Gil Removed', email: 'gil@example.com' }, title: 'First call with Gil' }), metaview.add({ person: { name: 'Gil Removed', email: 'gil@example.com' }, title: 'Second call with Gil' })];
  assert.equal((await dana.post('/metaview/refresh')).status, 202);
  const theirs = async () => (await dana.get('/metaview/calls?q=gil')).body.calls.map((c) => c.id).sort();
  assert.deepEqual(await until(theirs, (ids) => ids.length === 2), inMetaview.map((c) => c.id).sort());
  const broughtIn = (await dana.post(`/metaview/calls/${inMetaview[0].id}/open`, { application_id: id })).body.call_id;
  assert.ok(broughtIn);
  const kept = (await list(alex, '?general=1')).map((r) => r.id).filter((x) => x !== id).sort((a, b) => a - b);
  assert.equal((await dana.del(`/applications/${id}`)).status, 200);
  assert.equal((await dana.get(`/applications/${id}`)).status, 404);
  assert.equal((await dana.get(`/oracle/calls/${call}`)).status, 404);
  assert.equal((await dana.get(`/oracle/calls/${broughtIn}`)).status, 404);
  assert.equal(db('SELECT COUNT(*) AS n FROM candidates WHERE id = ?', candidateId)[0].n, 0);
  // What The Book remembered about their conversations in Metaview goes with them, and reading Metaview again does not bring it back.
  assert.deepEqual(await theirs(), []);
  assert.deepEqual(db('SELECT id FROM metaview_forgotten ORDER BY id').map((r) => r.id), inMetaview.map((c) => c.id).sort());
  const readAt = () => db(`SELECT value FROM settings WHERE key = 'metaview_checked_at'`)[0]?.value;
  const lastRead = readAt();
  assert.equal((await dana.post('/metaview/refresh')).status, 202);
  await until(async () => readAt(), (at) => at !== lastRead);
  assert.deepEqual(await theirs(), []);
  assert.equal(db('SELECT COUNT(*) AS n FROM metaview_calls WHERE id IN (?, ?)', inMetaview[0].id, inMetaview[1].id)[0].n, 0);
  await until(async () => uploads(), (now_) => now_.length === before_.length - 2);   // the résumé, the photo and the call's audio are gone
  assert.deepEqual((await list(alex, '?general=1')).map((r) => r.id).sort((a, b) => a - b), kept);
  // "Delete candidate data" does the same from the person's side.
  const other = await saved(dana, { name: 'Hal Removed', email: 'hal@example.com', resume: resume('Hal') });
  assert.equal((await dana.del(`/candidates/${(await detail(dana, other)).candidate.id}`)).status, 200);
  assert.equal((await dana.get(`/applications/${other}`)).status, 404);
  await until(async () => uploads(), (now_) => now_.length === before_.length - 2);
  // The address is free again.
  assert.equal((await save(dana, { name: 'Gil Again', email: 'gil@example.com' })).body.known, false);
});

// ---------- putting them on a job ----------
test('put on a job, their entry becomes that job\'s application: same id, at the first stage unless one is chosen', async () => {
  const before_ = await detail(dana, book.cleo);
  const refusedFirst = [
    [await addToJob(dana, book.cleo, {}), 'Choose a job to add them to.'],
    [await addToJob(dana, book.cleo, { job_id: 99999 }), 'Choose a job to add them to.'],
    [await addToJob(dana, book.cleo, { job_id: job.accountant, stage_id: 99999 }), 'That stage does not belong to this job.'],
    [await addToJob(dana, book.cleo, { job_id: job.payroll, stage_id: job.accountantStages[1].id }), 'That stage does not belong to this job.'],
  ];
  for (const [answer, sentence] of refusedFirst) {
    assert.equal(answer.status, 400);
    assert.deepEqual(answer.body, { error: sentence });
  }
  assert.equal((await addToJob(dana, 99999, { job_id: job.accountant })).status, 404);
  assert.equal((await detail(dana, book.cleo)).application.general, true);

  const added = await addToJob(sam, book.cleo, { job_id: job.accountant });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.deepEqual(added.body, { id: book.cleo, merged: false });
  const cleo = await detail(dana, book.cleo);
  assert.equal(cleo.application.general, false);
  assert.deepEqual([cleo.job.id, cleo.job.title, cleo.client.name, cleo.application.status], [job.accountant, 'Senior Accountant', 'Maple Freight', 'active']);
  assert.equal(cleo.stages.find((s) => s.id === cleo.application.stage_id).name, 'Applied');
  assert.deepEqual([cleo.candidate.id, cleo.candidate.client_id], [before_.candidate.id, client.maple]);
  assert.equal(cleo.application.owner_name, 'Dana Recruiter');            // whoever owned them still does
  assert.equal(cleo.activities[0].detail, 'Added to Senior Accountant at Applied');
  assert.equal(cleo.activities[0].user_name, 'Sam Okoro');
  // The date they entered the job is now, not the day they were saved, so the job's figures count from here.
  assert.ok(cleo.application.applied_at > before_.application.applied_at);
  assert.equal(cleo.application.applied_at, cleo.application.stage_entered_at);
  assert.deepEqual(db('SELECT stage_id FROM stage_history WHERE application_id = ?', book.cleo), [{ stage_id: cleo.application.stage_id }]);
  // Everything that was on the entry is still on it: the résumé, the notes, the history, the photo, the call.
  assert.equal((await dana.get(`/applications/${book.cleo}/resume`)).body.toString(), 'Cleo, accountant');
  assert.deepEqual(cleo.notes.map((n) => n.id), before_.notes.map((n) => n.id));
  // The history and the e-mails from before the job read exactly as they did, in the same order. (They are the
  // agency's own from here on and are kept in its own tables, so only the agency is ever read them.)
  assert.deepEqual(cleo.activities.slice(1).map(line), before_.activities.map(line));
  assert.deepEqual(cleo.emails.map(mail), before_.emails.map(mail));
  assert.ok(before_.activities.length > 3 && before_.emails.length === 1);
  assert.deepEqual(db('SELECT detail FROM activities WHERE application_id = ?', book.cleo), [{ detail: 'Added to Senior Accountant at Applied' }]);
  assert.deepEqual(db('SELECT COUNT(*) AS n FROM emails WHERE application_id = ?', book.cleo), [{ n: 0 }]);
  assert.equal(cleo.candidate.photo, before_.candidate.photo);
  const call = (await dana.get(`/oracle/calls/${book.cleoCall}`)).body;
  assert.deepEqual([call.call.application_id, call.candidate.id, call.application.job_title, call.application.client_name], [book.cleo, before_.candidate.id, 'Senior Accountant', 'Maple Freight']);
  assert.equal(call.call.note_saved, true);
  // Now that there is a job, the write-up for its hiring team is no longer refused for want of one.
  assert.notDeepEqual((await dana.post(`/oracle/calls/${book.cleoCall}/submission`)).body, NEEDS_JOB);

  // They are in the job's lists and out of the list of people on no job, and what needs a job now works.
  assert.equal((await list(alex, '?general=1')).some((r) => r.id === book.cleo), false);
  const row = (await list(alex, `?job_id=${job.accountant}`)).find((r) => r.id === book.cleo);
  assert.deepEqual([row.general, row.job_title, row.client_name, row.stage_name, row.stage_kind], [false, 'Senior Accountant', 'Maple Freight', 'Applied', 'applied']);
  assert.equal((await dana.get('/candidates/lookup?email=cleo@example.com')).body[0].general, false);
  assert.equal((await dana.patch(`/applications/${book.cleo}`, { rating: 5 })).status, 200);
  assert.equal((await dana.post(`/applications/${book.cleo}/move`, { stage_id: job.accountantStages[1].id })).status, 200);
  const jobNow = (await alex.get(`/jobs/${job.accountant}`)).body.job;
  assert.deepEqual([jobNow.total_applicants, jobNow.interviewing], [baseline[`alex /jobs/${job.accountant}`].job.total_applicants + 1, baseline[`alex /jobs/${job.accountant}`].job.interviewing + 1]);

  // A chosen stage: straight to an interview stage, and straight to Hired.
  const hygienist = (await alex.get(`/jobs/${job.hygienist}`)).body.stages;
  const eve = await addToJob(alex, book.eve, { job_id: job.hygienist, stage_id: hygienist[2].id });
  assert.deepEqual(eve.body, { id: book.eve, merged: false });
  const eveNow = await detail(alex, book.eve);
  // Starting in an interview stage is the same news as being moved into one, so it has a line of its own after "Added".
  assert.deepEqual([eveNow.application.stage_id, eveNow.application.status, eveNow.activities.slice(0, 2).map((a) => [a.type, a.detail]), eveNow.candidate.client_id],
    [hygienist[2].id, 'active', [['stage_interview', `Started at ${hygienist[2].name}`], ['added', `Added to Hygienist at ${hygienist[2].name}`]], client.northline]);
  assert.equal(eveNow.application.owner_name, 'Lena Fischer');
  const placed = await saved(dana, { name: 'Ivo Placed', email: 'ivo@example.com' });
  assert.equal((await addToJob(dana, placed, { job_id: job.hygienist, stage_id: hygienist.at(-1).id })).status, 200);
  const ivo = await detail(dana, placed);
  assert.deepEqual([ivo.application.status, ivo.application.hired_at, ivo.activities.slice(0, 2).map((a) => [a.type, a.detail])],
    ['hired', ivo.application.applied_at, [['hired', 'Marked as hired'], ['added', 'Added to Hygienist at Hired']]]);
  // The Metaview conversation Eve was chosen for still names her, now with her job.
  const planning = (await dana.get('/metaview/calls')).body.calls.find((c) => c.id === book.planning);
  assert.deepEqual([planning.match.application_id, planning.match.job_title, planning.match.client_name, planning.match.how], [book.eve, 'Hygienist', 'Northline Dental', 'chosen']);
});

test('once they are on a client\'s job, the hiring team sees them from that moment on, and nothing written before', async () => {
  // Cleo is at Maple now. Maya, at Maple, can open her; Noor, at Northline, cannot.
  assert.equal((await noor.get(`/applications/${book.cleo}`)).status, 404);
  const seen = (await maya.get(`/applications/${book.cleo}`)).body;
  assert.equal(seen.candidate.name, 'Cleo Marchetti');
  assert.equal(seen.application.general, false);
  assert.equal('general_until' in seen.application, false);
  // The agency's notes, the e-mail sent while she was on no job, and her earlier history stay with the agency.
  assert.deepEqual(seen.notes, []);
  assert.deepEqual(seen.emails, []);
  assert.deepEqual(seen.activities.map((a) => a.detail), ['Moved to Recruiter screen', 'Added to Senior Accountant at Applied']);
  const whole = await detail(dana, book.cleo);
  assert.equal(whole.notes.length, 1);
  assert.equal(whole.emails.length, 1);
  assert.ok(whole.activities.length > 4);
  assert.ok(whole.application.general_until);
  // What happens from here on is shown as for anyone in a pipeline.
  assert.equal((await dana.post(`/applications/${book.cleo}/notes`, { body: 'Available from January.', private: false })).status, 200);
  assert.equal((await dana.post(`/applications/${book.cleo}/emails`, { subject: 'Interview at Maple', body: 'Hi Cleo' })).status, 200);
  assert.equal((await maya.post(`/applications/${book.cleo}/notes`, { body: 'Looks good to us.' })).status, 200);
  const later = (await maya.get(`/applications/${book.cleo}`)).body;
  assert.deepEqual(later.notes.map((n) => n.body).sort(), ['Available from January.', 'Looks good to us.']);
  assert.deepEqual(later.emails.map((e) => e.subject), ['Interview at Maple']);
  assert.deepEqual(later.activities.map((a) => a.detail), ['Emailed candidate: Interview at Maple', 'Moved to Recruiter screen', 'Added to Senior Accountant at Applied']);
  // The dashboard's feed for the client holds nothing from before either.
  const feed = (await maya.get('/dashboard')).body.recent.filter((r) => r.application_id === book.cleo).map((r) => r.detail);
  assert.deepEqual(feed, ['Emailed candidate: Interview at Maple', 'Moved to Recruiter screen', 'Added to Senior Accountant at Applied']);
  assert.equal(JSON.stringify((await maya.get('/dashboard')).body).includes('The Book'), false);
});

test('a job the person is already in, and a client that already has a record of them, are both put to the recruiter', async () => {
  // Kevin's entry in The Book has the address of Maple's own record of Kevin, who is in Senior Accountant.
  const there = await addToJob(dana, book.kevin, { job_id: job.accountant });
  assert.equal(there.status, 409);
  // The answer names the record that is in the job, so the screen can offer to join the entry to it (tested further down).
  const kevinAtMaple = (await detail(dana, app.kevin)).candidate.id;
  assert.deepEqual(there.body, {
    error: 'Kevin Tremblay is already in the pipeline for Senior Accountant (Recruiter screen).', code: 'already_in_job', id: app.kevin, join: { candidate_id: kevinAtMaple, name: 'Kevin Tremblay' },
  });
  assert.equal((await detail(dana, book.kevin)).application.general, true);

  // Another job at Maple: the client has a record of him, so nothing is done until the recruiter says to join them.
  const asked = await addToJob(dana, book.kevin, { job_id: job.payroll });
  assert.equal(asked.status, 409);
  assert.deepEqual(asked.body, {
    error: 'Maple Freight already has a record of Kevin Tremblay. Join this entry to that record to add them to Payroll Specialist.', code: 'duplicate_in_client',
    matches: [{ candidate_id: kevinAtMaple, name: 'Kevin Tremblay', application_id: app.kevin, job_title: 'Senior Accountant', stage_name: 'Recruiter screen' }],
  });
  assert.equal((await detail(dana, book.kevin)).application.general, true);
  // A record that is not one of the matches is refused, whoever's it is.
  const priyaAtMaple = (await detail(dana, app.priya)).candidate.id;
  for (const into of [priyaAtMaple, 99999, (await detail(dana, book.kevin)).candidate.id]) {
    const wrong = await addToJob(dana, book.kevin, { job_id: job.payroll, into });
    assert.equal(wrong.status, 400, JSON.stringify(wrong.body));
    assert.deepEqual(wrong.body, { error: "The record you chose is not one of Maple Freight's records of this person. Go back and choose again." });
  }
  // At a client with no record of him there is nothing to ask: Northline has never heard of Kevin.
  const elsewhere = await saved(dana, { name: 'Kevin Tremblay Jr', email: 'kevin.jr@example.com' });
  assert.deepEqual((await addToJob(dana, elsewhere, { job_id: job.hygienist })).body, { id: elsewhere, merged: false });
});

test('joined to the client\'s record, the entry moves there with its notes, résumé, photo, calls and history', async () => {
  const general = await detail(dana, book.kevin);
  const kevinAtMaple = (await detail(dana, app.kevin)).candidate.id;
  // Give the entry something of everything first.
  assert.equal((await dana.post(`/applications/${book.kevin}/notes`, { body: 'Prefers contract roles.' })).status, 200);
  const again = await save(dana, { name: 'Kevin Tremblay', email: 'kevin.tremblay@example.com', resume: resume('Kevin, controller', 'Kevin.pdf'), photo: { name: 'kevin.png', bytes: PNG }, location: 'Ottawa' });
  assert.equal(again.body.id, book.kevin);
  const call = (await dana.upload('/oracle/calls/upload', { audio: { name: 'call.webm', bytes: RECORDING }, consent: 'true', application_id: book.kevin })).body.id;
  assert.equal((await dana.patch(`/oracle/calls/${call}`, { notes: 'Notice period is a month.' })).status, 200);
  assert.equal((await dana.post(`/oracle/calls/${call}/save-note`)).status, 200);
  const filesBefore = uploads();
  const historyBefore = (await detail(dana, book.kevin)).activities.map(line);

  const joined = await addToJob(dana, book.kevin, { job_id: job.payroll, stage_id: (await alex.get(`/jobs/${job.payroll}`)).body.stages[1].id, into: kevinAtMaple });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  assert.deepEqual(joined.body, { id: book.kevin, merged: true });
  // One Kevin at Maple, in two jobs. The record of him that belonged to no client is gone.
  assert.equal(db('SELECT COUNT(*) AS n FROM candidates WHERE id = ?', general.candidate.id)[0].n, 0);
  assert.deepEqual(db('SELECT id FROM applications WHERE candidate_id = ? ORDER BY id', kevinAtMaple).map((r) => r.id), [app.kevin, book.kevin].sort((a, b) => a - b));
  const kevin = await detail(dana, book.kevin);
  assert.deepEqual([kevin.candidate.id, kevin.candidate.client_id, kevin.job.title, kevin.application.general], [kevinAtMaple, client.maple, 'Payroll Specialist', false]);
  assert.deepEqual(kevin.others.map((o) => [o.id, o.job_title]), [[app.kevin, 'Senior Accountant']]);
  // The client's record keeps its own details and takes what it lacked: here the location and the photo.
  assert.deepEqual([kevin.candidate.location, kevin.candidate.phone, kevin.candidate.email], ['Ottawa', '(416) 555-0142', 'kevin.tremblay@example.com']);
  assert.match(kevin.candidate.photo, /^[a-f0-9]{8}$/);
  assert.deepEqual(uploads(), filesBefore);                              // the photo moved with him; no file was dropped
  // Everything on the entry came with it.
  assert.equal((await dana.get(`/applications/${book.kevin}/resume`)).body.toString(), 'Kevin, controller');
  assert.deepEqual(kevin.notes.map((n) => [n.body, n.private]).sort(), [['Notes from Call with Kevin Tremblay\n\nNotice period is a month.', 1], ['Prefers contract roles.', 1]]);
  assert.deepEqual(kevin.activities.slice(0, 3).map((a) => a.detail).sort(), ['Added to Payroll Specialist at Recruiter screen', "Joined to Kevin Tremblay's record at Maple Freight", 'Started at Recruiter screen']);
  assert.deepEqual(kevin.activities.slice(3).map(line), historyBefore);
  const moved = (await dana.get(`/oracle/calls/${call}`)).body;
  assert.deepEqual([moved.call.application_id, moved.candidate.id, moved.application.job_title, moved.call.note_saved], [book.kevin, kevinAtMaple, 'Payroll Specialist', true]);
  assert.deepEqual((await dana.get(`/oracle/calls?candidate_id=${kevinAtMaple}`)).body.map((c) => c.id), [call]);
  // The hiring team sees the entry from here on only.
  const seen = (await maya.get(`/applications/${book.kevin}`)).body;
  assert.deepEqual([seen.notes, seen.emails], [[], []]);
  // That he was joined from an entry in The Book is the agency's business: the hiring team is not shown that line.
  assert.deepEqual(seen.activities.map((a) => a.detail), ['Started at Recruiter screen', 'Added to Payroll Specialist at Recruiter screen']);
  assert.equal((await maya.get('/dashboard')).body.recent.some((r) => /Joined to/.test(r.detail)), false);
  assert.deepEqual(seen.earlier_resumes, []);
  // The address is free for somebody to be saved without a job again.
  assert.equal((await dana.get('/candidates/lookup?email=kevin.tremblay@example.com')).body.some((k) => k.general), false);
});

test('a link is enough for the client to count as having a record, and a record with no photo takes the entry\'s', async () => {
  // Priya is at Maple with a LinkedIn link. In The Book she is saved under another address, with the same link.
  const entry = await saved(dana, { name: 'Priya N.', email: 'priya.personal@example.com', linkedin: 'https://www.linkedin.com/in/priya-nair', photo: { name: 'priya.png', bytes: PNG }, current_title: 'Payroll Manager' });
  const priyaAtMaple = (await detail(dana, app.priya)).candidate.id;
  const inJob = await addToJob(dana, entry, { job_id: job.payroll });
  assert.deepEqual([inJob.status, inJob.body.code, inJob.body.id], [409, 'already_in_job', app.priya]);
  const asked = await addToJob(dana, entry, { job_id: job.accountant });
  assert.deepEqual([asked.status, asked.body.code, asked.body.matches.map((m) => m.candidate_id)], [409, 'duplicate_in_client', [priyaAtMaple]]);
  const filesBefore = uploads();
  assert.deepEqual((await addToJob(dana, entry, { job_id: job.accountant, into: priyaAtMaple })).body, { id: entry, merged: true });
  const priya = await detail(dana, entry);
  assert.deepEqual([priya.candidate.id, priya.candidate.name, priya.candidate.email, priya.candidate.current_title], [priyaAtMaple, 'Priya Nair', 'priya.nair@example.org', 'Payroll Manager']);
  assert.match(priya.candidate.photo, /^[a-f0-9]{8}$/);
  assert.deepEqual(uploads(), filesBefore);
  // The name and address she was saved under in The Book are not on Maple's record, so the history keeps them.
  assert.ok(priya.activities.some((a) => a.detail === "Joined to Priya Nair's record at Maple Freight. Their entry in The Book also had: name Priya N., email priya.personal@example.com"));
});

test('somebody already on a job is added to another job of the same client as a new application, and not to another client\'s', async () => {
  // Bruno goes on Senior Accountant from The Book, with a résumé; then on Payroll Specialist from there.
  assert.equal((await save(sam, { name: 'Bruno Okafor', email: 'bruno@example.com', resume: resume('Bruno, finance director', 'Bruno.pdf') })).body.id, book.bruno);
  assert.deepEqual((await addToJob(sam, book.bruno, { job_id: job.accountant })).body, { id: book.bruno, merged: false });
  const payroll = (await alex.get(`/jobs/${job.payroll}`)).body.stages;
  const filesBefore = uploads();
  const second = await addToJob(dana, book.bruno, { job_id: job.payroll, stage_id: payroll[1].id });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.merged, false);
  assert.notEqual(second.body.id, book.bruno);
  const one = await detail(dana, book.bruno), two = await detail(dana, second.body.id);
  assert.equal(two.candidate.id, one.candidate.id);
  assert.deepEqual([two.job.title, two.application.status, two.application.source, two.application.owner_name], ['Payroll Specialist', 'active', 'agency_sourced', 'Dana Recruiter']);
  assert.equal(two.stages.find((s) => s.id === two.application.stage_id).name, payroll[1].name);
  assert.deepEqual(two.activities.map((a) => a.detail), [`Started at ${payroll[1].name}`, `Added to Payroll Specialist at ${payroll[1].name}`]);
  assert.deepEqual(two.notes, []);                                       // a new application starts with a history of its own
  assert.deepEqual(two.others.map((o) => o.id), [book.bruno]);
  assert.deepEqual([one.job.title, one.application.general], ['Senior Accountant', false]);
  // The résumé goes with them as a copy: removing one application leaves the other's file.
  assert.equal(uploads().length, filesBefore.length + 1);
  assert.equal((await dana.get(`/applications/${second.body.id}/resume`)).body.toString(), 'Bruno, finance director');
  assert.equal((await dana.del(`/applications/${second.body.id}`)).status, 200);
  await until(async () => uploads(), (now_) => now_.length === filesBefore.length);
  assert.equal((await dana.get(`/applications/${book.bruno}/resume`)).body.toString(), 'Bruno, finance director');
  // The call placed to him earlier is still on his first application.
  assert.equal((await dana.get(`/oracle/calls/${book.brunoCall}`)).body.call.application_id, book.bruno);

  // Twice in one job is refused, and so is a job at another client, each with a sentence that says why.
  const twice = await addToJob(dana, book.bruno, { job_id: job.accountant });
  assert.equal(twice.status, 409);
  assert.deepEqual(twice.body, { error: 'Bruno Okafor is already in the pipeline for Senior Accountant (Applied).', code: 'already_in_job', id: book.bruno });
  const filesNow = uploads();
  const other = await addToJob(dana, book.bruno, { job_id: job.hygienist });
  assert.equal(other.status, 400);
  assert.deepEqual(other.body, { error: "Bruno Okafor is on Maple Freight's record, and Hygienist is a job at Northline Dental. Each client keeps its own record of a person, so add them to that job as a new candidate." });
  assert.deepEqual(uploads(), filesNow);
  assert.equal(db('SELECT COUNT(*) AS n FROM applications WHERE candidate_id = ?', one.candidate.id)[0].n, 1);
});

test('the extension puts somebody who is in The Book on a job by moving their entry: what was typed is saved onto it first, and no second record is made', async () => {
  // Saved from her LinkedIn profile with a note and a photo, and no job.
  const link = 'https://www.linkedin.com/in/wanjiru-kamau-okello';
  const id = await saved(sam, { name: 'Wanjiru Kamau-Okello', linkedin: link, source: 'linkedin', note: 'Found while sourcing for payroll roles.', note_private: 'true', photo: { name: 'photo.png', bytes: PNG } });
  // Later the recruiter opens the same profile, chooses a job and types a second note. The popup sends the form
  // without the job (so the note lands on the entry she has), then asks for that entry to be put on the job.
  const lookup = (await sam.get(`/candidates/lookup?linkedin=${encodeURIComponent(link)}`)).body;
  assert.deepEqual(lookup.map((r) => [r.application_id, r.general, r.job_id]), [[id, true, null]]);
  const again = await save(sam, { name: 'Wanjiru Kamau-Okello', linkedin: link, source: 'linkedin', note: 'Maple are hiring: she fits.', note_private: 'true', current_title: 'Payroll Lead' });
  assert.deepEqual(again.body, { id, known: true, merged: true, name: 'Wanjiru Kamau-Okello', general: true });
  const payroll = (await alex.get(`/jobs/${job.payroll}`)).body.stages;
  assert.deepEqual((await addToJob(sam, id, { job_id: job.payroll, stage_id: payroll[1].id })).body, { id, merged: false });

  const now_ = await detail(sam, id);
  assert.deepEqual([now_.application.general, now_.job.title, now_.client.id, now_.candidate.current_title], [false, 'Payroll Specialist', client.maple, 'Payroll Lead']);
  assert.equal(now_.stages.find((s) => s.id === now_.application.stage_id).name, payroll[1].name);
  assert.deepEqual(now_.notes.map((n) => [n.body, n.private]).sort(), [['Found while sourcing for payroll roles.', 1], ['Maple are hiring: she fits.', 1]]);
  assert.equal(typeof now_.candidate.photo, 'string');
  // One record of her, in one place: nothing is left in The Book without a job, and the client has no second record.
  assert.deepEqual((await list(sam, '?status=all&q=Wanjiru')).map((r) => [r.id, r.general, r.job_title]), [[id, false, 'Payroll Specialist']]);
  assert.equal(db('SELECT COUNT(*) AS n FROM candidates WHERE linkedin = ?', link)[0].n, 1);
  // The hiring team sees her on the job, and neither of the notes written for the agency.
  const theirs = await detail(maya, id);
  assert.deepEqual([theirs.job.title, theirs.notes.length, theirs.activities.map((a) => a.detail)], ['Payroll Specialist', 0, [`Started at ${payroll[1].name}`, `Added to Payroll Specialist at ${payroll[1].name}`]]);
});

// ---------- what the reviews found ----------
test('adding somebody who is in The Book to a job in the ordinary way puts their entry on the job: no second record is made', async () => {
  // Saved without a job, with a note, a résumé and a photo. Then added to a job with the Add candidate form (or by an
  // extension from before this was built), which knows nothing about her entry.
  const id = await saved(dana, { name: 'Marisol Etxeberria', email: 'marisol@example.com', linkedin: 'https://www.linkedin.com/in/marisol-etxeberria', phone: '416 555 0111',
    note: 'Strong on renewals.', resume: resume('Marisol, first', 'Marisol.pdf'), photo: { name: 'm.png', bytes: PNG } });
  const stages = (await alex.get(`/jobs/${job.payroll}`)).body.stages;
  const added = await sam.upload('/applications', { job_id: job.payroll, stage_id: stages[1].id, name: 'Marisol Etxeberria', email: 'marisol@example.com', current_title: 'Account Director', note: 'Maple want to meet her.', note_private: 'true' });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.deepEqual(added.body, { id, known: true, merged: true, name: 'Marisol Etxeberria', general: false, moved: true, joined: false });
  assert.equal(db(`SELECT COUNT(*) AS n FROM candidates WHERE email = 'marisol@example.com'`)[0].n, 1);
  assert.deepEqual((await list(alex, '?status=all&q=Marisol')).map((r) => [r.id, r.general, r.job_title]), [[id, false, 'Payroll Specialist']]);
  const now_ = await detail(dana, id);
  assert.deepEqual([now_.job.title, now_.client.id, now_.stages.find((s) => s.id === now_.application.stage_id).name, now_.candidate.phone, now_.candidate.current_title, now_.application.owner_name, now_.application.resume_name],
    ['Payroll Specialist', client.maple, stages[1].name, '416 555 0111', 'Account Director', 'Dana Recruiter', 'Marisol.pdf']);
  assert.deepEqual(now_.notes.map((n) => [n.body, n.private]).sort(), [['Maple want to meet her.', 1], ['Strong on renewals.', 1]]);
  assert.deepEqual(now_.activities.map((a) => a.detail), [`Started at ${stages[1].name}`, `Added to Payroll Specialist at ${stages[1].name}`, 'Added to The Book (agency sourced)']);
  assert.equal(now_.application.from_book, true);
  // The hiring team sees her from the moment she joined the job.
  const theirs = await detail(maya, id);
  assert.deepEqual([theirs.notes, theirs.emails, theirs.activities.map((a) => a.detail)], [[], [], [`Started at ${stages[1].name}`, `Added to Payroll Specialist at ${stages[1].name}`]]);
  // Added again, she is already in the job, and nothing is made.
  const twice = await sam.upload('/applications', { job_id: job.payroll, name: 'Marisol Etxeberria', email: 'marisol@example.com' });
  assert.deepEqual([twice.status, twice.body.error], [409, `Marisol Etxeberria is already in the pipeline for this job (${stages[1].name}).`]);

  // Found by LinkedIn link alone, with a newer résumé: the one on the entry is kept as an earlier résumé, which
  // only the agency is told about.
  const other = await saved(dana, { name: 'Teodor Blackwood', linkedin: 'https://www.linkedin.com/in/teodor-blackwood', resume: resume('Teodor, old', 'Teodor 2023.pdf') });
  const byLink = await dana.upload('/applications', { job_id: job.accountant, name: 'Teodor Blackwood', linkedin: 'https://linkedin.com/in/teodor-blackwood/', resume: resume('Teodor, new', 'Teodor 2026.pdf') });
  assert.deepEqual(byLink.body, { id: other, known: true, merged: true, name: 'Teodor Blackwood', general: false, moved: true, joined: false, resume: 'replaced' });
  const teodor = await detail(dana, other);
  assert.deepEqual([teodor.application.resume_name, teodor.earlier_resumes.map((r) => r.name)], ['Teodor 2026.pdf', ['Teodor 2023.pdf']]);
  assert.equal((await dana.get(`/applications/${other}/resumes/${teodor.earlier_resumes[0].id}`)).body.toString(), 'Teodor, old');
  // Under the line that says she is on the job, the agency is told how he was found and what became of his résumé.
  assert.deepEqual(teodor.activities.map((a) => a.detail), ['Added to Senior Accountant at Applied',
    'Recognised as Teodor Blackwood by LinkedIn link: their entry in The Book was put on the job',
    'A newer résumé was added. The one they had (Teodor 2023.pdf) is kept under Earlier résumés', 'Added to The Book (agency sourced)']);
  const seen = await detail(maya, other);
  assert.deepEqual([seen.application.resume_name, seen.earlier_resumes, seen.activities.map((a) => a.detail)], ['Teodor 2026.pdf', [], ['Added to Senior Accountant at Applied']]);
  assert.equal((await maya.get(`/applications/${other}/resumes/${teodor.earlier_resumes[0].id}`)).status, 403);
  assert.equal((await maya.get(`/applications/${other}/resume`)).body.toString(), 'Teodor, new');
});

test('added to a job at a client that already has a record of them, their entry in The Book joins that record', async () => {
  // Omar is on Northline's record (hired as Hygienist). He is also in The Book, under the same address.
  const omarAtNorthline = (await detail(sam, app.omar)).candidate.id;
  const entry = await saved(dana, { name: 'Omar Haddad', email: 'omar@example.com', phone: '613 555 0101', note: 'Would move for the right practice.' });
  const reception = (await alex.post('/jobs', { client_id: client.northline, title: 'Practice Manager', status: 'open' })).body.id;
  job.practice = reception;
  const added = await sam.upload('/applications', { job_id: reception, name: 'Omar Haddad', email: 'omar@example.com' });
  assert.deepEqual(added.body, { id: entry, known: true, merged: true, name: 'Omar Haddad', general: false, moved: true, joined: true });
  const omar = await detail(dana, entry);
  assert.deepEqual([omar.candidate.id, omar.candidate.phone, omar.job.title, omar.others.map((o) => [o.id, o.job_id])], [omarAtNorthline, '613 555 0101', 'Practice Manager', [[app.omar, job.hygienist]]]);
  assert.deepEqual(omar.notes.map((n) => [n.body, n.private]), [['Would move for the right practice.', 1]]);
  assert.equal(db(`SELECT COUNT(*) AS n FROM candidates WHERE email = 'omar@example.com'`)[0].n, 1);
  assert.deepEqual((await detail(noor, entry)).activities.map((a) => a.detail), ['Added to Practice Manager at Applied']);
});

test('found by their link, an entry whose own address is on a record at the client joins that record instead of clashing with it', async () => {
  // In The Book with a link and an address. Northline knows the same person by that address alone. The form sent
  // now carries only the link, so nothing typed matches Northline's record: the entry's own address does.
  const atClient = await sam.upload('/applications', { job_id: job.hygienist, name: 'Petra Novak', email: 'petra@example.com' });
  const record = (await detail(sam, atClient.body.id)).candidate.id;
  const entry = await saved(dana, { name: 'Petra Novak', email: 'petra@example.com', linkedin: 'https://www.linkedin.com/in/petra-novak', note: 'Knows the practice software.' });
  const added = await dana.upload('/applications', { job_id: job.practice, name: 'Petra Novak', linkedin: 'https://www.linkedin.com/in/petra-novak' });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.deepEqual(added.body, { id: entry, known: true, merged: true, name: 'Petra Novak', general: false, moved: true, joined: true });
  const petra = await detail(dana, entry);
  assert.deepEqual([petra.candidate.id, petra.candidate.linkedin, petra.job.title, petra.notes.map((n) => n.body)], [record, 'https://www.linkedin.com/in/petra-novak', 'Practice Manager', ['Knows the practice software.']]);
  assert.ok(petra.activities.some((a) => a.detail === 'Recognised as Petra Novak by the email address on their entry in The Book, and added to their existing record'));
  assert.equal(db(`SELECT COUNT(*) AS n FROM candidates WHERE email = 'petra@example.com'`)[0].n, 1);
  // The hiring team is told she was added to the job, and nothing about The Book or how she was matched.
  const theirs = await detail(noor, entry);
  assert.deepEqual(theirs.activities.map((a) => a.detail), ['Added to Practice Manager at Applied']);
  assert.equal(JSON.stringify(theirs).includes('The Book'), false);
  // The same, when the client's record under that address is plainly somebody else: nothing is joined, the entry
  // stays in The Book, and the client gets a record of its own for the person who was typed.
  await sam.upload('/applications', { job_id: job.hygienist, name: 'Somebody Else', email: 'shared@example.com' });
  const kept = await saved(dana, { name: 'Quentin Abara', email: 'shared.q@example.com', linkedin: 'https://www.linkedin.com/in/quentin-abara' });
  assert.equal((await dana.patch(`/applications/${kept}`, { candidate: { name: 'Quentin Abara', email: 'shared@example.com', linkedin: 'https://www.linkedin.com/in/quentin-abara' } })).status, 200);
  const apart = await dana.upload('/applications', { job_id: job.practice, name: 'Quentin Abara', linkedin: 'https://www.linkedin.com/in/quentin-abara' });
  assert.deepEqual(apart.body, { id: apart.body.id, known: false, merged: false, name: 'Quentin Abara', general: false });
  assert.notEqual(apart.body.id, kept);
  assert.equal((await detail(dana, kept)).application.general, true);
});

test('what an entry had that the client\'s record did not take is written in the history, for the agency only', async () => {
  // The Book knows Lena by her LinkedIn link, with a private address and number. Northline's record of her has its own.
  const atClient = await sam.upload('/applications', { job_id: job.hygienist, name: 'Lena Fischer', email: 'lena@northline-mail.example', phone: '416-555-0001', location: 'Client City', linkedin: 'https://www.linkedin.com/in/lena-fischer' });
  const entry = await saved(dana, { name: 'Lena Fischer', email: 'lena.private@example.com', phone: '647-555-0002', location: 'Book City', linkedin: 'https://www.linkedin.com/in/lena-fischer', current_title: 'Hygienist' });
  const record = (await detail(sam, atClient.body.id)).candidate.id;
  assert.deepEqual((await addToJob(dana, entry, { job_id: job.practice, into: record })).body, { id: entry, merged: true });
  const lena = await detail(dana, entry);
  assert.deepEqual([lena.candidate.email, lena.candidate.phone, lena.candidate.location, lena.candidate.current_title], ['lena@northline-mail.example', '416-555-0001', 'Client City', 'Hygienist']);
  assert.deepEqual(lena.activities.slice(0, 2).map((a) => a.detail).sort(), [
    'Added to Practice Manager at Applied',
    "Joined to Lena Fischer's record at Northline Dental. Their entry in The Book also had: email lena.private@example.com, phone 647-555-0002, location Book City",
  ]);
  const theirs = await detail(noor, entry);
  assert.deepEqual(theirs.activities.map((a) => a.detail), ['Added to Practice Manager at Applied']);
  assert.equal(JSON.stringify(theirs).includes('lena.private@example.com'), false);
});

test('the hiring team is not shown when the agency first saved somebody, nor a covering note saved with their entry', async () => {
  const entry = await saved(dana, { name: 'Greta Lindqvist', email: 'greta@example.com', cover_note: 'Agency eyes only: met at a conference.' });
  const person = db('SELECT c.id, c.created_at FROM candidates c JOIN applications a ON a.candidate_id = c.id WHERE a.id = ?', entry)[0];
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.deepEqual((await addToJob(dana, entry, { job_id: job.practice })).body, { id: entry, merged: false });
  // The agency still has the covering note, as a note only it can read: it is no longer on the application at all.
  const ours = await detail(dana, entry);
  assert.deepEqual([ours.candidate.created_at, ours.application.cover_note, ours.notes.map((n) => [n.body, n.private])],
    [person.created_at, null, [['Saved with their entry in The Book: Agency eyes only: met at a conference.', 1]]]);
  assert.deepEqual(db('SELECT cover_note FROM applications WHERE id = ?', entry), [{ cover_note: null }]);
  const theirs = await detail(noor, entry);
  assert.equal(theirs.application.cover_note, null);
  assert.equal(theirs.candidate.created_at, theirs.application.applied_at);
  assert.ok(theirs.candidate.created_at > person.created_at);
  assert.equal('general_until' in theirs.application, false);
  assert.equal('from_book' in theirs.application, false);
  // Somebody who was never in The Book is shown as before.
  const ordinary = await detail(noor, app.omar);
  assert.equal(ordinary.candidate.created_at, db('SELECT created_at FROM candidates WHERE id = ?', ordinary.candidate.id)[0].created_at);
});

test('a client record with no application still counts as their record, and the entry can be joined to it', async () => {
  // Such a record cannot be made through the app, but an older database may hold one: it is written straight in.
  const direct = new DatabaseSync(path.join(dataDir, 'app.db'));
  direct.exec('PRAGMA busy_timeout = 2000');
  const record = Number(direct.prepare(`INSERT INTO candidates (client_id, name, email, created_at) VALUES (?, 'Noa Appless', 'noapp@example.com', ?)`).run(client.northline, new Date().toISOString()).lastInsertRowid);
  direct.close();
  const entry = await saved(dana, { name: 'Noa Appless', email: 'noapp@example.com', note: 'Kept in The Book.' });
  const asked = await addToJob(dana, entry, { job_id: job.practice });
  assert.equal(asked.status, 409);
  assert.deepEqual(asked.body, {
    error: 'Northline Dental already has a record of Noa Appless. Join this entry to that record to add them to Practice Manager.', code: 'duplicate_in_client',
    matches: [{ candidate_id: record, name: 'Noa Appless', application_id: null, job_title: null, stage_name: null }],
  });
  assert.deepEqual((await addToJob(dana, entry, { job_id: job.practice, into: record })).body, { id: entry, merged: true });
  const noa = await detail(dana, entry);
  assert.deepEqual([noa.candidate.id, noa.job.title, noa.notes.map((n) => n.body)], [record, 'Practice Manager', ['Kept in The Book.']]);
});

test('when the client\'s record is already in the job, the entry is joined to the application it has there, and its history stays with the agency', async () => {
  // Ilse applied to Practice Manager herself (a record at Northline), and is also in The Book with notes, an e-mail,
  // a résumé and a call. Northline has only this one job to put her on.
  const applied = await sam.upload('/applications', { job_id: job.practice, name: 'Ilse Brandt', email: 'ilse@example.com', resume: resume('Ilse, as she applied', 'Ilse applied.pdf'), note: 'Applied through the site.', note_private: 'false' });
  const entry = await saved(dana, { name: 'Ilse Brandt', email: 'ilse@example.com', phone: '905 555 0144', resume: resume('Ilse, from The Book', 'Ilse book.pdf'), note: 'Salary expectations are high.', cover_note: 'Kept with her entry.' });
  assert.equal((await dana.post(`/applications/${entry}/emails`, { subject: 'Keeping in touch', body: 'Hi Ilse' })).status, 200);
  const call = (await dana.upload('/oracle/calls/upload', { audio: { name: 'call.webm', bytes: RECORDING }, consent: 'true', application_id: entry })).body.id;
  const record = (await detail(sam, applied.body.id)).candidate.id;
  const bookPerson = (await detail(dana, entry)).candidate.id;
  const filesBefore = uploads();

  const refused = await addToJob(dana, entry, { job_id: job.practice });
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.body, { error: 'Ilse Brandt is already in the pipeline for Practice Manager (Applied).', code: 'already_in_job', id: applied.body.id, join: { candidate_id: record, name: 'Ilse Brandt' } });
  const joined = await addToJob(dana, entry, { job_id: job.practice, into: record });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  assert.deepEqual(joined.body, { id: applied.body.id, merged: true });

  // One Ilse, one application in the job. Her entry and the record that belonged to no client are gone, and no file was dropped.
  assert.deepEqual(db('SELECT COUNT(*) AS n FROM applications WHERE id = ?', entry), [{ n: 0 }]);
  assert.deepEqual(db('SELECT COUNT(*) AS n FROM candidates WHERE id = ?', bookPerson), [{ n: 0 }]);
  assert.deepEqual(db(`SELECT id FROM candidates WHERE email = 'ilse@example.com'`).map((r) => r.id), [record]);
  assert.deepEqual(uploads(), filesBefore);
  const ilse = await detail(dana, applied.body.id);
  assert.equal(ilse.candidate.phone, '905 555 0144');
  assert.deepEqual([ilse.application.resume_name, ilse.earlier_resumes.map((r) => r.name)], ['Ilse applied.pdf', ['Ilse book.pdf']]);
  assert.equal((await dana.get(`/applications/${applied.body.id}/resumes/${ilse.earlier_resumes[0].id}`)).body.toString(), 'Ilse, from The Book');
  assert.deepEqual(ilse.notes.map((n) => [n.body, n.private]).sort(), [['Applied through the site.', 0], ['Salary expectations are high.', 1], ['Saved with their entry in The Book: Kept with her entry.', 1]]);
  assert.deepEqual(ilse.emails.map((e) => e.subject), ['Keeping in touch']);
  assert.deepEqual(ilse.activities.map((a) => a.detail).sort(), [
    'Added to The Book (agency sourced)', 'Added to the pipeline (agency sourced)', 'Call added, 9 sec', 'Emailed candidate: Keeping in touch', 'Joined with their entry in The Book, which had no job',
  ].sort());
  assert.equal(ilse.application.from_book, true);
  const moved = (await dana.get(`/oracle/calls/${call}`)).body;
  assert.deepEqual([moved.call.application_id, moved.candidate.id, moved.application.job_title], [applied.body.id, record, 'Practice Manager']);
  // The hiring team sees what it saw before, and nothing that came from The Book.
  const theirs = await detail(noor, applied.body.id);
  assert.deepEqual([theirs.notes.map((n) => n.body), theirs.emails, theirs.activities.map((a) => a.detail), theirs.earlier_resumes, theirs.application.resume_name],
    [['Applied through the site.'], [], ['Added to the pipeline (agency sourced)'], [], 'Ilse applied.pdf']);
  const feed = (await noor.get('/dashboard')).body.recent.filter((r) => r.application_id === applied.body.id).map((r) => r.detail);
  assert.deepEqual(feed, ['Added to the pipeline (agency sourced)']);
  book.ilse = applied.body.id;
  book.ilseCall = call;
});

test('deleting a job sends the people who were in The Book before it back to The Book, with everything the agency kept on them', async () => {
  const stages = (await alex.get(`/jobs/${job.practice}`)).body.stages;
  const doomed = (await alex.post('/jobs', { client_id: client.maple, title: 'Fleet Analyst', status: 'open' })).body.id;
  const fleet = (await alex.get(`/jobs/${doomed}`)).body.stages;
  // 1. Only ever on this job: a note, a résumé, a photo, an e-mail and a call from his time in The Book; then an
  //    interview, a rating, a note the hiring team could read and a write-up while on the job.
  const solo = await saved(dana, { name: 'Temp Person', email: 'temp.person@example.com', note: 'Kept for months.', resume: resume('Temp, CV', 'Temp.pdf'), photo: { name: 't.png', bytes: PNG } });
  assert.equal((await dana.post(`/applications/${solo}/emails`, { subject: 'Hello', body: 'Hi' })).status, 200);
  const soloCall = (await dana.upload('/oracle/calls/upload', { audio: { name: 'call.webm', bytes: RECORDING }, consent: 'true', application_id: solo })).body.id;
  const soloPerson = (await detail(dana, solo)).candidate.id;
  const soloAdded = (await detail(dana, solo)).application.applied_at;
  assert.deepEqual((await addToJob(dana, solo, { job_id: doomed, stage_id: fleet[1].id })).body, { id: solo, merged: false });
  assert.equal((await dana.post('/interviews', { application_id: solo, title: 'Screen', starts_at: '2099-04-01T15:00:00.000Z', panel: [] })).status, 200);
  assert.equal((await dana.patch(`/applications/${solo}`, { rating: 4 })).status, 200);
  assert.equal((await dana.post(`/applications/${solo}/notes`, { body: 'Maple liked him.', private: false })).status, 200);
  assert.equal((await dana.post(`/applications/${solo}/submit`, { note: 'Worth meeting.' })).status, 200);
  assert.equal((await put(dana, `/applications/${solo}/offer`, { salary: 60000, status: 'draft' })).status, 200);
  // 2. Saved to The Book a second time while on the job, so The Book already has an entry under her address.
  const twice = await saved(dana, { name: 'Twice Saved', email: 'twice@example.com', phone: '416 555 0190', note: 'First time round.', resume: resume('Twice, first CV', 'Twice 1.pdf') });
  const twicePerson = (await detail(dana, twice)).candidate.id;
  assert.equal((await addToJob(dana, twice, { job_id: doomed })).status, 200);
  const twin = await saved(sam, { name: 'Twice Saved', email: 'twice@example.com', note: 'Second time round.', resume: resume('Twice, second CV', 'Twice 2.pdf') });
  assert.notEqual(twin, twice);
  // 3. Put on a second job of the same client afterwards, so the client's record is still needed.
  const both = await saved(dana, { name: 'Both Jobs', email: 'both@example.com', note: 'Good with spreadsheets.', photo: { name: 'b.png', bytes: PNG } });
  const bothPerson = (await detail(dana, both)).candidate.id;
  assert.equal((await addToJob(dana, both, { job_id: doomed })).status, 200);
  const bothCall = (await dana.upload('/oracle/calls/upload', { audio: { name: 'call.webm', bytes: RECORDING }, consent: 'true', application_id: both })).body.id;
  const second = (await addToJob(dana, both, { job_id: job.payroll })).body.id;
  // 4. Joined to a record the client already had, which is on another of its jobs.
  const joinedEntry = await saved(dana, { name: 'Kevin Tremblay', email: 'kevin.tremblay@example.com', note: 'Back in The Book.' });
  const kevinAtMaple = (await detail(dana, app.kevin)).candidate.id;
  assert.deepEqual((await addToJob(dana, joinedEntry, { job_id: doomed, into: kevinAtMaple })).body, { id: joinedEntry, merged: true });
  // 5. Never in The Book: added straight to the job.
  const plain = (await dana.upload('/applications', { job_id: doomed, name: 'Plain Applicant', email: 'plain@example.com', resume: resume('Plain', 'Plain.pdf') })).body.id;
  const plainFile = db('SELECT resume_file FROM applications WHERE id = ?', plain)[0].resume_file;
  const inBookBefore = (await list(alex, '?general=1')).map((r) => r.id);
  const filesBefore = uploads();

  assert.equal((await alex.del(`/jobs/${doomed}`)).status, 200);
  await until(async () => uploads(), (now_) => !now_.includes(plainFile));

  // The one who was never in The Book went with the job, and so did his file. Nobody else's file went.
  assert.deepEqual(db('SELECT COUNT(*) AS n FROM applications WHERE id = ?', plain), [{ n: 0 }]);
  assert.deepEqual(db(`SELECT COUNT(*) AS n FROM candidates WHERE email = 'plain@example.com'`), [{ n: 0 }]);
  assert.deepEqual(filesBefore.filter((f) => !uploads().includes(f)), [plainFile]);

  // 1. Back in The Book as he was, under the same id and record, with everything from before and from the job's time.
  const temp = await detail(dana, solo);
  assert.deepEqual([temp.application.general, temp.job, temp.client, temp.stages, temp.interviews, temp.offer, temp.application.status, temp.application.rating, temp.application.review_status, temp.application.submission_note, temp.application.general_until],
    [true, null, null, [], [], null, 'active', null, null, null, null]);
  assert.deepEqual([temp.candidate.id, temp.candidate.client_id, temp.application.resume_name, temp.application.applied_at], [soloPerson, null, 'Temp.pdf', soloAdded]);
  assert.match(temp.candidate.photo, /^[a-f0-9]{8}$/);
  assert.deepEqual(temp.notes.map((n) => [n.body, n.private]).sort(), [['Kept for months.', 1], ['Maple liked him.', 1]]);
  assert.deepEqual(temp.emails.map((e) => e.subject), ['Hello']);
  assert.equal(temp.activities[0].detail, 'Back in The Book without a job: Fleet Analyst at Maple Freight was deleted');
  assert.ok(temp.activities.some((a) => a.detail === 'Added to The Book (agency sourced)'));
  assert.equal((await dana.get(`/applications/${solo}/resume`)).body.toString(), 'Temp, CV');
  assert.deepEqual((await dana.get(`/oracle/calls?candidate_id=${soloPerson}`)).body.map((c) => [c.id, c.application_id]), [[soloCall, solo]]);
  assert.deepEqual(db('SELECT COUNT(*) AS n FROM interviews WHERE application_id = ?', solo), [{ n: 0 }]);
  assert.deepEqual(db('SELECT COUNT(*) AS n FROM stage_history WHERE application_id = ?', solo), [{ n: 0 }]);
  assert.equal((await maya.get(`/applications/${solo}`)).status, 404);
  // He can be put on a job again, and what the hiring team sees starts again from that moment.
  assert.deepEqual((await addToJob(dana, solo, { job_id: job.accountant })).body, { id: solo, merged: false });
  const seen = await detail(maya, solo);
  assert.deepEqual([seen.notes, seen.emails, seen.activities.map((a) => a.detail)], [[], [], ['Added to Senior Accountant at Applied']]);

  // 2. The Book had an entry under her address: the one coming back is folded into it. One person, one entry, both
  //    notes, the kept entry's résumé on the profile and the other kept as an earlier one.
  assert.deepEqual(db('SELECT COUNT(*) AS n FROM applications WHERE id = ?', twice), [{ n: 0 }]);
  assert.deepEqual(db('SELECT COUNT(*) AS n FROM candidates WHERE id = ?', twicePerson), [{ n: 0 }]);
  assert.deepEqual(db(`SELECT COUNT(*) AS n FROM candidates WHERE email = 'twice@example.com'`), [{ n: 1 }]);
  const again = await detail(dana, twin);
  assert.deepEqual([again.application.general, again.candidate.client_id, again.candidate.phone, again.application.resume_name, again.earlier_resumes.map((r) => r.name)], [true, null, '416 555 0190', 'Twice 2.pdf', ['Twice 1.pdf']]);
  assert.deepEqual(again.notes.map((n) => n.body).sort(), ['First time round.', 'Second time round.']);
  assert.ok(again.activities.some((a) => a.detail === 'Back in The Book without a job: Fleet Analyst at Maple Freight was deleted'));

  // 3. Maple keeps its record for the other job. The Book gets a record of its own for the entry, with a copy of the
  //    details and the photo, and the call that was recorded on the entry.
  const back = await detail(dana, both);
  assert.equal(back.application.general, true);
  assert.notEqual(back.candidate.id, bothPerson);
  assert.deepEqual([back.candidate.client_id, back.candidate.name, back.candidate.email, back.notes.map((n) => n.body)], [null, 'Both Jobs', 'both@example.com', ['Good with spreadsheets.']]);
  assert.equal((await dana.get(`/candidates/${back.candidate.id}/photo`)).status, 200);
  assert.deepEqual((await dana.get(`/oracle/calls?candidate_id=${back.candidate.id}`)).body.map((c) => [c.id, c.application_id]), [[bothCall, both]]);
  const stayed = await detail(dana, second);
  assert.deepEqual([stayed.candidate.id, stayed.candidate.client_id, stayed.job.title, stayed.others], [bothPerson, client.maple, 'Payroll Specialist', []]);
  assert.equal((await dana.get(`/candidates/${bothPerson}/photo`)).status, 200);
  assert.notEqual(db('SELECT photo_file FROM candidates WHERE id = ?', bothPerson)[0].photo_file, db('SELECT photo_file FROM candidates WHERE id = ?', back.candidate.id)[0].photo_file);

  // 4. The same for an entry that had been joined to a record the client already had.
  const kevin = await detail(dana, joinedEntry);
  assert.deepEqual([kevin.application.general, kevin.candidate.client_id, kevin.candidate.email, kevin.notes.map((n) => n.body)], [true, null, 'kevin.tremblay@example.com', ['Back in The Book.']]);
  assert.equal((await detail(dana, app.kevin)).candidate.id, kevinAtMaple);

  // Everyone who was in The Book before is still there, joined by the three who came back under their own ids.
  assert.deepEqual((await list(alex, '?general=1')).map((r) => r.id).sort((a, b) => a - b), [...inBookBefore, both, joinedEntry].sort((a, b) => a - b));
  // Nothing about them reaches the hiring team.
  for (const id of [twin, both, joinedEntry]) assert.equal((await maya.get(`/applications/${id}`)).status, 404);
  assert.equal(JSON.stringify((await maya.get('/applications?status=all')).body).includes('Twice Saved'), false);
  void stages;
});

test('removed from a job, somebody who came from The Book goes back to it; anyone else is removed as before', async () => {
  const entry = await saved(dana, { name: 'Rana Aziz', email: 'rana@example.com', note: 'Sourced in spring.', resume: resume('Rana', 'Rana.pdf') });
  assert.equal((await addToJob(dana, entry, { job_id: job.practice })).status, 200);
  assert.equal((await dana.post('/interviews', { application_id: entry, title: 'Screen', starts_at: '2099-05-01T15:00:00.000Z', panel: [] })).status, 200);
  const filesBefore = uploads();
  const removed = await dana.del(`/applications/${entry}`);
  assert.deepEqual(removed.body, { ok: true, returned: true, id: entry });
  const rana = await detail(dana, entry);
  assert.deepEqual([rana.application.general, rana.candidate.client_id, rana.interviews, rana.application.resume_name, rana.notes.map((n) => n.body)], [true, null, [], 'Rana.pdf', ['Sourced in spring.']]);
  assert.equal(rana.activities[0].detail, 'Removed from Practice Manager at Northline Dental: back in The Book without a job');
  assert.deepEqual(uploads(), filesBefore);
  assert.equal((await noor.get(`/applications/${entry}`)).status, 404);
  // Removed again, now that she is on no job, her entry goes for good, as "Delete" on such a profile always did.
  assert.deepEqual((await dana.del(`/applications/${entry}`)).body, { ok: true });
  assert.deepEqual(db(`SELECT COUNT(*) AS n FROM candidates WHERE email = 'rana@example.com'`), [{ n: 0 }]);

  // Ilse's entry was joined to the application she already had in Practice Manager. Deleting that job sends that
  // application back to The Book with her, since it now holds what the agency kept on her.
  const ilsePerson = (await detail(dana, book.ilse)).candidate.id;
  assert.equal((await alex.del(`/jobs/${job.practice}`)).status, 200);
  const ilse = await detail(dana, book.ilse);
  assert.deepEqual([ilse.application.general, ilse.candidate.id, ilse.candidate.client_id], [true, ilsePerson, null]);
  assert.deepEqual(ilse.notes.map((n) => [n.body, n.private]).sort(), [['Applied through the site.', 1], ['Salary expectations are high.', 1], ['Saved with their entry in The Book: Kept with her entry.', 1]]);
  // The résumé her entry brought is her résumé again, and the one that was on Northline's application is an earlier one.
  assert.deepEqual([ilse.application.resume_name, ilse.earlier_resumes.map((r) => r.name)], ['Ilse book.pdf', ['Ilse applied.pdf']]);
  assert.equal((await dana.get(`/applications/${book.ilse}/resume`)).body.toString(), 'Ilse, from The Book');
  assert.equal((await dana.get(`/oracle/calls/${book.ilseCall}`)).body.call.application_id, book.ilse);
  assert.equal((await noor.get(`/applications/${book.ilse}`)).status, 404);
  // Erasing her erases the earlier résumé with the rest.
  const hers = db('SELECT resume_file FROM applications WHERE id = ? UNION ALL SELECT resume_file FROM earlier_resumes WHERE application_id = ?', book.ilse, book.ilse).map((r) => r.resume_file);
  assert.equal(hers.length, 2);
  assert.equal((await dana.del(`/candidates/${ilsePerson}`)).status, 200);
  await until(async () => uploads(), (now_) => !hers.some((f) => now_.includes(f)));
  assert.deepEqual(db('SELECT COUNT(*) AS n FROM earlier_resumes WHERE application_id = ?', book.ilse), [{ n: 0 }]);
});

// ---------- where this meets the fixes to the activity feed, to résumé names and to photos ----------
// Those fixes were made to the release before this one, for people added straight to a job. These tests hold them
// to the same for people who are saved without a job and put on one later.
const feedOf = async (who, name) => (await who.get('/dashboard')).body.recent.filter((r) => r.candidate_name === name).map((r) => [r.milestone, r.detail, r.job_title]);
const wholeName = (res) => decodeURIComponent(res.headers.get('content-disposition').split("filename*=UTF-8''")[1]);

test('put on a job from The Book straight into an interview stage, Offer or Hired is a milestone on the dashboard, as being added straight into one is', async () => {
  job.credit = (await alex.post('/jobs', { client_id: client.maple, title: 'Credit Controller', status: 'open' })).body.id;
  const stages = (await alex.get(`/jobs/${job.credit}`)).body.stages;
  const [applied, interview] = stages, offer = stages.find((s) => s.kind === 'offer'), hired = stages.find((s) => s.kind === 'hired');
  assert.deepEqual([applied.kind, interview.kind], ['applied', 'interview']);
  const inBook = async (name) => {
    const id = await saved(dana, { name, email: `${name.toLowerCase().replace(' ', '.')}@example.com`, note: 'Kept in The Book.' });
    assert.deepEqual(await feedOf(alex, name), [], 'nobody saved without a job is in the feed');
    return id;
  };

  // From their profile ("Add to a job"), at a chosen interview stage: the same two lines as someone added straight
  // into that stage, the first of them the milestone. Both carry the moment they joined the job.
  book.uma = await inBook('Uma Interview');
  assert.deepEqual((await addToJob(dana, book.uma, { job_id: job.credit, stage_id: interview.id })).body, { id: book.uma, merged: false });
  const uma = await detail(dana, book.uma);
  assert.deepEqual(uma.activities.map((a) => [a.type, a.detail]), [['stage_interview', `Started at ${interview.name}`], ['added', `Added to Credit Controller at ${interview.name}`], ['added', 'Added to The Book (agency sourced)']]);
  assert.deepEqual(uma.activities.slice(0, 2).map((a) => a.created_at), [uma.application.general_until, uma.application.general_until]);
  // The feed has the job's news and nothing from before it, for the agency as well: "Added to The Book" beside the
  // name of a job would read as that job's news.
  assert.deepEqual(await feedOf(alex, 'Uma Interview'), [['interview', `Started at ${interview.name}`, 'Credit Controller'], [null, `Added to Credit Controller at ${interview.name}`, 'Credit Controller']]);
  // The hiring team sees the milestone too, and still nothing from before the job.
  assert.deepEqual(await feedOf(maya, 'Uma Interview'), [['interview', `Started at ${interview.name}`, 'Credit Controller'], [null, `Added to Credit Controller at ${interview.name}`, 'Credit Controller']]);
  assert.deepEqual((await detail(maya, book.uma)).activities.map((a) => a.detail), [`Started at ${interview.name}`, `Added to Credit Controller at ${interview.name}`]);

  // Straight to Offer, and straight to Hired.
  const vik = await inBook('Vik Offer');
  assert.equal((await addToJob(dana, vik, { job_id: job.credit, stage_id: offer.id })).status, 200);
  assert.deepEqual((await feedOf(alex, 'Vik Offer')).slice(0, 2), [['offer', 'Started at Offer', 'Credit Controller'], [null, 'Added to Credit Controller at Offer', 'Credit Controller']]);
  const wes = await inBook('Wes Hired');
  assert.equal((await addToJob(dana, wes, { job_id: job.credit, stage_id: hired.id })).status, 200);
  assert.deepEqual((await feedOf(alex, 'Wes Hired')).slice(0, 2), [['hired', 'Marked as hired', 'Credit Controller'], [null, 'Added to Credit Controller at Hired', 'Credit Controller']]);
  assert.equal((await detail(dana, wes)).application.status, 'hired');

  // At the job's first stage there is nothing to shout about: one line, and no milestone.
  book.xan = await inBook('Xan Applied');
  assert.equal((await addToJob(dana, book.xan, { job_id: job.credit })).status, 200);
  assert.deepEqual(await feedOf(alex, 'Xan Applied'), [[null, 'Added to Credit Controller at Applied', 'Credit Controller']]);

  // Sent with a job from the Add candidate dialog or the extension, their entry goes on the job the same way.
  const yara = await inBook('Yara Dialog');
  const sent = await sam.upload('/applications', { job_id: job.credit, stage_id: interview.id, name: 'Yara Dialog', email: 'yara.dialog@example.com' });
  assert.deepEqual(sent.body, { id: yara, known: true, merged: true, name: 'Yara Dialog', general: false, moved: true, joined: false });
  assert.deepEqual((await feedOf(alex, 'Yara Dialog')).slice(0, 2), [['interview', `Started at ${interview.name}`, 'Credit Controller'], [null, `Added to Credit Controller at ${interview.name}`, 'Credit Controller']]);
  assert.deepEqual(await feedOf(maya, 'Yara Dialog'), [['interview', `Started at ${interview.name}`, 'Credit Controller'], [null, `Added to Credit Controller at ${interview.name}`, 'Credit Controller']]);

  // And somebody already on a job, added to another job of the client at an interview stage.
  const payroll = (await alex.get(`/jobs/${job.payroll}`)).body.stages;
  const second = (await addToJob(dana, book.xan, { job_id: job.payroll, stage_id: payroll[1].id })).body.id;
  assert.deepEqual((await detail(dana, second)).activities.map((a) => [a.type, a.detail]), [['stage_interview', `Started at ${payroll[1].name}`], ['added', `Added to Payroll Specialist at ${payroll[1].name}`]]);
  assert.deepEqual((await feedOf(alex, 'Xan Applied')).slice(0, 2), [['interview', `Started at ${payroll[1].name}`, 'Payroll Specialist'], [null, `Added to Payroll Specialist at ${payroll[1].name}`, 'Payroll Specialist']]);
});

test('back in The Book they are in no feed; on another job, what happened on the first one is history, not that job\'s milestone', async () => {
  const credit = (await alex.get(`/jobs/${job.credit}`)).body.stages;
  const offer = credit.find((s) => s.kind === 'offer');
  assert.equal((await dana.post(`/applications/${book.uma}/move`, { stage_id: offer.id })).status, 200);
  assert.deepEqual((await feedOf(alex, 'Uma Interview'))[0], ['offer', 'Moved to Offer', 'Credit Controller']);
  assert.deepEqual((await dana.del(`/applications/${book.uma}`)).body, { ok: true, returned: true, id: book.uma });
  assert.deepEqual(await feedOf(alex, 'Uma Interview'), []);
  assert.deepEqual(await feedOf(maya, 'Uma Interview'), []);

  // On Payroll Specialist now. Her history is whole on her profile, and in the feed the offer stage she reached on
  // Credit Controller is no longer picked out: it would read as an offer for the job named beside it.
  assert.equal((await addToJob(dana, book.uma, { job_id: job.payroll })).status, 200);
  const rows = await feedOf(alex, 'Uma Interview');
  assert.deepEqual(rows, [[null, 'Added to Payroll Specialist at Applied', 'Payroll Specialist']], 'nothing from the first job is in the feed under the second');
  assert.ok((await detail(dana, book.uma)).activities.some((a) => a.type === 'stage_offer' && a.detail === 'Moved to Offer'));
  assert.deepEqual(await feedOf(maya, 'Uma Interview'), [[null, 'Added to Payroll Specialist at Applied', 'Payroll Specialist']]);
  // What happens on this job is its news again.
  const payroll = (await alex.get(`/jobs/${job.payroll}`)).body.stages;
  assert.equal((await dana.post(`/applications/${book.uma}/move`, { stage_id: payroll[1].id })).status, 200);
  assert.deepEqual((await feedOf(alex, 'Uma Interview'))[0], ['interview', `Moved to ${payroll[1].name}`, 'Payroll Specialist']);
  assert.deepEqual((await feedOf(maya, 'Uma Interview'))[0], ['interview', `Moved to ${payroll[1].name}`, 'Payroll Specialist']);
});

test('a résumé whose name has accents or another alphabet keeps it: in The Book, as an earlier résumé, and on the way to a job', async () => {
  const first = 'Zoë Müller – Lebenslauf (2024).pdf', second = '履歴書_山田太郎.pdf';
  const id = await saved(dana, { name: 'Zoë Müller', email: 'zoe.muller@example.com', resume: resume('Zoë, first', first) });
  assert.equal((await detail(dana, id)).application.resume_name, first);
  const download = await dana.get(`/applications/${id}/resume`);
  assert.match(download.headers.get('content-disposition'), /^attachment; filename="[\w.\- ]+"; filename\*=UTF-8''[\w.%~!-]+$/);
  assert.equal(wholeName(download), first);

  // Saved again with a newer file: the first is kept as an earlier résumé, under its whole name, and is offered
  // for download under it.
  const again = await save(sam, { name: 'Zoë Müller', email: 'zoe.muller@example.com', resume: resume('Zoë, second', second) });
  assert.deepEqual(again.body, { id, known: true, merged: true, name: 'Zoë Müller', general: true, resume: 'replaced' });
  const zoe = await detail(dana, id);
  assert.deepEqual([zoe.application.resume_name, zoe.earlier_resumes.map((r) => r.name)], [second, [first]]);
  assert.equal(zoe.activities[0].detail, `Saved to The Book again, with a newer résumé. The one they had (${first}) is kept under Earlier résumés`);
  const earlier = await dana.get(`/applications/${id}/resumes/${zoe.earlier_resumes[0].id}`);
  assert.equal(earlier.body.toString(), 'Zoë, first');
  assert.match(earlier.headers.get('content-disposition'), /^attachment; filename="[\w.\- ]+"; filename\*=UTF-8''[\w.%~!-]+$/);
  assert.equal(wholeName(earlier), first);
  assert.equal(wholeName(await dana.get(`/applications/${id}/resume`)), second);

  // On a job, and on a second job of that client (which gets a copy of the file), the name is still whole.
  assert.equal((await addToJob(dana, id, { job_id: job.credit })).status, 200);
  const other = (await addToJob(dana, id, { job_id: job.payroll })).body.id;
  for (const application of [id, other]) {
    assert.equal((await detail(maya, application)).application.resume_name, second);
    const file = await maya.get(`/applications/${application}/resume`);
    assert.deepEqual([file.body.toString(), wholeName(file)], ['Zoë, second', second]);
  }
});

test('a photo that cannot be kept: the person is still saved to The Book, the answer says the photo was not, and a photo they had stays', async () => {
  const notAPicture = { name: 'p.png', bytes: Buffer.concat([PNG.subarray(0, 8), Buffer.from('only the first eight bytes of a picture')]) };
  const filesBefore = uploads();
  const made = await save(dana, { name: 'Quinn Nophoto', email: 'quinn@example.com', photo: notAPicture });
  assert.deepEqual(made.body, { id: made.body.id, known: false, merged: false, name: 'Quinn Nophoto', general: true, photo_rejected: true });
  const id = made.body.id;
  assert.equal((await detail(dana, id)).candidate.photo, null);
  assert.deepEqual(await until(async () => uploads(), (now_) => now_.length === filesBefore.length), filesBefore); // the file was not left behind

  // Saved again with a real picture, then with another that cannot be kept: the real one is still theirs.
  const good = await save(dana, { name: 'Quinn Nophoto', email: 'quinn@example.com', photo: { name: 'q.png', bytes: PNG } });
  assert.deepEqual(good.body, { id, known: true, merged: true, name: 'Quinn Nophoto', general: true });
  const { candidate } = await detail(dana, id);
  assert.match(candidate.photo, /^[a-f0-9]{8}$/);
  const bad = await save(sam, { name: 'Quinn Nophoto', email: 'quinn@example.com', photo: notAPicture });
  assert.deepEqual(bad.body, { id, known: true, merged: true, name: 'Quinn Nophoto', general: true, photo_rejected: true });
  assert.equal((await detail(dana, id)).candidate.photo, candidate.photo);

  // The picture of somebody on no job is kept by the browser like any other; "the file is missing" is not, and
  // neither is the refusal a client's user gets.
  const address = `/candidates/${candidate.id}/photo?v=${candidate.photo}`;
  const found = await dana.get(address);
  assert.deepEqual([found.status, found.headers.get('cache-control'), found.headers.get('content-type')], [200, 'private, max-age=604800', 'image/png']);
  const folder = path.join(dataDir, 'uploads');
  const file = fs.readdirSync(folder).find((name) => name.startsWith(candidate.photo));
  fs.renameSync(path.join(folder, file), path.join(dataDir, file));
  const missing = await dana.get(address);
  assert.equal(missing.status, 404);
  assert.doesNotMatch(missing.headers.get('cache-control') || '', /max-age=604800/);
  fs.renameSync(path.join(dataDir, file), path.join(folder, file));
  const refused = await maya.get(address);
  assert.equal(refused.status, 404);
  assert.doesNotMatch(refused.headers.get('cache-control') || '', /max-age=604800/);

  // Sent with a job and a picture that cannot be kept: their entry goes on the job, and the answer says both things.
  const moved = await dana.upload('/applications', { job_id: job.credit, name: 'Quinn Nophoto', email: 'quinn@example.com', photo: notAPicture });
  assert.deepEqual(moved.body, { id, known: true, merged: true, name: 'Quinn Nophoto', general: false, moved: true, joined: false, photo_rejected: true });
  assert.equal((await detail(dana, id)).candidate.photo, candidate.photo);
  assert.equal((await dana.get(address)).status, 200);
});

test('interview stages put in a new order in the job form: people who came from The Book stay in the stage they were in, and the order is the one that counts from then on', async () => {
  const before_ = (await alex.get(`/jobs/${job.credit}`)).body;
  const interviews = before_.stages.filter((s) => s.kind === 'interview');
  const board = async () => (await list(alex, `?job_id=${job.credit}&status=all`)).map((r) => `${r.id}:${r.stage_id}`).sort();
  const boardBefore = await board();
  const yara = (await list(alex, `?job_id=${job.credit}&status=all`)).find((r) => r.name === 'Yara Dialog');
  assert.equal(yara.stage_id, interviews[0].id);
  // The first interview stage is dragged to the end: the form sends the same stages, by id, in the new order.
  const order = [...interviews.slice(1), interviews[0]];
  assert.equal((await put(alex, `/jobs/${job.credit}`, { title: before_.job.title, status: before_.job.status, interview_stages: order.map((s) => ({ id: s.id, name: s.name })) })).status, 200);
  const after_ = (await alex.get(`/jobs/${job.credit}`)).body.stages;
  assert.deepEqual(after_.map((s) => s.id), [before_.stages[0].id, ...order.map((s) => s.id), ...before_.stages.filter((s) => s.kind === 'offer' || s.kind === 'hired').map((s) => s.id)]);
  assert.deepEqual(await board(), boardBefore);
  assert.deepEqual((await detail(maya, yara.id)).activities.map((a) => a.detail), [`Started at ${interviews[0].name}`, `Added to Credit Controller at ${interviews[0].name}`]);

  // Put on the job from The Book with no stage chosen: still its first stage, Applied.
  const zed = await saved(dana, { name: 'Zed Later', email: 'zed.later@example.com' });
  assert.equal((await addToJob(dana, zed, { job_id: job.credit })).status, 200);
  assert.equal((await detail(dana, zed)).application.stage_id, before_.stages[0].id);
  // Yara is in what is now the last interview stage, so a move to the one before it is a move back, not a milestone.
  assert.equal((await dana.post(`/applications/${yara.id}/move`, { stage_id: order[0].id })).status, 200);
  assert.deepEqual((await feedOf(alex, 'Yara Dialog'))[0], [null, `Moved back to ${order[0].name}`, 'Credit Controller']);
  assert.equal((await dana.post(`/applications/${yara.id}/move`, { stage_id: interviews[0].id })).status, 200);
  assert.deepEqual((await feedOf(maya, 'Yara Dialog'))[0], ['interview', `Moved to ${interviews[0].name}`, 'Credit Controller']);
});

// ---------- the demo data ----------
// ---------- the reports ----------
test('the reports count somebody who came from The Book like anyone else in a job, and what was counted goes when they return to The Book', async () => {
  // Counting begins now: a real workspace starts on a set day, and writes nothing down before it.
  assert.equal((await put(alex, '/reports/start', { date: '2026-01-05' })).status, 200);
  const events = (applicationId) => db('SELECT kind, job_id, client_id, user_id, fee, set_aside_at FROM report_events WHERE application_id = ? ORDER BY id', applicationId);
  const counted = async () => {
    const row = (await alex.get('/reports/individual')).body.rows.find((r) => r.name === 'Dana Recruiter') ?? { submissions: 0, interviews: 0, placements: 0 };
    const maple = (await alex.get('/reports/clients')).body.rows.find((r) => r.id === client.maple);
    return { dana: [row.submissions, row.interviews, row.placements], maple: [maple.submissions, maple.interviews, maple.placements, maple.billings] };
  };
  const danaId = db(`SELECT id FROM users WHERE email = 'dana@agency.example'`)[0].id;
  const before_ = await counted();
  const first = (await alex.post('/jobs', { client_id: client.maple, title: 'Financial Analyst', status: 'open' })).body.id;
  const second = (await alex.post('/jobs', { client_id: client.maple, title: 'Treasury Analyst', status: 'open' })).body.id;
  const stagesOf = async (jobId) => (await alex.get(`/jobs/${jobId}`)).body.stages;
  const withClient = (stages) => stages.find((s) => s.kind === 'interview' && s.with_client);

  // Saved without a job: nothing to count, and no placement to show.
  const id = await saved(dana, { name: 'Rhea Counted', email: 'rhea.counted@example.com' });
  assert.deepEqual(events(id), []);
  assert.equal((await detail(dana, id)).placement, null);

  // On a job, she is submitted, meets the client and is hired: each is written down once, as for anyone.
  const firstStages = await stagesOf(first);
  assert.equal((await addToJob(dana, id, { job_id: first })).status, 200);
  assert.equal((await dana.post(`/applications/${id}/submit`, { note: 'Worth meeting.' })).status, 200);
  assert.equal((await dana.post(`/applications/${id}/move`, { stage_id: withClient(firstStages).id })).status, 200);
  assert.equal((await put(dana, `/applications/${id}/offer`, { salary: 100000, status: 'accepted' })).status, 200);
  assert.equal((await dana.post(`/applications/${id}/move`, { stage_id: firstStages.at(-1).id })).status, 200);
  assert.deepEqual(events(id).map((e) => [e.kind, e.job_id, e.client_id, e.user_id, e.fee]),
    [['submission', first, client.maple, danaId, null], ['first_interview', first, client.maple, danaId, null], ['placement', first, client.maple, danaId, 20000]]);
  const during = await counted();
  assert.deepEqual(during.dana, before_.dana.map((n) => n + 1));
  assert.deepEqual(during.maple.slice(0, 3), before_.maple.slice(0, 3).map((n) => n + 1));
  assert.equal((await detail(dana, id)).placement.fee, 20000);
  assert.equal((await detail(maya, id)).placement, undefined);   // the fee is the agency's business

  // Removed from the job she goes back to The Book, and what was counted for her in that job goes, as it does for
  // anybody removed from a job. The reports are as they were.
  const removed = await dana.del(`/applications/${id}`);
  assert.deepEqual(removed.body, { ok: true, returned: true, id });
  assert.deepEqual(events(id), []);
  assert.deepEqual(await counted(), before_);
  assert.equal((await detail(dana, id)).placement, null);

  // On the next job she is counted afresh, for that job: the first job's submission does not stand in for this one.
  const secondStages = await stagesOf(second);
  assert.equal((await addToJob(dana, id, { job_id: second })).status, 200);
  assert.equal((await dana.post(`/applications/${id}/submit`, { note: 'Worth meeting here too.' })).status, 200);
  assert.deepEqual(events(id).map((e) => [e.kind, e.job_id]), [['submission', second]]);
  assert.equal((await dana.post(`/applications/${id}/move`, { stage_id: secondStages.at(-1).id })).status, 200);
  assert.deepEqual(events(id).map((e) => [e.kind, e.job_id, e.fee]), [['submission', second, null], ['placement', second, null]]);   // no offer on this job, so no fee yet
  assert.equal((await detail(dana, id)).placement.fee, null);

  // When the job itself is deleted she returns to The Book again, and again nothing stays counted for her.
  assert.equal((await alex.del(`/jobs/${second}`)).status, 200);
  assert.equal((await detail(dana, id)).application.general, true);
  assert.deepEqual(events(id), []);
  assert.deepEqual(await counted(), before_);

  // Put straight into Hired, by each of the three ways onto a job, is a placement, credited to whoever owns them.
  assert.equal((await addToJob(sam, id, { job_id: first, stage_id: firstStages.at(-1).id })).status, 200);
  assert.deepEqual(events(id).map((e) => [e.kind, e.job_id, e.user_id]), [['placement', first, danaId]]);
  const typed = await saved(dana, { name: 'Tomas Counted', email: 'tomas.counted@example.com' });
  const viaForm = await dana.upload('/applications', { job_id: first, stage_id: firstStages.at(-1).id, name: 'Tomas Counted', email: 'tomas.counted@example.com' });
  assert.deepEqual([viaForm.status, viaForm.body.id], [200, typed]);
  assert.deepEqual(events(typed).map((e) => [e.kind, e.job_id, e.user_id]), [['placement', first, danaId]]);
  const third = (await alex.post('/jobs', { client_id: client.maple, title: 'Tax Analyst', status: 'open' })).body.id;
  const another = await addToJob(dana, typed, { job_id: third, stage_id: (await stagesOf(third)).at(-1).id });
  assert.equal(another.status, 200, JSON.stringify(another.body));
  assert.deepEqual(events(another.body.id).map((e) => [e.kind, e.job_id, e.user_id]), [['placement', third, danaId]]);
  // Put into a stage where the client meets them, with nothing submitted, is no interview on the reports: the ratio is interviews out of submissions.
  const quiet = await saved(dana, { name: 'Una Counted', email: 'una.counted@example.com' });
  assert.equal((await addToJob(dana, quiet, { job_id: first, stage_id: withClient(firstStages).id })).status, 200);
  assert.deepEqual(events(quiet), []);
  // The hiring team is not sent which stages are interviews with the client, here as anywhere.
  assert.equal(Object.hasOwn((await detail(maya, quiet)).stages[1], 'with_client'), false);
  assert.equal(Object.hasOwn((await detail(dana, quiet)).stages[1], 'with_client'), true);
});

test('what somebody wrote to one client when they applied there is never shown to another client\'s hiring team', async () => {
  const slug = (await alex.get(`/clients/${client.northline}`)).body.client.slug;
  const clinic = (await alex.post('/jobs', { client_id: client.northline, title: 'Clinic Lead', status: 'open',
    questions: [{ id: 'q1', label: 'What salary do you expect at Northline?', type: 'short', required: true }, { id: 'q2', label: 'Can you work Saturdays?', type: 'yesno' }] })).body.id;
  // Petra applies on Northline's careers page: she answers Northline's questions, writes them a note and ticks their consent box.
  const sent = await session(api.base).upload(`/public/careers/${slug}/jobs/${clinic}/apply`, { name: 'Petra Novak', email: 'petra@example.com', consent: 'yes',
    answers: JSON.stringify({ q1: 'NORTHLINE-ANSWER: 95k, and I would take less', q2: 'yes' }), cover_note: 'Dear Northline, I have always wanted to work for you.',
    resume: resume('Petra, written for Northline Dental', 'Petra for Northline.pdf') });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const hers = (await list(alex, `?job_id=${clinic}`))[0].id;
  const atNorthline = await detail(noor, hers);
  assert.deepEqual([atNorthline.application.answers.map((a) => a.answer), atNorthline.application.cover_note, atNorthline.application.source, Boolean(atNorthline.application.consent_at)],
    [['NORTHLINE-ANSWER: 95k, and I would take less', 'yes'], 'Dear Northline, I have always wanted to work for you.', 'careers_page', true]);
  // The agency has her in The Book as well, and joins that entry to the application she made.
  const entry = await saved(dana, { name: 'Petra Novak', email: 'petra@example.com', note: 'Met at a careers fair.', resume: resume('Petra, as the agency holds her', 'Petra CV.pdf') });
  assert.deepEqual((await addToJob(dana, entry, { job_id: clinic, into: atNorthline.candidate.id })).body, { id: hers, merged: true });
  // Northline still sees what she wrote to Northline, and the résumé she sent them. The agency's copy is set aside.
  assert.equal((await detail(noor, hers)).application.answers.length, 2);
  assert.equal((await detail(noor, hers)).application.resume_name, 'Petra for Northline.pdf');
  assert.deepEqual((await detail(dana, hers)).earlier_resumes.map((r) => r.name), ['Petra CV.pdf']);

  // Removed from the job, she goes back to The Book. What she wrote to Northline is kept for the agency as a note,
  // and is no longer on the application that will go on to the next job.
  assert.deepEqual((await dana.del(`/applications/${hers}`)).body, { ok: true, returned: true, id: hers });
  const inBook = await detail(dana, hers);
  assert.deepEqual([inBook.application.general, inBook.application.answers, inBook.application.cover_note, inBook.application.consent_at, inBook.application.source], [true, [], null, null, 'agency_sourced']);
  assert.deepEqual(db('SELECT answers, cover_note, consent_at, source FROM applications WHERE id = ?', hers), [{ answers: '[]', cover_note: null, consent_at: null, source: 'agency_sourced' }]);
  const kept = inBook.notes.find((n) => n.body.startsWith('From their own application'));
  assert.equal(kept.private, 1);
  assert.equal(kept.body, [
    `From their own application for Clinic Lead at Northline Dental, where they agreed to their data being processed on ${atNorthline.application.consent_at.slice(0, 10)}. Kept for the agency only.`,
    'Screening answers:\nWhat salary do you expect at Northline?\nNORTHLINE-ANSWER: 95k, and I would take less\n\nCan you work Saturdays?\nyes',
    'Note from the candidate:\nDear Northline, I have always wanted to work for you.',
  ].join('\n\n'));
  // So is the résumé she sent Northline: the entry has the agency's own copy again, and hers to Northline is an earlier one.
  assert.deepEqual([inBook.application.resume_name, inBook.earlier_resumes.map((r) => r.name)], ['Petra CV.pdf', ['Petra for Northline.pdf']]);
  assert.equal((await dana.get(`/applications/${hers}/resume`)).body.toString(), 'Petra, as the agency holds her');
  assert.equal((await dana.get(`/applications/${hers}/resumes/${inBook.earlier_resumes[0].id}`)).body.toString(), 'Petra, written for Northline Dental');

  // Put on a job at Maple. Maple's hiring team is shown her name, details and résumé, and not a word of Northline's.
  const fleet = (await alex.post('/jobs', { client_id: client.maple, title: 'Fleet Planner', status: 'open' })).body.id;
  assert.deepEqual((await addToJob(dana, hers, { job_id: fleet })).body, { id: hers, merged: false });
  const atMaple = await detail(maya, hers);
  assert.deepEqual([atMaple.application.answers, atMaple.application.cover_note, atMaple.application.consent_at, atMaple.application.source, atMaple.notes, atMaple.emails, atMaple.activities.map((a) => a.detail)],
    [[], null, null, 'agency_sourced', [], [], ['Added to Fleet Planner at Applied']]);
  assert.deepEqual([atMaple.application.resume_name, atMaple.earlier_resumes, (await maya.get(`/applications/${hers}/resume`)).body.toString()], ['Petra CV.pdf', [], 'Petra, as the agency holds her']);
  assert.equal((await maya.get(`/applications/${hers}/resumes/${inBook.earlier_resumes[0].id}`)).status, 403);
  for (const answer of [atMaple, (await maya.get('/dashboard')).body, await list(maya, '?status=all'), (await maya.get(`/reports?job_id=${fleet}`)).body]) {
    assert.equal(/northline|95k|careers/i.test(JSON.stringify(answer)), false, 'nothing of Northline reaches Maple');
  }
  // The agency still has all of it.
  const whole = await detail(dana, hers);
  assert.ok(whole.notes.some((n) => n.body.includes('NORTHLINE-ANSWER')));
  assert.ok(whole.emails.some((e) => /Clinic Lead/.test(e.subject)), 'the confirmation Northline sent her');
  assert.ok(whole.activities.some((a) => a.detail === 'Applied via careers page'));

  // The second lock. Were answers, a note or a consent date ever left on an entry that became a job's application,
  // the hiring team would still not be passed them. (Written straight into the database: no screen can do it.)
  const direct = new DatabaseSync(path.join(dataDir, 'app.db'));
  direct.exec('PRAGMA busy_timeout = 2000');
  direct.prepare(`UPDATE applications SET answers = ?, cover_note = 'LEFT BEHIND', consent_at = '2026-01-01T00:00:00.000Z' WHERE id = ?`).run(JSON.stringify([{ question: 'Q', answer: 'LEFT BEHIND' }]), hers);
  direct.close();
  const still = await detail(maya, hers);
  assert.deepEqual([still.application.answers, still.application.cover_note, still.application.consent_at], [[], null, null]);
  assert.equal(JSON.stringify(still).includes('LEFT BEHIND'), false);
  assert.equal((await detail(dana, hers)).application.cover_note, 'LEFT BEHIND');
  assert.equal((await dana.del(`/candidates/${whole.candidate.id}`)).status, 200);

  // The agency held no résumé of its own for Rolf. The one he sent Northline does not become his résumé in The Book,
  // by either road: on the application he made, or as the copy that went with him to another of Northline's jobs.
  for (const viaCopy of [false, true]) {
    const address = `rolf${viaCopy ? '.copy' : ''}@example.com`;
    assert.equal((await session(api.base).upload(`/public/careers/${slug}/jobs/${clinic}/apply`, { name: 'Rolf Maier', email: address, consent: 'yes',
      answers: JSON.stringify({ q1: 'a lot' }), resume: resume(`Rolf, written for Northline (${viaCopy})`, 'Rolf for Northline.pdf') })).status, 200);
    let his = (await list(alex, `?job_id=${clinic}`)).find((r) => r.email === address).id;
    const record = (await detail(dana, his)).candidate.id;
    if (viaCopy) his = (await addToJob(dana, his, { job_id: job.hygienist })).body.id;
    const rolf = await saved(dana, { name: 'Rolf Maier', email: address });
    assert.deepEqual((await addToJob(dana, rolf, { job_id: viaCopy ? job.hygienist : clinic, into: record })).body, { id: his, merged: true });
    assert.equal((await detail(noor, his)).application.resume_name, 'Rolf for Northline.pdf');
    assert.deepEqual((await dana.del(`/applications/${his}`)).body, { ok: true, returned: true, id: his });
    const back = await detail(dana, his);
    assert.deepEqual([back.application.general, back.application.resume_name, back.earlier_resumes.map((r) => r.name)], [true, null, ['Rolf for Northline.pdf']]);
    assert.deepEqual((await addToJob(dana, his, { job_id: fleet })).body, { id: his, merged: false });
    const shown = await detail(maya, his);
    assert.deepEqual([shown.application.resume_name, shown.earlier_resumes, (await maya.get(`/applications/${his}/resume`)).status], [null, [], 404]);
    assert.equal(/northline/i.test(JSON.stringify(shown)), false);
    assert.equal((await dana.del(`/candidates/${shown.candidate.id}`)).status, 200);
    if (viaCopy) assert.equal((await dana.del(`/candidates/${record}`)).status, 200);
  }
});

test('found in The Book by their link with another address typed, the entry keeps its own address and the history says so, for the agency only', async () => {
  const entry = await saved(dana, { name: 'Linus Varga', email: 'linus.old@example.com', linkedin: 'https://www.linkedin.com/in/linus-varga', phone: '416 555 0100' });
  const depot = (await alex.post('/jobs', { client_id: client.maple, title: 'Depot Manager', status: 'open' })).body.id;
  const added = await sam.upload('/applications', { job_id: depot, name: 'Linus Varga', email: 'linus.new@example.com', linkedin: 'https://linkedin.com/in/linus-varga/' });
  assert.deepEqual(added.body, { id: entry, known: true, merged: true, name: 'Linus Varga', general: false, moved: true, joined: false });
  const linus = await detail(dana, entry);
  assert.deepEqual([linus.candidate.email, linus.candidate.phone], ['linus.old@example.com', '416 555 0100']);
  assert.deepEqual(linus.activities.map((a) => a.detail), ['Added to Depot Manager at Applied',
    'A different email address was entered (linus.new@example.com); the record keeps linus.old@example.com',
    'Recognised as Linus Varga by LinkedIn link: their entry in The Book was put on the job', 'Added to The Book (agency sourced)']);
  // How somebody was matched is the agency's business.
  assert.deepEqual((await detail(maya, entry)).activities.map((a) => a.detail), ['Added to Depot Manager at Applied']);
  assert.equal(JSON.stringify((await maya.get('/dashboard')).body).includes('linus.new'), false);
  // Found by the address they have, nothing needs saying.
  const other = await saved(dana, { name: 'Mina Varga', email: 'mina@example.com' });
  assert.equal((await sam.upload('/applications', { job_id: depot, name: 'Mina Varga', email: 'mina@example.com' })).body.id, other);
  assert.deepEqual((await detail(dana, other)).activities.map((a) => a.detail), ['Added to Depot Manager at Applied', 'Added to The Book (agency sourced)']);
});

test('one person on file in two places: each profile points to the other, and deleting all data on them can take both', async () => {
  const days = (await alex.post('/jobs', { client_id: client.maple, title: 'Dispatcher', status: 'open' })).body.id;
  const nights = (await alex.post('/jobs', { client_id: client.maple, title: 'Night Dispatcher', status: 'open' })).body.id;
  const filesBefore = uploads();
  // From The Book onto one of Maple's jobs, then onto a second. Removed from the first, what the agency kept on the
  // entry goes back to The Book as a record of its own, and Maple keeps its record for the second job.
  const entry = await saved(dana, { name: 'Odile Ferrand', email: 'odile@example.com', linkedin: 'https://www.linkedin.com/in/odile-ferrand', note: 'Kept on the entry.', resume: resume('Odile', 'Odile.pdf') });
  assert.equal((await addToJob(dana, entry, { job_id: days })).status, 200);
  const second = (await addToJob(dana, entry, { job_id: nights })).body.id;
  assert.deepEqual((await dana.del(`/applications/${entry}`)).body, { ok: true, returned: true, id: entry });
  const inBook = await detail(dana, entry), onJob = await detail(dana, second);
  assert.notEqual(inBook.candidate.id, onJob.candidate.id);
  assert.deepEqual([inBook.application.general, inBook.notes.map((n) => n.body), onJob.job.title, onJob.notes], [true, ['Kept on the entry.'], 'Night Dispatcher', []]);
  // Each profile says where the other record is.
  assert.deepEqual(onJob.elsewhere, [{ candidate_id: inBook.candidate.id, name: 'Odile Ferrand', client_id: null, client_name: null, application_id: entry, job_title: null, same_email: true }]);
  assert.deepEqual(inBook.elsewhere, [{ candidate_id: onJob.candidate.id, name: 'Odile Ferrand', client_id: client.maple, client_name: 'Maple Freight', application_id: second, job_title: 'Night Dispatcher', same_email: true }]);
  // The hiring team is told nothing about it.
  const theirs = await detail(maya, second);
  assert.equal('elsewhere' in theirs, false);
  assert.equal(JSON.stringify(theirs).includes('The Book'), false);
  // Nor the day the agency first saved her. Maple's record of her is the one that was made then, and the application
  // that came from The Book has left it: to the hiring team the record still begins with her first application here.
  assert.ok(db('SELECT created_at FROM candidates WHERE id = ?', onJob.candidate.id)[0].created_at < theirs.application.applied_at);
  assert.equal(theirs.candidate.created_at, theirs.application.applied_at);
  assert.equal(onJob.candidate.created_at, db('SELECT created_at FROM candidates WHERE id = ?', onJob.candidate.id)[0].created_at);

  // Another client's record of the same person is pointed out too: here one that shares only her LinkedIn link.
  const hygiene = (await alex.post('/jobs', { client_id: client.northline, title: 'Hygiene Lead', status: 'open' })).body.id;
  // (She applied there herself, under another address: an application through the careers page is never joined to anyone.)
  const northline = (await alex.get(`/clients/${client.northline}`)).body.client.slug;
  assert.equal((await session(api.base).upload(`/public/careers/${northline}/jobs/${hygiene}/apply`, { name: 'Odile Ferrand-Roy', email: 'odile.work@example.com', linkedin: 'https://linkedin.com/in/odile-ferrand', consent: 'yes' })).status, 200);
  const third = (await list(alex, `?job_id=${hygiene}`))[0].id;
  const atNorthline = (await detail(sam, third)).candidate.id;
  assert.deepEqual((await detail(dana, second)).elsewhere.map((r) => [r.candidate_id, r.name, r.client_name, r.job_title, r.same_email]),
    [[inBook.candidate.id, 'Odile Ferrand', null, null, true], [atNorthline, 'Odile Ferrand-Roy', 'Northline Dental', 'Hygiene Lead', false]]);

  // Deleting all data on her: a record that is not one of hers is refused and nothing goes; a client user cannot ask at all.
  const stranger = (await detail(dana, app.kevin)).candidate.id;
  const refused = await dana.del(`/candidates/${onJob.candidate.id}?also=${inBook.candidate.id},${stranger}`);
  assert.deepEqual([refused.status, refused.body.error], [409, 'One of the other records is no longer on file as this person’s. Nothing has been deleted: open the profile again and choose once more.']);
  assert.equal((await maya.del(`/candidates/${onJob.candidate.id}?also=${inBook.candidate.id}`)).status, 403);
  assert.deepEqual(db(`SELECT COUNT(*) AS n FROM candidates WHERE id IN (?, ?, ?, ?)`, onJob.candidate.id, inBook.candidate.id, atNorthline, stranger), [{ n: 4 }]);
  // Asked for the Maple record and the one in The Book, both go, with their files; Northline's, left unticked, stays.
  const gone = await dana.del(`/candidates/${onJob.candidate.id}?also=${inBook.candidate.id}`);
  assert.deepEqual(gone.body, { ok: true, erased: 2 });
  assert.deepEqual(db(`SELECT id FROM candidates WHERE email LIKE 'odile%' ORDER BY id`), [{ id: atNorthline }]);
  assert.deepEqual(db('SELECT COUNT(*) AS n FROM applications WHERE id IN (?, ?)', entry, second), [{ n: 0 }]);
  for (const table of ['notes', 'activities', 'agency_activities', 'emails', 'agency_emails']) assert.deepEqual(db(`SELECT COUNT(*) AS n FROM ${table} WHERE application_id IN (?, ?)`, entry, second), [{ n: 0 }], table);
  assert.deepEqual(await until(async () => uploads(), (now_) => now_.length === filesBefore.length), filesBefore, 'the résumés of both records are removed');
  assert.deepEqual((await detail(sam, third)).elsewhere, []);
  // Deleted the ordinary way, one record goes and the answer says so.
  assert.deepEqual((await dana.del(`/candidates/${atNorthline}`)).body, { ok: true, erased: 1 });

  // The same two records arise when somebody who is in The Book applies on a client's careers page.
  const slug = (await alex.get(`/clients/${client.maple}`)).body.client.slug;
  const bookEntry = await saved(dana, { name: 'Quentin Roux', email: 'quentin@example.com' });
  assert.equal((await session(api.base).upload(`/public/careers/${slug}/jobs/${days}/apply`, { name: 'Quentin Roux', email: 'quentin@example.com', consent: 'yes' })).status, 200);
  const applied = (await list(alex, `?job_id=${days}`)).find((r) => r.name === 'Quentin Roux').id;
  assert.deepEqual((await detail(dana, applied)).elsewhere.map((r) => [r.application_id, r.client_name]), [[bookEntry, null]]);
  assert.deepEqual((await detail(dana, bookEntry)).elsewhere.map((r) => [r.application_id, r.client_name, r.job_title]), [[applied, 'Maple Freight', 'Dispatcher']]);
});

test('nothing the agency kept is stored where the hiring team is shown from: read the way the release before this one reads it, a client is shown exactly what it is shown now', async () => {
  // Should a deploy ever be rolled back, the release before this one (09368bb, the one that is live) would be
  // reading this database. It knows nothing of people who came from The Book: it shows a client every history line
  // that is not a call or the agency's note about its own confidential post, every e-mail, every note that is not
  // agency only, the covering note and the answers of an application in one of its jobs. These are its queries. For
  // every application in a job, they must find what this release shows the client. (The applications made through
  // a confidential post are held to the same further down, where the two features meet.)
  const asBefore = (id) => ({
    history: db(`SELECT ac.detail FROM activities ac WHERE ac.application_id = ? AND ac.type NOT IN ('call', 'board') ORDER BY ac.created_at DESC, ac.id DESC`, id).map((r) => r.detail),
    emails: db('SELECT e.subject FROM emails e WHERE e.application_id = ? ORDER BY e.created_at DESC', id).map((r) => r.subject).sort(),
    notes: db('SELECT n.body FROM notes n WHERE n.application_id = ? AND n.private = 0 ORDER BY n.created_at DESC', id).map((r) => r.body).sort(),
    written: db('SELECT cover_note, answers, consent_at FROM applications WHERE id = ?', id).map((r) => [r.cover_note, JSON.parse(r.answers), r.consent_at])[0],
  });
  let fromBook = 0, withHistory = 0;
  for (const [who, clientId] of [[maya, client.maple], [noor, client.northline]]) {
    for (const row of await list(alex, `?client_id=${clientId}&status=all`)) {
      const shown = (await who.get(`/applications/${row.id}`)).body;
      assert.deepEqual(asBefore(row.id), {
        history: shown.activities.map((a) => a.detail), emails: shown.emails.map((e) => e.subject).sort(), notes: shown.notes.map((n) => n.body).sort(),
        written: [shown.application.cover_note, shown.application.answers, shown.application.consent_at],
      }, `${row.name} in ${row.job_title}`);
      const ours = await detail(dana, row.id);
      if (ours.application.from_book) fromBook += 1;
      if (ours.activities.length > shown.activities.length + ours.activities.filter((a) => a.type === 'call').length || ours.emails.length > shown.emails.length) withHistory += 1;
    }
    // Its dashboard feed, too: the fifteen newest lines of this client's applications that are not calls (or the agency's notes about a post).
    const feed = db(
      `SELECT ac.detail FROM activities ac JOIN applications a ON a.id = ac.application_id JOIN jobs j ON j.id = a.job_id
       WHERE ac.type NOT IN ('call', 'board') AND j.client_id = ? ORDER BY ac.created_at DESC, ac.id DESC LIMIT 15`, clientId).map((r) => r.detail);
    assert.deepEqual(feed, (await who.get('/dashboard')).body.recent.map((r) => r.detail));
  }
  // And no line about The Book hangs from an application in a job, where a feed or a profile could pick it up.
  assert.deepEqual(db(`SELECT ac.detail FROM activities ac JOIN applications a ON a.id = ac.application_id WHERE a.job_id IS NOT NULL AND ac.detail LIKE '%The Book%'`), []);
  assert.equal(JSON.stringify((await alex.get('/dashboard')).body.recent).includes('The Book'), false);
  // The comparison was not an empty one: people who came from The Book are on these jobs, with history only the agency reads.
  assert.ok(fromBook >= 8, `${fromBook} applications that came from The Book`);
  assert.ok(withHistory >= 8, `${withHistory} with history or e-mails only the agency is shown`);
});

test('a note written by a client user can only be deleted by them while they can still open the person it is on', async () => {
  const entry = await saved(dana, { name: 'Tova Lindqvist', email: 'tova@example.com' });
  assert.equal((await addToJob(dana, entry, { job_id: job.accountant })).status, 200);
  const write = async (body) => (await maya.post(`/applications/${entry}/notes`, { body })).body.id;
  const first = await write('Maple: liked her.'), second = await write('Maple: second thoughts.'), third = await write('Maple: third.');
  // While she is on Maple's job, a note of Maya's own goes when Maya deletes it.
  assert.deepEqual((await maya.del(`/notes/${first}`)).body, { ok: true });
  // Back in The Book, Maya is told the same about her note as about a note that never existed, and it stays.
  assert.deepEqual((await dana.del(`/applications/${entry}`)).body, { ok: true, returned: true, id: entry });
  assert.equal((await maya.get(`/applications/${entry}`)).status, 404);
  const refused = await maya.del(`/notes/${second}`), never = await maya.del('/notes/99999999');
  assert.deepEqual([refused.status, refused.body], [403, { error: 'You can only delete your own notes.' }]);
  assert.deepEqual([never.status, never.body], [refused.status, refused.body]);
  // On another client's job it is the same.
  assert.equal((await addToJob(dana, entry, { job_id: job.hygienist })).status, 200);
  assert.deepEqual([(await maya.del(`/notes/${third}`)).status, (await noor.del(`/notes/${third}`)).status], [403, 403]);
  assert.deepEqual((await detail(dana, entry)).notes.map((n) => [n.body, n.private]).sort(), [['Maple: second thoughts.', 1], ['Maple: third.', 1]]);
  assert.deepEqual((await detail(noor, entry)).notes, []);
  assert.equal((await dana.del(`/candidates/${(await detail(dana, entry)).candidate.id}`)).status, 200);
});

// The record of an e-mail is written when the mail provider has answered, which can take seconds. These tests hold
// the provider's answer back (a stand-in for Resend's web API, on this machine) and change the application meanwhile.
test('an e-mail still on its way when the person is put on a job, joined to an application or deleted is recorded where the agency alone reads it, or not at all', async () => {
  const held = [];
  let asked = 0;
  const provider = http.createServer((req, res) => { req.resume(); req.on('end', () => { asked += 1; held.push(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"id":"stand-in"}'); }); }); });
  await new Promise((resolve) => provider.listen(PORTS.mail, '127.0.0.1', resolve));
  const dir = tempDir('pool-mail');
  const server = await startBook({ port: PORTS.mailApi, dataDir: dir, standIn: metaview,
    env: { RESEND_API_KEY: 'stand-in', MAIL_FROM: 'agency@agency.example', RESEND_API_URL: `http://127.0.0.1:${PORTS.mail}/emails` } });
  const read = (query, ...params) => {
    const database = new DatabaseSync(path.join(dir, 'app.db'), { readOnly: true });
    try { return database.prepare(query).all(...params).map((row) => ({ ...row })); } finally { database.close(); }
  };
  /** Where anything about a message with this subject is recorded: a list of "table application" (and the line, for history). */
  const recorded = (subject) => [
    ...read('SELECT application_id AS id FROM emails WHERE subject = ?', subject).map((r) => `emails ${r.id}`),
    ...read('SELECT application_id AS id FROM agency_emails WHERE subject = ?', subject).map((r) => `agency_emails ${r.id}`),
    ...read('SELECT application_id AS id FROM activities WHERE detail = ?', `Emailed candidate: ${subject}`).map((r) => `activities ${r.id}`),
    ...read('SELECT application_id AS id FROM agency_activities WHERE detail = ?', `Emailed candidate: ${subject}`).map((r) => `agency_activities ${r.id}`),
  ];
  /** Start sending, wait until the provider has the message, do `meanwhile`, then let the provider answer. */
  const sendWhile = async (who, id, subject, meanwhile) => {
    const before = asked;
    const sending = who.post(`/applications/${id}/emails`, { subject, body: `BODY of ${subject}` });
    await until(async () => asked, (n) => n > before);
    await meanwhile();
    held.splice(0).forEach((answer) => answer());
    return sending;
  };
  try {
    const owner = session(server.base);
    assert.equal((await owner.post('/setup', { agencyName: 'Harbour Talent', name: 'Alex Morgan', email: 'alex@agency.example', password: 'demo1234' })).status, 200);
    assert.equal((await owner.putJson('/settings', { agencyName: 'Harbour Talent', candidateMail: true })).status, 200); // off until an admin switches them on
    const kestrel = (await owner.post('/clients', { name: 'Kestrel Logistics' })).body.id, lumen = (await owner.post('/clients', { name: 'Lumen Health' })).body.id;
    const { token } = (await owner.post('/invites', { role: 'client', email: 'kim@kestrel.example', client_id: kestrel })).body;
    const kim = session(server.base);
    assert.equal((await kim.post(`/invites/${token}/accept`, { name: 'Kim Client', password: 'demo1234' })).status, 200);
    const sales = (await owner.post('/jobs', { client_id: kestrel, title: 'Head of Sales', status: 'open' })).body.id;
    const nurse = (await owner.post('/jobs', { client_id: lumen, title: 'Nurse Lead', status: 'open' })).body.id;
    const inBook = async (fields) => (await owner.upload('/applications', fields)).body.id;
    const seenByKim = async (id) => { const d = (await kim.get(`/applications/${id}`)).body; return [d.emails.map((e) => e.subject), d.activities.map((a) => a.detail)]; };
    const feed = async () => (await kim.get('/dashboard')).body.recent.map((r) => r.detail);

    // Nothing happens meanwhile: recorded on the application, as it always was, for the hiring team to read too.
    const plain = (await owner.upload('/applications', { job_id: sales, name: 'Pia Plain', email: 'pia@example.com' })).body.id;
    const ordinary = await sendWhile(owner, plain, 'ON-THE-JOB', async () => {});
    assert.deepEqual([ordinary.status, ordinary.body.delivery, ordinary.body.id > 0], [200, 'sent', true]);
    assert.deepEqual(recorded('ON-THE-JOB'), [`emails ${plain}`, `activities ${plain}`]);
    assert.deepEqual(await seenByKim(plain), [['ON-THE-JOB'], ['Emailed candidate: ON-THE-JOB', 'Added to the pipeline (agency sourced)']]);

    // Sent from The Book, and put on a job before the provider answers: the agency's own tables, with the moment it was sent.
    const dana_ = await inBook({ name: 'Dana Whitlock', email: 'dana.whitlock@example.com' });
    const moved = await sendWhile(owner, dana_, 'BOOK-MAIL', async () => assert.equal((await addToJob(owner, dana_, { job_id: sales })).status, 200));
    assert.deepEqual([moved.status, moved.body.delivery, moved.body.id < 0], [200, 'sent', true]);
    assert.deepEqual(recorded('BOOK-MAIL'), [`agency_emails ${dana_}`, `agency_activities ${dana_}`]);
    assert.deepEqual(await seenByKim(dana_), [[], ['Added to Head of Sales at Applied']]);
    const whole = (await owner.get(`/applications/${dana_}`)).body;
    assert.deepEqual(whole.emails.map((e) => [e.id, e.subject, e.body, e.delivery]), [[moved.body.id, 'BOOK-MAIL', 'BODY of BOOK-MAIL', 'sent']]);
    assert.deepEqual(whole.activities.map((a) => a.detail), ['Added to Head of Sales at Applied', 'Emailed candidate: BOOK-MAIL', 'Added to The Book (agency sourced)']);
    assert.ok(read('SELECT created_at FROM agency_emails WHERE application_id = ?', dana_)[0].created_at < whole.application.general_until);

    // Sent from a job, and by the time the provider answers they are back in The Book and on another client's job.
    const next = await sendWhile(owner, dana_, 'KESTREL-MAIL', async () => {
      assert.equal((await owner.del(`/applications/${dana_}`)).body.returned, true);
      assert.equal((await addToJob(owner, dana_, { job_id: nurse })).status, 200);
    });
    assert.deepEqual([next.status, next.body.id < 0], [200, true]);
    assert.deepEqual(recorded('KESTREL-MAIL'), [`agency_emails ${dana_}`, `agency_activities ${dana_}`]);
    assert.deepEqual(read('SELECT COUNT(*) AS n FROM emails WHERE application_id = ?', dana_), [{ n: 0 }]);

    // An interview edited with "send the invitation again" sends an e-mail like any other. With nothing happening
    // meanwhile it is recorded on the application; and when, before the provider answers, they are back in The Book
    // and on another client's job, it is the agency's own, with the one sent before it.
    const invitation = 'Interview for Nurse Lead at Lumen Health';
    const invitations = (table) => read(`SELECT application_id AS id, delivery, body FROM ${table} WHERE subject = ? ORDER BY id`, invitation);
    const visit = (await owner.post('/interviews', { application_id: dana_, title: 'Ward visit', starts_at: '2099-07-01T15:00:00.000Z', panel: [] })).body.id;
    const editWhile = async (changes, meanwhile) => {
      const before = asked;
      const sending = owner.patch(`/interviews/${visit}`, { ...changes, notify: true });
      await until(async () => asked, (n) => n > before);
      await meanwhile();
      held.splice(0).forEach((answer) => answer());
      return sending;
    };
    assert.deepEqual((await editWhile({ starts_at: '2099-07-02T15:00:00.000Z', time_label: 'Thursday 2 July, 11:00' }, async () => {})).body, { ok: true });
    assert.deepEqual([invitations('emails').map((e) => [e.id, e.delivery, /When: Thursday 2 July, 11:00\n/.test(e.body)]), invitations('agency_emails')], [[[dana_, 'sent', true]], []]);
    const late = await editWhile({ starts_at: '2099-07-03T15:00:00.000Z', time_label: 'Friday 3 July, 11:00' }, async () => {
      assert.equal((await owner.del(`/applications/${dana_}`)).body.returned, true);
      assert.equal((await addToJob(owner, dana_, { job_id: sales })).status, 200);
    });
    assert.deepEqual(late.body, { ok: true });
    assert.deepEqual([invitations('emails'), invitations('agency_emails').map((e) => [e.id, e.delivery, e.body.match(/When: (.*)/)[1]])],
      [[], [[dana_, 'sent', 'Thursday 2 July, 11:00'], [dana_, 'sent', 'Friday 3 July, 11:00']]]);
    assert.deepEqual(await seenByKim(dana_), [[], ['Added to Head of Sales at Applied']]);
    assert.equal(/Nurse Lead|Lumen|Ward visit/.test(JSON.stringify((await kim.get(`/applications/${dana_}`)).body)), false);

    // Sent from The Book, and the entry is joined to the application the client's record already has: recorded there, for the agency.
    const there = (await owner.upload('/applications', { job_id: sales, name: 'Enzo Ferri', email: 'enzo@example.com' })).body.id;
    const record = (await owner.get(`/applications/${there}`)).body.candidate.id;
    const enzo = await inBook({ name: 'Enzo Ferri', email: 'enzo@example.com' });
    const joined = await sendWhile(owner, enzo, 'ENTRY-MAIL', async () => assert.deepEqual((await addToJob(owner, enzo, { job_id: sales, into: record })).body, { id: there, merged: true }));
    assert.deepEqual([joined.status, joined.body.delivery, joined.body.id < 0], [200, 'sent', true]);
    assert.deepEqual(recorded('ENTRY-MAIL'), [`agency_emails ${there}`, `agency_activities ${there}`]);
    assert.deepEqual(await seenByKim(there), [[], ['Added to the pipeline (agency sourced)']]);
    assert.ok((await owner.get(`/applications/${there}`)).body.emails.some((e) => e.subject === 'ENTRY-MAIL'));

    // Two entries in The Book merged into one meanwhile: recorded on the one that is kept.
    const one = await inBook({ name: 'Gus Hale', email: 'gus@example.com' }), other = await inBook({ name: 'Gus Hale', linkedin: 'https://www.linkedin.com/in/gus-hale' });
    const person = async (id) => (await owner.get(`/applications/${id}`)).body.candidate.id;
    const [going, kept] = [await person(other), await person(one)];
    const merged = await sendWhile(owner, one, 'TWO-ENTRIES', async () => assert.equal((await owner.post(`/candidates/${kept}/merge`, { into: going })).status, 200));
    assert.deepEqual([merged.status, merged.body.id > 0], [200, true]);
    assert.deepEqual(recorded('TWO-ENTRIES'), [`emails ${other}`, `activities ${other}`]);

    // The application is deleted meanwhile: the request still answers, and nothing is recorded anywhere.
    const gone = await sendWhile(owner, plain, 'DELETED', async () => assert.deepEqual((await owner.del(`/applications/${plain}`)).body, { ok: true }));
    assert.deepEqual([gone.status, gone.body], [200, { id: null, delivery: 'sent' }]);
    assert.deepEqual(recorded('DELETED'), []);

    // The hiring team's feed has the one line that was theirs to see, and no trace of the rest.
    assert.equal(/BOOK-MAIL|KESTREL-MAIL|ENTRY-MAIL|TWO-ENTRIES/.test(JSON.stringify([await feed(), await seenByKim(there), (await kim.get('/applications?status=all')).body])), false);
    assert.equal(asked, 8);
    assert.equal(server.output().includes('constraint failed'), false, server.output());
  } finally {
    held.splice(0).forEach((answer) => answer());
    await server.stop();
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- where this meets the To do page ----------
// To do came with the release before this one, for people in jobs: The Book puts a candidate on their recruiter's To
// prep list a week before an interview and on To debrief when it has been held. These tests hold it to the same for
// people who are saved without a job and put on one later, and to nothing at all while they are on no job.
const NO_ROW = [{ n: 0 }];
/** A new open job, made by Alex. Its account executive is Alex unless another is named (the user id, or null for none). */
const newOpenJob = async (clientId, title, accountExecutive) => {
  const id = (await alex.post('/jobs', { client_id: clientId, title, status: 'open', ...(accountExecutive ? { account_executive_id: accountExecutive } : {}) })).body.id;
  // A job with no account executive cannot be made through the app; written straight in, as an older workspace has them.
  if (accountExecutive === null) {
    const database = new DatabaseSync(path.join(dataDir, 'app.db'));
    try { database.prepare('UPDATE jobs SET account_executive_id = NULL WHERE id = ?').run(id); } finally { database.close(); }
  }
  return { id, stages: (await alex.get(`/jobs/${id}`)).body.stages };
};
const inDays = (days) => new Date(Date.now() + days * 86400000).toISOString();
const book_ = async (who, appId, title, startsAt, extra = {}) => {
  const made = await who.post('/interviews', { application_id: appId, title, starts_at: startsAt, duration_min: 60, panel: [], ...extra });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  return made.body.id;
};
/**
 * Where an application is on somebody's To do page, as [list, job, client, added by The Book, the interview it is
 * about]. On the way it checks the page as a whole: the count in the menu is the number of rows the page shows, and
 * every row of the two people lists says who it is, for which job at which client, and at what stage.
 */
async function onToDo(who, appId) {
  const page = (await who.get('/todos')).body;
  const shown = page.job.open.length + page.prep.open.length + page.debrief.open.length;
  assert.deepEqual([page.counts.total, (await who.get('/nav')).body.todo], [shown, shown], 'the count in the menu is what the page shows');
  const people = ['prep', 'debrief'].flatMap((kind) => [...page[kind].open.map((x) => [kind, x]), ...page[kind].done.map((x) => [`${kind}, done`, x])]);
  for (const [, x] of people) assert.ok(x.name && x.job_id && x.job_title && x.client_name && x.stage_name, `no row is blank: ${JSON.stringify(x)}`);
  return people.filter(([, x]) => x.application_id === appId).map(([where, x]) => [where, x.job_title, x.client_name, x.auto, x.interview?.title ?? null]);
}
/** Whether the picker beside the two people lists offers this application, however it is asked. */
async function offered(who, appId, name) {
  const found = [];
  for (const query of ['', '?whose=all', `?q=${encodeURIComponent(name)}`, `?q=${encodeURIComponent(name.split(' ')[0].slice(0, 3))}`]) {
    const answer = await who.get(`/todos/people${query}`);
    assert.equal(answer.status, 200, `${query}: ${JSON.stringify(answer.body)}`);
    for (const p of answer.body) assert.ok(p.job_id && p.job_title && p.client_name && p.stage_name, `the picker offers nobody without a job: ${JSON.stringify(p)}`);
    if (answer.body.some((p) => p.application_id === appId)) found.push(query);
  }
  return found;
}

test('on no job, nobody can be put on To prep or To debrief; on a job they are on them like anyone else, and they come off both when they go back to The Book', async () => {
  // Dana is the account executive of the jobs in this story: the people The Book puts on To prep go to her.
  const danaId = db(`SELECT id FROM users WHERE email = 'dana@agency.example'`)[0].id;
  const fleet = await newOpenJob(client.maple, 'Fleet Planner', danaId);
  const tova = await saved(dana, { name: 'Tova Lindqvist', email: 'tova@example.com', note: 'Met at the logistics fair.' });
  const menu = async (who) => (await who.get('/nav')).body.todo;
  const [danaBefore, samBefore] = [await menu(dana), await menu(sam)];

  // In The Book she is offered by neither picker nor search, and asking for her by number is refused. Nothing is
  // written, so nothing is counted in the menu that no list could show.
  assert.deepEqual(await offered(dana, tova, 'Tova Lindqvist'), []);
  for (const kind of ['prep', 'debrief']) {
    const asked = await dana.post('/todos', { kind, application_id: tova, note: 'Should not be saved' });
    assert.deepEqual([asked.status, asked.body], [400, NEEDS_JOB], kind);
  }
  assert.deepEqual(db('SELECT COUNT(*) AS n FROM todos WHERE application_id = ?', tova), NO_ROW);
  assert.deepEqual([await menu(dana), await onToDo(dana, tova)], [danaBefore, []]);

  // Sam puts her on a job, at an interview stage, and Alex books the interview. Fleet Planner is Dana's job (and
  // Dana saved her). So she goes on Dana's To prep list, not on that of whoever put her on the job or booked the interview.
  assert.equal((await addToJob(sam, tova, { job_id: fleet.id, stage_id: fleet.stages[1].id })).status, 200);
  assert.deepEqual(await onToDo(dana, tova), [], 'being on a job puts nobody on a list by itself');
  const first = await book_(alex, tova, 'Hiring manager interview', inDays(2));
  assert.deepEqual(await onToDo(dana, tova), [['prep', 'Fleet Planner', 'Maple Freight', true, 'Hiring manager interview']]);
  assert.deepEqual([await onToDo(sam, tova), await onToDo(alex, tova)], [[], []]);
  assert.equal(await menu(dana), danaBefore + 1);
  // Now the picker has her, for Dana among her own and for Sam among everyone's and by name.
  assert.deepEqual(await offered(dana, tova, 'Tova Lindqvist'), ['', '?whose=all', '?q=Tova%20Lindqvist', '?q=Tov']);
  assert.deepEqual(await offered(sam, tova, 'Tova Lindqvist'), ['?whose=all', '?q=Tova%20Lindqvist', '?q=Tov']);
  assert.equal((await sam.post('/todos', { kind: 'prep', application_id: tova, note: 'Sit in on this one' })).status, 200);
  assert.equal((await dana.post('/todos', { kind: 'job', job_id: fleet.id })).status, 200);

  // The interview is held: she is to debrief, for Dana, and both preps come off as done. What she said is saved on
  // her profile for the agency alone.
  assert.equal((await alex.patch(`/interviews/${first}`, { status: 'completed' })).status, 200);
  assert.deepEqual(await onToDo(dana, tova), [['prep, done', 'Fleet Planner', 'Maple Freight', true, 'Hiring manager interview'], ['debrief', 'Fleet Planner', 'Maple Freight', true, 'Hiring manager interview']]);
  assert.deepEqual(await onToDo(sam, tova), [['prep, done', 'Fleet Planner', 'Maple Freight', false, 'Hiring manager interview']]);
  const debrief = (await dana.get('/todos')).body.debrief.open.find((x) => x.application_id === tova);
  const ticked = await dana.patch(`/todos/${debrief.id}`, { done: true, debrief: 'Liked the team; worried about the commute.' });
  assert.equal(ticked.status, 200);
  const said = 'Debrief after Hiring manager interview:\nLiked the team; worried about the commute.';
  assert.deepEqual((await detail(dana, tova)).notes.filter((n) => n.id === ticked.body.note_id).map((n) => [n.body, n.private]), [[said, 1]]);
  assert.equal(JSON.stringify((await maya.get(`/applications/${tova}`)).body).includes('commute'), false);
  // A second interview, and she is to prep again.
  await book_(dana, tova, 'Final interview', inDays(3));
  assert.deepEqual((await onToDo(dana, tova)).map((row) => `${row[0]}: ${row[4]}`), ['prep: Final interview', 'prep, done: Hiring manager interview', 'debrief, done: Hiring manager interview']);
  assert.equal(await menu(dana), danaBefore + 2);   // the job, and her prep

  // Removed from the job, she is back in The Book: off both lists of everyone who had her, done items too, and the
  // menu counts what is left. The job Dana picked stays on her list. What was said at the debrief stays on her profile.
  assert.deepEqual((await dana.del(`/applications/${tova}`)).body, { ok: true, returned: true, id: tova });
  assert.deepEqual([await onToDo(dana, tova), await onToDo(sam, tova)], [[], []]);
  assert.deepEqual([await menu(dana), await menu(sam)], [danaBefore + 1, samBefore]);
  assert.deepEqual((await dana.get('/todos')).body.job.open.filter((x) => x.job_id === fleet.id).map((x) => x.title), ['Fleet Planner']);
  assert.deepEqual(db('SELECT COUNT(*) AS n FROM todos WHERE application_id = ?', tova), NO_ROW);
  const back = await detail(dana, tova);
  assert.deepEqual([back.application.general, back.interviews, back.notes.map((n) => [n.body, n.private]).sort()], [true, [], [[said, 1], ['Met at the logistics fair.', 1]]]);
  // In The Book again she is as she was before: not offered, and refused. An item from an open tab is gone, not stuck.
  assert.deepEqual(await offered(dana, tova, 'Tova Lindqvist'), []);
  assert.deepEqual([(await dana.post('/todos', { kind: 'debrief', application_id: tova })).body, (await dana.patch(`/todos/${debrief.id}`, { done: false })).status], [NEEDS_JOB, 404]);

  // On another client's job, nothing of the first one follows her onto a list. An interview there puts her on Dana's
  // list for that job (Dana's too), and Northline's hiring team is shown none of what was said about Maple's.
  const office = await newOpenJob(client.northline, 'Office Manager', danaId);
  assert.equal((await addToJob(dana, tova, { job_id: office.id })).status, 200);
  assert.deepEqual([await onToDo(dana, tova), await onToDo(sam, tova)], [[], []]);
  await book_(sam, tova, 'Meet the practice', inDays(1));
  assert.deepEqual([await onToDo(dana, tova), await onToDo(sam, tova)], [[['prep', 'Office Manager', 'Northline Dental', true, 'Meet the practice']], []]);
  assert.equal(/commute|Liked the team|Debrief|Fleet|Maple|logistics fair/.test(JSON.stringify((await noor.get(`/applications/${tova}`)).body)), false);
});

test('deleting a job takes it off every To do page, with the people in it: those who go back to The Book and those who go with the job', async () => {
  const dock = await newOpenJob(client.maple, 'Dock Supervisor', db(`SELECT id FROM users WHERE email = 'dana@agency.example'`)[0].id);   // Dana's job
  const ivo = await saved(dana, { name: 'Ivo Brandt', email: 'ivo@example.com' });
  assert.equal((await addToJob(dana, ivo, { job_id: dock.id, stage_id: dock.stages[1].id })).status, 200);
  const una = (await dana.upload('/applications', { job_id: dock.id, name: 'Una Straight', email: 'una@example.com' })).body.id;
  await book_(dana, ivo, 'Recruiter screen', inDays(1));
  await book_(dana, una, 'Recruiter screen', inDays(2));
  assert.equal((await dana.post('/todos', { kind: 'job', job_id: dock.id })).status, 200);
  assert.equal((await sam.post('/todos', { kind: 'debrief', application_id: ivo })).status, 200);
  assert.equal((await sam.post('/todos', { kind: 'job', job_id: dock.id })).status, 200);
  assert.deepEqual([await onToDo(dana, ivo), await onToDo(dana, una), await onToDo(sam, ivo)],
    [[['prep', 'Dock Supervisor', 'Maple Freight', true, 'Recruiter screen']], [['prep', 'Dock Supervisor', 'Maple Freight', true, 'Recruiter screen']], [['debrief', 'Dock Supervisor', 'Maple Freight', false, null]]]);
  const [danaBefore, samBefore] = [(await dana.get('/nav')).body.todo, (await sam.get('/nav')).body.todo];

  assert.equal((await alex.del(`/jobs/${dock.id}`)).status, 200);
  assert.deepEqual([await onToDo(dana, ivo), await onToDo(dana, una), await onToDo(sam, ivo)], [[], [], []]);
  assert.deepEqual([(await dana.get('/nav')).body.todo, (await sam.get('/nav')).body.todo], [danaBefore - 3, samBefore - 2]);
  for (const who of [dana, sam]) assert.equal((await who.get('/todos')).body.job.open.some((x) => x.job_id === dock.id), false);
  assert.deepEqual(db('SELECT COUNT(*) AS n FROM todos WHERE application_id IN (?, ?) OR job_id = ?', ivo, una, dock.id), NO_ROW);
  // Ivo is back in The Book and Una went with the job, as before.
  assert.deepEqual([(await detail(dana, ivo)).application.general, (await dana.get(`/applications/${una}`)).status], [true, 404]);
});

test('an entry joined to a client\'s record, or folded into another application, leaves every to-do item on the application that is kept and none on one that is gone', async () => {
  // Two jobs with no account executive, so that each item goes to the recruiter who owns the candidate: Sam's to
  // Sam and Dana's to Dana, which is what shows where an item ends up when two entries become one.
  const route = await newOpenJob(client.maple, 'Route Analyst', null);
  const depot = await newOpenJob(client.maple, 'Depot Lead', null);
  const rowsFor = (...ids) => db(`SELECT application_id AS app, user_id, kind, note FROM todos WHERE application_id IN (${ids.map(() => '?').join(', ')}) AND done_at IS NULL AND removed_at IS NULL ORDER BY id`, ...ids);
  const idOf = async (who) => (await who.get('/me')).body.user.id;
  const [danaId, samId] = [await idOf(dana), await idOf(sam)];

  // Mira is on Maple's record, in Route Analyst, with an interview: she is on Sam's To prep list, with his note.
  const there = (await sam.upload('/applications', { job_id: route.id, name: 'Mira Oyelaran', email: 'mira@example.com' })).body.id;
  const record = (await detail(sam, there)).candidate.id;
  await book_(sam, there, 'First interview', inDays(2));
  const samsItem = (await sam.get('/todos')).body.prep.open.find((x) => x.application_id === there);
  assert.equal((await sam.patch(`/todos/${samsItem.id}`, { note: 'Bring the route maps' })).status, 200);
  // Dana had saved her to The Book as well. Put on the same job, her entry is joined to the application that is
  // there: Sam's item stays where it is, once, with its note, and nothing is left about the entry that went.
  const entry = await saved(dana, { name: 'Mira Oyelaran', email: 'mira@example.com', note: 'Kept in The Book.' });
  assert.deepEqual((await addToJob(dana, entry, { job_id: route.id, into: record })).body, { id: there, merged: true });
  assert.deepEqual(rowsFor(there, entry), [{ app: there, user_id: samId, kind: 'prep', note: 'Bring the route maps' }]);
  assert.deepEqual([await onToDo(sam, there), await onToDo(dana, there)], [[['prep', 'Route Analyst', 'Maple Freight', true, 'First interview']], []]);

  // Joined to the client's record for another of its jobs, the entry becomes that job's application on the record.
  // What is on a list for the record's other job is untouched, and an interview in the new job goes to the entry's owner.
  const second = await saved(dana, { name: 'Mira Oyelaran', email: 'mira@example.com' });
  const joined = await addToJob(dana, second, { job_id: depot.id, into: record });
  assert.deepEqual(joined.body, { id: second, merged: true });
  await book_(sam, second, 'Depot walk-round', inDays(1));
  assert.deepEqual(rowsFor(there, second), [{ app: there, user_id: samId, kind: 'prep', note: 'Bring the route maps' }, { app: second, user_id: danaId, kind: 'prep', note: null }]);
  assert.deepEqual([await onToDo(sam, there), await onToDo(dana, second), await onToDo(sam, second)],
    [[['prep', 'Route Analyst', 'Maple Freight', true, 'First interview']], [['prep', 'Depot Lead', 'Maple Freight', true, 'Depot walk-round']], []]);

  // Removed from the first job, the application that the entry was joined to goes back to The Book: off Sam's list.
  // The record is still needed for Depot Lead, whose item stays.
  assert.equal((await dana.del(`/applications/${there}`)).body.returned, true);
  assert.deepEqual(rowsFor(there, second), [{ app: second, user_id: danaId, kind: 'prep', note: null }]);
  assert.deepEqual([await onToDo(sam, there), await onToDo(dana, second)], [[], [['prep', 'Depot Lead', 'Maple Freight', true, 'Depot walk-round']]]);

  // Saved to The Book again while on a job, and then removed from the job: the application is folded into the
  // entry The Book already has, and is gone, with its items. The entry that is kept has none.
  const pia = await saved(dana, { name: 'Pia Novak', email: 'pia.novak@example.com' });
  assert.equal((await addToJob(dana, pia, { job_id: route.id })).status, 200);
  await book_(dana, pia, 'First interview', inDays(1));
  assert.equal((await sam.post('/todos', { kind: 'debrief', application_id: pia })).status, 200);
  const again = await saved(sam, { name: 'Pia Novak', email: 'pia.novak@example.com' });
  assert.notEqual(again, pia);
  assert.deepEqual([await onToDo(dana, pia), await onToDo(sam, pia)], [[['prep', 'Route Analyst', 'Maple Freight', true, 'First interview']], [['debrief', 'Route Analyst', 'Maple Freight', false, null]]]);
  assert.deepEqual((await dana.del(`/applications/${pia}`)).body, { ok: true, returned: true, id: again });
  assert.deepEqual(db('SELECT COUNT(*) AS n FROM todos WHERE application_id IN (?, ?)', pia, again), NO_ROW);
  assert.deepEqual([await onToDo(dana, pia), await onToDo(sam, pia), await onToDo(dana, again), await onToDo(sam, again)], [[], [], [], []]);
  assert.deepEqual(await offered(dana, again, 'Pia Novak'), []);

  // Two entries of one person in The Book merged into one: neither can have an item, and the merge leaves none.
  const twin = await saved(dana, { name: 'Pia Novak', linkedin: 'https://www.linkedin.com/in/pia-novak' });
  const person = async (id) => (await detail(dana, id)).candidate.id;
  assert.equal((await dana.post(`/candidates/${await person(twin)}/merge`, { into: await person(again) })).status, 200);
  assert.deepEqual(db('SELECT COUNT(*) AS n FROM todos WHERE application_id IN (?, ?)', twin, again), NO_ROW);
  assert.deepEqual((await dana.post('/todos', { kind: 'prep', application_id: again })).body, NEEDS_JOB);

  // Deleting all data on somebody who came from The Book takes their items with them.
  const before = (await dana.get('/nav')).body.todo;
  assert.equal((await dana.del(`/candidates/${record}`)).status, 200);
  assert.deepEqual(db('SELECT COUNT(*) AS n FROM todos WHERE application_id = ?', second), NO_ROW);
  assert.deepEqual([await onToDo(dana, second), (await dana.get('/nav')).body.todo], [[], before - 1]);
});

// ---------- where this meets editing an interview ----------
// An interview can be edited since the release before this one, and the candidate sent the invitation again. For
// somebody who came from The Book that e-mail, and the line in the history that says what was changed, are like any
// other written after they joined the job: kept where the job's hiring team is shown from, and taken from there
// with everything else if they go on to another job.
test('an interview edited for somebody who came from The Book: the invitation sent again and the line in the history belong to the job, for its hiring team to read and no other client\'s', async () => {
  const yard = await newOpenJob(client.maple, 'Yard Scheduler');
  const wren = await saved(dana, { name: 'Wren Abara', email: 'wren@example.com' });
  assert.equal((await dana.post(`/applications/${wren}/emails`, { subject: 'Keeping in touch', body: 'Hi Wren, between us.' })).status, 200);
  assert.equal((await addToJob(dana, wren, { job_id: yard.id })).status, 200);
  const joined = (await detail(dana, wren)).application.general_until;
  const invitation = 'Interview for Yard Scheduler at Maple Freight';
  const visit = await book_(dana, wren, 'Site visit', '2099-06-01T15:00:00.000Z', { kind: 'onsite', location: 'Dock 4', notify: true, time_label: 'Monday 1 June, 11:00' });
  const edit = async (changes) => {
    const answer = await dana.patch(`/interviews/${visit}`, { title: 'Site visit', kind: 'onsite', duration_min: 60, ...changes });
    assert.deepEqual([answer.status, answer.body], [200, { ok: true }]);
  };
  // Moved to another day, and the invitation sent again. Then a new place at the same time, sent again. Then a
  // longer interview with nothing sent, and its status changed with "send" asked for but no details given.
  await edit({ starts_at: '2099-06-02T16:30:00.000Z', location: 'Dock 4', notify: true, time_label: 'Tuesday 2 June, 12:30' });
  await edit({ starts_at: '2099-06-02T16:30:00.000Z', location: 'Head office, room 2', notify: true, time_label: 'Tuesday 2 June, 12:30' });
  await edit({ starts_at: '2099-06-02T16:30:00.000Z', location: 'Head office, room 2', duration_min: 90 });
  assert.equal((await dana.patch(`/interviews/${visit}`, { status: 'completed', notify: true })).status, 200);
  assert.equal((await dana.patch(`/interviews/${visit}`, { status: 'scheduled', notify: true })).status, 200);

  // Where they are stored: the three invitations and the lines about the interview are in the tables the hiring team
  // is shown from, each written after she joined the job. The agency's own tables hold what was written in The Book.
  const whenAndWhere = (body) => [body.match(/When: (.*)/)[1], body.match(/Where: (.*)/)[1]];
  const sent = [['Monday 1 June, 11:00', 'Dock 4'], ['Tuesday 2 June, 12:30', 'Dock 4'], ['Tuesday 2 June, 12:30', 'Head office, room 2']];
  const lines = ['Added to Yard Scheduler at Applied', 'Scheduled Site visit', 'Rescheduled Site visit', 'Updated Site visit', 'Updated Site visit', 'Site visit marked completed', 'Site visit marked scheduled'];
  const stored = (table, column) => db(`SELECT ${column} AS x, created_at FROM ${table} WHERE application_id = ? ORDER BY id`, wren);
  assert.deepEqual(db('SELECT subject, body, to_email, sent_by FROM emails WHERE application_id = ? ORDER BY id', wren).map((e) => [e.subject, e.to_email, ...whenAndWhere(e.body)]),
    sent.map((s) => [invitation, 'wren@example.com', ...s]));
  assert.deepEqual(stored('activities', 'detail').map((a) => a.x), lines);
  for (const row of [...stored('emails', 'subject'), ...stored('activities', 'detail')]) assert.ok(row.created_at >= joined, `${row.x} was written after she joined the job`);
  assert.deepEqual(stored('agency_emails', 'subject').map((e) => e.x), ['Keeping in touch']);
  assert.deepEqual(stored('agency_activities', 'detail').map((a) => a.x), ['Added to The Book (agency sourced)', 'Emailed candidate: Keeping in touch']);
  for (const row of [...stored('agency_emails', 'subject'), ...stored('agency_activities', 'detail')]) assert.ok(row.created_at < joined);

  // Who is shown them. Maple's hiring team: the invitations and the lines, newest first, and nothing from The Book.
  // The agency: everything. Northline's hiring team cannot open her at all.
  const seen = (await maya.get(`/applications/${wren}`)).body;
  assert.deepEqual(seen.emails.map((e) => [e.subject, ...whenAndWhere(e.body)]), sent.map((s) => [invitation, ...s]).reverse());
  assert.deepEqual(seen.activities.map((a) => a.detail), [...lines].reverse());
  assert.equal(/Keeping in touch|between us|The Book/.test(JSON.stringify(seen)), false);
  assert.equal(/Keeping in touch|The Book/.test(JSON.stringify((await maya.get('/dashboard')).body)), false);
  const whole = await detail(dana, wren);
  assert.deepEqual(whole.emails.map((e) => e.subject), [invitation, invitation, invitation, 'Keeping in touch']);
  assert.deepEqual(whole.activities.map((a) => a.detail), [...lines].reverse().concat(['Emailed candidate: Keeping in touch', 'Added to The Book (agency sourced)']));
  assert.equal((await noor.get(`/applications/${wren}`)).status, 404);
  // The hiring team can edit the interview too, and what they send is on the job like the rest.
  await (async () => {
    const answer = await maya.patch(`/interviews/${visit}`, { title: 'Site visit', kind: 'onsite', duration_min: 90, starts_at: '2099-06-03T16:30:00.000Z', location: 'Head office, room 2', notify: true, time_label: 'Wednesday 3 June, 12:30' });
    assert.equal(answer.status, 200);
  })();
  assert.deepEqual(db('SELECT COUNT(*) AS n FROM emails WHERE application_id = ?', wren), [{ n: 4 }]);
  assert.deepEqual(db('SELECT COUNT(*) AS n FROM agency_emails WHERE application_id = ?', wren), [{ n: 1 }]);

  // Back in The Book the interview is gone and every e-mail is still on her entry, for the agency. Put on a job at
  // another client, all of it is the agency's own: nothing about Maple's interview is where Northline's hiring team
  // is shown from, and they are shown none of it.
  assert.equal((await dana.del(`/applications/${wren}`)).body.returned, true);
  const inBook = await detail(dana, wren);
  assert.deepEqual([inBook.interviews, inBook.emails.map((e) => e.subject)], [[], [invitation, invitation, invitation, invitation, 'Keeping in touch']]);
  const clinic = await newOpenJob(client.northline, 'Clinic Coordinator');
  assert.equal((await addToJob(dana, wren, { job_id: clinic.id })).status, 200);
  assert.deepEqual(db('SELECT COUNT(*) AS n FROM emails WHERE application_id = ?', wren), NO_ROW);
  assert.deepEqual(db('SELECT COUNT(*) AS n FROM agency_emails WHERE application_id = ?', wren), [{ n: 5 }]);
  assert.deepEqual(stored('activities', 'detail').map((a) => a.x), ['Added to Clinic Coordinator at Applied']);
  const atNorthline = (await noor.get(`/applications/${wren}`)).body;
  assert.deepEqual([atNorthline.emails, atNorthline.activities.map((a) => a.detail), atNorthline.interviews], [[], ['Added to Clinic Coordinator at Applied'], []]);
  assert.equal(/Maple|Yard|Site visit|Dock 4|Head office|Keeping in touch/.test(JSON.stringify([atNorthline, (await noor.get('/dashboard')).body, (await noor.get('/interviews')).body])), false);
  const after_ = await detail(dana, wren);
  assert.deepEqual(after_.emails.map((e) => e.subject), [invitation, invitation, invitation, invitation, 'Keeping in touch']);
  assert.ok(after_.activities.some((a) => a.detail === 'Rescheduled Site visit') && after_.activities.some((a) => a.detail === 'Updated Site visit'));
  // An interview at Northline, edited and sent again, is Northline's to read.
  const meet = await book_(dana, wren, 'Meet the practice', '2099-08-01T15:00:00.000Z');
  assert.equal((await dana.patch(`/interviews/${meet}`, { title: 'Meet the practice', starts_at: '2099-08-02T15:00:00.000Z', notify: true, time_label: 'Sunday 2 August, 11:00' })).status, 200);
  const later = (await noor.get(`/applications/${wren}`)).body;
  assert.deepEqual(later.emails.map((e) => [e.subject, ...whenAndWhere(e.body)]), [['Interview for Clinic Coordinator at Northline Dental', 'Sunday 2 August, 11:00', 'Details to follow']]);
  assert.deepEqual(later.activities.map((a) => a.detail), ['Rescheduled Meet the practice', 'Scheduled Meet the practice', 'Added to Clinic Coordinator at Applied']);
});

// ---------- where this meets account executives and the job board ----------
// Every job has an account executive, and the dashboard has a job board with a column for each (the release that is
// live). Somebody on no job is on nobody's board; on a job they are one of the people in it, whoever the job belongs to.
test('account executives and the job board: somebody on no job is in no column and no count, and on a job they are counted in it and stay with the recruiter who owns them when the job is handed on', async () => {
  const idOf = (email) => db('SELECT id FROM users WHERE email = ?', email)[0].id;
  const [alexId, samId] = [idOf('alex@agency.example'), idOf('sam@agency.example')];
  const boardOf = async (who, query = '?board=all') => (await who.get(`/dashboard${query}`)).body.board;
  /** A job's card on the board: whose column it is in, and the people it counts. */
  const card = async (jobId) => {
    for (const column of await boardOf(alex)) {
      const found = column.jobs.find((j) => j.id === jobId);
      if (found) return [column.name, found.in_pipeline, found.interviewing, found.offers, found.hires];
    }
    return null;
  };
  const jobsOf = async (who, executive) => (await who.get(`/jobs?account_executive=${executive}`)).body.map((j) => [j.id, j.total_applicants, j.active_candidates, j.interviewing]);
  const everything = async () => ({ board: await boardOf(alex), open: await boardOf(alex, ''), danas: await boardOf(dana), jobs: await jobsOf(alex, alexId), nobody: await jobsOf(alex, 'none'),
    people: (await alex.get('/account-executives')).body, extension: (await sam.get('/jobs')).body.map((j) => [j.id, j.title, j.status, j.account_executive_name]) });
  const before = await everything();
  const [whose, pipeline, interviewing, offers, hires] = await card(job.accountant);
  assert.equal(whose, 'Alex Morgan');

  // Saved without a job: the board (open jobs, or all of them; for an admin and for a recruiter), the Jobs page
  // narrowed to one person's jobs, the people a job can belong to and the extension's list of jobs are word for
  // word what they were. Nobody has a column for owning somebody who is on no job.
  const una = await saved(sam, { name: 'Una Fairweather', email: 'una@example.com' });
  assert.deepEqual(await everything(), before);
  assert.deepEqual(await jobsOf(alex, samId), []);
  assert.equal(JSON.stringify(before.board).includes('Sam Okoro'), false);

  // Put on Alex's job by Dana, straight into an interview stage: one more in its pipeline and at interview, in
  // Alex's column. She belongs to Sam, who saved her: not to the job's account executive, and not to Dana.
  assert.equal((await addToJob(dana, una, { job_id: job.accountant, stage_id: job.accountantStages[1].id })).status, 200);
  assert.deepEqual(await card(job.accountant), ['Alex Morgan', pipeline + 1, interviewing + 1, offers, hires]);
  assert.equal((await detail(alex, una)).application.owner_name, 'Sam Okoro');
  // The brief is the account executive's: Sam, who owns her, and Dana, who put her on the job, cannot edit it.
  for (const who of [sam, dana]) assert.equal((await put(who, `/jobs/${job.accountant}/brief`, { brief: { about: 'Not theirs to write' } })).status, 403);

  // The job is handed to Sam. It is in his column with the same people counted, he can edit its brief, and she is
  // still his. Dana, who put her on the job, still cannot hand the job on or edit its brief.
  assert.equal((await put(dana, `/jobs/${job.accountant}`, { title: 'Senior Accountant', status: 'open', account_executive_id: idOf('dana@agency.example') })).status, 403);
  assert.equal((await put(alex, `/jobs/${job.accountant}`, { title: 'Senior Accountant', status: 'open', account_executive_id: samId })).status, 200);
  assert.deepEqual(await card(job.accountant), ['Sam Okoro', pipeline + 1, interviewing + 1, offers, hires]);
  assert.deepEqual((await jobsOf(alex, samId)).map(([id]) => id), [job.accountant]);
  assert.equal((await put(sam, `/jobs/${job.accountant}/brief`, { brief: { about: 'Written by its account executive' } })).status, 200);
  assert.equal((await put(dana, `/jobs/${job.accountant}/brief`, { brief: { about: 'Not hers to write' } })).status, 403);
  assert.equal((await detail(alex, una)).application.owner_name, 'Sam Okoro');
  // The client's hiring team sees her on the job, and nothing of whose job it is or of the board.
  const forMaya = { dashboard: (await maya.get('/dashboard')).body, jobs: (await maya.get('/jobs')).body, job: (await maya.get(`/jobs/${job.accountant}`)).body.job, her: (await maya.get(`/applications/${una}`)).body };
  assert.equal('board' in forMaya.dashboard, false);
  for (const shown of [...forMaya.dashboard.jobs, ...forMaya.jobs, forMaya.job, forMaya.her.job]) {
    assert.deepEqual(Object.keys(shown).filter((key) => /account_executive|created_by/.test(key)), [], JSON.stringify(shown));
  }
  assert.equal(/account_executive|The Book/.test(JSON.stringify(forMaya)), false);
  assert.deepEqual(forMaya.her.activities.map((a) => a.detail), ['Started at Recruiter screen', 'Added to Senior Accountant at Recruiter screen']);
  assert.equal((await maya.get('/account-executives')).status, 403);
  assert.deepEqual((await maya.get(`/jobs?account_executive=${alexId}`)).body.map((j) => j.id), (await maya.get('/jobs')).body.map((j) => j.id), 'the filter is ignored for a client user');

  // Removed from the job she goes back to The Book: the job counts what it counted before her, in Sam's column
  // now, and she is in no column again. The job goes back to Alex, so the tests that follow find it as it was.
  assert.equal((await dana.del(`/applications/${una}`)).body.returned, true);
  assert.deepEqual(await card(job.accountant), ['Sam Okoro', pipeline, interviewing, offers, hires]);
  assert.equal((await put(alex, `/jobs/${job.accountant}`, { title: 'Senior Accountant', status: 'open', account_executive_id: alexId })).status, 200);
  assert.deepEqual([(await everything()).board, (await everything()).jobs], [before.board, before.jobs]);
  assert.equal((await dana.del(`/applications/${una}`)).status, 200);
});

test('a card\'s pipeline on the job board: somebody on no job is never in it; put on the job they are, under their stage, and their name opens their profile on the job', async () => {
  const pipelineOf = async (who, jobId) => {
    const res = await who.get(`/jobs/${jobId}/pipeline`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.stages;
  };
  const allJobs = [job.accountant, job.payroll, job.hygienist, job.temp];
  const everyPipeline = async () => Promise.all(allJobs.map((id) => pipelineOf(alex, id)));
  const before = await everyPipeline();

  // Saved without a job, with a photo: in no job's pipeline, under any stage, and no count moves.
  const vera = await saved(sam, { name: 'Vera Lindqvist', email: 'vera.lindqvist@example.com', current_title: 'Payroll Lead', photo: { name: 'vera.png', bytes: PNG } });
  assert.deepEqual(await everyPipeline(), before);
  assert.equal(JSON.stringify(await everyPipeline()).includes('Vera'), false);

  // Put on a job straight into its second stage: she is in that stage, newest first, with the same id her entry had,
  // and that id opens her profile as the job's application (not as somebody in The Book).
  const stage = job.accountantStages[1];
  assert.equal((await addToJob(dana, vera, { job_id: job.accountant, stage_id: stage.id })).status, 200);
  const now = await pipelineOf(alex, job.accountant);
  const was = before[0];
  assert.deepEqual(now.map((s) => [s.id, s.count]), was.map((s) => [s.id, s.count + (s.id === stage.id ? 1 : 0)]));
  const here = now.find((s) => s.id === stage.id).people;
  assert.deepEqual([here[0].id, here[0].name, here[0].status, here[0].current_title, Boolean(here[0].photo)], [vera, 'Vera Lindqvist', 'active', 'Payroll Lead', true]);
  const profile = await detail(alex, here[0].id);
  assert.deepEqual([profile.application.general, profile.job.id, profile.application.stage_id], [false, job.accountant, stage.id]);
  // The other jobs' pipelines did not notice, and the hiring team is not sent the board's pipeline, of this job or any.
  assert.deepEqual((await everyPipeline()).slice(1), before.slice(1));
  assert.equal((await maya.get(`/jobs/${job.accountant}/pipeline`)).status, 403);

  // Hired, she is under Hired, as on the job's own Pipeline tab.
  const hired = job.accountantStages.at(-1);
  assert.equal((await dana.post(`/applications/${vera}/move`, { stage_id: hired.id })).status, 200);
  assert.deepEqual((await pipelineOf(alex, job.accountant)).find((s) => s.id === hired.id).people.filter((a) => a.id === vera).map((a) => a.status), ['hired']);

  // Removed from the job she goes back to The Book, and out of its pipeline: every pipeline is as it was.
  assert.equal((await dana.del(`/applications/${vera}`)).body.returned, true);
  assert.deepEqual(await everyPipeline(), before);
  assert.equal((await dana.del(`/applications/${vera}`)).status, 200);
});

// ---------- where this meets the agency's own jobs page ----------
// "Jobs on our website" came with the release before this one: a confidential advert for a client's job on a public
// board in the agency's name, with its own application form. Somebody who applies there has not been told who the
// client is, and until a recruiter ticks that they know, nothing The Book sends them by itself names the client.
// These tests hold the two to each other: the public forms against people who are in The Book without a job, and
// what the board notes about an applicant against an entry that goes back to The Book and on to another client.
//
// They run on a server of their own, with e-mail delivery connected to a stand-in for the mail provider on this
// machine (the two ports the test above uses, which it has given back by now), so that what a candidate is sent can
// be read, and held back while something else happens.
let meet = null;
/** That server, started the first time it is asked for: an agency, two clients with a hiring manager each, jobs, and two confidential posts. */
function meeting() {
  meet ??= (async () => {
    const sent = [], held = [];
    const m = { sent, hold: false, release: () => held.splice(0).forEach((answer) => answer()) };
    m.provider = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        sent.push(JSON.parse(raw));
        const answer = () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"id":"stand-in"}'); };
        if (m.hold) held.push(answer); else answer();
      });
    });
    await new Promise((resolve) => m.provider.listen(PORTS.mail, '127.0.0.1', resolve));
    m.dir = tempDir('pool-board');
    m.server = await startBook({ port: PORTS.mailApi, dataDir: m.dir, standIn: metaview,
      env: { RESEND_API_KEY: 'stand-in', MAIL_FROM: 'Harbour Talent <jobs@agency.example>', RESEND_API_URL: `http://127.0.0.1:${PORTS.mail}/emails`, TRUST_PROXY: '1' } });
    m.read = (query, ...params) => {
      const database = new DatabaseSync(path.join(m.dir, 'app.db'), { readOnly: true });
      try { return database.prepare(query).all(...params).map((row) => ({ ...row })); } finally { database.close(); }
    };
    m.to = (address) => sent.filter((mail_) => mail_.to.includes(address));
    const ok = (res) => { assert.equal(res.status, 200, JSON.stringify(res.body)); return res.body; };
    m.ok = ok;
    m.boss = session(m.server.base);
    ok(await m.boss.post('/setup', { agencyName: 'Harbour Talent', name: 'Alex Morgan', email: 'alex@agency.example', password: 'demo1234' }));
    ok(await m.boss.putJson('/settings', { agencyName: 'Harbour Talent', candidateMail: true })); // off until an admin switches them on
    m.kestrel = ok(await m.boss.post('/clients', { name: 'Kestrel Logistics' })).id;
    m.lumen = ok(await m.boss.post('/clients', { name: 'Lumen Health' })).id;
    const join = async (role, name, email, extra = {}) => {
      const { token } = ok(await m.boss.post('/invites', { role, email, ...extra }));
      const person = session(m.server.base);
      ok(await person.post(`/invites/${token}/accept`, { name, password: 'demo1234' }));
      return person;
    };
    m.rec = await join('recruiter', 'Dana Recruiter', 'dana@agency.example');
    m.kim = await join('client', 'Kim Castellan', 'kim@kestrel.example', { client_id: m.kestrel });
    m.lena = await join('client', 'Lena Brandt', 'lena@lumen.example', { client_id: m.lumen });
    const newJob = async (clientId, title, extra = {}) => ok(await m.boss.post('/jobs', { client_id: clientId, title, status: 'open', ...extra })).id;
    m.sales = await newJob(m.kestrel, 'Head of Sales', { questions: [{ id: 'q1', label: 'What do you know about Kestrel?', type: 'short', required: false }] });
    m.dispatch = await newJob(m.kestrel, 'Dispatcher');
    m.nurse = await newJob(m.lumen, 'Nurse Lead');
    // Two confidential posts. The Kestrel job stays on Kestrel's careers page as well, under its own title; the Lumen job is on the board only.
    const post = async (jobId, fields) => {
      const saved_ = ok(await m.boss.putJson(`/jobs/${jobId}/board`, { enabled: true, show_salary: false, ...fields }));
      assert.equal(saved_.state.live, true, JSON.stringify(saved_.check.problems));
      return saved_.post.token;
    };
    m.salesPost = await post(m.sales, { title: 'Sales Director', location: 'North of England', description: 'Lead a sales team of eight at a same-day delivery business.', hide_from_careers: false });
    m.nursePost = await post(m.nurse, { title: 'Clinical Lead', location: 'Greater Toronto Area', description: 'Our client runs family clinics across the province and needs somebody to lead a team of nurses.', hide_from_careers: true });
    m.slug = ok(await m.boss.get(`/clients/${m.kestrel}`)).client.slug;
    let visitor = 0;
    /** Send a public form as a visitor from an address of their own, so that the limit on applications counts each apart. */
    m.visit = async (pathname, fields) => {
      const form = new FormData();
      for (const [name, value] of Object.entries(fields)) {
        if (value && typeof value === 'object') form.append(name, new Blob([value.bytes]), value.name);
        else if (value !== undefined) form.append(name, String(value));
      }
      visitor += 1;
      const res = await fetch(`${m.server.base}/api${pathname}`, { method: 'POST', body: form, headers: { 'X-Forwarded-For': `198.51.100.${visitor}` } });
      return { status: res.status, body: await res.json() };
    };
    m.onBoard = (token, fields) => m.visit(`/public/board/posts/${token}/apply`, { consent: 'yes', ...fields });
    m.onCareers = (jobId, fields) => m.visit(`/public/careers/${m.slug}/jobs/${jobId}/apply`, { consent: 'yes', answers: '{}', ...fields });
    m.detail = async (who, id) => ok(await who.get(`/applications/${id}`));
    /** The application this address has in a job. */
    m.inJob = async (jobId, email) => ok(await m.boss.get(`/applications?job_id=${jobId}&status=all`)).find((a) => a.email === email)?.id;
    m.inBook = async (fields) => { const made = ok(await m.rec.upload('/applications', fields)); assert.equal(made.general, true); return made.id; };
    /** What the board has noted about an application, read from the database. */
    m.noted = (id) => m.read('SELECT post_id, public_title, client_known_at IS NOT NULL AS known, direct_applied_at IS NOT NULL AS direct FROM board_applications WHERE application_id = ?', id);
    /** How many people the post's own tab says applied through it. */
    m.applied = async (jobId) => ok(await m.boss.get(`/jobs/${jobId}/board`)).applied;
    /**
     * What a client's hiring team would be shown of an application by the release that is live now (09368bb), should
     * a deploy ever be rolled back to it: its own queries, read straight from the database.
     */
    m.asLive = (id) => ({
      history: m.read(`SELECT ac.detail FROM activities ac WHERE ac.application_id = ? AND ac.type NOT IN ('call', 'board') ORDER BY ac.created_at DESC, ac.id DESC`, id).map((r) => r.detail),
      emails: m.read('SELECT e.subject FROM emails e WHERE e.application_id = ? ORDER BY e.created_at DESC', id).map((r) => r.subject).sort(),
      notes: m.read('SELECT n.body FROM notes n WHERE n.application_id = ? AND n.private = 0 ORDER BY n.created_at DESC', id).map((r) => r.body).sort(),
      written: m.read('SELECT cover_note, answers, consent_at, source FROM applications WHERE id = ?', id).map((r) => [r.cover_note, JSON.parse(r.answers), r.consent_at, r.source])[0],
      board: m.read('SELECT public_title FROM board_applications WHERE application_id = ?', id).map((r) => r.public_title),
    });
    /** The same, as this release shows it to that hiring team (it is never sent what the board noted). */
    m.asShown = async (who, id) => {
      const shown = await m.detail(who, id);
      assert.equal('board' in shown, false);
      return { history: shown.activities.map((a) => a.detail), emails: shown.emails.map((e) => e.subject).sort(), notes: shown.notes.map((n) => n.body).sort(),
        written: [shown.application.cover_note, shown.application.answers, shown.application.consent_at, shown.application.source] };
    };
    return m;
  })();
  return meet;
}
after(async () => {
  if (!meet) return;
  const m = await meet.catch(() => null);
  if (!m) return;
  m.release();
  await m.server?.stop();
  m.provider.closeAllConnections();
  await new Promise((resolve) => m.provider.close(resolve));
  fs.rmSync(m.dir, { recursive: true, force: true });
});
const CONFIRMATION = 'Thanks for applying through Harbour Talent';

test('somebody in The Book who applies on the agency\'s website or on a client\'s careers page is answered exactly as anyone is, and the hiring team is shown what they sent and nothing the agency holds', async () => {
  const m = await meeting();
  // Ines is in The Book: a note, a covering note saved with her entry, the agency's copy of her résumé, and an e-mail from the agency.
  const entry = await m.inBook({ name: 'Ines Okoro', email: 'ines@example.com', linkedin: 'https://www.linkedin.com/in/ines-okoro', phone: '416 555 0111', note: 'AGENCY-NOTE: met at a fair, wants out by June.',
    cover_note: 'AGENCY-COVER: kept with her entry', resume: resume('Ines, as the agency holds her', 'Ines CV (agency).pdf') });
  m.ok(await m.rec.post(`/applications/${entry}/emails`, { subject: 'BOOK-MAIL', body: 'Between us, Ines: Kestrel may have something.' }));
  const before = [await m.detail(m.rec, entry), m.read('SELECT * FROM candidates WHERE email = ?', 'ines@example.com'), m.read('SELECT * FROM applications WHERE id = ?', entry)];

  // She applies through the confidential post, and so does somebody nobody has heard of. The form answers both the
  // same, and each is sent one confirmation with the same words but for the name.
  m.sent.length = 0;
  const hers = await m.onBoard(m.salesPost, { name: 'Ines Okoro', email: 'Ines@Example.com', linkedin: 'https://www.linkedin.com/in/ines-okoro', cover_note: 'HER-NOTE: I would like to lead a sales team.',
    resume: resume('Ines, written for the post', 'Ines for the post.pdf') });
  const anyones = await m.onBoard(m.salesPost, { name: 'Nora Newcomer', email: 'nora@example.com', linkedin: 'https://www.linkedin.com/in/nora-newcomer', cover_note: 'A note.', resume: resume('Nora', 'Nora.pdf') });
  assert.deepEqual([hers.status, hers.body], [200, { ok: true }]);
  assert.deepEqual([hers.status, hers.body], [anyones.status, anyones.body]);
  const words = (address, name) => m.to(address).map((mail_) => [mail_.subject, mail_.text.replaceAll(name, '(name)')]);
  assert.deepEqual(words('ines@example.com', 'Ines'), words('nora@example.com', 'Nora'));
  assert.deepEqual(m.to('ines@example.com').map((mail_) => mail_.subject), [CONFIRMATION]);
  // The same on a client's own careers page, for another of Kestrel's jobs.
  m.sent.length = 0;
  const direct = await m.onCareers(m.dispatch, { name: 'Ines Okoro', email: 'ines@example.com', cover_note: 'HER-NOTE to Kestrel, for dispatch.' });
  const anyDirect = await m.onCareers(m.dispatch, { name: 'Nora Newcomer', email: 'nora@example.com', cover_note: 'A note.' });
  assert.deepEqual([direct.status, direct.body, direct.status, direct.body], [200, { ok: true }, anyDirect.status, anyDirect.body]);
  assert.deepEqual(words('ines@example.com', 'Ines'), words('nora@example.com', 'Nora'));
  assert.deepEqual(m.to('ines@example.com').map((mail_) => mail_.subject), ['We received your application for Dispatcher']);

  // Her entry in The Book is exactly as it was: the forms joined her to nothing and changed nothing.
  assert.deepEqual([await m.detail(m.rec, entry), m.read('SELECT * FROM candidates WHERE id = ?', before[1][0].id), m.read('SELECT * FROM applications WHERE id = ?', entry)],
    [{ ...before[0], elsewhere: (await m.detail(m.rec, entry)).elsewhere }, before[1], before[2]]);
  // Kestrel has a record of its own for her, made from what she typed, with her two applications on it.
  const onPost = await m.inJob(m.sales, 'ines@example.com'), onCareers = await m.inJob(m.dispatch, 'ines@example.com');
  const record = (await m.detail(m.rec, onPost)).candidate;
  assert.deepEqual([record.client_id, record.phone, (await m.detail(m.rec, onCareers)).candidate.id], [m.kestrel, null, record.id]);
  assert.deepEqual(m.noted(onPost), [{ post_id: 1, public_title: 'Sales Director', known: 0, direct: 0 }]);
  // The agency is told she is on file twice. Nobody else is.
  assert.deepEqual((await m.detail(m.rec, onPost)).elsewhere.map((r) => [r.application_id, r.client_id, r.same_email]), [[entry, null, true]]);
  assert.deepEqual((await m.detail(m.rec, entry)).elsewhere.map((r) => [r.candidate_id, r.client_name, r.same_email]), [[record.id, 'Kestrel Logistics', true]]);

  // Kestrel's hiring team is shown what she sent them, and not a word of what the agency holds.
  const nothingOfTheBook = (answer) => assert.equal(/AGENCY-NOTE|AGENCY-COVER|BOOK-MAIL|Between us|The Book|agency\)\.pdf|416 555 0111|elsewhere|earlier/i.test(JSON.stringify(answer).replace('"earlier_resumes":[]', '')), false, JSON.stringify(answer));
  const shownOnPost = await m.detail(m.kim, onPost);
  assert.deepEqual([shownOnPost.application.cover_note, shownOnPost.application.resume_name, shownOnPost.application.source, shownOnPost.notes, shownOnPost.emails.map((e) => e.subject), shownOnPost.activities.map((a) => a.detail), shownOnPost.earlier_resumes],
    ['HER-NOTE: I would like to lead a sales team.', 'Ines for the post.pdf', 'our_website', [], [CONFIRMATION], ['Applied via the agency’s website'], []]);
  for (const answer of [shownOnPost, await m.detail(m.kim, onCareers), m.ok(await m.kim.get('/applications?status=all')), m.ok(await m.kim.get('/dashboard')), m.ok(await m.kim.get('/reports'))]) nothingOfTheBook(answer);
  assert.equal((await m.kim.get(`/applications/${entry}`)).status, 404);

  // The agency joins her entry to the application she made through the post. One person cannot be in a job twice,
  // so the entry is folded into it. What she wrote and sent is still hers, apart from what the agency held: her
  // note, her résumé and her consent stay on the application, and the agency's are kept where only the agency reads.
  const consent = shownOnPost.application.consent_at;
  assert.deepEqual(m.ok(await addToJob(m.rec, entry, { job_id: m.sales, into: record.id })), { id: onPost, merged: true });
  const shown = await m.detail(m.kim, onPost);
  assert.deepEqual([shown.application.cover_note, shown.application.resume_name, shown.application.consent_at, shown.application.source, shown.notes, shown.emails.map((e) => e.subject), shown.activities.map((a) => a.detail), shown.earlier_resumes],
    ['HER-NOTE: I would like to lead a sales team.', 'Ines for the post.pdf', consent, 'our_website', [], [CONFIRMATION], ['Applied via the agency’s website'], []]);
  assert.equal(m.ok(await m.kim.get(`/applications/${onPost}/resume`)).toString(), 'Ines, written for the post');
  nothingOfTheBook({ ...shown, candidate: { ...shown.candidate, phone: null } }); // her number is one of the contact details the record was missing, which the dialog says it takes
  assert.equal(shown.candidate.phone, '416 555 0111');
  for (const answer of [m.ok(await m.kim.get('/applications?status=all')), m.ok(await m.kim.get('/dashboard'))]) nothingOfTheBook(answer);
  const ours = await m.detail(m.rec, onPost);
  assert.deepEqual(ours.notes.map((n) => [n.body, n.private]).sort(), [['AGENCY-NOTE: met at a fair, wants out by June.', 1], ['Saved with their entry in The Book: AGENCY-COVER: kept with her entry', 1]]);
  assert.deepEqual([ours.emails.map((e) => [e.subject, e.agency_only]), ours.earlier_resumes.map((r) => r.name), ours.application.from_book], [[[CONFIRMATION, 0], ['BOOK-MAIL', 1]], ['Ines CV (agency).pdf'], true]);
  // She is still somebody who came through the post and has not been told who the client is.
  assert.deepEqual([ours.board.title, ours.board.client_known, m.noted(onPost)], ['Sales Director', false, [{ post_id: 1, public_title: 'Sales Director', known: 0, direct: 0 }]]);
  // And nothing of the agency's is stored where the release that is live now shows a hiring team from.
  for (const id of [onPost, onCareers]) {
    const { board, ...live } = m.asLive(id);
    assert.deepEqual(live, await m.asShown(m.kim, id));
  }

  // Applying again through the post, now that her entry is part of that application: answered as before, nothing
  // saved from the form, and the hiring team's view gains only the line that she applied again. One address is sent
  // three e-mails an hour at most, whoever it belongs to, and what the agency sent her while she was in The Book
  // counts as it did before it was moved to the agency's own table: so this time there is no confirmation. Nora,
  // who has had two e-mails, is sent a third and then no fourth.
  m.sent.length = 0;
  const again = await m.onBoard(m.salesPost, { name: 'Ines O', email: 'ines@example.com', cover_note: 'SECOND-NOTE', resume: resume('second', 'Second.pdf') });
  assert.deepEqual([again.status, again.body, m.to('ines@example.com')], [200, { ok: true }, []]);
  assert.deepEqual(m.read(`SELECT (SELECT COUNT(*) FROM emails WHERE to_email = ?1) AS shown, (SELECT COUNT(*) FROM agency_emails WHERE to_email = ?1) AS kept`, 'ines@example.com'), [{ shown: 2, kept: 1 }]);
  const third = await m.onBoard(m.salesPost, { name: 'Nora Newcomer', email: 'nora@example.com' }), fourth = await m.onBoard(m.salesPost, { name: 'Nora Newcomer', email: 'nora@example.com' });
  assert.deepEqual([third.body, fourth.body, m.to('nora@example.com').map((mail_) => mail_.subject)], [{ ok: true }, { ok: true }, [CONFIRMATION]]);
  const after_ = await m.detail(m.kim, onPost);
  assert.deepEqual([after_.application.cover_note, after_.application.resume_name, after_.activities.map((a) => a.detail), after_.notes], ['HER-NOTE: I would like to lead a sales team.', 'Ines for the post.pdf', ['Applied again, through the agency’s website', 'Applied via the agency’s website'], []]);
  nothingOfTheBook({ ...after_, candidate: { ...after_.candidate, phone: null } });
  assert.equal(uploadsOf(m).some((name) => fs.readFileSync(path.join(m.dir, 'uploads', name)).toString() === 'second'), false, 'the résumé sent with a form that saved nothing is not kept');
});

/** Somebody applies through a confidential post, and the agency joins an entry it holds on them to that application: so they are somebody who came from The Book, and go back to it when they leave the job. Resolves to the application's id. */
async function throughPostWithEntry(m, token, jobId, name, email, extra = {}) {
  m.ok(await m.onBoard(token, { name, email, cover_note: extra.note ?? `POST-NOTE from ${name}`, ...(extra.resume ? { resume: extra.resume } : {}) }));
  const id = await m.inJob(jobId, email);
  const record = (await m.detail(m.rec, id)).candidate.id;
  const entry = await m.inBook({ name, email, note: `AGENCY-NOTE on ${name}` });
  assert.deepEqual(m.ok(await addToJob(m.rec, entry, { job_id: jobId, into: record })), { id, merged: true });
  return id;
}

test('somebody who came through a confidential post and goes back to The Book takes nothing of the post or of that client to the next client\'s job', async () => {
  const m = await meeting();
  const before = await m.applied(m.sales);
  // Jo has not been told who the client is; Kay has, and the tick says so.
  const jo = await throughPostWithEntry(m, m.salesPost, m.sales, 'Jo Marchetti', 'jo@example.com', { resume: resume('Jo, written for the post', 'Jo for the post.pdf') });
  const kay = await throughPostWithEntry(m, m.salesPost, m.sales, 'Kay Lindqvist', 'kay@example.com');
  assert.equal(m.ok(await m.rec.putJson(`/applications/${kay}/client-known`, { known: true })).client_known, true);
  assert.equal(await m.applied(m.sales), before + 2);
  assert.deepEqual([(await m.detail(m.rec, jo)).board, m.noted(jo)], [{ title: 'Sales Director', client_known: false, client_known_at: null, client_known_by_name: null }, [{ post_id: 1, public_title: 'Sales Director', known: 0, direct: 0 }]]);
  const agreed = (await m.detail(m.rec, jo)).application.consent_at.slice(0, 10);

  // While Jo is on Kestrel's job, what The Book sends by itself keeps the client's name from Jo: the invitation
  // uses the title Jo applied under and says "our client", and one that would name Kestrel all the same is held
  // back. A held e-mail is recorded nowhere: not where the hiring team reads, and not in the agency's own table.
  const mailRows = () => m.read(`SELECT (SELECT COUNT(*) FROM emails) AS shown, (SELECT COUNT(*) FROM agency_emails) AS kept, (SELECT COUNT(*) FROM activities WHERE type = 'email') + (SELECT COUNT(*) FROM agency_activities WHERE type = 'email') AS lines`)[0];
  m.sent.length = 0;
  let rows = mailRows();
  const first = m.ok(await m.rec.post('/interviews', { application_id: jo, title: 'First call', starts_at: inDays(3), notify: true, time_label: 'Tuesday at 10', location: 'By phone', panel: [] }));
  assert.deepEqual([first.notice, m.sent.map((mail_) => mail_.subject)], [undefined, ['Interview for Sales Director at our client']]);
  assert.deepEqual(mailRows(), { ...rows, shown: rows.shown + 1 });
  rows = mailRows();
  const heldBack = m.ok(await m.rec.patch(`/interviews/${first.id}`, { starts_at: inDays(4), location: 'Kestrel Logistics, 12 Dock Road', notify: true }));
  assert.match(heldBack.notice, /^The e-mail was not sent: it names the client, and this candidate applied through your confidential post/);
  assert.deepEqual([m.sent.length, mailRows()], [1, rows]);
  // An e-mail written by hand that names Kestrel is refused until the recruiter has seen the warning, and a refused one is recorded nowhere either.
  const refused = await m.rec.post(`/applications/${jo}/emails`, { subject: 'About Kestrel', body: 'Kestrel Logistics would like to meet you.' });
  assert.deepEqual([refused.status, refused.body.code, m.sent.length, mailRows()], [409, 'names_client', 1, rows]);
  assert.deepEqual(m.ok(await m.rec.post(`/applications/${jo}/emails/check`, { subject: 'About Kestrel', body: 'Kestrel Logistics would like to meet you.' })), { names_client: true });
  // Jo is on the To prep list of the job's account executive (Alex, who made it), for that interview, like anyone in a job.
  assert.deepEqual(await onToDo(m.boss, jo), [['prep', 'Head of Sales', 'Kestrel Logistics', true, 'First call']]);
  assert.deepEqual(await onToDo(m.rec, jo), []);
  // In the reports the source is the agency's website: "Our website" to the agency, the agency's to the client.
  const sources = async (who, query = '') => m.ok(await who.get(`/reports${query}`)).sources.map((x) => [x.source, x.label, x.applicants]);
  assert.ok((await sources(m.rec, `?client_id=${m.kestrel}`)).some(([source, label]) => source === 'our_website' && label === 'Our website'));
  assert.ok((await sources(m.kim)).some(([source, label]) => source === 'our_website' && label === 'Agency website'));

  // (Were the consent Kay ticked on the form ever missing from her application, it would still be one she made
  // on the agency's website, and would be treated as that. Written straight into the database: no screen can do it.)
  const direct = new DatabaseSync(path.join(m.dir, 'app.db'));
  direct.exec('PRAGMA busy_timeout = 2000');
  direct.prepare('UPDATE applications SET consent_at = NULL WHERE id = ?').run(kay);
  direct.close();
  // Both are removed from the job. They came from The Book, so they go back to it.
  for (const id of [jo, kay]) assert.deepEqual(m.ok(await m.rec.del(`/applications/${id}`)), { ok: true, returned: true, id });
  // What the board noted about the application was that job's, and went with it: the post, the title they saw, the tick.
  assert.deepEqual([m.noted(jo), m.noted(kay), await m.applied(m.sales)], [[], [], before]);
  const inBook = await m.detail(m.rec, jo);
  assert.deepEqual([inBook.application.general, inBook.board, inBook.application.source, inBook.application.cover_note, inBook.application.consent_at, inBook.application.resume_name, inBook.earlier_resumes.map((r) => r.name)],
    [true, null, 'agency_sourced', null, null, null, ['Jo for the post.pdf']]);
  // The agency keeps, as its own note, what the application was and whether they had been told.
  const keptNote = (detail_) => detail_.notes.find((n) => n.body.startsWith('From their own application'));
  assert.deepEqual([keptNote(inBook).private, keptNote(inBook).body.split('\n\n')], [1, [
    `From their own application for Head of Sales at Kestrel Logistics, where they agreed to their data being processed on ${agreed}. Kept for the agency only.`,
    'They applied through your confidential post “Sales Director” and had not been told who the client is.',
    'Note from the candidate:\nPOST-NOTE from Jo Marchetti']]);
  assert.deepEqual(keptNote(await m.detail(m.rec, kay)).body.split('\n\n').slice(0, 2), ['From their own application for Head of Sales at Kestrel Logistics. Kept for the agency only.',
    'They applied through your confidential post “Sales Director” and had since been told who the client is.']);
  assert.equal((await m.detail(m.rec, kay)).application.source, 'agency_sourced');
  // In The Book the tick has nothing to be about, a message is not looked at for the client's name, Jo is on nobody's To prep list, and no list of The Book carries the board's source.
  const noTick = await m.rec.putJson(`/applications/${jo}/client-known`, { known: true });
  assert.deepEqual([noTick.status, noTick.body.error], [400, 'This candidate did not apply through a confidential post.']);
  assert.deepEqual(m.ok(await m.rec.post(`/applications/${jo}/emails/check`, { subject: 'About Kestrel', body: 'Kestrel Logistics would like to meet you.' })), { names_client: false });
  assert.deepEqual([await onToDo(m.rec, jo), await onToDo(m.boss, jo)], [[], []]);
  assert.deepEqual(m.ok(await m.rec.get('/applications?general=1')).filter((a) => a.source === 'our_website'), []);
  assert.deepEqual(m.read(`SELECT id FROM applications WHERE job_id IS NULL AND source = 'our_website'`), []);
  assert.equal((await sources(m.rec, `?client_id=${m.kestrel}`)).find(([source]) => source === 'our_website')?.[2] ?? 0, before);

  // Put on Lumen's job. Lumen's hiring team is shown Jo from that moment on: no post, no title, no Kestrel, no note
  // Jo wrote for the post, no "website", and the source of somebody the agency holds.
  for (const id of [jo, kay]) assert.deepEqual(m.ok(await addToJob(m.rec, id, { job_id: m.nurse })), { id, merged: false });
  const atLumen = await m.detail(m.lena, jo);
  assert.deepEqual([atLumen.application.source, atLumen.application.cover_note, atLumen.application.answers, atLumen.application.consent_at, atLumen.application.resume_name, atLumen.notes, atLumen.emails, atLumen.activities.map((a) => a.detail), 'board' in atLumen],
    ['agency_sourced', null, [], null, null, [], [], ['Added to Nurse Lead at Applied'], false]);
  const nothingOfKestrel = (answer) => assert.equal(/kestrel|sales|confidential|website|our client|POST-NOTE|AGENCY-NOTE|First call|Dock Road|for the post/i.test(JSON.stringify(answer)), false, JSON.stringify(answer));
  for (const who of [jo, kay]) nothingOfKestrel(await m.detail(m.lena, who));
  for (const answer of [m.ok(await m.lena.get('/applications?status=all')), m.ok(await m.lena.get('/dashboard')), m.ok(await m.lena.get('/reports')), m.ok(await m.lena.get(`/jobs/${m.nurse}`)), m.ok(await m.lena.get('/interviews'))]) nothingOfKestrel(answer);
  assert.deepEqual(await sources(m.lena), [['agency_sourced', 'Agency sourced', 2]]);
  // To the agency they are somebody on Lumen's job like any other: the board has no record of this application,
  // the post on Lumen's own job does not count them, and the tick is not offered. Kay's "knows who the client is"
  // was about Kestrel, and has not become a tick about Lumen.
  for (const id of [jo, kay]) assert.deepEqual([(await m.detail(m.rec, id)).board, m.noted(id)], [null, []]);
  assert.equal(await m.applied(m.nurse), 0);
  assert.equal((await m.rec.putJson(`/applications/${kay}/client-known`, { known: false })).status, 400);
  // So what The Book sends Jo by itself is about this job, in this client's name, like anybody else's on it.
  m.sent.length = 0;
  const ward = m.ok(await m.rec.post('/interviews', { application_id: jo, title: 'Ward visit', starts_at: inDays(5), notify: true, time_label: 'Friday at 2', location: 'Lumen Health, 3 King Street', panel: [] }));
  assert.deepEqual([ward.notice, m.sent.map((mail_) => mail_.subject)], [undefined, ['Interview for Nurse Lead at Lumen Health']]);
  assert.equal(/Sales Director|our client|Kestrel/i.test(m.sent[0].text), false, m.sent[0].text);
  assert.deepEqual((await m.detail(m.lena, jo)).emails.map((e) => e.subject), ['Interview for Nurse Lead at Lumen Health']);
  // And a hand-written message that names the new client needs no warning.
  assert.deepEqual(m.ok(await m.rec.post(`/applications/${jo}/emails/check`, { subject: 'About Lumen', body: 'Lumen Health would like to meet you.' })), { names_client: false });
  // The agency still has all of it: the history of the first job, the confirmation, and its own notes.
  const whole = await m.detail(m.rec, jo);
  assert.ok(whole.activities.some((a) => a.detail === 'Applied via the agency’s website' && a.agency_only === 1));
  assert.ok(whole.emails.some((e) => e.subject === CONFIRMATION && e.agency_only === 1) && whole.emails.some((e) => e.subject === 'Interview for Sales Director at our client' && e.agency_only === 1));
  assert.ok(whole.notes.some((n) => n.body === 'AGENCY-NOTE on Jo Marchetti' && n.private === 1));
  // Read the way the release that is live now would read it, should a deploy be rolled back: Lumen's hiring team is
  // shown the same, and that release finds no record of a post on either application.
  for (const id of [jo, kay]) {
    const { board, ...live } = m.asLive(id);
    assert.deepEqual([board, live], [[], await m.asShown(m.lena, id)]);
  }
  // Kestrel's hiring team can no longer open either of them.
  assert.deepEqual([(await m.kim.get(`/applications/${jo}`)).status, (await m.kim.get(`/applications/${kay}`)).status], [404, 404]);
});

test('an e-mail that names the client: sent with the warning seen it makes the tick, and one still on its way when the person leaves the job, or is joined to an application made through a post, is the agency\'s own', async () => {
  const m = await meeting();
  /** Where anything about a message with this subject is recorded: "table application", as in the test of e-mails on their way above. */
  const recorded = (subject) => [
    ...m.read('SELECT application_id AS id FROM emails WHERE subject = ?', subject).map((r) => `emails ${r.id}`),
    ...m.read('SELECT application_id AS id FROM agency_emails WHERE subject = ?', subject).map((r) => `agency_emails ${r.id}`),
    ...m.read('SELECT application_id AS id FROM activities WHERE detail = ?', `Emailed candidate: ${subject}`).map((r) => `activities ${r.id}`),
    ...m.read('SELECT application_id AS id FROM agency_activities WHERE detail = ?', `Emailed candidate: ${subject}`).map((r) => `agency_activities ${r.id}`),
  ];
  const boardLines = (id) => m.read(`SELECT 'shown' AS kept, detail FROM activities WHERE application_id = ?1 AND type = 'board' UNION ALL SELECT 'agency', detail FROM agency_activities WHERE application_id = ?1 AND type = 'board'`, id);
  /** Start sending, wait until the provider has the message, do `meanwhile`, then let the provider answer. */
  const sendWhile = async (id, subject, meanwhile, extra = {}) => {
    const had = m.sent.length;
    m.hold = true;
    const sending = m.rec.post(`/applications/${id}/emails`, { subject, body: `Kestrel Logistics would like to meet you. (${subject})`, ...extra });
    await until(async () => m.sent.length, (n) => n > had);
    m.hold = false;
    await meanwhile();
    m.release();
    return sending;
  };
  const naming = { names_client_ok: true };

  // Sent with the warning seen, and delivered: the candidate now knows, and the tick is made. The message is on the
  // job for its hiring team to read; that the agency noted the tick is not.
  const lou = await throughPostWithEntry(m, m.salesPost, m.sales, 'Lou Ferrand', 'lou@example.com');
  const told = await sendWhile(lou, 'TOLD', async () => {}, naming);
  assert.deepEqual([told.status, told.body.delivery, told.body.id > 0], [200, 'sent', true]);
  assert.deepEqual([recorded('TOLD'), m.noted(lou).map((b) => b.known), boardLines(lou)], [[`emails ${lou}`, `activities ${lou}`], [1], [{ kept: 'shown', detail: 'Told who the client is, by e-mail' }]]);
  const louAtKestrel = await m.detail(m.kim, lou);
  assert.deepEqual([louAtKestrel.emails.map((e) => e.subject), louAtKestrel.activities.map((a) => a.detail)], [['TOLD', CONFIRMATION], ['Emailed candidate: TOLD', 'Applied via the agency’s website']]);
  const inFeed = async (who) => m.ok(await who.get('/dashboard')).recent.filter((r) => r.application_id === lou).map((r) => r.detail);
  assert.deepEqual([await inFeed(m.rec), await inFeed(m.kim)], [['Told who the client is, by e-mail', 'Emailed candidate: TOLD', 'Applied via the agency’s website'], ['Emailed candidate: TOLD', 'Applied via the agency’s website']]);
  // The release that is live now would show Kestrel's hiring team the same of this application, feed included.
  const { board: louBoard, ...louLive } = m.asLive(lou);
  assert.deepEqual([louBoard, louLive], [['Sales Director'], await m.asShown(m.kim, lou)]);
  assert.deepEqual(m.read(`SELECT ac.detail FROM activities ac JOIN applications a ON a.id = ac.application_id JOIN jobs j ON j.id = a.job_id WHERE ac.type NOT IN ('call', 'board') AND j.client_id = ? ORDER BY ac.created_at DESC, ac.id DESC LIMIT 15`, m.kestrel).map((r) => r.detail),
    m.ok(await m.kim.get('/dashboard')).recent.map((r) => r.detail));

  // Still on its way when the person has gone back to The Book and on to another client's job: the record is the
  // agency's own, with the history line beside it. The tick was the first job's: nothing is ticked, and no line about
  // it is written on the application that is now Lumen's.
  const mia = await throughPostWithEntry(m, m.salesPost, m.sales, 'Mia Haddad', 'mia@example.com');
  const late = await sendWhile(mia, 'LATE', async () => {
    assert.equal(m.ok(await m.rec.del(`/applications/${mia}`)).returned, true);
    m.ok(await addToJob(m.rec, mia, { job_id: m.nurse }));
  }, naming);
  assert.deepEqual([late.status, late.body.delivery, late.body.id < 0], [200, 'sent', true]);
  assert.deepEqual([recorded('LATE'), m.noted(mia), boardLines(mia), (await m.detail(m.rec, mia)).board], [[`agency_emails ${mia}`, `agency_activities ${mia}`], [], [], null]);
  const miaAtLumen = await m.detail(m.lena, mia);
  assert.deepEqual([miaAtLumen.emails, miaAtLumen.activities.map((a) => a.detail), /kestrel|LATE|confidential|website/i.test(JSON.stringify(miaAtLumen))], [[], ['Added to Nurse Lead at Applied'], false]);

  // Back in The Book only: recorded on their entry, which only the agency opens, and again nothing is ticked.
  const ned = await throughPostWithEntry(m, m.salesPost, m.sales, 'Ned Okafor', 'ned@example.com');
  const home = await sendWhile(ned, 'HOME', async () => assert.equal(m.ok(await m.rec.del(`/applications/${ned}`)).returned, true), naming);
  assert.deepEqual([home.status, home.body.delivery], [200, 'sent']);
  assert.deepEqual([recorded('HOME'), m.noted(ned), boardLines(ned), (await m.detail(m.rec, ned)).application.general], [[`emails ${ned}`, `activities ${ned}`], [], [], true]);

  // The other way round. The agency writes to somebody in The Book, which needs no warning: no post is in view.
  // Before the provider answers, their entry is joined to the application they made through the post. The record
  // goes there for the agency alone, as any e-mail from before the job does; and because nobody was warned and said
  // "send anyway", the person is still somebody who has not been told who the client is.
  m.ok(await m.onBoard(m.salesPost, { name: 'Noa Castel', email: 'noa@example.com' }));
  const noa = await m.inJob(m.sales, 'noa@example.com');
  const record = (await m.detail(m.rec, noa)).candidate.id;
  const entry = await m.inBook({ name: 'Noa Castel', email: 'noa@example.com' });
  assert.deepEqual(m.ok(await m.rec.post(`/applications/${entry}/emails/check`, { subject: 'ENTRY', body: 'Kestrel Logistics would like to meet you.' })), { names_client: false });
  const joined = await sendWhile(entry, 'ENTRY', async () => assert.deepEqual(m.ok(await addToJob(m.rec, entry, { job_id: m.sales, into: record })), { id: noa, merged: true }));
  assert.deepEqual([joined.status, joined.body.delivery, joined.body.id < 0], [200, 'sent', true]);
  assert.deepEqual([recorded('ENTRY'), m.noted(noa).map((b) => b.known), boardLines(noa)], [[`agency_emails ${noa}`, `agency_activities ${noa}`], [0], []]);
  const noaAtKestrel = await m.detail(m.kim, noa);
  assert.deepEqual([noaAtKestrel.emails.map((e) => e.subject), noaAtKestrel.activities.map((a) => a.detail)], [[CONFIRMATION], ['Applied via the agency’s website']]);
  // So the next thing The Book sends Noa by itself still says "our client".
  m.sent.length = 0;
  m.ok(await m.rec.post('/interviews', { application_id: noa, title: 'First call', starts_at: inDays(6), notify: true, location: 'By phone', panel: [] }));
  assert.deepEqual(m.sent.map((mail_) => mail_.subject), ['Interview for Sales Director at our client']);
  assert.equal(m.server.output().includes('constraint failed'), false, m.server.output());
});

test('put on a job that has a confidential post from The Book, somebody is on it like anyone the agency adds; and "Our website" is only ever an application made on the board', async () => {
  const m = await meeting();
  const applied = await m.applied(m.nurse);
  // Pat is in The Book, and is put on Lumen's job, which is advertised on the agency's website only.
  const pat = await m.inBook({ name: 'Pat Varga', email: 'pat@example.com', note: 'AGENCY-NOTE on Pat' });
  m.ok(await m.rec.post(`/applications/${pat}/emails`, { subject: 'BOOK-MAIL to Pat', body: 'Between us.' }));
  assert.deepEqual(m.ok(await addToJob(m.rec, pat, { job_id: m.nurse })), { id: pat, merged: false });
  // The agency put Pat on the job: the board has no record of an application, the post does not count one, and
  // what The Book sends is in the client's name.
  assert.deepEqual([(await m.detail(m.rec, pat)).board, m.noted(pat), await m.applied(m.nurse)], [null, [], applied]);
  m.sent.length = 0;
  m.ok(await m.rec.post('/interviews', { application_id: pat, title: 'Ward visit', starts_at: inDays(5), notify: true, location: 'Lumen Health, 3 King Street', panel: [] }));
  assert.deepEqual(m.sent.map((mail_) => mail_.subject), ['Interview for Nurse Lead at Lumen Health']);
  const seen = async () => { const d = await m.detail(m.lena, pat); return [d.notes, d.emails.map((e) => e.subject), d.activities.map((a) => a.detail), d.application.source]; };
  assert.deepEqual(await seen(), [[], ['Interview for Nurse Lead at Lumen Health'], ['Scheduled Ward visit', 'Added to Nurse Lead at Applied'], 'agency_sourced']);
  // Pat then finds the advert and applies through it. The form answers as it answers anyone, with its confirmation;
  // Pat is in the job once; and the hiring team's view gains that line and that e-mail, and nothing from before the job.
  m.sent.length = 0;
  const again = await m.onBoard(m.nursePost, { name: 'Pat Varga', email: 'pat@example.com', cover_note: 'A note from Pat' });
  assert.deepEqual([again.status, again.body, m.sent.map((mail_) => mail_.subject)], [200, { ok: true }, [CONFIRMATION]]);
  assert.deepEqual(m.ok(await m.rec.get(`/applications?job_id=${m.nurse}&status=all`)).filter((a) => a.email === 'pat@example.com').map((a) => a.id), [pat]);
  assert.deepEqual(await seen(), [[], [CONFIRMATION, 'Interview for Nurse Lead at Lumen Health'], ['Applied again, through the agency’s website', 'Scheduled Ward visit', 'Added to Nurse Lead at Applied'], 'agency_sourced']);
  assert.equal(/AGENCY-NOTE|BOOK-MAIL|The Book|A note from Pat/.test(JSON.stringify(await m.detail(m.lena, pat))), false);
  const { board, ...live } = m.asLive(pat);
  assert.deepEqual([board, live], [[], await m.asShown(m.lena, pat)]);

  // The same by Add candidate with the job chosen: the entry of somebody in The Book goes on the job, and nothing of the post's is noted.
  const quin = await m.inBook({ name: 'Quin Abara', email: 'quin@example.com' });
  assert.deepEqual(m.ok(await m.rec.upload('/applications', { job_id: m.nurse, name: 'Quin Abara', email: 'quin@example.com', source: 'our_website' })),
    { id: quin, known: true, merged: true, name: 'Quin Abara', general: false, moved: true, joined: false });
  assert.deepEqual([(await m.detail(m.rec, quin)).board, m.noted(quin), (await m.detail(m.rec, quin)).application.source, await m.applied(m.nurse)], [null, [], 'agency_sourced', applied]);

  // "Our website" cannot be chosen for anybody by hand: not when saving somebody to The Book, and not when somebody
  // on a job is added to another of the client's jobs.
  const byHand = await m.inBook({ name: 'Rosa Lind', email: 'rosa@example.com', source: 'our_website' });
  assert.equal((await m.detail(m.rec, byHand)).application.source, 'agency_sourced');
  const ward = m.ok(await m.boss.post('/jobs', { client_id: m.lumen, title: 'Ward Clerk', status: 'open' })).id;
  const second = m.ok(await addToJob(m.rec, pat, { job_id: ward, source: 'our_website' }));
  assert.deepEqual([second.merged, (await m.detail(m.rec, second.id)).application.source, m.noted(second.id)], [false, 'agency_sourced', []]);
  assert.equal((await m.detail(m.rec, m.ok(await addToJob(m.rec, quin, { job_id: ward, source: 'linkedin' })).id)).application.source, 'linkedin');
  // So the only applications under that source are the ones the board itself has a record of.
  assert.deepEqual(m.read(`SELECT a.id FROM applications a WHERE a.source = 'our_website' AND a.id NOT IN (SELECT application_id FROM board_applications)`), []);
  assert.deepEqual(m.ok(await m.rec.get('/applications?general=1')).filter((a) => a.source === 'our_website'), []);
});

test('deleting, merging and deleting the job of people who applied through a post leaves the board\'s record with the application it is about, or nowhere', async () => {
  const m = await meeting();
  const boardRows = () => m.read('SELECT COUNT(*) AS n FROM board_applications')[0].n;
  const orphans = () => m.read('SELECT b.application_id FROM board_applications b LEFT JOIN applications a ON a.id = b.application_id LEFT JOIN board_posts p ON p.id = b.post_id WHERE a.id IS NULL OR p.id IS NULL OR a.job_id IS NOT p.job_id');
  let rows = boardRows();
  const applied = await m.applied(m.sales);

  // Removed from the job, somebody who only ever applied through the post is deleted, as anyone only in that job is; the board's record goes with the application.
  m.ok(await m.onBoard(m.salesPost, { name: 'Rae Simmonds', email: 'rae@example.com' }));
  const rae = await m.inJob(m.sales, 'rae@example.com');
  assert.deepEqual([boardRows(), await m.applied(m.sales)], [rows + 1, applied + 1]);
  assert.deepEqual(m.ok(await m.rec.del(`/applications/${rae}`)), { ok: true });
  assert.deepEqual([boardRows(), await m.applied(m.sales), m.read('SELECT id FROM candidates WHERE email = ?', 'rae@example.com')], [rows, applied, []]);

  // Two records of one person at the client, one of them from the post, are merged: the application keeps its
  // number, so the board's record stays with it, and the person is still somebody who has not been told.
  const sourced = m.ok(await m.rec.upload('/applications', { job_id: m.dispatch, name: 'Sol Achebe', linkedin: 'https://www.linkedin.com/in/sol-achebe' })).id;
  m.ok(await m.onBoard(m.salesPost, { name: 'Sol Achebe', email: 'sol@example.com', linkedin: 'https://www.linkedin.com/in/sol-achebe/' }));
  const sol = await m.inJob(m.sales, 'sol@example.com');
  const [from, into] = [(await m.detail(m.rec, sourced)).candidate.id, (await m.detail(m.rec, sol)).candidate.id];
  assert.deepEqual((await m.detail(m.rec, sourced)).duplicates.map((d) => d.candidate_id), [into]);
  for (const [going, kept] of [[from, into]]) assert.deepEqual(m.ok(await m.rec.post(`/candidates/${going}/merge`, { into: kept })), { ok: true, id: kept });
  assert.deepEqual([(await m.detail(m.rec, sol)).board.client_known, m.noted(sol), (await m.detail(m.rec, sourced)).board, (await m.detail(m.rec, sourced)).candidate.id], [false, [{ post_id: 1, public_title: 'Sales Director', known: 0, direct: 0 }], null, into]);
  assert.deepEqual(m.ok(await m.rec.post(`/applications/${sol}/emails/check`, { subject: 's', body: 'Kestrel Logistics' })), { names_client: true });
  // The other way round as well: the record from the post is the one that goes.
  const sourced2 = m.ok(await m.rec.upload('/applications', { job_id: m.dispatch, name: 'Tam Okoye', linkedin: 'https://www.linkedin.com/in/tam-okoye' })).id;
  m.ok(await m.onBoard(m.salesPost, { name: 'Tam Okoye', email: 'tam@example.com', linkedin: 'https://www.linkedin.com/in/tam-okoye' }));
  const tam = await m.inJob(m.sales, 'tam@example.com');
  const kept = (await m.detail(m.rec, sourced2)).candidate.id;
  m.ok(await m.rec.post(`/candidates/${(await m.detail(m.rec, tam)).candidate.id}/merge`, { into: kept }));
  assert.deepEqual([(await m.detail(m.rec, tam)).candidate.id, (await m.detail(m.rec, tam)).board.client_known, m.noted(tam).length], [kept, false, 1]);
  assert.deepEqual(orphans(), []);

  // One person on file twice, in The Book and on the client's record with an application made through the post:
  // "Delete all data on this person" takes both, and the board's record with them.
  rows = boardRows();
  const uma = await m.inBook({ name: 'Uma Brandt-Roy', email: 'uma@example.com' });
  m.ok(await m.onBoard(m.salesPost, { name: 'Uma Brandt-Roy', email: 'uma@example.com' }));
  const umaAtKestrel = await m.inJob(m.sales, 'uma@example.com');
  assert.equal(boardRows(), rows + 1);
  const person = (await m.detail(m.rec, uma)).candidate.id, theirs = (await m.detail(m.rec, umaAtKestrel)).candidate.id;
  assert.deepEqual(m.ok(await m.rec.del(`/candidates/${person}?also=${theirs}`)), { ok: true, erased: 2 });
  assert.deepEqual([boardRows(), m.read('SELECT id FROM candidates WHERE email = ?', 'uma@example.com'), (await m.rec.get(`/applications/${umaAtKestrel}`)).status], [rows, [], 404]);

  // A job with a post is deleted. Somebody who came from The Book goes back to it, with the agency's note of what
  // they applied for; somebody who only applied through the post goes with the job; and the post goes, with its
  // history and everything it had noted.
  const temp = m.ok(await m.boss.post('/jobs', { client_id: m.kestrel, title: 'Temp Planner', status: 'open' })).id;
  const view = m.ok(await m.boss.putJson(`/jobs/${temp}/board`, { enabled: true, title: 'Planner (three months)', location: 'North of England', description: 'A three-month contract planning routes for a delivery business.', show_salary: false, hide_from_careers: true }));
  assert.equal(view.state.live, true, JSON.stringify(view.check.problems));
  const postId = m.read('SELECT id FROM board_posts WHERE job_id = ?', temp)[0].id;
  const vic = await throughPostWithEntry(m, view.post.token, temp, 'Vic Tremblay', 'vic@example.com');
  m.ok(await m.onBoard(view.post.token, { name: 'Wes Only-Post', email: 'wes@example.com' }));
  const wes = await m.inJob(temp, 'wes@example.com');
  assert.deepEqual(m.read('SELECT application_id FROM board_applications WHERE post_id = ? ORDER BY application_id', postId).map((b) => b.application_id), [vic, wes].sort((a, b) => a - b));
  const agreed = (await m.detail(m.rec, vic)).application.consent_at.slice(0, 10);
  assert.deepEqual(m.ok(await m.boss.del(`/jobs/${temp}`)), { ok: true });
  assert.deepEqual([m.read('SELECT id FROM board_posts WHERE id = ?', postId), m.read('SELECT id FROM board_log WHERE post_id = ?', postId), m.read('SELECT application_id FROM board_applications WHERE post_id = ? OR application_id IN (?, ?)', postId, vic, wes)], [[], [], []]);
  assert.equal((await m.rec.get(`/applications/${wes}`)).status, 404);
  const back = await m.detail(m.rec, vic);
  assert.deepEqual([back.application.general, back.board, back.application.source], [true, null, 'agency_sourced']);
  assert.deepEqual(back.notes.find((n) => n.body.startsWith('From their own application')).body.split('\n\n').slice(0, 2), [
    `From their own application for Temp Planner at Kestrel Logistics, where they agreed to their data being processed on ${agreed}. Kept for the agency only.`,
    'They applied through your confidential post “Planner (three months)” and had not been told who the client is.']);
  assert.deepEqual(back.activities.map((a) => a.detail).slice(0, 1), ['Back in The Book without a job: Temp Planner at Kestrel Logistics was deleted']);
  assert.deepEqual(orphans(), []);
  // The public is told the same about that post as about one that never was.
  const gone = await m.onBoard(view.post.token, { name: 'Late Comer', email: 'late@example.com' });
  assert.deepEqual([gone.status, gone.body], [404, { error: 'This role is no longer open.' }]);
});

// ---------- back on the job they applied for through its post ----------
// When somebody who came through a confidential post goes back to The Book, what the board had noted about them is
// set aside, where nothing reads it. Put back on the job the post is for, they are that post's applicant again: not
// told who the client is, or told, as they were. On any other job, nothing of the post.
/** What the board has set aside for an application. Read from the database: no route shows it. */
const setAside = (m, id) => m.read('SELECT post_id, public_title, client_known_at IS NOT NULL AS known, direct_applied_at IS NOT NULL AS direct FROM post_applications_set_aside WHERE application_id = ? ORDER BY post_id', id);
/** The board's record of somebody who applied through Kestrel's post ("Sales Director", the first post) and has not been told who the client is. */
const UNTOLD = [{ post_id: 1, public_title: 'Sales Director', known: 0, direct: 0 }];
const TOLD = [{ ...UNTOLD[0], known: 1 }];
const BACK_LINE = (told) => `Applied for this job through your confidential post “Sales Director” before: ${told ? 'they have been told who the client is' : 'they have not been told who the client is'}`;
const NAMES_KESTREL = { subject: 'About Kestrel', body: 'Kestrel Logistics would like to meet you.' };
/** Remove somebody who came from The Book from their job: they go back to The Book. Resolves to their entry's id. */
async function backToBook(m, id) {
  const gone = m.ok(await m.rec.del(`/applications/${id}`));
  assert.equal(gone.returned, true);
  return gone.id;
}
/** Book an interview and tell the candidate. Resolves to the interview, the notice the recruiter was shown, and the subjects of what was sent. */
async function invite(m, id, extra = {}) {
  m.sent.length = 0;
  const made = m.ok(await m.rec.post('/interviews', { application_id: id, title: 'First call', starts_at: inDays(3), notify: true, location: 'By phone', panel: [], ...extra }));
  return { id: made.id, notice: made.notice, sent: m.sent.map((mail_) => mail_.subject) };
}
/** Whether a hand-written message that names Kestrel would be stopped for this person. */
const stopsKestrel = async (m, id) => m.ok(await m.rec.post(`/applications/${id}/emails/check`, NAMES_KESTREL)).names_client;
/** How many people each list says applied through Kestrel's post: the post's own tab, and the list of posts under Jobs. */
const appliedThrough = async (m, jobId = m.sales) => [await m.applied(jobId), m.ok(await m.boss.get('/board/posts')).find((post) => post.job_id === jobId).applied];
/** No application says "Our website" that the board has no record of, and nobody in The Book says it. */
const ourWebsiteIsTheBoards = (m) => assert.deepEqual(m.read(`SELECT id FROM applications WHERE source = 'our_website' AND (job_id IS NULL OR id NOT IN (SELECT application_id FROM board_applications))`), []);
/** Nothing is set aside for an application or a post that is gone, and nothing is both set aside and noted for the same application and post. */
const nothingAstray = (m) => assert.deepEqual(m.read(
  `SELECT k.application_id FROM post_applications_set_aside k LEFT JOIN applications a ON a.id = k.application_id LEFT JOIN board_posts p ON p.id = k.post_id
   LEFT JOIN board_applications b ON b.application_id = k.application_id AND b.post_id = k.post_id WHERE a.id IS NULL OR p.id IS NULL OR b.application_id IS NOT NULL`), []);

test('put back on the job they applied for through its confidential post, somebody is that post\'s applicant again, told or not told as they were, whichever way they are put back', async () => {
  const m = await meeting();
  const [before] = await appliedThrough(m);
  // Four people came through the post, and the agency joined an entry it held on each to their application. Ada, Cy
  // and Dee have not been told who the client is; Ben has. Dee has also applied on Kestrel's own careers page for
  // another job, so Kestrel keeps a record of her when she leaves this one.
  const ada = await throughPostWithEntry(m, m.salesPost, m.sales, 'Ada Whitlock', 'ada@example.com', { resume: resume('Ada, written for the post', 'Ada for the post.pdf') });
  const ben = await throughPostWithEntry(m, m.salesPost, m.sales, 'Ben Okonjo', 'ben@example.com');
  const cy = await throughPostWithEntry(m, m.salesPost, m.sales, 'Cy Lindgren', 'cy@example.com');
  const dee = await throughPostWithEntry(m, m.salesPost, m.sales, 'Dee Marlow', 'dee@example.com');
  assert.equal(m.ok(await m.rec.putJson(`/applications/${ben}/client-known`, { known: true })).client_known, true);
  m.ok(await m.onCareers(m.dispatch, { name: 'Dee Marlow', email: 'dee@example.com' }));
  const deeAtKestrel = (await m.detail(m.rec, dee)).candidate.id;
  const all = [ada, ben, cy, dee];
  const was = {};
  for (const id of all) was[id] = { board: (await m.detail(m.rec, id)).board, noted: m.noted(id) };
  assert.deepEqual([was[ada], was[ben].noted, was[ben].board.client_known_by_name, await appliedThrough(m)],
    [{ board: { title: 'Sales Director', client_known: false, client_known_at: null, client_known_by_name: null }, noted: UNTOLD }, TOLD, 'Dana Recruiter', [before + 4, before + 4]]);

  // All four are removed from the job and go back to The Book. The board has no record of them, neither list counts
  // them, and what it had noted is set aside as it was.
  for (const id of all) assert.equal(await backToBook(m, id), id);
  for (const id of all) assert.deepEqual([(await m.detail(m.rec, id)).board, m.noted(id), setAside(m, id)], [null, [], was[id].noted]);
  assert.deepEqual(await appliedThrough(m), [before, before]);
  const when = Date.parse(m.read('SELECT set_aside_at FROM post_applications_set_aside WHERE application_id = ?', ada)[0].set_aside_at);
  assert.ok(when <= Date.now() && when > Date.now() - 60000, 'it says when they left the job');
  // In The Book nothing reads it: no tick, no warning, and a message that names Kestrel is not looked at.
  assert.deepEqual([(await m.rec.putJson(`/applications/${ada}/client-known`, { known: true })).status, await stopsKestrel(m, ada)], [400, false]);
  // The agency gives Ada's entry a résumé of its own while she is there.
  assert.equal(m.ok(await m.rec.upload('/applications', { name: 'Ada Whitlock', email: 'ada@example.com', resume: resume('Ada, as the agency holds her', 'Ada CV (agency).pdf') })).id, ada);

  // Each is put back on the same job another way: from the profile ("Add to a job"); from the profile at a later
  // stage; by Add candidate with the job chosen, which is also what the extension sends; and from the profile where
  // the client already has a record of the person, which the entry is joined to.
  assert.deepEqual(m.ok(await addToJob(m.rec, ada, { job_id: m.sales })), { id: ada, merged: false });
  const stages = m.ok(await m.boss.get(`/jobs/${m.sales}`)).stages;
  assert.deepEqual(m.ok(await addToJob(m.rec, ben, { job_id: m.sales, stage_id: stages[1].id })), { id: ben, merged: false });
  assert.deepEqual(m.ok(await m.rec.upload('/applications', { job_id: m.sales, stage_id: stages[0].id, source: 'linkedin', name: 'Cy Lindgren', email: 'cy@example.com' })),
    { id: cy, known: true, merged: true, name: 'Cy Lindgren', general: false, moved: true, joined: false });
  const asked = await addToJob(m.rec, dee, { job_id: m.sales });
  assert.deepEqual([asked.status, asked.body.code, asked.body.matches.map((match) => match.candidate_id)], [409, 'duplicate_in_client', [deeAtKestrel]]);
  assert.deepEqual(m.ok(await addToJob(m.rec, dee, { job_id: m.sales, into: deeAtKestrel })), { id: dee, merged: true });

  // Each is exactly what they were to the board: the same post, the title they saw, and told or not told, by whom
  // and when. Nothing is left set aside, and both lists count them again.
  for (const id of all) assert.deepEqual([(await m.detail(m.rec, id)).board, m.noted(id), setAside(m, id)], [was[id].board, was[id].noted, []], `application ${id}`);
  assert.deepEqual(await appliedThrough(m), [before + 4, before + 4]);
  nothingAstray(m);
  // The agency's history says so, in a line of the board's own.
  const line = async (id) => (await m.detail(m.rec, id)).activities.filter((a) => a.type === 'board').map((a) => a.detail);
  assert.deepEqual([await line(ada), await line(ben), await line(cy), await line(dee)], [[BACK_LINE(false)], [BACK_LINE(true), 'Marked as knowing who the client is'], [BACK_LINE(false)], [BACK_LINE(false)]]);

  // The agency put them on the job this time, so the source stays "Agency sourced": "Our website" is only ever on
  // an application as it was made on the board. What Ada wrote for the post, the consent she gave there and the
  // résumé she sent stay where her return to The Book put them, with the agency; the application carries the
  // entry's own résumé, like any entry put on a job.
  const adaNow = await m.detail(m.rec, ada);
  assert.deepEqual([adaNow.application.source, adaNow.application.cover_note, adaNow.application.consent_at, adaNow.application.resume_name, adaNow.earlier_resumes.map((r) => r.name)],
    ['agency_sourced', null, null, 'Ada CV (agency).pdf', ['Ada for the post.pdf']]);
  assert.ok(adaNow.notes.some((n) => n.private === 1 && n.body.includes('They applied through your confidential post “Sales Director” and had not been told who the client is.') && n.body.includes('POST-NOTE from Ada Whitlock')));
  for (const id of all) assert.equal((await m.detail(m.rec, id)).application.source, 'agency_sourced');
  ourWebsiteIsTheBoards(m);
  // Kestrel's hiring team is shown somebody the agency added: nothing of the post, the tick, or what the agency keeps.
  const atKestrel = await m.detail(m.kim, ada);
  assert.deepEqual([atKestrel.application.source, atKestrel.application.cover_note, atKestrel.application.resume_name, atKestrel.notes, atKestrel.emails, atKestrel.activities.map((a) => a.detail), atKestrel.earlier_resumes, 'board' in atKestrel],
    ['agency_sourced', null, 'Ada CV (agency).pdf', [], [], ['Added to Head of Sales at Applied'], [], false]);
  assert.equal(/confidential|Sales Director|our client|website|POST-NOTE|AGENCY-NOTE|told who|for the post/i.test(JSON.stringify(atKestrel)), false, JSON.stringify(atKestrel));
  assert.deepEqual(m.ok(await m.kim.get('/dashboard')).recent.filter((r) => r.application_id === ada).map((r) => r.detail), ['Added to Head of Sales at Applied']);
  // The release that is live now would show that hiring team the same, and takes her for an applicant of the post
  // who has not been told, as this one does.
  const { board: adaBoard, ...adaLive } = m.asLive(ada);
  assert.deepEqual([adaBoard, adaLive], [['Sales Director'], await m.asShown(m.kim, ada)]);

  // So what The Book sends Ada by itself keeps the client's name from her again: the invitation is reworded, one
  // that would name Kestrel all the same is held back, and a hand-written one that names Kestrel is refused until
  // the recruiter has seen the warning.
  const first = await invite(m, ada);
  assert.deepEqual([first.notice, first.sent], [undefined, ['Interview for Sales Director at our client']]);
  assert.equal(/Kestrel|Head of Sales/.test(m.sent[0].text), false, m.sent[0].text);
  const held = m.ok(await m.rec.patch(`/interviews/${first.id}`, { starts_at: inDays(4), location: 'Kestrel Logistics, 12 Dock Road', notify: true }));
  assert.match(held.notice, /^The e-mail was not sent: it names the client, and this candidate applied through your confidential post/);
  const refused = await m.rec.post(`/applications/${ada}/emails`, NAMES_KESTREL);
  assert.deepEqual([refused.status, refused.body.code, m.sent.length, await stopsKestrel(m, ada)], [409, 'names_client', 1, true]);
  for (const id of [cy, dee]) assert.deepEqual([(await invite(m, id)).sent, await stopsKestrel(m, id)], [['Interview for Sales Director at our client'], true]);
  // Ben had been told, and is written to like anybody on the job.
  assert.deepEqual([(await invite(m, ben, { location: 'Kestrel Logistics, 12 Dock Road' })).sent, await stopsKestrel(m, ben)], [['Interview for Head of Sales at Kestrel Logistics'], false]);
  // The tick is offered for Ada, and once it is made she is written to like anybody too.
  assert.equal(m.ok(await m.rec.putJson(`/applications/${ada}/client-known`, { known: true })).client_known, true);
  assert.deepEqual([m.noted(ada), await stopsKestrel(m, ada), m.ok(await m.rec.post(`/applications/${ada}/emails`, NAMES_KESTREL)).delivery], [TOLD, false, 'sent']);

  // They leave the job a second time. The board's record is set aside again as it is by now: Ada has been told
  // since, Cy has not. The agency's note says so, and says nothing of an application of their own, since there was
  // none this time. Ada's entry keeps the résumé the agency gave it: it was never one she sent this client.
  for (const id of [ada, cy]) assert.equal(await backToBook(m, id), id);
  assert.deepEqual([setAside(m, ada), setAside(m, cy), m.noted(ada), m.noted(cy), await appliedThrough(m)], [TOLD, UNTOLD, [], [], [before + 2, before + 2]]);
  const second = (detail_) => detail_.notes.filter((n) => n.body.startsWith('From their time on')).map((n) => [n.private, n.body.split('\n\n')]);
  assert.deepEqual(second(await m.detail(m.rec, cy)), [[1, ['From their time on Head of Sales at Kestrel Logistics. Kept for the agency only.', 'They applied through your confidential post “Sales Director” and had not been told who the client is.']]]);
  assert.deepEqual(second(await m.detail(m.rec, ada)), [[1, ['From their time on Head of Sales at Kestrel Logistics. Kept for the agency only.', 'They applied through your confidential post “Sales Director” and had since been told who the client is.']]]);
  const adaBack = await m.detail(m.rec, ada);
  assert.deepEqual([adaBack.application.general, adaBack.application.resume_name, adaBack.earlier_resumes.map((r) => r.name), adaBack.application.source], [true, 'Ada CV (agency).pdf', ['Ada for the post.pdf'], 'agency_sourced']);
  // And a third time on the job, each is again what they were when they left it.
  for (const id of [ada, cy]) assert.deepEqual(m.ok(await addToJob(m.rec, id, { job_id: m.sales })), { id, merged: false });
  assert.deepEqual([m.noted(ada), m.noted(cy), setAside(m, ada), setAside(m, cy), await appliedThrough(m)], [TOLD, UNTOLD, [], [], [before + 4, before + 4]]);
  assert.deepEqual([(await invite(m, cy)).sent, await stopsKestrel(m, cy), await stopsKestrel(m, ada)], [['Interview for Sales Director at our client'], true, false]);
  ourWebsiteIsTheBoards(m);
  nothingAstray(m);
});

test('an entry joined to an application that is already on the post\'s job: the person is still somebody who came through the post, and an application the board has a record of keeps it', async () => {
  const m = await meeting();
  const [before] = await appliedThrough(m);
  const eli = await throughPostWithEntry(m, m.salesPost, m.sales, 'Eli Navarro', 'eli@example.com');
  const fay = await throughPostWithEntry(m, m.salesPost, m.sales, 'Fay Oduya', 'fay@example.com');
  assert.equal(m.ok(await m.rec.putJson(`/applications/${fay}/client-known`, { known: true })).client_known, true);
  for (const id of [eli, fay]) assert.equal(await backToBook(m, id), id);
  assert.deepEqual([setAside(m, eli), setAside(m, fay), await appliedThrough(m)], [UNTOLD, TOLD, [before, before]]);

  // Eli then applies for the same job on Kestrel's own careers page, where it is advertised under its real title:
  // he does not know it is the job he applied for through the post. Kestrel gets a record of its own, as for anybody.
  m.sent.length = 0;
  m.ok(await m.onCareers(m.sales, { name: 'Eli Navarro', email: 'eli@example.com', cover_note: 'DIRECT-NOTE from Eli' }));
  const direct = await m.inJob(m.sales, 'eli@example.com');
  assert.notEqual(direct, eli);
  assert.deepEqual([m.to('eli@example.com').map((mail_) => mail_.subject), m.noted(direct), (await m.detail(m.rec, direct)).board], [['We received your application for Head of Sales'], [], null]);
  // The agency joins his entry to that application. One person is in a job once, so the entry is folded into it,
  // and with it what the board had set aside: he is somebody who came through the post and has not been told.
  const record = (await m.detail(m.rec, direct)).candidate.id;
  const asked = await addToJob(m.rec, eli, { job_id: m.sales });
  assert.deepEqual([asked.status, asked.body.code, asked.body.join.candidate_id], [409, 'already_in_job', record]);
  assert.deepEqual(m.ok(await addToJob(m.rec, eli, { job_id: m.sales, into: record })), { id: direct, merged: true });
  assert.deepEqual([m.noted(direct), setAside(m, direct), setAside(m, eli), (await m.detail(m.rec, direct)).board.client_known], [[{ ...UNTOLD[0], direct: 1 }], [], [], false]);
  assert.deepEqual((await m.detail(m.rec, direct)).activities.filter((a) => a.type === 'board').map((a) => a.detail), [BACK_LINE(false)]);
  // What he wrote to Kestrel on its own form is still his, on the application, for its hiring team to read; the
  // post and the tick are not.
  const shown = await m.detail(m.kim, direct);
  assert.deepEqual([shown.application.source, shown.application.cover_note, shown.activities.map((a) => a.detail), 'board' in shown], ['careers_page', 'DIRECT-NOTE from Eli', ['Applied via careers page'], false]);
  assert.equal(/confidential|Sales Director|our client|told who|POST-NOTE|AGENCY-NOTE/i.test(JSON.stringify(shown)), false, JSON.stringify(shown));
  // He has applied on the careers page once and been answered once, like anybody: applying there again brings no
  // second confirmation, which would tell him the two are one job.
  m.sent.length = 0;
  m.ok(await m.onCareers(m.sales, { name: 'Eli Navarro', email: 'eli@example.com' }));
  assert.deepEqual(m.to('eli@example.com'), []);
  // And what The Book sends him by itself keeps the client's name from him.
  assert.deepEqual([(await invite(m, direct)).sent, await stopsKestrel(m, direct)], [['Interview for Sales Director at our client'], true]);

  // Fay, who had been told, applies through the post again while she is in The Book. That is a new application as
  // far as the board can tell, from somebody who has not been told. The agency joins her entry to it: the board's
  // record of the application stays as it is, the newer of the two, and nothing is left set aside.
  m.ok(await m.onBoard(m.salesPost, { name: 'Fay Oduya', email: 'fay@example.com' }));
  const again = await m.inJob(m.sales, 'fay@example.com');
  assert.deepEqual([again === fay, m.noted(again)], [false, UNTOLD]);
  assert.deepEqual(m.ok(await addToJob(m.rec, fay, { job_id: m.sales, into: (await m.detail(m.rec, again)).candidate.id })), { id: again, merged: true });
  assert.deepEqual([m.noted(again), setAside(m, again), setAside(m, fay), (await m.detail(m.rec, again)).application.source], [UNTOLD, [], [], 'our_website']);
  assert.deepEqual(await appliedThrough(m), [before + 2, before + 2]);
  ourWebsiteIsTheBoards(m);
  nothingAstray(m);
});

test('on another client\'s job, or another job of the same client, nothing of the post goes with them; added to the post\'s job from there, they are its applicant again', async () => {
  const m = await meeting();
  const [sales] = await appliedThrough(m), [nurse] = await appliedThrough(m, m.nurse);
  const nothingOfThePost = (answer) => assert.equal(/confidential|Sales Director|our client|website|POST-NOTE|AGENCY-NOTE|told who/i.test(JSON.stringify(answer)), false, JSON.stringify(answer));
  const gil = await throughPostWithEntry(m, m.salesPost, m.sales, 'Gil Arnesen', 'gil@example.com');
  assert.equal(await backToBook(m, gil), gil);

  // Lumen's job, which has a confidential post of its own. Gil is on it like anyone the agency adds: the board has
  // no record of him, neither post counts him, and what The Book sends is in Lumen's name. What was set aside for
  // Kestrel's post stays where nothing reads it.
  assert.deepEqual(m.ok(await addToJob(m.rec, gil, { job_id: m.nurse })), { id: gil, merged: false });
  assert.deepEqual([(await m.detail(m.rec, gil)).board, m.noted(gil), setAside(m, gil), await appliedThrough(m, m.nurse), await appliedThrough(m)], [null, [], UNTOLD, [nurse, nurse], [sales, sales]]);
  const ward = await invite(m, gil, { location: 'Lumen Health, 3 King Street' });
  assert.deepEqual([ward.notice, ward.sent, (await m.rec.putJson(`/applications/${gil}/client-known`, { known: true })).status], [undefined, ['Interview for Nurse Lead at Lumen Health'], 400]);
  nothingOfThePost(await m.detail(m.lena, gil));
  // (Somebody else on Lumen's job applied through Lumen's own post in an earlier test, which its hiring team may read.)
  for (const answer of [await m.detail(m.lena, gil), m.ok(await m.lena.get('/applications?status=all')), m.ok(await m.lena.get('/dashboard')), m.ok(await m.lena.get('/reports')), m.ok(await m.lena.get('/interviews'))]) {
    assert.equal(/kestrel|sales|our client|POST-NOTE|AGENCY-NOTE|told who/i.test(JSON.stringify(answer)), false, JSON.stringify(answer));
  }
  const { board: atLumen, ...liveAtLumen } = m.asLive(gil);
  assert.deepEqual([atLumen, liveAtLumen], [[], await m.asShown(m.lena, gil)]);

  // Back to The Book and on to another of Kestrel's jobs, which has no post: the same. An e-mail that names Kestrel
  // is what anybody on that job is sent.
  assert.equal(await backToBook(m, gil), gil);
  assert.deepEqual(m.ok(await addToJob(m.rec, gil, { job_id: m.dispatch })), { id: gil, merged: false });
  assert.deepEqual([(await m.detail(m.rec, gil)).board, m.noted(gil), setAside(m, gil), await appliedThrough(m)], [null, [], UNTOLD, [sales, sales]]);
  const depot = await invite(m, gil, { location: 'Kestrel Logistics, 12 Dock Road' });
  assert.deepEqual([depot.notice, depot.sent, await stopsKestrel(m, gil)], [undefined, ['Interview for Dispatcher at Kestrel Logistics'], false]);
  nothingOfThePost(await m.detail(m.kim, gil));

  // From there he is added to Head of Sales as well, as somebody already on a client's job is: a second application
  // of the same record. On the job the post is for, he is its applicant again and has not been told; on the other
  // job he is as he was.
  const second = m.ok(await addToJob(m.rec, gil, { job_id: m.sales }));
  assert.deepEqual([second.merged, second.id === gil], [false, false]);
  assert.deepEqual([m.noted(second.id), m.noted(gil), (await m.detail(m.rec, second.id)).board.client_known, await appliedThrough(m)], [UNTOLD, [], false, [sales + 1, sales + 1]]);
  assert.deepEqual((await m.detail(m.rec, second.id)).activities.filter((a) => a.type === 'board').map((a) => a.detail), [BACK_LINE(false)]);
  assert.deepEqual([(await invite(m, second.id)).sent, await stopsKestrel(m, second.id), await stopsKestrel(m, gil)], [['Interview for Sales Director at our client'], true, false]);
  const secondAtKestrel = await m.detail(m.kim, second.id);
  assert.deepEqual([secondAtKestrel.activities.map((a) => a.detail), 'board' in secondAtKestrel], [['Scheduled First call', 'Added to Head of Sales at Applied'], false]);
  nothingOfThePost({ ...secondAtKestrel, emails: [] });
  assert.deepEqual(secondAtKestrel.emails.map((e) => e.subject), ['Interview for Sales Director at our client']);
  // The second application never was in The Book, so removing it deletes it, and the board's record with it. The
  // one on Dispatcher goes back to The Book, and from there on to Head of Sales: still somebody who has not been told.
  assert.deepEqual(m.ok(await m.rec.del(`/applications/${second.id}`)), { ok: true });
  assert.deepEqual([m.noted(second.id), setAside(m, gil), await appliedThrough(m)], [[], UNTOLD, [sales, sales]]);
  assert.equal(await backToBook(m, gil), gil);
  assert.deepEqual(m.ok(await addToJob(m.rec, gil, { job_id: m.sales })), { id: gil, merged: false });
  assert.deepEqual([m.noted(gil), setAside(m, gil), await appliedThrough(m)], [UNTOLD, [], [sales + 1, sales + 1]]);

  // The same when somebody on another of the client's jobs is added to the post's job by Add candidate (or the
  // extension), which adds to the record the client has: Hal, on Dispatcher, is the post's applicant on Head of Sales.
  const hal = await throughPostWithEntry(m, m.salesPost, m.sales, 'Hal Ibsen', 'hal@example.com');
  assert.equal(await backToBook(m, hal), hal);
  assert.deepEqual(m.ok(await addToJob(m.rec, hal, { job_id: m.dispatch })), { id: hal, merged: false });
  const added = m.ok(await m.rec.upload('/applications', { job_id: m.sales, name: 'Hal Ibsen', email: 'hal@example.com', source: 'referral' }));
  assert.deepEqual([added.known, added.general, added.id === hal, 'moved' in added], [true, false, false, false]);
  assert.deepEqual([m.noted(added.id), m.noted(hal), setAside(m, hal), (await m.detail(m.rec, added.id)).application.source, await stopsKestrel(m, added.id)], [UNTOLD, [], UNTOLD, 'referral', true]);
  assert.deepEqual(await appliedThrough(m), [sales + 2, sales + 2]);
  ourWebsiteIsTheBoards(m);
  nothingAstray(m);
});

test('the post edited or switched off in between changes nothing about who has been told; with the person, the entry or the job deleted, nothing is left set aside', async () => {
  const m = await meeting();
  const POST = { title: 'Planner (six months)', location: 'North of England', description: 'A six-month contract planning routes for a delivery business.', show_salary: false, hide_from_careers: true };
  const planner = m.ok(await m.boss.post('/jobs', { client_id: m.kestrel, title: 'Route Planner', status: 'open' })).id;
  const view = m.ok(await m.boss.putJson(`/jobs/${planner}/board`, { enabled: true, ...POST }));
  assert.equal(view.state.live, true, JSON.stringify(view.check.problems));
  const postId = m.read('SELECT id FROM board_posts WHERE job_id = ?', planner)[0].id;
  const asSeen = [{ post_id: postId, public_title: 'Planner (six months)', known: 0, direct: 0 }];
  const forPost = () => m.read('SELECT application_id FROM post_applications_set_aside WHERE post_id = ? ORDER BY application_id', postId).map((row) => row.application_id);
  const people = {};
  for (const name of ['Ivy Castellane', 'Jon Abiodun', 'Kit Sorrell', 'Lee Vantongeren']) {
    const short = name.split(' ')[0].toLowerCase();
    people[short] = await throughPostWithEntry(m, view.post.token, planner, name, `${short}@example.com`);
    assert.equal(await backToBook(m, people[short]), people[short]);
  }
  const { ivy, jon, kit, lee } = people;
  assert.deepEqual([forPost(), m.ok(await m.boss.get(`/jobs/${planner}/board`)).applied], [[ivy, jon, kit, lee].sort((a, b) => a - b), 0]);

  // The post is given another title. Ivy, put back on the job, is written to under the title she saw.
  const edited = m.ok(await m.boss.putJson(`/jobs/${planner}/board`, { enabled: true, ...POST, title: 'Senior Route Planner' }));
  assert.deepEqual([edited.state.live, edited.post.title], [true, 'Senior Route Planner']);
  assert.deepEqual(m.ok(await addToJob(m.rec, ivy, { job_id: planner })), { id: ivy, merged: false });
  assert.deepEqual([m.noted(ivy), (await m.detail(m.rec, ivy)).board.title, (await invite(m, ivy)).sent], [asSeen, 'Planner (six months)', ['Interview for Planner (six months) at our client']]);
  // The post is switched off. Jon still has not been told who the client is, and is put back as somebody who has not.
  const off = m.ok(await m.boss.putJson(`/jobs/${planner}/board`, { enabled: false, ...POST, title: 'Senior Route Planner' }));
  assert.equal(off.state.live, false);
  assert.deepEqual(m.ok(await addToJob(m.rec, jon, { job_id: planner })), { id: jon, merged: false });
  assert.deepEqual([m.noted(jon), await stopsKestrel(m, jon), (await invite(m, jon)).sent, m.ok(await m.boss.get(`/jobs/${planner}/board`)).applied, forPost()],
    [asSeen, true, ['Interview for Planner (six months) at our client'], 2, [kit, lee].sort((a, b) => a - b)]);

  // "Delete all data on this person" for Kit, who is in The Book: nothing is left of her, set aside or anywhere.
  const kitsRecord = (await m.detail(m.rec, kit)).candidate.id;
  assert.deepEqual(m.ok(await m.rec.del(`/candidates/${kitsRecord}`)), { ok: true, erased: 1 });
  assert.deepEqual([setAside(m, kit), forPost(), m.read('SELECT id FROM candidates WHERE email = ?', 'kit@example.com'), m.read('SELECT id FROM applications WHERE id = ?', kit)], [[], [lee], [], []]);
  nothingAstray(m);

  // The job is deleted, and its post with it. Ivy and Jon came from The Book and go back to it; Lee was there
  // already. Nothing is set aside for a post that no longer exists, for any of them.
  assert.deepEqual(m.ok(await m.boss.del(`/jobs/${planner}`)), { ok: true });
  assert.deepEqual([forPost(), m.read('SELECT application_id FROM board_applications WHERE post_id = ?', postId), m.read('SELECT id FROM board_posts WHERE id = ?', postId)], [[], [], []]);
  for (const id of [ivy, jon, lee]) assert.deepEqual([(await m.detail(m.rec, id)).application.general, (await m.detail(m.rec, id)).board, setAside(m, id)], [true, null, []]);
  // Lee, put on another of Kestrel's jobs afterwards, is on it like anyone.
  assert.deepEqual(m.ok(await addToJob(m.rec, lee, { job_id: m.dispatch })), { id: lee, merged: false });
  assert.deepEqual([m.noted(lee), (await invite(m, lee, { location: 'Kestrel Logistics, 12 Dock Road' })).sent], [[], ['Interview for Dispatcher at Kestrel Logistics']]);
  // And an entry that is removed outright takes what was set aside for it.
  const moe = await throughPostWithEntry(m, m.salesPost, m.sales, 'Moe Castellani', 'moe@example.com');
  assert.equal(await backToBook(m, moe), moe);
  assert.deepEqual(setAside(m, moe), UNTOLD);
  assert.deepEqual(m.ok(await m.rec.del(`/applications/${moe}`)), { ok: true });
  assert.deepEqual([setAside(m, moe), m.read('SELECT id FROM candidates WHERE email = ?', 'moe@example.com')], [[], []]);
  nothingAstray(m);
});

test('an entry folded into another entry in The Book takes what was set aside with it, and "has not been told" is the one that counts when both had something', async () => {
  const m = await meeting();
  // Max was saved to The Book again while he was on the job. When he leaves it, his entry is folded into that one,
  // since one person has one entry: what the board set aside goes with it.
  const max = await throughPostWithEntry(m, m.salesPost, m.sales, 'Max Delacroix', 'max@example.com');
  const twin = await m.inBook({ name: 'Max Delacroix', email: 'max@example.com' });
  assert.equal(await backToBook(m, max), twin);
  assert.deepEqual([(await m.rec.get(`/applications/${max}`)).status, setAside(m, max), setAside(m, twin), (await m.detail(m.rec, twin)).board], [404, [], UNTOLD, null]);
  assert.deepEqual(m.ok(await addToJob(m.rec, twin, { job_id: m.sales })), { id: twin, merged: false });
  // The entry that is on the job now is not the application he made on the board, and does not say it is.
  assert.deepEqual([m.noted(twin), setAside(m, twin), (await m.detail(m.rec, twin)).application.source, (await invite(m, twin)).sent], [UNTOLD, [], 'agency_sourced', ['Interview for Sales Director at our client']]);

  // Nia is in The Book twice, once under her address and once under her link, and the two are merged: the entry
  // that is kept carries what was set aside for the one that went.
  const nia = await throughPostWithEntry(m, m.salesPost, m.sales, 'Nia Castellanos', 'nia@example.com');
  assert.equal(await backToBook(m, nia), nia);
  const other = await m.inBook({ name: 'Nia Castellanos', linkedin: 'https://www.linkedin.com/in/nia-castellanos' });
  const [from, into] = [(await m.detail(m.rec, nia)).candidate.id, (await m.detail(m.rec, other)).candidate.id];
  assert.deepEqual(m.ok(await m.rec.post(`/candidates/${from}/merge`, { into })), { ok: true, id: into });
  assert.deepEqual([setAside(m, nia), setAside(m, other)], [[], UNTOLD]);
  assert.deepEqual(m.ok(await addToJob(m.rec, other, { job_id: m.sales })), { id: other, merged: false });
  assert.deepEqual([m.noted(other), await stopsKestrel(m, other)], [UNTOLD, true]);

  // Tia's entry is joined to an application she made on Kestrel's careers page for another job. What was set aside
  // for the post goes with it and stays set aside, since that job is not the post's. When that application goes back
  // to The Book and on to the post's job, she is somebody who came through the post and has not been told.
  const tia = await throughPostWithEntry(m, m.salesPost, m.sales, 'Tia Rosenqvist', 'tia@example.com');
  assert.equal(await backToBook(m, tia), tia);
  m.ok(await m.onCareers(m.dispatch, { name: 'Tia Rosenqvist', email: 'tia@example.com' }));
  const onDispatch = await m.inJob(m.dispatch, 'tia@example.com');
  assert.deepEqual(m.ok(await addToJob(m.rec, tia, { job_id: m.dispatch, into: (await m.detail(m.rec, onDispatch)).candidate.id })), { id: onDispatch, merged: true });
  assert.deepEqual([setAside(m, tia), setAside(m, onDispatch), m.noted(onDispatch), (await m.detail(m.rec, onDispatch)).board, await stopsKestrel(m, onDispatch)], [[], UNTOLD, [], null, false]);
  assert.equal(await backToBook(m, onDispatch), onDispatch);
  assert.deepEqual(m.ok(await addToJob(m.rec, onDispatch, { job_id: m.sales })), { id: onDispatch, merged: false });
  assert.deepEqual([m.noted(onDispatch), setAside(m, onDispatch), await stopsKestrel(m, onDispatch)], [UNTOLD, [], true]);

  // Ora applied through the post twice, under two addresses, and was told who the client is on one application
  // only. Both go back to The Book and the two entries are merged, the one that says "told" being kept: together
  // they say she has not been told, which is the safe one of the two.
  const told = await throughPostWithEntry(m, m.salesPost, m.sales, 'Ora Benali', 'ora@example.com');
  const untold = await throughPostWithEntry(m, m.salesPost, m.sales, 'Ora Benali', 'ora.work@example.com');
  assert.equal(m.ok(await m.rec.putJson(`/applications/${told}/client-known`, { known: true })).client_known, true);
  for (const id of [told, untold]) assert.equal(await backToBook(m, id), id);
  assert.deepEqual([setAside(m, told), setAside(m, untold)], [TOLD, UNTOLD]);
  const [going, kept] = [(await m.detail(m.rec, untold)).candidate.id, (await m.detail(m.rec, told)).candidate.id];
  assert.deepEqual(m.ok(await m.rec.post(`/candidates/${going}/merge`, { into: kept })), { ok: true, id: kept });
  assert.deepEqual([setAside(m, told), setAside(m, untold)], [UNTOLD, []]);
  assert.deepEqual(m.ok(await addToJob(m.rec, told, { job_id: m.sales })), { id: told, merged: false });
  assert.deepEqual([m.noted(told), await stopsKestrel(m, told)], [UNTOLD, true]);
  ourWebsiteIsTheBoards(m);
  nothingAstray(m);
});

test('two requests to put the same person on a job at once: one of them does, and the board\'s record is where they ended up, once', async () => {
  const m = await meeting();
  const [before] = await appliedThrough(m);
  const names = [['Oz Petrenko', 'oz@example.com'], ['Pam Okwuosa', 'pam@example.com'], ['Quy Halvorsen', 'quy@example.com']];
  const ids = [];
  for (const [name, email] of names) {
    const id = await throughPostWithEntry(m, m.salesPost, m.sales, name, email);
    assert.equal(await backToBook(m, id), id);
    ids.push(id);
  }
  const [oz, pam, quy] = ids;
  // The same job, asked for twice in the same moment by two people.
  const twice = await Promise.all([addToJob(m.rec, oz, { job_id: m.sales }), addToJob(m.boss, oz, { job_id: m.sales })]);
  assert.deepEqual(twice.map((answer) => answer.status).sort(), [200, 409]);
  assert.deepEqual([m.noted(oz), setAside(m, oz), await appliedThrough(m)], [UNTOLD, [], [before + 1, before + 1]]);
  assert.deepEqual((await m.detail(m.rec, oz)).activities.filter((a) => a.type === 'board').map((a) => a.detail), [BACK_LINE(false)]);
  // The post's job and another client's job, in the same moment: Pam is on one of them, and the board has a record
  // of her exactly when that is the post's job. Otherwise it stays set aside.
  const [toSales, toNurse] = await Promise.all([addToJob(m.rec, pam, { job_id: m.sales }), addToJob(m.boss, pam, { job_id: m.nurse })]);
  assert.deepEqual([toSales.status, toNurse.status].sort(), [200, 400]);
  const on = (await m.detail(m.rec, pam)).job.id;
  assert.equal(on, toSales.status === 200 ? m.sales : m.nurse);
  assert.deepEqual([m.noted(pam), setAside(m, pam)], on === m.sales ? [UNTOLD, []] : [[], UNTOLD]);
  assert.deepEqual(await stopsKestrel(m, pam), on === m.sales);
  // "Add to a job" on the profile and Add candidate with the job chosen, in the same moment.
  const both = await Promise.all([addToJob(m.rec, quy, { job_id: m.sales }), m.boss.upload('/applications', { job_id: m.sales, name: 'Quy Halvorsen', email: 'quy@example.com' })]);
  assert.deepEqual(both.map((answer) => answer.status).sort(), [200, 409]);
  assert.deepEqual([m.noted(quy), setAside(m, quy), m.ok(await m.boss.get(`/applications?job_id=${m.sales}&status=all`)).filter((a) => a.email === 'quy@example.com').map((a) => a.id)], [UNTOLD, [], [quy]]);
  assert.deepEqual(await appliedThrough(m), [before + 2 + (on === m.sales ? 1 : 0), before + 2 + (on === m.sales ? 1 : 0)]);
  nothingAstray(m);
  assert.equal(m.server.output().includes('constraint failed'), false, m.server.output());
});

test('an e-mail that names the client, still on its way while the person leaves the job: put back before it arrives it makes the tick, and after it arrives they count as not told until somebody ticks it', async () => {
  const m = await meeting();
  /** Start sending a message that names Kestrel, with the warning seen; wait until the provider has it, do `meanwhile`, then let the provider answer. */
  const sendWhile = async (id, subject, meanwhile) => {
    const had = m.sent.length;
    m.hold = true;
    const sending = m.rec.post(`/applications/${id}/emails`, { subject, body: 'Kestrel Logistics would like to meet you.', names_client_ok: true });
    await until(async () => m.sent.length, (n) => n > had);
    m.hold = false;
    await meanwhile();
    m.release();
    return m.ok(await sending);
  };
  // Rhea leaves the job and is put back on it while the message is with the mail provider. Delivered, it has told
  // her, and she is on the job it was about: the tick is made on the record the board has of her again.
  const rhea = await throughPostWithEntry(m, m.salesPost, m.sales, 'Rhea Lindahl', 'rhea@example.com');
  const there = await sendWhile(rhea, 'THERE-AND-BACK', async () => {
    assert.equal(await backToBook(m, rhea), rhea);
    assert.deepEqual(m.ok(await addToJob(m.rec, rhea, { job_id: m.sales })), { id: rhea, merged: false });
    assert.deepEqual(m.noted(rhea), UNTOLD);
  });
  assert.deepEqual([there.delivery, m.noted(rhea), setAside(m, rhea), await stopsKestrel(m, rhea)], ['sent', TOLD, [], false]);
  assert.deepEqual((await m.detail(m.rec, rhea)).activities.filter((a) => a.type === 'board').map((a) => a.detail), ['Told who the client is, by e-mail', BACK_LINE(false)]);
  // It was sent before she was on the job this time, so the record of it is the agency's own.
  assert.deepEqual((await m.detail(m.kim, rhea)).emails.map((e) => e.subject), []);
  // Sven is still in The Book when the message arrives. Nothing is ticked there, and nothing that was set aside is
  // touched: put back on the job he counts as not told, and the tick is there for the recruiter to make.
  const sven = await throughPostWithEntry(m, m.salesPost, m.sales, 'Sven Aaltonen', 'sven@example.com');
  const away = await sendWhile(sven, 'AWAY', async () => assert.equal(await backToBook(m, sven), sven));
  assert.deepEqual([away.delivery, m.noted(sven), setAside(m, sven)], ['sent', [], UNTOLD]);
  assert.deepEqual(m.ok(await addToJob(m.rec, sven, { job_id: m.sales })), { id: sven, merged: false });
  assert.deepEqual([m.noted(sven), await stopsKestrel(m, sven)], [UNTOLD, true]);
  assert.equal(m.ok(await m.rec.putJson(`/applications/${sven}/client-known`, { known: true })).client_known, true);
  assert.equal(m.server.output().includes('constraint failed'), false, m.server.output());
});

test('nothing reads what the board has set aside but the step that puts somebody on a job', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const TABLE = 'post_applications_set_aside';
  const files = (dir) => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
  const naming = [...files('server'), ...files('src'), ...files('extension')].filter((file) => fs.readFileSync(path.join(root, file), 'utf8').includes(TABLE)).sort();
  // The database code makes the table, the demo data empties it with the rest, and the board's own file uses it. No
  // route, report, feed, e-mail or screen names it.
  assert.deepEqual(naming, ['server/board.js', 'server/db.js', 'server/seed.js']);
  // In the board's file, three functions name it: the one that sets a record aside when somebody leaves a job, the
  // one that puts it back when they are put on the job again, and the one that moves it when an entry is folded
  // into another application.
  const source = fs.readFileSync(path.join(root, 'server', 'board.js'), 'utf8');
  const within = new Set();
  for (let at = source.indexOf(TABLE); at !== -1; at = source.indexOf(TABLE, at + 1)) {
    within.add([...source.slice(0, at).matchAll(/^(?:export )?(?:async )?function (\w+)|^(?:export )?const (\w+) = /gm)].at(-1).slice(1).find(Boolean));
  }
  assert.deepEqual([...within], ['leftJob', 'putOnJob', 'entryFolded']);
  // And each of the three is called from one place: leaving a job for The Book, being put on a job, and an entry being folded.
  const api_ = fs.readFileSync(path.join(root, 'server', 'api.js'), 'utf8');
  const calls = (name) => api_.split(`board.${name}(`).length - 1;
  assert.deepEqual([calls('leftJob'), calls('putOnJob'), calls('entryFolded')], [1, 1, 2]);
  assert.equal(api_.includes('const viaPost = board.putOnJob(applicationId, job.id, appliedDirectlyAt);'), true);
});

test('the demo data has people in The Book without a job', () => {
  const dir = tempDir('pool-seed');
  try {
    const run = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/seed.js'], { cwd: path.resolve(import.meta.dirname, '..'), env: { PATH: process.env.PATH, HOME: process.env.HOME, DATA_DIR: dir }, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const database = new DatabaseSync(path.join(dir, 'app.db'), { readOnly: true });
    const people = database.prepare(
      `SELECT c.name, c.email, c.client_id, a.stage_id, a.status, a.resume_file, u.name AS owner, (SELECT COUNT(*) FROM notes n WHERE n.application_id = a.id AND n.private = 1) AS notes,
         (SELECT detail FROM activities ac WHERE ac.application_id = a.id) AS history
       FROM applications a JOIN candidates c ON c.id = a.candidate_id LEFT JOIN users u ON u.id = a.owner_id WHERE a.job_id IS NULL ORDER BY a.applied_at`).all();
    database.close();
    assert.equal(people.length, 5);
    for (const p of people) {
      assert.deepEqual([p.client_id, p.stage_id, p.status], [null, null, 'active'], p.name);
      assert.ok(['Alex Morgan', 'Priya Nair'].includes(p.owner), p.name);
      assert.match(p.history, /^Added to The Book \(/);
      if (p.resume_file) assert.ok(fs.existsSync(path.join(dir, 'uploads', p.resume_file)), p.name);
    }
    // One came from a profile alone: no résumé and no address yet, and a note on why they were kept.
    assert.deepEqual(people.filter((p) => !p.resume_file).map((p) => [p.name, p.email, p.notes]), [['Ingrid Sorensen-Hale', null, 1]]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
