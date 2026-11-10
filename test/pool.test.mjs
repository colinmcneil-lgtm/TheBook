// People in The Book without a job, end to end: The Book's real API on a throwaway data folder. Run with `npm test`.
//
// A person can be saved with no job chosen. They get an entry with no job and no stage, which belongs to the agency
// alone, and which becomes a job's application when they are put on one. These tests add such people, do everything
// a profile allows to them, check that everything about jobs, clients and the hiring team's view carries on as if
// they were not there, and then put them on jobs.
//
// Phone calls go to the stand-in for Twilio (test/twilio-standin/), and the calendar is a file the test writes: no
// real phone rings and no real calendar is read. The screens are not driven here.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { session, tempDir, until, RECORDING } from './oracle-helpers.mjs';
import { startApi, PORTS as CALENDAR_PORTS, calendar, vevent, at } from './calendar-helpers.mjs';
import { BOOK_NUMBER, putJson } from './phone-helpers.mjs';
import { startStandin } from './twilio-standin/standin.mjs';

// Two ports: POOL_TEST_PORT and the one after it, or the two straight after the calendar tests' five.
const BASE_PORT = Number(process.env.POOL_TEST_PORT) || CALENDAR_PORTS.internal + 1;
const PORTS = { api: BASE_PORT, twilio: BASE_PORT + 1 };
const TZ = 'America/Toronto';
const DAY = '2026-11-10';
const NEEDS_JOB = { error: 'Add them to a job first.' };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)]);
const resume = (text, name = 'resume.pdf') => ({ name, bytes: Buffer.from(text) });

let api, twilio, dataDir, files;
let alex, dana, sam, maya, noor;          // the owner, two recruiters, and a hiring manager at each of two clients
const client = {}, job = {}, app = {};    // ids, by a short name
const book = {};                          // the entries of people saved without a job, by a short name
let baseline;                             // what the lists about jobs and clients answered before anyone was saved without a job

const put = (who, pathname, json) => putJson(who, api.base, pathname, json);
const detail = async (who, id) => (await who.get(`/applications/${id}`)).body;
const list = async (who, query = '') => (await who.get(`/applications${query}`)).body;
const uploads = () => fs.readdirSync(path.join(dataDir, 'uploads')).sort();
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
  files = tempDir('pool-calendar');
  twilio = await startStandin({ port: PORTS.twilio, numbers: [BOOK_NUMBER], quiet: true, stepMs: 5 });
  api = await startApi({
    port: PORTS.api, dataDir, files,
    env: {
      TWILIO_ACCOUNT_SID: twilio.config.accountSid, TWILIO_AUTH_TOKEN: twilio.config.authToken, TWILIO_NUMBER: BOOK_NUMBER, TWILIO_API_URL: twilio.baseUrl,
      APP_URL: `http://127.0.0.1:${PORTS.api}`, PHONE_SWEEP_MS: '150', PHONE_QUIET_MS: '500', PHONE_RECORDING_WAIT_MS: '350', PHONE_RECORDING_GIVE_UP_MS: '900', PHONE_RETRY_MS: '50',
    },
  });

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
  await twilio?.close();
  for (const dir of [dataDir, files]) if (dir) fs.rmSync(dir, { recursive: true, force: true });
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

// ---------- calls, the phone and the calendar ----------
test('a call in The Oracle can be put on somebody who is on no job, and its summary saved on their profile', async () => {
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

test('they can be found to ring, rung through The Book, and the call lands on their profile', async () => {
  const found = (await dana.get('/phone/lookup?q=bruno')).body;
  assert.deepEqual(found, [{
    candidate_id: found[0]?.candidate_id, name: 'Bruno Okafor', photo: null, phone: '+14165550177', phone_display: '(416) 555-0177',
    applications: [{ id: book.bruno, job_title: null, client_name: null, status: 'active' }],
  }]);
  // By the digits of a number; Kevin has one record at a client and one in The Book, with the same number.
  const kevins = (await dana.get('/phone/lookup?q=5550142')).body;
  assert.deepEqual(kevins.map((k) => k.applications.map((a) => [a.id, a.job_title, a.client_name])).sort(), [[[app.kevin, 'Senior Accountant', 'Maple Freight']], [[book.kevin, null, null]]].sort());

  assert.equal((await put(dana, '/me/phone', { phone: '647-555-0142' })).status, 200);
  const placed = await dana.post('/phone/calls', { application_id: book.bruno });
  assert.equal(placed.status, 201, JSON.stringify(placed.body));
  await twilio.idle();
  const ended = await until(async () => (await dana.get(`/phone/calls/${placed.body.id}`)).body, (c) => c.status === 'ended' || c.status === 'failed');
  assert.equal(ended.outcome, 'completed', JSON.stringify(ended));
  // The recording is fetched and becomes a call in The Oracle on their entry, with a line on their history.
  const calls = await until(async () => (await dana.get(`/oracle/calls?application_id=${book.bruno}`)).body, (rows) => rows.length === 1 && rows[0].status !== 'recording' && rows[0].duration_ms);
  assert.deepEqual([calls[0].source, calls[0].candidate_name, calls[0].job_title, calls[0].client_name, calls[0].title], ['phone', 'Bruno Okafor', null, null, 'Call with Bruno Okafor']);
  const history = await until(async () => (await detail(dana, book.bruno)).activities, (rows) => rows.some((a) => a.type === 'call'));
  assert.match(history.find((a) => a.type === 'call').detail, /^Phone call, /);
  book.brunoCall = calls[0].id;
});

test('the calendar matches an event to somebody who is on no job, and they can be chosen for one', async () => {
  const timed = (uid, title, from, to, ...more) => vevent(`UID:${uid}`, `SUMMARY:${title}`, `DTSTART${at('20261110', from)}`, `DTEND${at('20261110', to)}`, ...more);
  fs.writeFileSync(path.join(files, 'pool-day.ics'), calendar(
    timed('guest@test', 'Intro call', '0900', '0930', 'ATTENDEE;CN=Bruno;PARTSTAT=NEEDS-ACTION:mailto:bruno@example.com'),
    timed('named@test', 'Coffee with Cleo Marchetti', '1000', '1030'),
    timed('number@test', 'Ring back', '1100', '1115', 'DESCRIPTION:Cell: 613 555 0190'),
    timed('first@test', 'Call Eve', '1200', '1215'),
    timed('both@test', 'Catch up with Kevin Tremblay', '1300', '1330'),
    timed('free@test', 'Planning', '1400', '1430')));
  const linked = await put(dana, '/calendar/link', { url: 'https://calendar.test/pool-day.ics', tz: TZ });
  assert.equal(linked.status, 200, JSON.stringify(linked.body));
  const day = (await dana.get(`/calendar/day?date=${DAY}&tz=${TZ}`)).body;
  assert.deepEqual(day.warnings, []);
  const event = (title) => day.events.find((e) => e.title === title);
  const shape = (m) => m && [m.application_id, m.name, m.job_title, m.client_name, m.how];
  assert.deepEqual(shape(event('Intro call').match), [book.bruno, 'Bruno Okafor', null, null, 'email']);
  assert.deepEqual(shape(event('Coffee with Cleo Marchetti').match), [book.cleo, 'Cleo Marchetti', null, null, 'name']);
  assert.deepEqual(shape(event('Ring back').match), [book.ana, 'Ana Ruiz', null, null, 'phone']);
  // A first name alone is only ever offered.
  assert.equal(event('Call Eve').match, null);
  assert.deepEqual(event('Call Eve').suggestions.map(shape), [[book.eve, 'Eve Lindqvist', null, null, 'name']]);
  // Kevin is on file twice, at a client and in The Book, and in progress in both: which is meant is the recruiter's call.
  assert.equal(event('Catch up with Kevin Tremblay').match, null);
  assert.deepEqual(event('Catch up with Kevin Tremblay').suggestions.map(shape).sort(), [[app.kevin, 'Kevin Tremblay', 'Senior Accountant', 'Maple Freight', 'name'], [book.kevin, 'Kevin Tremblay', null, null, 'name']].sort());

  const chosen = await put(dana, `/calendar/events/${event('Planning').key}`, { application_id: book.eve, added: true });
  assert.equal(chosen.status, 200, JSON.stringify(chosen.body));
  assert.deepEqual(shape(chosen.body.match), [book.eve, 'Eve Lindqvist', null, null, 'chosen']);
  assert.deepEqual(shape((await dana.get(`/calendar/day?date=${DAY}&tz=${TZ}`)).body.events.find((e) => e.title === 'Planning').match), [book.eve, 'Eve Lindqvist', null, null, 'chosen']);
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
      await who.get('/candidates/lookup?email=cleo@example.com'), await who.get('/phone/lookup?q=bruno'), await who.get('/oracle/calls'), await who.get(`/oracle/calls/${book.cleoCall}`),
      await who.get(`/oracle/calls/${book.cleoCall}/audio`), await who.get(`/oracle/calls?application_id=${book.cleo}`), await who.get(`/calendar/day?date=${DAY}&tz=${TZ}`),
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
  const kept = (await list(alex, '?general=1')).map((r) => r.id).filter((x) => x !== id).sort((a, b) => a - b);
  assert.equal((await dana.del(`/applications/${id}`)).status, 200);
  assert.equal((await dana.get(`/applications/${id}`)).status, 404);
  assert.equal((await dana.get(`/oracle/calls/${call}`)).status, 404);
  assert.equal(db('SELECT COUNT(*) AS n FROM candidates WHERE id = ?', candidateId)[0].n, 0);
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
  assert.deepEqual(cleo.activities.slice(1).map((a) => a.id), before_.activities.map((a) => a.id));
  assert.deepEqual(cleo.emails.map((e) => e.id), before_.emails.map((e) => e.id));
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
  assert.deepEqual([eveNow.application.stage_id, eveNow.application.status, eveNow.activities[0].detail, eveNow.candidate.client_id], [hygienist[2].id, 'active', `Added to Hygienist at ${hygienist[2].name}`, client.northline]);
  assert.equal(eveNow.application.owner_name, 'Lena Fischer');
  const placed = await saved(dana, { name: 'Ivo Placed', email: 'ivo@example.com' });
  assert.equal((await addToJob(dana, placed, { job_id: job.hygienist, stage_id: hygienist.at(-1).id })).status, 200);
  const ivo = await detail(dana, placed);
  assert.deepEqual([ivo.application.status, ivo.application.hired_at, ivo.activities[0].detail], ['hired', ivo.application.applied_at, 'Added to Hygienist at Hired']);
  // The calendar event Eve was chosen for still names her, now with her job.
  const planning = (await dana.get(`/calendar/day?date=${DAY}&tz=${TZ}`)).body.events.find((e) => e.title === 'Planning');
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
  const historyBefore = (await detail(dana, book.kevin)).activities.map((a) => a.id);

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
  assert.deepEqual(kevin.activities.slice(0, 2).map((a) => a.detail).sort(), ['Added to Payroll Specialist at Recruiter screen', "Joined to Kevin Tremblay's record at Maple Freight"]);
  assert.deepEqual(kevin.activities.slice(2).map((a) => a.id), historyBefore);
  const moved = (await dana.get(`/oracle/calls/${call}`)).body;
  assert.deepEqual([moved.call.application_id, moved.candidate.id, moved.application.job_title, moved.call.note_saved], [book.kevin, kevinAtMaple, 'Payroll Specialist', true]);
  assert.deepEqual((await dana.get(`/oracle/calls?candidate_id=${kevinAtMaple}`)).body.map((c) => c.id), [call]);
  // The hiring team sees the entry from here on only.
  const seen = (await maya.get(`/applications/${book.kevin}`)).body;
  assert.deepEqual([seen.notes, seen.emails], [[], []]);
  // That he was joined from an entry in The Book is the agency's business: the hiring team is not shown that line.
  assert.deepEqual(seen.activities.map((a) => a.detail), ['Added to Payroll Specialist at Recruiter screen']);
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
  assert.deepEqual(two.activities.map((a) => a.detail), [`Added to Payroll Specialist at ${payroll[1].name}`]);
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
  assert.deepEqual([theirs.job.title, theirs.notes.length, theirs.activities.map((a) => a.detail)], ['Payroll Specialist', 0, [`Added to Payroll Specialist at ${payroll[1].name}`]]);
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
  assert.deepEqual(now_.activities.map((a) => a.detail), [`Added to Payroll Specialist at ${stages[1].name}`, 'Added to The Book (agency sourced)']);
  assert.equal(now_.application.from_book, true);
  // The hiring team sees her from the moment she joined the job.
  const theirs = await detail(maya, id);
  assert.deepEqual([theirs.notes, theirs.emails, theirs.activities.map((a) => a.detail)], [[], [], [`Added to Payroll Specialist at ${stages[1].name}`]]);
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
  assert.equal(teodor.activities[0].detail, 'A newer résumé was added. The one they had (Teodor 2023.pdf) is kept under Earlier résumés');
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
  const ours = await detail(dana, entry);
  assert.deepEqual([ours.candidate.created_at, ours.application.cover_note], [person.created_at, 'Agency eyes only: met at a conference.']);
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
  assert.deepEqual(ilse.earlier_resumes.map((r) => r.name), ['Ilse book.pdf']);
  assert.equal((await dana.get(`/oracle/calls/${book.ilseCall}`)).body.call.application_id, book.ilse);
  assert.equal((await noor.get(`/applications/${book.ilse}`)).status, 404);
  // Erasing her erases the earlier résumé with the rest.
  const hers = db('SELECT resume_file FROM applications WHERE id = ? UNION ALL SELECT resume_file FROM earlier_resumes WHERE application_id = ?', book.ilse, book.ilse).map((r) => r.resume_file);
  assert.equal(hers.length, 2);
  assert.equal((await dana.del(`/candidates/${ilsePerson}`)).status, 200);
  await until(async () => uploads(), (now_) => !hers.some((f) => now_.includes(f)));
  assert.deepEqual(db('SELECT COUNT(*) AS n FROM earlier_resumes WHERE application_id = ?', book.ilse), [{ n: 0 }]);
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
