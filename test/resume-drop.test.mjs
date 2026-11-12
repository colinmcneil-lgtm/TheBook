// A résumé dropped on a candidate's profile, end to end against the real API on a throwaway data folder. Run with
// `npm test`. The dialog that reads the file in the browser is not driven here; these tests send what it sends: the
// file, and the details the recruiter ticked (PUT /applications/:id/resume).
//
// Every résumé, name, address and number here is made up.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { startServer, session, tempDir, until, PORTS } from './oracle-helpers.mjs';

const PORT = PORTS.resumeDrop; // the one kept for this file (see PORT_PLAN in oracle-helpers.mjs)
const file = (text, name = 'resume.txt') => ({ name, bytes: Buffer.from(text) });

let server, dataDir, base;
let alex, maya, noor, cora;        // the owner, and a hiring manager at each of the three clients
const client = {}, job = {}, app = {};

const uploads = () => fs.readdirSync(path.join(dataDir, 'uploads')).sort();
/** Read the server's database directly, for things no route shows. */
function db(query, ...params) {
  const database = new DatabaseSync(path.join(dataDir, 'app.db'), { readOnly: true });
  try { return database.prepare(query).all(...params).map((row) => ({ ...row })); } finally { database.close(); }
}
const mails = () => db('SELECT (SELECT COUNT(*) FROM emails) + (SELECT COUNT(*) FROM agency_emails) AS n')[0].n;
const detail = async (who, id) => (await who.get(`/applications/${id}`)).body;
const lines = (d) => d.activities.map((a) => a.detail);

/** What the profile's dialog sends: the file, and each detail that was ticked. */
async function attach(who, id, resume, details = {}) {
  const form = new FormData();
  if (resume) form.append('resume', new Blob([resume.bytes]), resume.name);
  for (const [key, value] of Object.entries(details)) form.append(key, value);
  const res = await fetch(`${base}/api/applications/${id}/resume`, { method: 'PUT', body: form, headers: who ? { Cookie: who.cookie() } : {} });
  return { status: res.status, body: await res.json() };
}
/**
 * The files in the uploads folder once it has stopped changing. A file that is not needed after all (the same résumé
 * sent twice) is removed a moment after the answer, so a count taken straight after one would include it.
 */
async function steady() {
  for (let last = uploads(); ;) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    const now = uploads();
    if (JSON.stringify(now) === JSON.stringify(last)) return now;
    last = now;
  }
}
/** The uploads folder ends up as it was: a refused file is not left behind. */
const leftAsItWas = async (before) => until(async () => uploads(), (now) => JSON.stringify(now) === JSON.stringify(before), 5000);

before(async () => {
  dataDir = tempDir('resume-drop');
  // Behind a proxy, so that each application made on a careers page here can come from an address of its own: the
  // form takes ten an address every ten minutes, and this file makes more.
  server = await startServer({ port: PORT, dataDir, env: { TRUST_PROXY: '1' } });
  base = server.base;
  alex = session(base);
  assert.equal((await alex.post('/setup', { agencyName: 'Harbour Talent', name: 'Alex Morgan', email: 'alex@agency.example', password: 'demo1234' })).status, 200);
  client.maple = (await alex.post('/clients', { name: 'Maple Freight' })).body.id;
  client.northline = (await alex.post('/clients', { name: 'Northline Dental' })).body.id;
  client.cedar = (await alex.post('/clients', { name: 'Cedar Logistics' })).body.id;
  const join = async (email, clientId, name) => {
    const { token } = (await alex.post('/invites', { role: 'client', email, client_id: clientId })).body;
    const person = session(base);
    assert.equal((await person.post(`/invites/${token}/accept`, { name, password: 'demo1234' })).status, 200);
    return person;
  };
  maya = await join('maya@maple.example', client.maple, 'Maya Example');
  noor = await join('noor@northline.example', client.northline, 'Noor Example');
  cora = await join('cora@cedar.example', client.cedar, 'Cora Example');
  const newJob = async (clientId, title) => (await alex.post('/jobs', { client_id: clientId, title, status: 'open' })).body.id;
  job.accountant = await newJob(client.maple, 'Senior Accountant');
  job.payroll = await newJob(client.maple, 'Payroll Specialist');
  job.hygienist = await newJob(client.northline, 'Hygienist');
  job.receptionist = await newJob(client.cedar, 'Receptionist');
  const add = async (fields) => {
    const made = await alex.upload('/applications', fields);
    assert.equal(made.status, 200, JSON.stringify(made.body));
    return made.body.id;
  };
  // Saved from LinkedIn by the extension: a link and a title, no address, no phone and no résumé.
  app.jordan = await add({ job_id: job.accountant, name: 'Jordan Example', linkedin: 'https://www.linkedin.com/in/jordan-example', current_title: 'Accountant' });
  app.casey = await add({ job_id: job.accountant, name: 'Casey Example', email: 'casey@example.com', phone: '(647) 555-0121', linkedin: 'https://www.linkedin.com/in/casey-example' });
  app.robin = await add({ job_id: job.hygienist, name: 'Robin Example', email: 'robin@example.com' });
});

after(async () => {
  await server?.stop();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

test('a résumé attached to a profile that has none, with the empty details it fills in', async () => {
  const mailed = mails();
  const answer = await attach(alex, app.jordan, file('Jordan Example\njordan@example.com\n416 555 0188', 'Jordan Example CV.txt'),
    { email: 'Jordan@Example.com ', phone: '416 555 0188', location: 'Toronto, ON', current_company: 'Varsity Freight', current_title: '' });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.deepEqual(answer.body, { ok: true, resume: 'added', filled: ['email', 'phone', 'location', 'current_company'] });

  const seen = await detail(alex, app.jordan);
  assert.equal(seen.application.resume_name, 'Jordan Example CV.txt');
  assert.deepEqual([seen.candidate.name, seen.candidate.email, seen.candidate.phone, seen.candidate.location, seen.candidate.current_title, seen.candidate.current_company],
    ['Jordan Example', 'jordan@example.com', '416 555 0188', 'Toronto, ON', 'Accountant', 'Varsity Freight']);
  // One line in the history, saying which details were filled in and not what they were.
  assert.equal(lines(seen)[0], 'Résumé added; filled in email, phone, location and company from it');
  assert.equal(seen.activities[0].user_name, 'Alex Morgan');
  assert.deepEqual(seen.earlier_resumes, []);

  // The client's hiring team sees it as they see a résumé attached when the candidate was added: the file, the
  // details, the line.
  const theirs = await detail(maya, app.jordan);
  assert.equal(theirs.application.resume_name, 'Jordan Example CV.txt');
  assert.equal(theirs.candidate.phone, '416 555 0188');
  assert.equal(lines(theirs)[0], 'Résumé added; filled in email, phone, location and company from it');
  const download = await maya.get(`/applications/${app.jordan}/resume`);
  assert.equal(download.status, 200);
  assert.equal(download.body.toString(), 'Jordan Example\njordan@example.com\n416 555 0188');
  assert.equal(mails(), mailed, 'nothing is sent to anybody');
});

test('a résumé on file is replaced, never written over: the earlier one is kept for the agency, and never listed for a client', async () => {
  const answer = await attach(alex, app.jordan, file('Jordan Example\nSenior Accountant, Varsity Freight', 'Jordan 2026.pdf'));
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.deepEqual(answer.body, { ok: true, resume: 'replaced', filled: [] });
  const seen = await detail(alex, app.jordan);
  assert.equal(seen.application.resume_name, 'Jordan 2026.pdf');
  assert.equal(lines(seen)[0], 'Résumé replaced');
  assert.deepEqual(seen.earlier_resumes.map((r) => r.name), ['Jordan Example CV.txt']);
  const earlier = await alex.get(`/applications/${app.jordan}/resumes/${seen.earlier_resumes[0].id}`);
  assert.equal(earlier.status, 200);
  assert.equal(earlier.body.toString(), 'Jordan Example\njordan@example.com\n416 555 0188');

  const theirs = await detail(maya, app.jordan);
  assert.equal(theirs.application.resume_name, 'Jordan 2026.pdf');
  assert.deepEqual(theirs.earlier_resumes, []);
  assert.equal((await maya.get(`/applications/${app.jordan}/resumes/${seen.earlier_resumes[0].id}`)).status, 403);
  assert.equal((await maya.get(`/applications/${app.jordan}/resume`)).body.toString(), 'Jordan Example\nSenior Accountant, Varsity Freight');
});

test('the same file sent twice is kept once', async () => {
  const before = await steady();
  const again = await attach(alex, app.jordan, file('Jordan Example\nSenior Accountant, Varsity Freight', 'copy of Jordan 2026.pdf'));
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.deepEqual(again.body, { ok: true, resume: 'unchanged', filled: [] });
  await leftAsItWas(before);
  const seen = await detail(alex, app.jordan);
  assert.equal(seen.application.resume_name, 'Jordan 2026.pdf');
  assert.equal(seen.earlier_resumes.length, 1);
  assert.equal(lines(seen)[0], 'Résumé replaced', 'nothing happened, so nothing is written');
  // The same file with a detail ticked fills that detail in, and says so.
  const filled = await attach(alex, app.jordan, file('Jordan Example\nSenior Accountant, Varsity Freight'), { current_title: 'Senior Accountant' });
  assert.deepEqual(filled.body, { ok: true, resume: 'unchanged', filled: ['current_title'] });
  await leftAsItWas(before);
  assert.equal(lines(await detail(alex, app.jordan))[0], 'Filled in current title from the résumé on file');
});

test('a detail the profile has is only changed when it is sent, and the same value is not a change', async () => {
  const resume = file('Casey Example\ncasey@example.com\n416 555 0199', 'casey.txt');
  // Nothing ticked: the résumé is attached and the phone on the profile stays.
  assert.deepEqual((await attach(alex, app.casey, resume)).body, { ok: true, resume: 'added', filled: [] });
  assert.equal((await detail(alex, app.casey)).candidate.phone, '(647) 555-0121');
  // Ticked, with the address it already has: only the phone is a change.
  const answer = await attach(alex, app.casey, resume, { phone: '416 555 0199', email: 'casey@example.com' });
  assert.deepEqual(answer.body, { ok: true, resume: 'unchanged', filled: ['phone'] });
  const seen = await detail(alex, app.casey);
  assert.equal(seen.candidate.phone, '416 555 0199');
  assert.equal(seen.candidate.email, 'casey@example.com');
  assert.equal(seen.candidate.name, 'Casey Example');
  // A name is never taken from here, whatever is sent.
  await attach(alex, app.casey, resume, { name: 'Somebody Else' });
  assert.equal((await detail(alex, app.casey)).candidate.name, 'Casey Example');
});

test('a bad address, or an address or LinkedIn link already on another record at the same client, refuses everything and leaves no file behind', async () => {
  const before = await steady();
  const was = await detail(alex, app.jordan);
  const tryWith = async (details, status, message) => {
    const answer = await attach(alex, app.jordan, file(`Jordan Example\n${JSON.stringify(details)}`, 'refused.txt'), details);
    assert.equal(answer.status, status, JSON.stringify(answer.body));
    assert.equal(answer.body.error, message);
    await leftAsItWas(before);
  };
  await tryWith({ email: 'jordan at example.com', phone: '416 555 0100' }, 400, 'That email address does not look right.');
  await tryWith({ email: 'casey@example.com', phone: '416 555 0100' }, 400, 'Another candidate at this client already uses that email.');
  await tryWith({ linkedin: 'linkedin.com/in/casey-example/', location: 'Ottawa' }, 400, "That LinkedIn link is already on Casey Example's record at this client. Untick it, or check the link.");
  await tryWith({ linkedin: 'not a link at all', location: 'Ottawa' }, 400, 'The profile link does not look like a web address.');
  const now = await detail(alex, app.jordan);
  assert.deepEqual(now.candidate, was.candidate);
  assert.equal(now.application.resume_name, was.application.resume_name);
  assert.deepEqual(now.earlier_resumes, was.earlier_resumes);
  assert.deepEqual(lines(now), lines(was));
  // The same address at another client is another client's record, and is no reason to refuse.
  assert.equal((await attach(alex, app.robin, file('Robin Example', 'robin.txt'), { phone: '416 555 0111', email: 'robin@example.com' })).status, 200);
});

test('a file that is not a résumé, one that is too large, or none at all is refused, and nothing is left behind', async () => {
  const before = await steady();
  const picture = await attach(alex, app.casey, { name: 'casey.png', bytes: Buffer.from('not a résumé') }, { phone: '416 555 0100' });
  assert.deepEqual([picture.status, picture.body.error], [400, 'Résumé must be a PDF, Word, RTF or text file.']);
  const huge = await attach(alex, app.casey, { name: 'casey.pdf', bytes: Buffer.alloc(8 * 1024 * 1024 + 1, 32) }, { phone: '416 555 0100' });
  assert.deepEqual([huge.status, huge.body.error], [400, 'That file is larger than 8 MB.']);
  const none = await attach(alex, app.casey, null, { phone: '416 555 0100' });
  assert.deepEqual([none.status, none.body.error], [400, 'Choose a résumé to attach.']);
  await leftAsItWas(before);
  assert.equal((await detail(alex, app.casey)).candidate.phone, '416 555 0199');
});

test('a client\'s user and a signed-out visitor cannot attach a résumé, and send no file to the server', async () => {
  const before = await steady();
  const theirs = await attach(maya, app.casey, file('Casey Example', 'from the client.txt'), { phone: '416 555 0100' });
  assert.deepEqual([theirs.status, theirs.body.error], [403, 'Only the agency team can do this.']);
  const other = await attach(noor, app.casey, file('Casey Example', 'from another client.txt'));
  assert.equal(other.status, 403);
  const nobody = await attach(null, app.casey, file('Casey Example', 'from nobody.txt'));
  assert.equal(nobody.status, 401);
  await leftAsItWas(before);
  const seen = await detail(alex, app.casey);
  assert.equal(seen.candidate.phone, '416 555 0199');
  assert.equal(seen.application.resume_name, 'casey.txt');
  // A profile that does not exist answers as one, and keeps no file.
  assert.equal((await attach(alex, 999999, file('Nobody', 'nobody.txt'))).status, 404);
  await leftAsItWas(before);
});

test('somebody on no job: the résumé goes on their entry, and The Book\'s own rule of one entry per address holds', async () => {
  const made = await alex.upload('/applications', { name: 'Ana Example', email: 'ana@example.com' });
  assert.equal(made.body.general, true);
  app.ana = made.body.id;
  await alex.upload('/applications', { name: 'Bea Example', email: 'bea@example.com' });
  const before = await steady();
  const clash = await attach(alex, app.ana, file('Ana Example', 'ana.txt'), { email: 'bea@example.com' });
  assert.deepEqual([clash.status, clash.body.error], [400, 'Someone else saved to The Book without a job already uses that email.']);
  await leftAsItWas(before);
  const answer = await attach(alex, app.ana, file('Ana Example\nana@example.com\n416 555 0144', 'Ana Example.pdf'), { phone: '416 555 0144', linkedin: 'https://ca.linkedin.com/in/ana-example/?trk=share' });
  assert.deepEqual(answer.body, { ok: true, resume: 'added', filled: ['phone', 'linkedin'] });
  const seen = await detail(alex, app.ana);
  assert.equal(seen.application.resume_name, 'Ana Example.pdf');
  assert.equal(seen.candidate.linkedin, 'https://www.linkedin.com/in/ana-example');
  assert.equal(lines(seen)[0], 'Résumé added; filled in phone and LinkedIn link from it');
  assert.equal((await maya.get(`/applications/${app.ana}`)).status, 404, 'a client user is told it does not exist');
  // Another entry's link is refused the same way as at a client. (Jordan's, on a client's record, would not be.)
  await alex.upload('/applications', { name: 'Cleo Example', linkedin: 'https://www.linkedin.com/in/cleo-example' });
  const book = await attach(alex, app.ana, file('Ana Example', 'ana3.txt'), { linkedin: 'https://www.linkedin.com/in/cleo-example' });
  assert.deepEqual([book.status, book.body.error], [400, "That LinkedIn link is already on Cleo Example's entry in The Book. Untick it, or check the link."]);
});

test('put on a job, removed, and joined to a record the client has: the résumé the agency attached ends up where The Book says', async () => {
  const resumeOf = async (who, id) => (await who.get(`/applications/${id}/resume`)).body.toString();
  // On a job: the entry keeps its résumé, which the hiring team now sees, but not the line written before the job.
  assert.equal((await alex.post(`/applications/${app.ana}/add-to-job`, { job_id: job.accountant })).status, 200);
  let theirs = await detail(maya, app.ana);
  assert.equal(theirs.application.resume_name, 'Ana Example.pdf');
  assert.ok(!lines(theirs).some((l) => l.startsWith('Résumé')), 'what was written before the job is the agency\'s');
  assert.deepEqual(theirs.earlier_resumes, []);
  // Replaced while on the job: the hiring team sees the new one, the agency keeps both earlier ones.
  assert.equal((await attach(alex, app.ana, file('Ana Example, on the job', 'Ana on the job.docx'))).body.resume, 'replaced');
  theirs = await detail(maya, app.ana);
  assert.equal(theirs.application.resume_name, 'Ana on the job.docx');
  assert.equal(lines(theirs)[0], 'Résumé replaced');
  assert.deepEqual(theirs.earlier_resumes, []);

  // Removed from the job: back in The Book with the résumé that was on the profile.
  const back = await alex.del(`/applications/${app.ana}`);
  assert.equal(back.body.returned, true);
  let seen = await detail(alex, app.ana);
  assert.equal(seen.application.general, true);
  assert.equal(seen.application.resume_name, 'Ana on the job.docx');
  assert.deepEqual(seen.earlier_resumes.map((r) => r.name), ['Ana Example.pdf']);

  // Ana applies for the payroll job on Maple Freight's careers page herself, with a résumé of her own.
  const { slug } = (await alex.get(`/clients/${client.maple}`)).body.client;
  const form = new FormData();
  for (const [k, v] of Object.entries({ name: 'Ana Example', email: 'ana@example.com', consent: 'yes' })) form.append(k, v);
  form.append('resume', new Blob([Buffer.from('Ana Example, sent to Maple Freight herself')]), 'Ana for Maple.pdf');
  assert.equal((await fetch(`${base}/api/public/careers/${slug}/jobs/${job.payroll}/apply`, { method: 'POST', body: form })).status, 200);
  const own = (await alex.get(`/applications?job_id=${job.payroll}`)).body.find((r) => r.email === 'ana@example.com');

  // Joined to it: her application keeps the résumé she sent, and the one the agency had is set aside for the agency.
  const refused = await alex.post(`/applications/${app.ana}/add-to-job`, { job_id: job.payroll });
  assert.equal(refused.body.code, 'already_in_job');
  assert.equal((await alex.post(`/applications/${app.ana}/add-to-job`, { job_id: job.payroll, into: refused.body.join.candidate_id })).status, 200);
  assert.equal(await resumeOf(maya, own.id), 'Ana Example, sent to Maple Freight herself');

  // The agency drops a newer résumé on that application, which the hiring team now sees.
  assert.equal((await attach(alex, own.id, file('Ana Example, the agency\'s newest', 'Ana newest.pdf'), { phone: '416 555 0145' })).body.resume, 'replaced');
  theirs = await detail(maya, own.id);
  assert.equal(theirs.application.resume_name, 'Ana newest.pdf');
  assert.equal(theirs.candidate.phone, '416 555 0145');
  assert.deepEqual(theirs.earlier_resumes, []);

  // Removed from that job: it is the application she made herself, so whatever résumé is on it is set aside, as one
  // attached any other way would be. The entry has the résumé it brought again; what she sent Maple Freight and the
  // one dropped on her application are kept under Earlier résumés, with the one the entry had before.
  assert.equal((await alex.del(`/applications/${own.id}`)).body.returned, true);
  seen = await detail(alex, own.id);
  assert.equal(seen.application.general, true);
  assert.equal(await resumeOf(alex, own.id), 'Ana Example, on the job');
  assert.deepEqual(seen.earlier_resumes.map((r) => r.name).sort(), ['Ana Example.pdf', 'Ana for Maple.pdf', 'Ana newest.pdf']);

  // Put on another client's job: that hiring team sees the entry's résumé and nothing of Maple Freight's.
  assert.equal((await alex.post(`/applications/${own.id}/add-to-job`, { job_id: job.hygienist })).status, 200);
  const northline = await detail(noor, own.id);
  assert.equal(northline.application.resume_name, 'Ana on the job.docx');
  assert.deepEqual(northline.earlier_resumes, []);
  assert.equal(await resumeOf(noor, own.id), 'Ana Example, on the job');
});

test('a résumé the client was sent by the person stays theirs when it goes back to The Book, as before', async () => {
  // Somebody saved to The Book without a résumé, joined to the careers-page application they made with one, and
  // removed again: the résumé they sent the client is kept for the agency only, and the entry goes back without one.
  const entry = (await alex.upload('/applications', { name: 'Dev Example', email: 'dev@example.com' })).body.id;
  const { slug } = (await alex.get(`/clients/${client.maple}`)).body.client;
  const form = new FormData();
  for (const [k, v] of Object.entries({ name: 'Dev Example', email: 'dev@example.com', consent: 'yes' })) form.append(k, v);
  form.append('resume', new Blob([Buffer.from('Dev Example, sent to Maple Freight')]), 'Dev.pdf');
  assert.equal((await fetch(`${base}/api/public/careers/${slug}/jobs/${job.payroll}/apply`, { method: 'POST', body: form })).status, 200);
  const own = (await alex.get(`/applications?job_id=${job.payroll}`)).body.find((r) => r.email === 'dev@example.com');
  const refused = await alex.post(`/applications/${entry}/add-to-job`, { job_id: job.payroll });
  assert.equal((await alex.post(`/applications/${entry}/add-to-job`, { job_id: job.payroll, into: refused.body.join.candidate_id })).status, 200);
  assert.equal((await alex.del(`/applications/${own.id}`)).body.returned, true);
  const seen = await detail(alex, own.id);
  assert.equal(seen.application.resume_file, null);
  assert.deepEqual(seen.earlier_resumes.map((r) => r.name), ['Dev.pdf']);
});

test('deleting the person leaves nothing of what the agency attached', async () => {
  const id = (await alex.upload('/applications', { name: 'Eli Example', email: 'eli@example.com' })).body.id;
  await attach(alex, id, file('Eli Example one', 'eli1.txt'));
  await attach(alex, id, file('Eli Example two', 'eli2.txt'));
  const before = await steady();
  const { candidate } = await detail(alex, id);
  assert.equal(db('SELECT COUNT(*) AS n FROM earlier_resumes WHERE application_id = ?', id)[0].n, 1);
  assert.equal((await alex.del(`/candidates/${candidate.id}`)).status, 200);
  assert.equal(db('SELECT COUNT(*) AS n FROM earlier_resumes WHERE application_id = ?', id)[0].n, 0);
  await until(async () => uploads(), (now) => now.length === before.length - 2, 5000);
});

/** The person applies for a job on its client's careers page (Maple Freight's unless said) themselves; answers their own application's id. */
async function appliesOnCareers(name, email, jobId, resume, clientId = client.maple) {
  const { slug } = (await alex.get(`/clients/${clientId}`)).body.client;
  const form = new FormData();
  for (const [k, v] of Object.entries({ name, email, consent: 'yes' })) form.append(k, v);
  if (resume) form.append('resume', new Blob([resume.bytes]), resume.name);
  visitor += 1;
  const sent = await fetch(`${base}/api/public/careers/${slug}/jobs/${jobId}/apply`, { method: 'POST', body: form, headers: { 'X-Forwarded-For': `192.0.2.${visitor}` } });
  assert.equal(sent.status, 200);
  return (await alex.get(`/applications?job_id=${jobId}`)).body.find((r) => r.email === email).id;
}
let visitor = 0; // each application made on a careers page comes from an address of its own (see before)
/** Their entry in The Book is joined to the record Maple Freight has of them, on this job. */
async function joinOnJob(entry, jobId) {
  const refused = await alex.post(`/applications/${entry}/add-to-job`, { job_id: jobId });
  assert.equal(refused.body.code, 'already_in_job', JSON.stringify(refused.body));
  assert.equal((await alex.post(`/applications/${entry}/add-to-job`, { job_id: jobId, into: refused.body.join.candidate_id })).status, 200);
}
const resumeText = async (who, id) => { const r = await who.get(`/applications/${id}/resume`); return r.status === 200 ? r.body.toString() : r.status; };

test('their own résumé put back on their application by the agency is still theirs, and does not go on to the next client', async () => {
  // Bo, in The Book, applies to Maple Freight herself, and is joined to that application.
  const entry = (await alex.upload('/applications', { name: 'Bo Example', email: 'bo@example.com' })).body.id;
  const own = await appliesOnCareers('Bo Example', 'bo@example.com', job.payroll, file('Bo Example, sent to Maple Freight herself', 'bo-own.pdf'));
  await joinOnJob(entry, job.payroll);
  // The agency replaces her résumé by mistake, then puts hers back: downloaded from Earlier résumés and dropped again.
  assert.equal((await attach(alex, own, file('Bo Example, the agency\'s', 'bo-agency.pdf'))).body.resume, 'replaced');
  const kept = (await detail(alex, own)).earlier_resumes.find((r) => r.name === 'bo-own.pdf');
  const hers = (await alex.get(`/applications/${own}/resumes/${kept.id}`)).body;
  assert.equal((await attach(alex, own, { name: 'bo-own.pdf', bytes: hers })).body.resume, 'replaced');
  // Removed from the job: what she sent Maple Freight is kept for the agency only, and the entry goes back without it.
  assert.equal((await alex.del(`/applications/${own}`)).body.returned, true);
  assert.equal(await resumeText(alex, own), 404);
  assert.ok((await detail(alex, own)).earlier_resumes.some((r) => r.name === 'bo-own.pdf'));
  // Put on Northline Dental's job: its hiring team is not given what she wrote to Maple Freight.
  assert.equal((await alex.post(`/applications/${own}/add-to-job`, { job_id: job.hygienist })).status, 200);
  assert.equal(await resumeText(noor, own), 404);
  assert.deepEqual((await detail(noor, own)).earlier_resumes, []);
});

test('a copy of their own résumé on another of the client\'s jobs comes off too, after the agency replaced the one on their own application', async () => {
  // Pat applies to Maple Freight herself; the agency adds her to a second Maple job, with a copy of her résumé.
  const own = await appliesOnCareers('Pat Example', 'pat@example.com', job.payroll, file('Pat Example, sent to Maple Freight herself', 'pat.pdf'));
  const second = (await alex.post(`/applications/${own}/add-to-job`, { job_id: job.accountant })).body.id;
  // Saved to The Book, and joined to the second application.
  const entry = (await alex.upload('/applications', { name: 'Pat Example', email: 'pat@example.com' })).body;
  await joinOnJob(entry.id, job.accountant);
  // The agency drops its own résumé on her own application, so hers is now under Earlier résumés there.
  assert.equal((await attach(alex, own, file('Pat Example, the agency\'s', 'pat-agency.pdf'))).body.resume, 'replaced');
  // Removed from the second job: the copy of what she sent Maple Freight does not go back to The Book with her.
  assert.equal((await alex.del(`/applications/${second}`)).body.returned, true);
  assert.equal(await resumeText(alex, second), 404);
  assert.deepEqual((await detail(alex, second)).earlier_resumes.map((r) => r.name), ['pat.pdf']);
});

test('a copy of the résumé on their own application, on another of the client\'s jobs, is set aside whoever dropped it there', async () => {
  const own = await appliesOnCareers('Lee Example', 'lee@example.com', job.payroll, file('Lee Example, sent to Maple Freight herself', 'lee.pdf'));
  assert.equal((await attach(alex, own, file('Lee Example, the agency\'s', 'lee-agency.pdf'))).body.resume, 'replaced');
  const second = (await alex.post(`/applications/${own}/add-to-job`, { job_id: job.accountant })).body.id; // a copy of the one on her application
  const entry = (await alex.upload('/applications', { name: 'Lee Example', email: 'lee@example.com' })).body;
  await joinOnJob(entry.id, job.accountant);
  assert.equal((await alex.del(`/applications/${second}`)).body.returned, true);
  assert.equal(await resumeText(alex, second), 404);
  assert.deepEqual((await detail(alex, second)).earlier_resumes.map((r) => r.name), ['lee-agency.pdf']);
});

test('a résumé dropped on their entry in The Book, which an application they made with none had been using, is set aside when they go back', async () => {
  const entry = (await alex.upload('/applications', { name: 'Quinn Example', email: 'quinn@example.com' })).body.id;
  assert.equal((await attach(alex, entry, file('Quinn Example, the agency\'s', 'quinn.txt'))).body.resume, 'added');
  const own = await appliesOnCareers('Quinn Example', 'quinn@example.com', job.payroll, null);
  await joinOnJob(entry, job.payroll);
  assert.equal(await resumeText(maya, own), 'Quinn Example, the agency\'s');
  // As for a résumé saved with the entry: on the application they made themselves, the résumé is set aside.
  assert.equal((await alex.del(`/applications/${own}`)).body.returned, true);
  assert.equal(await resumeText(alex, own), 404);
  assert.deepEqual((await detail(alex, own)).earlier_resumes.map((r) => r.name), ['quinn.txt']);
});

// ---------- what goes on to the next client ----------
// A résumé dropped on a profile is treated as any other résumé on the application: the same rules as a résumé
// attached when somebody already in The Book is saved again. Going back to The Book, whichever file would be left on
// the profile is held to one more check (clientsCopy in server/api.js), against the fingerprints recorded when people
// sent clients résumés themselves: a file is set aside when it was sent to this client, or when it was sent to any
// client and is the very same file as one of the application's earlier résumés.

/**
 * Somebody back in The Book is put on Northline Dental's job, and this is what Northline's hiring manager can list
 * or download of them: the résumé route, the earlier-résumé route for every earlier résumé there is, and the profile.
 */
async function northlineSees(id, [who, jobId] = [noor, job.hygienist]) {
  const put = await alex.post(`/applications/${id}/add-to-job`, { job_id: jobId });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const target = put.body.id ?? id;
  const payload = await who.get(`/applications/${target}`);
  assert.equal(payload.status, 200);
  const earlier = [];
  for (const { id: kept } of db('SELECT id FROM earlier_resumes')) {
    const answer = await who.get(`/applications/${target}/resumes/${kept}`);
    assert.ok([403, 404].includes(answer.status), `earlier résumé ${kept} answers ${answer.status}`);
    earlier.push(answer.status);
  }
  return { id: target, resume: await resumeText(who, target), payload: JSON.stringify(payload.body), listed: payload.body.earlier_resumes };
}
/** The same, for Cedar Logistics' hiring manager and job. */
const CEDAR = () => [cora, job.receptionist];
/** Northline (or `at`) is given nothing of what they sent Maple Freight: no résumé, no earlier one, not a name of one. */
async function northlineGetsNothing(id, ...names) {
  const at = Array.isArray(names[0]) ? names.shift() : undefined;
  const seen = await northlineSees(id, at);
  assert.equal(seen.resume, 404);
  assert.deepEqual(seen.listed, []);
  for (const name of names) assert.ok(!seen.payload.includes(name), `${name} is not in what Northline is sent`);
  assert.ok(!seen.payload.includes('Maple'), 'nor the client');
  return seen;
}
/** The agency still has this file under Earlier résumés, once (or `times`), and can download it. */
async function agencyKeeps(id, text, times = 1) {
  const { earlier_resumes: earlier } = await detail(alex, id);
  const found = [];
  for (const r of earlier) {
    const got = await alex.get(`/applications/${id}/resumes/${r.id}`);
    assert.equal(got.status, 200);
    if (got.body.toString() === text) found.push(r.name);
  }
  assert.equal(found.length, times, `kept under Earlier résumés: ${JSON.stringify(found)}`);
}
const newJob = async (title) => (await alex.post('/jobs', { client_id: client.maple, title, status: 'open' })).body.id;

for (const [label, drops] of [['the same file', ['X']], ['another file, then the same one', ['Y', 'X']], ['the same, another, the same again', ['X', 'Y', 'X']]]) {
  test(`what they sent the client, dropped on their entry on another of its jobs (${label}), does not go on to the next client`, async () => {
    const who = `Rho${drops.join('')}`;
    const email = `${who.toLowerCase()}@example.com`;
    const sent = file(`${who} Example, sent to Maple Freight on its careers page`, `${who} for Maple.pdf`);
    const [first, third] = [await newJob(`Fleet Planner ${who}`), await newJob(`Route Analyst ${who}`)];
    // They apply to Maple's first job themselves with X, and their entry in The Book is joined into that application.
    const entry = (await alex.upload('/applications', { name: `${who} Example`, email })).body.id;
    const own = await appliesOnCareers(`${who} Example`, email, first, sent);
    await joinOnJob(entry, first);
    // Removed from it: back in The Book with X under Earlier résumés, and no longer an application of their own.
    assert.equal((await alex.del(`/applications/${own}`)).body.returned, true);
    let seen = await detail(alex, own);
    assert.equal(seen.application.resume_file, null);
    assert.deepEqual(seen.earlier_resumes.map((r) => r.name), [`${who} for Maple.pdf`]);
    assert.deepEqual(db('SELECT source, consent_at FROM applications WHERE id = ?', own)[0], { source: 'agency_sourced', consent_at: null });
    // Put on another of Maple's jobs, where the agency drops what it has: a byte-for-byte copy of X among them.
    assert.equal((await alex.post(`/applications/${own}/add-to-job`, { job_id: third })).status, 200);
    for (const d of drops) {
      const f = d === 'X' ? { name: `${who} again.pdf`, bytes: sent.bytes } : file(`${who} Example, the agency's own`, `${who} agency.pdf`);
      assert.equal((await attach(alex, own, f)).status, 200);
    }
    assert.equal(await resumeText(maya, own), sent.bytes.toString());
    // Replacing the copy put it under Earlier résumés beside X (a résumé is compared with the one on file only).
    const copies = drops.filter((d) => d === 'X').length;
    const kept = (await detail(alex, own)).earlier_resumes.length;
    // Removed from that one: the copy of X is not left on the profile. It is the same file as X, which is kept
    // already, so it is not kept a second time.
    assert.equal((await alex.del(`/applications/${own}`)).body.returned, true);
    seen = await detail(alex, own);
    assert.equal(seen.application.general, true);
    assert.equal(seen.application.resume_file, null);
    assert.equal(seen.earlier_resumes.length, kept);
    await agencyKeeps(own, sent.bytes.toString(), copies);
    await northlineGetsNothing(own, `${who} for Maple.pdf`, `${who} again.pdf`);
    await agencyKeeps(own, sent.bytes.toString(), copies);
  });
}

test('a copy of what they sent the client, dropped on their entry and set aside when it was joined, is not put back when they go back', async () => {
  const sent = file('Sol Example, sent to Maple Freight with the first application', 'Sol first.pdf');
  const [first, second] = [await newJob('Depot Manager'), await newJob('Yard Supervisor')];
  // They apply to two of Maple's jobs themselves, with X and with Z.
  await appliesOnCareers('Sol Example', 'sol@example.com', first, sent);
  const theirs = await appliesOnCareers('Sol Example', 'sol@example.com', second, file('Sol Example, the second version', 'Sol second.pdf'));
  // The agency drops a copy of X on their entry in The Book, then joins the entry into the second application:
  // Z is kept, and the copy is set aside as the résumé the entry brought.
  const entry = (await alex.upload('/applications', { name: 'Sol Example', email: 'sol@example.com' })).body.id;
  assert.equal((await attach(alex, entry, { name: 'Sol from our files.pdf', bytes: sent.bytes })).body.resume, 'added');
  await joinOnJob(entry, second);
  assert.equal(await resumeText(maya, theirs), 'Sol Example, the second version');
  // Removed from the second job: Z is set aside, and so is the copy, which is X.
  assert.equal((await alex.del(`/applications/${theirs}`)).body.returned, true);
  const seen = await detail(alex, theirs);
  assert.equal(seen.application.general, true);
  assert.equal(seen.application.resume_file, null);
  await agencyKeeps(theirs, sent.bytes.toString());
  await agencyKeeps(theirs, 'Sol Example, the second version');
  await northlineGetsNothing(theirs, 'Sol first.pdf', 'Sol from our files.pdf', 'Sol second.pdf');
});

test('on an application they made themselves, a copy of their résumé that is one byte different is set aside too', async () => {
  const sent = file('Ira Example, sent to Maple Freight herself', 'Ira.pdf');
  const first = await newJob('Customs Clerk');
  const entry = (await alex.upload('/applications', { name: 'Ira Example', email: 'ira@example.com' })).body.id;
  const own = await appliesOnCareers('Ira Example', 'ira@example.com', first, sent);
  await joinOnJob(entry, first);
  const resaved = Buffer.concat([sent.bytes, Buffer.from('\n')]);
  assert.equal((await attach(alex, own, { name: 'Ira resaved.pdf', bytes: resaved })).body.resume, 'replaced');
  assert.equal((await alex.del(`/applications/${own}`)).body.returned, true);
  assert.equal((await detail(alex, own)).application.resume_file, null);
  await agencyKeeps(own, resaved.toString());
  await agencyKeeps(own, sent.bytes.toString());
  await northlineGetsNothing(own, 'Ira.pdf', 'Ira resaved.pdf');
});

test('a résumé dropped on somebody the agency found, on no job or on a job, goes back to The Book with them and on to the next job', async () => {
  // In The Book, then on a Maple job, then back.
  const kai = (await alex.upload('/applications', { name: 'Kai Example', email: 'kai@example.com' })).body.id;
  assert.equal((await attach(alex, kai, file('Kai Example, from the agency', 'Kai.pdf'))).body.resume, 'added');
  const first = await newJob('Warehouse Lead');
  assert.equal((await alex.post(`/applications/${kai}/add-to-job`, { job_id: first })).status, 200);
  assert.equal((await alex.del(`/applications/${kai}`)).body.returned, true);
  assert.equal(await resumeText(alex, kai), 'Kai Example, from the agency');
  let seen = await northlineSees(kai);
  assert.equal(seen.resume, 'Kai Example, from the agency');
  assert.deepEqual(seen.listed, []);

  // Put on a Maple job from The Book with no résumé, and given one there.
  const lou = (await alex.upload('/applications', { name: 'Lou Example', email: 'lou@example.com' })).body.id;
  const second = await newJob('Shift Supervisor');
  assert.equal((await alex.post(`/applications/${lou}/add-to-job`, { job_id: second })).status, 200);
  assert.equal((await attach(alex, lou, file('Lou Example, from the agency', 'Lou.pdf'))).body.resume, 'added');
  assert.equal((await alex.del(`/applications/${lou}`)).body.returned, true);
  assert.equal(await resumeText(alex, lou), 'Lou Example, from the agency');
  seen = await northlineSees(lou);
  assert.equal(seen.resume, 'Lou Example, from the agency');
  assert.deepEqual(seen.listed, []);
});

test('when the job is deleted instead, the same holds', async () => {
  // As the first of these: what they sent Maple, then a copy of it on another Maple job, which is then deleted.
  const sent = file('Ash Example, sent to Maple Freight on its careers page', 'Ash for Maple.pdf');
  const [first, third] = [await newJob('Planner'), await newJob('Planner, nights')];
  const entry = (await alex.upload('/applications', { name: 'Ash Example', email: 'ash@example.com' })).body.id;
  const own = await appliesOnCareers('Ash Example', 'ash@example.com', first, sent);
  await joinOnJob(entry, first);
  assert.equal((await alex.del(`/applications/${own}`)).body.returned, true);
  assert.equal((await alex.post(`/applications/${own}/add-to-job`, { job_id: third })).status, 200);
  assert.equal((await attach(alex, own, { name: 'Ash again.pdf', bytes: sent.bytes })).status, 200);
  assert.equal((await alex.del(`/jobs/${third}`)).status, 200);
  assert.equal((await detail(alex, own)).application.resume_file, null);
  await agencyKeeps(own, sent.bytes.toString());
  await northlineGetsNothing(own, 'Ash for Maple.pdf', 'Ash again.pdf');

  // And as the second: the copy set aside when the entry was joined is not put back when that job is deleted.
  const copy = file('Cy Example, sent to Maple Freight with the first application', 'Cy first.pdf');
  const [one, two] = [await newJob('Dispatcher'), await newJob('Dispatcher, weekends')];
  await appliesOnCareers('Cy Example', 'cy@example.com', one, copy);
  const theirs = await appliesOnCareers('Cy Example', 'cy@example.com', two, file('Cy Example, the second version', 'Cy second.pdf'));
  const cy = (await alex.upload('/applications', { name: 'Cy Example', email: 'cy@example.com' })).body.id;
  assert.equal((await attach(alex, cy, { name: 'Cy from our files.pdf', bytes: copy.bytes })).body.resume, 'added');
  await joinOnJob(cy, two);
  assert.equal((await alex.del(`/jobs/${two}`)).status, 200);
  assert.equal((await detail(alex, theirs)).application.resume_file, null);
  await agencyKeeps(theirs, copy.bytes.toString());
  await northlineGetsNothing(theirs, 'Cy first.pdf', 'Cy from our files.pdf', 'Cy second.pdf');
});

test('somebody the agency found, on two of the client\'s jobs, keeps the agency\'s résumé when removed from one or when it is deleted', async () => {
  // Saved to The Book with the agency's résumé, put on one Maple job and then on a second, which takes a copy of it.
  for (const how of ['removed', 'deleted']) {
    const who = `Mo${how}`;
    const text = `${who} Example, the agency's résumé`;
    const entry = (await alex.upload('/applications', { name: `${who} Example`, email: `${who.toLowerCase()}@example.com`, resume: file(text, 'agency.pdf') })).body.id;
    const [first, second] = [await newJob(`Loader ${who}`), await newJob(`Loader ${who}, nights`)];
    assert.equal((await alex.post(`/applications/${entry}/add-to-job`, { job_id: first })).status, 200);
    const copy = (await alex.post(`/applications/${entry}/add-to-job`, { job_id: second })).body.id;
    assert.equal(await resumeText(maya, copy), text);
    if (how === 'removed') assert.equal((await alex.del(`/applications/${entry}`)).body.returned, true);
    else assert.equal((await alex.del(`/jobs/${first}`)).status, 200);
    assert.equal(await resumeText(alex, entry), text);
    assert.deepEqual((await detail(alex, entry)).earlier_resumes, []);
    const seen = await northlineSees(entry);
    assert.equal(seen.resume, text);
    assert.deepEqual(seen.listed, []);
  }
  // The same with the résumé dropped on them while on the first job.
  const entry = (await alex.upload('/applications', { name: 'Mo Dropped', email: 'mo.dropped@example.com' })).body.id;
  const [first, second] = [await newJob('Loader, dropped'), await newJob('Loader, dropped, nights')];
  assert.equal((await alex.post(`/applications/${entry}/add-to-job`, { job_id: first })).status, 200);
  assert.equal((await attach(alex, entry, file('Mo Dropped, from the agency', 'Mo.pdf'))).body.resume, 'added');
  assert.equal((await alex.post(`/applications/${entry}/add-to-job`, { job_id: second })).status, 200);
  assert.equal((await alex.del(`/applications/${entry}`)).body.returned, true);
  assert.equal((await northlineSees(entry)).resume, 'Mo Dropped, from the agency');
});

test('a copy of what they sent the client, on an application the agency made, counts while their own application is there', async () => {
  // Nell is in The Book with X. She applies to Maple with X herself; the agency adds that application to a second
  // Maple job (a copy of X goes). Her entry is put on a third Maple job, joined to that record, and removed.
  for (const how of ['on file', 'replaced']) {
    const who = how === 'on file' ? 'Nell' : 'Nia';
    const email = `${who.toLowerCase()}@example.com`;
    const sent = file(`${who} Example, sent to Maple Freight herself`, `${who}.pdf`);
    const entry = (await alex.upload('/applications', { name: `${who} Example`, email, resume: { name: `${who} from our files.pdf`, bytes: sent.bytes } })).body.id;
    const [first, second, third] = [await newJob(`Clerk, ${who}`), await newJob(`Clerk, ${who}, nights`), await newJob(`Clerk, ${who}, weekends`)];
    const own = await appliesOnCareers(`${who} Example`, email, first, sent);
    const copy = (await alex.post(`/applications/${own}/add-to-job`, { job_id: second })).body.id;
    // The second time, the agency replaces X on her own application, so X is only under its Earlier résumés.
    if (how === 'replaced') assert.equal((await attach(alex, own, file(`${who} Example, tidied by the agency`, `${who} tidied.pdf`))).body.resume, 'replaced');
    const refused = await alex.post(`/applications/${entry}/add-to-job`, { job_id: third });
    assert.equal(refused.body.code, 'duplicate_in_client', JSON.stringify(refused.body));
    assert.equal((await alex.post(`/applications/${entry}/add-to-job`, { job_id: third, into: refused.body.matches[0].candidate_id })).status, 200);
    assert.equal(await resumeText(maya, copy), sent.bytes.toString());
    assert.equal((await alex.del(`/applications/${entry}`)).body.returned, true);
    assert.equal(await resumeText(alex, entry), 404);
    await agencyKeeps(entry, sent.bytes.toString());
    await northlineGetsNothing(entry, `${who}.pdf`, `${who} from our files.pdf`);
  }
});

test('somebody the agency found, on one job that is deleted, keeps the résumé dropped on them', async () => {
  const entry = (await alex.upload('/applications', { name: 'Vi Example', email: 'vi@example.com' })).body.id;
  const only = await newJob('Picker, Vi');
  assert.equal((await alex.post(`/applications/${entry}/add-to-job`, { job_id: only })).status, 200);
  assert.equal((await attach(alex, entry, file('Vi Example, from the agency', 'Vi.pdf'))).body.resume, 'added');
  assert.equal((await alex.del(`/jobs/${only}`)).status, 200);
  assert.equal(await resumeText(alex, entry), 'Vi Example, from the agency');
  const seen = await northlineSees(entry);
  assert.equal(seen.resume, 'Vi Example, from the agency');
  assert.deepEqual(seen.listed, []);
});

test('a second entry in The Book holding a copy of what they sent the client: they are folded into it, and the copy is set aside', async () => {
  for (const how of ['saved with it', 'dropped on it']) {
    const who = how === 'saved with it' ? 'Tam' : 'Uma';
    const email = `${who.toLowerCase()}@example.com`;
    const sent = file(`${who} Example, sent to Maple Freight herself`, `${who} for Maple.pdf`);
    const first = await newJob(`Driver, ${who}`);
    const own = await appliesOnCareers(`${who} Example`, email, first, sent);
    const entry = (await alex.upload('/applications', { name: `${who} Example`, email })).body.id;
    await joinOnJob(entry, first);
    // While they are on Maple's job, the agency saves them to The Book again, with a copy of what they sent.
    const fields = { name: `${who} Example`, email };
    if (how === 'saved with it') fields.resume = { name: 'from our files.pdf', bytes: sent.bytes };
    const twin = (await alex.upload('/applications', fields)).body.id;
    if (how === 'dropped on it') assert.equal((await attach(alex, twin, { name: 'from our files.pdf', bytes: sent.bytes })).body.resume, 'added');
    const back = (await alex.del(`/applications/${own}`)).body;
    assert.equal(back.returned, true);
    const kept = back.id;
    assert.equal(await resumeText(alex, kept), 404);
    await agencyKeeps(kept, sent.bytes.toString());
    await northlineGetsNothing(kept, `${who} for Maple.pdf`, 'from our files.pdf');
  }
});

test('the agency\'s résumé is set aside when they also sent that very file to the client themselves, after they were put on its job', async () => {
  const text = 'Wren Example, the agency\'s and the one she sent';
  const entry = (await alex.upload('/applications', { name: 'Wren Example', email: 'wren@example.com', resume: file(text, 'Wren.pdf') })).body.id;
  const [first, second] = [await newJob('Packer, Wren'), await newJob('Packer, Wren, nights')];
  assert.equal((await alex.post(`/applications/${entry}/add-to-job`, { job_id: first })).status, 200);
  // She applies to another of Maple's jobs herself with the same file, and the agency then replaces it there.
  const own = await appliesOnCareers('Wren Example', 'wren@example.com', second, file(text, 'Wren for Maple.pdf'));
  assert.equal(db('SELECT candidate_id FROM applications WHERE id = ?', own)[0].candidate_id, db('SELECT candidate_id FROM applications WHERE id = ?', entry)[0].candidate_id);
  assert.equal((await attach(alex, own, file('Wren Example, tidied by the agency', 'Wren tidied.pdf'))).body.resume, 'replaced');
  assert.equal((await alex.del(`/applications/${entry}`)).body.returned, true);
  assert.equal(await resumeText(alex, entry), 404);
  await agencyKeeps(entry, text);
  await northlineGetsNothing(entry, 'Wren.pdf', 'Wren for Maple.pdf');
});

test('the résumé the entry brought is not put back when it is a copy of what they sent the client on another of its jobs', async () => {
  const sent = file('Zed Example, sent to Maple Freight with the first application', 'Zed first.pdf');
  const [one, two, three] = [await newJob('Porter, Zed'), await newJob('Porter, Zed, nights'), await newJob('Porter, Zed, weekends')];
  // They apply to two of Maple's jobs with X and Z. The agency adds the first application to a third job (a copy of
  // X goes with it), and then deletes the first application outright: what they sent was recorded, so it still counts.
  const first = await appliesOnCareers('Zed Example', 'zed@example.com', one, sent);
  const theirs = await appliesOnCareers('Zed Example', 'zed@example.com', two, file('Zed Example, the second version', 'Zed second.pdf'));
  const copy = (await alex.post(`/applications/${first}/add-to-job`, { job_id: three })).body.id;
  assert.equal(await resumeText(maya, copy), sent.bytes.toString());
  assert.equal((await alex.del(`/applications/${first}`)).body.returned, undefined);
  // A copy of X dropped on their entry in The Book is set aside when the entry is joined to the second application.
  const entry = (await alex.upload('/applications', { name: 'Zed Example', email: 'zed@example.com' })).body.id;
  assert.equal((await attach(alex, entry, { name: 'Zed from our files.pdf', bytes: sent.bytes })).body.resume, 'added');
  await joinOnJob(entry, two);
  assert.equal((await alex.del(`/applications/${theirs}`)).body.returned, true);
  assert.equal(await resumeText(alex, theirs), 404);
  await agencyKeeps(theirs, sent.bytes.toString());
  await northlineGetsNothing(theirs, 'Zed first.pdf', 'Zed from our files.pdf', 'Zed second.pdf');
});

// ---------- the agency's own résumé on somebody who was on several of a client's jobs ----------
// Nobody sent a client the agency's résumé Z, so nothing recorded matches it, however often the person went back and
// forth and wherever copies of it lie: it goes on to the next client.

/** Put their entry on a job, joined to the record the client has of them when there is one; answers the id there. */
async function putOn(entry, jobId) {
  const tried = await alex.post(`/applications/${entry}/add-to-job`, { job_id: jobId });
  if (tried.status === 200) return tried.body.id ?? entry;
  const into = tried.body.join?.candidate_id ?? tried.body.matches?.[0]?.candidate_id;
  assert.ok(into, JSON.stringify(tried.body));
  const joined = await alex.post(`/applications/${entry}/add-to-job`, { job_id: jobId, into });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  return joined.body.id ?? entry;
}
const removeFrom = async (id) => { const r = await alex.del(`/applications/${id}`); assert.equal(r.status, 200); assert.equal(r.body.returned, true); return r.body.id ?? id; };
/** The agency's résumé is on their entry, nothing was set aside, and Northline's hiring manager downloads it. */
async function goesOnWith(id, text) {
  assert.equal(await resumeText(alex, id), text);
  assert.deepEqual((await detail(alex, id)).earlier_resumes, []);
  const seen = await northlineSees(id);
  assert.equal(seen.resume, text);
  assert.deepEqual(seen.listed, []);
  assert.ok(!seen.payload.includes('Maple'), 'nor the client');
  assert.equal(await resumeText(alex, seen.id), text); // and the agency still has it
}
const agencyEntry = async (who, text) => (await alex.upload('/applications', { name: `${who} Example`, email: `${who.toLowerCase()}@example.com`, resume: file(text, 'agency.pdf') })).body.id;

for (const [label, between] of [['put back on the first job', 'first'], ['put on a third job instead', 'third'], ['on another client\'s job in between, then a third', 'other']]) {
  test(`on two of the client's jobs, removed from one, ${label} and removed: the agency's résumé goes on to the next client`, async () => {
    const who = `Pip${between}`;
    const text = `${who} Example, the agency's résumé`;
    const entry = await agencyEntry(who, text);
    const [first, second, third] = [await newJob(`Sorter ${who}`), await newJob(`Sorter ${who}, nights`), await newJob(`Sorter ${who}, weekends`)];
    await putOn(entry, first);
    assert.equal((await alex.post(`/applications/${entry}/add-to-job`, { job_id: second })).status, 200); // a copy of Z goes
    let back = await removeFrom(entry);
    if (between === 'other') {
      const elsewhere = (await alex.post('/jobs', { client_id: client.northline, title: `Receptionist ${who}`, status: 'open' })).body.id;
      back = await removeFrom(await putOn(back, elsewhere));
    }
    back = await removeFrom(await putOn(back, between === 'first' ? first : third));
    await goesOnWith(back, text);
  });
}

test('on two of the client\'s jobs, the first deleted, then on a third and removed: the agency\'s résumé goes on to the next client', async () => {
  const text = 'Pia Example, the agency\'s résumé';
  const entry = await agencyEntry('Pia', text);
  const [first, second, third] = [await newJob('Sorter Pia'), await newJob('Sorter Pia, nights'), await newJob('Sorter Pia, weekends')];
  await putOn(entry, first);
  assert.equal((await alex.post(`/applications/${entry}/add-to-job`, { job_id: second })).status, 200);
  assert.equal((await alex.del(`/jobs/${first}`)).status, 200);
  await goesOnWith(await removeFrom(await putOn(entry, third)), text);
});

test('added straight to a client\'s job with the agency\'s résumé, saved to The Book with it later, joined on another job and removed: it goes on', async () => {
  const text = 'Pax Example, the agency\'s résumé';
  const [first, second] = [await newJob('Sorter Pax'), await newJob('Sorter Pax, nights')];
  assert.equal((await alex.upload('/applications', { job_id: second, name: 'Pax Example', email: 'pax@example.com', resume: file(text, 'agency.pdf') })).status, 200);
  const entry = await agencyEntry('Pax', text);
  await goesOnWith(await removeFrom(await putOn(entry, first)), text);
});

// ---------- what is recorded, and what it decides ----------
// Each résumé somebody sends a client themselves leaves a fingerprint (its SHA-256) with that client's name in
// sent_resumes. Nothing else is inferred from what lies around on the person's applications.

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const fingerprints = (bytes) => db('SELECT client_id FROM sent_resumes WHERE hash = ? ORDER BY id', sha256(bytes)).map((r) => r.client_id);
/** The agency's résumé is on their entry, and Northline's hiring manager downloads it; the agency keeps `also` too. */
async function stillGoesOn(id, text, ...also) {
  assert.equal(await resumeText(alex, id), text);
  for (const other of also) await agencyKeeps(id, other);
  const seen = await northlineSees(id);
  assert.equal(seen.resume, text);
  assert.deepEqual(seen.listed, []);
  assert.ok(!seen.payload.includes('Maple'), 'nor the client');
  for (const other of also) await agencyKeeps(seen.id, other);
}

test('a résumé dropped on the copy on a second job, the entry later joined into that copy: the agency\'s résumé goes back on the profile', async () => {
  for (const how of ['removed', 'deleted']) {
    const who = `Quill${how}`;
    const Z = `${who} Example, the agency's résumé`;
    const Y = `${who} Example, a newer one from the agency`;
    const entry = await agencyEntry(who, Z);
    const [first, second] = [await newJob(`Checker ${who}`), await newJob(`Checker ${who}, nights`)];
    await putOn(entry, first);
    const copy = (await alex.post(`/applications/${entry}/add-to-job`, { job_id: second })).body.id; // a copy of Z goes
    assert.equal((await attach(alex, copy, file(Y, 'newer.pdf'))).body.resume, 'replaced');       // the copy of Z is kept there
    await removeFrom(entry);
    assert.equal(await putOn(entry, second), copy); // joined into the copy, which keeps Y: Z is set aside as the one the entry brought
    let back;
    if (how === 'removed') back = await removeFrom(copy);
    else {
      assert.equal((await alex.del(`/jobs/${second}`)).status, 200);
      back = copy;
    }
    // The Z the entry brought is the same file as the copy of Z kept on that application, which nobody sent Maple.
    assert.equal(fingerprints(Buffer.from(Z)).length, 0);
    await stillGoesOn(back, Z, Y);
  }
});

test('the agency\'s résumé stays when it was also brought onto the application the person made themselves', async () => {
  const X = 'Mara Example, sent to Maple Freight herself';
  const Z = 'Mara Example, the agency\'s résumé';
  const [first, second] = [await newJob('Coordinator, Mara'), await newJob('Coordinator, Mara, nights')];
  const own = await appliesOnCareers('Mara Example', 'mara@example.com', first, file(X, 'Mara for Maple.pdf'));
  const entry = await agencyEntry('Mara', Z);
  await joinOnJob(entry, first); // Z is set aside on her own application as the résumé the entry brought
  assert.equal(await resumeText(maya, own), X);
  const again = await agencyEntry('Mara', Z); // saved to The Book again, with the same Z
  const on = await putOn(again, second);
  await stillGoesOn(await removeFrom(on), Z);
});

test('the agency drops Z, then Y, then Z again on somebody it found: Z stays on the profile when they go back', async () => {
  const Z = 'Xan Example, the agency\'s résumé';
  const Y = 'Xan Example, another from the agency';
  const entry = (await alex.upload('/applications', { name: 'Xan Example', email: 'xan@example.com' })).body.id;
  await putOn(entry, await newJob('Sorter, Xan'));
  for (const text of [Z, Y, Z]) assert.equal((await attach(alex, entry, file(text, 'xan.pdf'))).status, 200);
  await removeFrom(entry);
  await stillGoesOn(entry, Z, Y);
});

test('their own application deleted outright, a copy of its résumé on another of the client\'s jobs: when that one goes back, the copy is held back', async () => {
  const X = 'Odo Example, sent to Maple Freight himself';
  const [first, second] = [await newJob('Driver, Odo'), await newJob('Driver, Odo, nights')];
  const own = await appliesOnCareers('Odo Example', 'odo@example.com', first, file(X, 'Odo for Maple.pdf'));
  const copy = (await alex.post(`/applications/${own}/add-to-job`, { job_id: second })).body.id; // made by the agency
  assert.equal((await alex.del(`/applications/${own}`)).status, 200);
  assert.equal(db('SELECT COUNT(*) AS n FROM applications WHERE id = ?', own)[0].n, 0);
  // Their entry in The Book is joined into the copy, and removed again.
  const entry = (await alex.upload('/applications', { name: 'Odo Example', email: 'odo@example.com' })).body.id;
  await joinOnJob(entry, second);
  await removeFrom(copy);
  assert.equal(await resumeText(alex, copy), 404);
  await agencyKeeps(copy, X);
  await northlineGetsNothing(copy, 'Odo for Maple.pdf');
  await agencyKeeps(copy, X);
});

test('a second record of theirs at the client that nothing ties to the first, made by the agency with a copy of what they sent: it is held back', async () => {
  const X = 'Pell Example, sent to Maple Freight herself';
  await appliesOnCareers('Pell Example', 'pell@example.com', await newJob('Analyst, Pell'), file(X, 'Pell for Maple.pdf'));
  // Saved to The Book under another address and no link, with the same file: Maple gets a second record of her.
  const entry = (await alex.upload('/applications', { name: 'Pell Example', email: 'pell.other@example.com', resume: file(X, 'from our files.pdf') })).body.id;
  assert.equal(await putOn(entry, await newJob('Analyst, Pell, nights')), entry);
  await removeFrom(entry);
  assert.equal(await resumeText(alex, entry), 404);
  await agencyKeeps(entry, X);
  await northlineGetsNothing(entry, 'Pell for Maple.pdf', 'from our files.pdf');
});

test('what they sent the agency\'s post is recorded and held back the same way', async () => {
  const X = 'Rue Example, sent through the agency\'s post';
  const jobId = await newJob('Planner, Rue');
  const saved = await alex.putJson(`/jobs/${jobId}/board`, { enabled: true, title: 'Transport Planner', location: 'Toronto', description: 'A planning role with a growing transport business.', show_salary: false, hide_from_careers: false });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.state.live, true, JSON.stringify(saved.body.state));
  const form = new FormData();
  for (const [k, v] of Object.entries({ name: 'Rue Example', email: 'rue@example.com', consent: 'yes' })) form.append(k, v);
  form.append('resume', new Blob([Buffer.from(X)]), 'Rue.pdf');
  visitor += 1;
  const sent = await fetch(`${base}/api/public/board/posts/${saved.body.post.token}/apply`, { method: 'POST', body: form, headers: { 'X-Forwarded-For': `192.0.2.${visitor}` } });
  assert.equal(sent.status, 200);
  assert.deepEqual(fingerprints(Buffer.from(X)), [client.maple]);
  // A second record of her at Maple, made by the agency with a copy of that file, goes back to The Book without it.
  const entry = (await alex.upload('/applications', { name: 'Rue Example', email: 'rue.other@example.com', resume: file(X, 'from our files.pdf') })).body.id;
  await putOn(entry, await newJob('Planner, Rue, nights'));
  await removeFrom(entry);
  assert.equal(await resumeText(alex, entry), 404);
  await agencyKeeps(entry, X);
  await northlineGetsNothing(entry, 'Rue.pdf', 'from our files.pdf');
});

test('what they sent one client is not held back from an entry that was never on that client\'s jobs', async () => {
  // Sam sent X to Maple himself. The agency holds the same X on his entry in The Book, which goes on a job at
  // Northline and is removed: X stays on his profile, and the next client is given it, as on the live release.
  const X = 'Sam Example, sent to Maple and held by the agency';
  await appliesOnCareers('Sam Example', 'sam@example.com', await newJob('Clerk, Sam'), file(X, 'Sam for Maple.pdf'));
  assert.deepEqual(fingerprints(Buffer.from(X)), [client.maple]);
  const entry = (await alex.upload('/applications', { name: 'Sam Example', email: 'sam@example.com', resume: file(X, 'Sam.pdf') })).body.id;
  const northline = (await alex.post('/jobs', { client_id: client.northline, title: 'Practice Clerk, Sam', status: 'open' })).body.id;
  await putOn(entry, northline);
  await removeFrom(entry);
  assert.equal(await resumeText(alex, entry), X);
  assert.deepEqual((await detail(alex, entry)).earlier_resumes, []);
  const seen = await northlineSees(entry, CEDAR());
  assert.equal(seen.resume, X);
  assert.deepEqual(seen.listed, []);
});

test('what they sent one client, set aside when they went back, then dropped again on another client\'s job, is held back', async () => {
  // Tia applied to Northline herself with X; her entry was joined into that application and removed: X is under
  // Earlier résumés. Put on a Maple job, the agency drops a copy of X there. Removed from Maple, the copy is held back.
  const X = 'Tia Example, sent to Northline Dental herself';
  const own = await appliesOnCareers('Tia Example', 'tia@example.com', job.hygienist, file(X, 'Tia for Northline.pdf'), client.northline);
  const entry = (await alex.upload('/applications', { name: 'Tia Example', email: 'tia@example.com' })).body.id;
  await joinOnJob(entry, job.hygienist);
  await removeFrom(own);
  await agencyKeeps(own, X);
  await putOn(own, await newJob('Receptionist, Tia'));
  assert.equal((await attach(alex, own, { name: 'Tia again.pdf', bytes: Buffer.from(X) })).body.resume, 'added');
  assert.equal(await resumeText(maya, own), X);
  await removeFrom(own);
  assert.equal(await resumeText(alex, own), 404);
  await agencyKeeps(own, X);
  await northlineGetsNothing(own, CEDAR(), 'Tia for Northline.pdf', 'Tia again.pdf');
  await agencyKeeps(own, X);
});

test('erasing the person removes the fingerprints of their files; a deleted client leaves its rows with no client', async () => {
  const X = 'Uri Example, sent to Maple himself';
  const own = await appliesOnCareers('Uri Example', 'uri@example.com', await newJob('Packer, Uri'), file(X, 'Uri.pdf'));
  assert.deepEqual(fingerprints(Buffer.from(X)), [client.maple]);
  // Removing the application leaves the fingerprint: he did send it.
  const copy = (await alex.post(`/applications/${own}/add-to-job`, { job_id: await newJob('Packer, Uri, nights') })).body.id;
  assert.equal((await alex.del(`/applications/${own}`)).status, 200);
  assert.deepEqual(fingerprints(Buffer.from(X)), [client.maple]);
  const { candidate } = await detail(alex, copy);
  assert.equal((await alex.del(`/candidates/${candidate.id}`)).status, 200);
  assert.deepEqual(fingerprints(Buffer.from(X)), []);

  // A client deleted from the database (no route does it; its rows cascade): the fingerprint stays, with no client.
  const elm = (await alex.post('/clients', { name: 'Elm Removals' })).body.id;
  const elmJob = (await alex.post('/jobs', { client_id: elm, title: 'Mover', status: 'open' })).body.id;
  const W = 'Vic Example, sent to Elm Removals';
  await appliesOnCareers('Vic Example', 'vic@example.com', elmJob, file(W, 'Vic.pdf'), elm);
  assert.deepEqual(fingerprints(Buffer.from(W)), [elm]);
  const database = new DatabaseSync(path.join(dataDir, 'app.db'));
  try {
    database.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    database.prepare('DELETE FROM clients WHERE id = ?').run(elm);
  } finally { database.close(); }
  assert.deepEqual(fingerprints(Buffer.from(W)), [null]);
});

test('a database from before this version: what was on file is recorded once at the first start, and the rules hold for it', async () => {
  // Stop the server and make the database look as the live release left it: no sent_resumes, no setting, and rows
  // written straight into applications and earlier_resumes.
  await server.stop();
  const uploadsDir = path.join(dataDir, 'uploads');
  const G = 'Gus Example, sent to Maple Freight before this version';
  const H = 'Hal Example, set aside when he went back to The Book before this version';
  const U = 'Una Example, from the agency\'s files, saved again over a newer one before this version';
  const ids = {};
  const database = new DatabaseSync(path.join(dataDir, 'app.db'));
  try {
    database.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    database.exec(`DROP TABLE sent_resumes; DELETE FROM settings WHERE key = 'sent_resumes_backfilled'`);
    const run = (sql, ...p) => Number(database.prepare(sql).run(...p).lastInsertRowid);
    const t = new Date().toISOString();
    const put = (name, text) => { fs.writeFileSync(path.join(uploadsDir, name), text); return name; };
    const stage = database.prepare(`SELECT id FROM stages WHERE job_id = ? AND kind = 'applied'`).get(job.payroll).id;
    const alexId = database.prepare('SELECT id FROM users WHERE email = ?').get('alex@agency.example').id;
    // Gus applied on Maple's careers page with G. The agency holds a copy of G on an entry under another address.
    const gus = run('INSERT INTO candidates (client_id, name, email, created_at) VALUES (?, ?, ?, ?)', client.maple, 'Gus Example', 'gus@example.com', t);
    run(`INSERT INTO applications (candidate_id, job_id, stage_id, source, resume_file, resume_name, consent_at, applied_at, stage_entered_at, updated_at)
         VALUES (?, ?, ?, 'careers_page', ?, 'Gus.pdf', ?, ?, ?, ?)`, gus, job.payroll, stage, put('0000aaaa-gus-sent.pdf', G), t, t, t, t);
    const gusBook = run('INSERT INTO candidates (client_id, name, email, created_at) VALUES (NULL, ?, ?, ?)', 'Gus Example', 'gus.other@example.com', t);
    ids.gus = run(`INSERT INTO applications (candidate_id, job_id, stage_id, source, resume_file, resume_name, applied_at, stage_entered_at, updated_at)
         VALUES (?, NULL, NULL, 'agency_sourced', ?, 'from our files.pdf', ?, ?, ?)`, gusBook, put('0000aaaa-gus-book.pdf', G), t, t, t);
    // Hal went back to The Book from a client's job, with H set aside under Earlier résumés.
    const hal = run('INSERT INTO candidates (client_id, name, email, created_at) VALUES (NULL, ?, ?, ?)', 'Hal Example', 'hal@example.com', t);
    ids.hal = run(`INSERT INTO applications (candidate_id, job_id, stage_id, source, applied_at, stage_entered_at, updated_at) VALUES (?, NULL, NULL, 'agency_sourced', ?, ?, ?)`, hal, t, t, t);
    run('INSERT INTO earlier_resumes (application_id, resume_file, resume_name, kept_at, kept_by) VALUES (?, ?, ?, ?, ?)', ids.hal, put('0000aaaa-hal.pdf', H), 'Hal.pdf', t, alexId);
    // It was an application he had made himself: the return left the agency's note on it, at the same moment.
    run('INSERT INTO notes (application_id, user_id, body, private, created_at) VALUES (?, ?, ?, 1, ?)', ids.hal, alexId,
      'From their own application for Payroll Clerk at Maple Freight, where they agreed to their data being processed on 2026-01-05. Kept for the agency only.', t);
    // Una is somebody the agency found. It saved her with U, then with a newer file, then with U again: U is on her
    // entry and also among its earlier résumés. Nothing here was sent to a client, so none of it is recorded.
    const una = run('INSERT INTO candidates (client_id, name, email, created_at) VALUES (NULL, ?, ?, ?)', 'Una Example', 'una@example.com', t);
    ids.una = run(`INSERT INTO applications (candidate_id, job_id, stage_id, source, resume_file, resume_name, applied_at, stage_entered_at, updated_at)
         VALUES (?, NULL, NULL, 'agency_sourced', ?, 'Una.pdf', ?, ?, ?)`, una, put('0000aaaa-una-now.pdf', U), t, t, t);
    run('INSERT INTO earlier_resumes (application_id, resume_file, resume_name, kept_at, kept_by) VALUES (?, ?, ?, ?, ?)', ids.una, put('0000aaaa-una-first.pdf', U), 'Una.pdf', t, alexId);
    run('INSERT INTO earlier_resumes (application_id, resume_file, resume_name, kept_at, kept_by) VALUES (?, ?, ?, ?, ?)', ids.una, put('0000aaaa-una-newer.pdf', `${U}, the newer one`), 'Una newer.pdf', t, alexId);
    // An application of somebody's own whose file is no longer on disk is passed over.
    const gone = run('INSERT INTO candidates (client_id, name, email, created_at) VALUES (?, ?, ?, ?)', client.maple, 'Ivo Example', 'ivo@example.com', t);
    run(`INSERT INTO applications (candidate_id, job_id, stage_id, source, resume_file, resume_name, consent_at, applied_at, stage_entered_at, updated_at)
         VALUES (?, ?, ?, 'careers_page', 'missing-file.pdf', 'Ivo.pdf', ?, ?, ?, ?)`, gone, job.payroll, stage, t, t, t, t);
  } finally { database.close(); }

  server = await startServer({ port: PORT, dataDir, env: { TRUST_PROXY: '1' } });
  assert.deepEqual(fingerprints(Buffer.from(G)), [client.maple]);
  assert.deepEqual(fingerprints(Buffer.from(H)), [null]);
  assert.equal(db(`SELECT COUNT(*) AS n FROM settings WHERE key = 'sent_resumes_backfilled'`)[0].n, 1);
  const own = db(`SELECT COUNT(*) AS n FROM applications WHERE job_id IS NOT NULL AND resume_file IS NOT NULL AND resume_file != 'missing-file.pdf'
    AND (consent_at IS NOT NULL OR source IN ('careers_page', 'our_website'))`)[0].n;
  const recorded = db('SELECT COUNT(*) AS n FROM sent_resumes')[0].n;
  // Earlier in this file people's own applications went back to The Book too: each left its note and its file set aside.
  const theirs = db(`SELECT COUNT(*) AS n FROM earlier_resumes r WHERE r.kept_by IS NOT NULL AND EXISTS (SELECT 1 FROM notes n
    WHERE n.application_id = r.application_id AND n.created_at = r.kept_at AND n.body LIKE 'From their own application for %')`)[0].n;
  assert.ok(theirs < db('SELECT COUNT(*) AS n FROM earlier_resumes WHERE kept_by IS NOT NULL')[0].n, 'not every earlier résumé is one they sent');
  assert.equal(recorded, own + theirs, 'one row for each file on people\'s own applications that is on disk, and one for each set aside when such an application went back');
  assert.deepEqual(fingerprints(Buffer.from(U)), [], 'what the agency saved again over a newer file is not what anybody sent a client');

  // (1) Gus's entry, put on a Maple job as a second record of him and removed: the copy of G is held back.
  await putOn(ids.gus, await newJob('Loader, Gus'));
  await removeFrom(ids.gus);
  assert.equal(await resumeText(alex, ids.gus), 404);
  await agencyKeeps(ids.gus, G);
  await northlineGetsNothing(ids.gus, 'Gus.pdf', 'from our files.pdf');
  // (2) Hal, put on a Maple job where a copy of H is dropped, and removed: the copy is held back.
  await putOn(ids.hal, await newJob('Loader, Hal'));
  assert.equal((await attach(alex, ids.hal, file(H, 'Hal again.pdf'))).body.resume, 'added');
  await removeFrom(ids.hal);
  assert.equal(await resumeText(alex, ids.hal), 404);
  await agencyKeeps(ids.hal, H);
  await northlineGetsNothing(ids.hal, 'Hal.pdf', 'Hal again.pdf');

  // Una, put on a Maple job and removed: the agency's résumé stays on her profile, and the next client's team gets it.
  await putOn(ids.una, await newJob('Loader, Una'));
  await removeFrom(ids.una);
  await stillGoesOn(ids.una, U);

  // A second start records nothing more.
  const before = db('SELECT id, client_id, hash, sent_at FROM sent_resumes ORDER BY id');
  await server.stop();
  server = await startServer({ port: PORT, dataDir, env: { TRUST_PROXY: '1' } });
  assert.deepEqual(db('SELECT id, client_id, hash, sent_at FROM sent_resumes ORDER BY id'), before);
});
