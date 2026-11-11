// A résumé dropped on a candidate's profile, end to end against the real API on a throwaway data folder. Run with
// `npm test`. The dialog that reads the file in the browser is not driven here; these tests send what it sends: the
// file, and the details the recruiter ticked (PUT /applications/:id/resume).
//
// Every résumé, name, address and number here is made up.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer, session, tempDir, until, PORTS } from './oracle-helpers.mjs';

const PORT = PORTS.resumeDrop; // the one kept for this file (see PORT_PLAN in oracle-helpers.mjs)
const file = (text, name = 'resume.txt') => ({ name, bytes: Buffer.from(text) });

let server, dataDir, base;
let alex, maya, noor;              // the owner, and a hiring manager at each of the two clients
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
  server = await startServer({ port: PORT, dataDir });
  base = server.base;
  alex = session(base);
  assert.equal((await alex.post('/setup', { agencyName: 'Harbour Talent', name: 'Alex Morgan', email: 'alex@agency.example', password: 'demo1234' })).status, 200);
  client.maple = (await alex.post('/clients', { name: 'Maple Freight' })).body.id;
  client.northline = (await alex.post('/clients', { name: 'Northline Dental' })).body.id;
  const join = async (email, clientId, name) => {
    const { token } = (await alex.post('/invites', { role: 'client', email, client_id: clientId })).body;
    const person = session(base);
    assert.equal((await person.post(`/invites/${token}/accept`, { name, password: 'demo1234' })).status, 200);
    return person;
  };
  maya = await join('maya@maple.example', client.maple, 'Maya Example');
  noor = await join('noor@northline.example', client.northline, 'Noor Example');
  const newJob = async (clientId, title) => (await alex.post('/jobs', { client_id: clientId, title, status: 'open' })).body.id;
  job.accountant = await newJob(client.maple, 'Senior Accountant');
  job.payroll = await newJob(client.maple, 'Payroll Specialist');
  job.hygienist = await newJob(client.northline, 'Hygienist');
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

  // The agency drops a newer résumé on that application: it is the agency's, though the application is hers.
  assert.equal((await attach(alex, own.id, file('Ana Example, the agency\'s newest', 'Ana newest.pdf'), { phone: '416 555 0145' })).body.resume, 'replaced');
  theirs = await detail(maya, own.id);
  assert.equal(theirs.application.resume_name, 'Ana newest.pdf');
  assert.equal(theirs.candidate.phone, '416 555 0145');
  assert.deepEqual(theirs.earlier_resumes, []);

  // Removed from that job: the agency's newest goes back to The Book with her; what she sent Maple Freight is kept
  // under Earlier résumés, and so is the one the entry had before.
  assert.equal((await alex.del(`/applications/${own.id}`)).body.returned, true);
  seen = await detail(alex, own.id);
  assert.equal(seen.application.general, true);
  assert.equal(await resumeOf(alex, own.id), 'Ana Example, the agency\'s newest');
  assert.ok(seen.earlier_resumes.some((r) => r.name === 'Ana for Maple.pdf'));
  assert.ok(seen.earlier_resumes.some((r) => r.name === 'Ana on the job.docx'));

  // Put on another client's job: that hiring team sees the agency's résumé and nothing of Maple Freight's.
  assert.equal((await alex.post(`/applications/${own.id}/add-to-job`, { job_id: job.hygienist })).status, 200);
  const northline = await detail(noor, own.id);
  assert.equal(northline.application.resume_name, 'Ana newest.pdf');
  assert.deepEqual(northline.earlier_resumes, []);
  assert.equal(await resumeOf(noor, own.id), 'Ana Example, the agency\'s newest');
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
  assert.equal(db('SELECT COUNT(*) AS n FROM agency_resumes WHERE application_id = ?', id)[0].n, 2);
  assert.equal((await alex.del(`/candidates/${candidate.id}`)).status, 200);
  assert.equal(db('SELECT COUNT(*) AS n FROM agency_resumes WHERE application_id = ?', id)[0].n, 0);
  await until(async () => uploads(), (now) => now.length === before.length - 2, 5000);
});
