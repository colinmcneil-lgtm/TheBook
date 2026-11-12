// A job's description on its Brief, end to end against the real API on a throwaway data folder: the PDF made from
// the advert saved on the job (with or without the client's name), the check run before the one without, and the
// client's own file kept with the job. Run with `npm test`. The PDFs are read back with pdfjs-dist, as the app reads
// the PDFs people drop on it. The card on the Brief and the box the file is dropped in are not driven here: these
// tests send what they send.
//
// Every person, company, address and figure here is made up.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer, session, tempDir, until, PORTS } from './oracle-helpers.mjs';
import * as appWords from '../src/lib.js';
import * as serverWords from '../server/jobwords.js';

const PORT = PORTS.jobDescription; // the one kept for this file (see PORT_PLAN in oracle-helpers.mjs)

let server, dataDir, base;
let alex, priya, marcus, maya; // the admin, two recruiters, and somebody on Lumen Health's hiring team
let lumen, north;              // the two clients
const job = {};

const uploads = () => fs.readdirSync(path.join(dataDir, 'uploads')).sort();
function db(query, ...params) {
  const database = new DatabaseSync(path.join(dataDir, 'app.db'), { readOnly: true });
  try { return database.prepare(query).all(...params).map((row) => ({ ...row })); } finally { database.close(); }
}
function write(sql, ...params) {
  const database = new DatabaseSync(path.join(dataDir, 'app.db'));
  try { return database.prepare(sql).run(...params); } finally { database.close(); }
}
/**
 * The files in the uploads folder once it has stopped changing. A file that is replaced or removed goes a moment after
 * the answer, so a list taken straight after one would still have it.
 */
async function steady() {
  for (let last = uploads(); ;) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    const now = uploads();
    if (JSON.stringify(now) === JSON.stringify(last)) return now;
    last = now;
  }
}
const leftAsItWas = (before) => until(async () => uploads(), (now) => JSON.stringify(now) === JSON.stringify(before), 5000);
const join = async (role, name, email, extra = {}) => {
  const { token } = (await alex.post('/invites', { role, email, ...extra })).body;
  const person = session(base);
  assert.equal((await person.post(`/invites/${token}/accept`, { name, password: 'demo1234' })).status, 200);
  return person;
};
const newJob = async (who, fields) => {
  const made = await who.post('/jobs', { status: 'open', work_mode: 'hybrid', employment_type: 'full_time', ...fields });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  return made.body.id;
};
/** Send a file as the card and the job form do: PUT, with `replace` when the person agreed to replace the one there. */
async function keep(who, jobId, file, replace = false) {
  const form = new FormData();
  if (replace) form.append('replace', '1');
  if (file) form.append('file', new Blob([file.bytes]), file.name);
  const res = await fetch(`${base}/api/jobs/${jobId}/job-description/file`, { method: 'PUT', body: form, headers: who ? { Cookie: who.cookie() } : {} });
  return { status: res.status, body: await res.json() };
}
const pdfOf = (who, jobId, query) => who.get(`/jobs/${jobId}/job-description/pdf?${query}`);

/** A PDF's text, page by page and line by line, and what it says about itself. */
async function readPdf(bytes) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  const doc = await task.promise;
  try {
    const pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      let text = '';
      for (const item of (await (await doc.getPage(n)).getTextContent()).items) { text += item.str; if (item.hasEOL) text += '\n'; }
      pages.push(text);
    }
    const { info } = await doc.getMetadata();
    return { pages, text: pages.join('\n'), info };
  } finally {
    await task.destroy();
  }
}
/** The text with its line breaks taken out, for finding sentences that wrapped. */
const flat = (s) => s.replace(/\s+/g, ' ');

// Words put in every part of a job that must never reach a PDF: the brief, who we are looking for, the fee, the pay notes.
const SECRET = { about: 'Axolotl reorganisation', must: 'Quokka certification', where: 'Platypus meetups', pay_notes: 'Narwhal bonus scheme', flex: 'Pangolin stretch', ideal: 'Zanzibar temperament', process: 'Wombat panel' };
const DESCRIPTION = `We are looking for a senior engineer to own the services behind a busy scheduling engine.

What you will do
• Design and ship backend services in TypeScript and Postgres
• Improve the reliability of the booking APIs
• Mentor engineers and raise the bar on code review

About the role:
You will join a team of six, working from the London office two days a week.

What we offer
- A competitive salary
- 28 days of holiday`;
const PARAGRAPHS = ['We are looking for a senior engineer to own the services behind a busy scheduling engine.', 'What you will do',
  'Design and ship backend services in TypeScript and Postgres', 'Improve the reliability of the booking APIs', 'Mentor engineers and raise the bar on code review',
  'About the role', 'You will join a team of six, working from the London office two days a week.', 'What we offer', 'A competitive salary', '28 days of holiday'];

before(async () => {
  dataDir = tempDir('jobdescription');
  server = await startServer({ port: PORT, dataDir });
  base = server.base;
  alex = session(base);
  assert.equal((await alex.post('/setup', { agencyName: 'Harbour Talent', name: 'Alex Morgan', email: 'alex@agency.example', password: 'demo1234' })).status, 200);
  lumen = (await alex.post('/clients', { name: 'Lumen Health', brand_color: '#0b6e99', website: 'https://www.lumenhealth.example', currency: 'GBP', engagement_model: 'per_hire', fee_percent: 23 })).body.id;
  north = (await alex.post('/clients', { name: 'North', currency: 'CAD' })).body.id;
  priya = await join('recruiter', 'Priya Nair', 'priya@agency.example');
  marcus = await join('recruiter', 'Marcus Bell', 'marcus@agency.example');
  maya = await join('client', 'Maya Okonkwo', 'maya@lumenhealth.example', { client_id: lumen });

  job.full = await newJob(priya, { client_id: lumen, title: 'Senior Backend Engineer', location: 'London', salary_min: 85000, salary_max: 105000, description: DESCRIPTION, ideal_profile: SECRET.ideal });
  assert.equal((await priya.putJson(`/jobs/${job.full}/brief`, { brief: { about: SECRET.about, must_haves: [SECRET.must], where_to_look: [SECRET.where], pay_notes: SECRET.pay_notes, pay_flex: SECRET.flex, process_notes: SECRET.process } })).status, 200);
  job.named = await newJob(priya, { client_id: lumen, title: 'Product Designer', location: 'Manchester', description: 'Join Lumen Health as a designer.\n\nAt Lumen Health you will design for clinics.\n\nLumen Health is growing. See www.lumenhealth.example for more.' });
  job.empty = await newJob(priya, { client_id: lumen, title: 'Clinic Manager', location: 'Leeds' });
  job.north = await newJob(alex, { client_id: north, title: 'Store Planner', location: 'Toronto', salary_min: 60000, salary_max: 70000, description: 'Plan the stock for our stores.\n\nWhat you will do\n• Forecast demand' });
});

after(async () => {
  await server?.stop();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

test('every route is refused to a client’s user and to somebody signed out, and a file sent by them is not kept', async () => {
  const before = await steady();
  const routes = [['get', '/job-description'], ['get', '/job-description/check?name=without&pay=1'], ['get', '/job-description/pdf?name=with&pay=1'],
    ['get', '/job-description/pdf?name=without&pay=1&anyway=1'], ['get', '/job-description/file'], ['del', '/job-description/file']];
  for (const [method, route] of routes) {
    const theirs = await maya[method](`/jobs/${job.full}${route}`);
    assert.deepEqual([theirs.status, theirs.body.error], [403, 'Only the agency team can do this.'], route);
    assert.equal((await session(base)[method](`/jobs/${job.full}${route}`)).status, 401, route);
  }
  const sent = await keep(maya, job.full, { name: 'theirs.pdf', bytes: Buffer.from('%PDF-1.4 from the client') });
  assert.deepEqual([sent.status, sent.body.error], [403, 'Only the agency team can do this.']);
  assert.equal((await keep(null, job.full, { name: 'nobody.pdf', bytes: Buffer.from('%PDF-1.4') })).status, 401);
  await leftAsItWas(before);
});

test('a job that does not exist is not found on every route, and a file sent for it is not kept', async () => {
  const before = await steady();
  for (const route of ['/job-description', '/job-description/check?name=without', '/job-description/pdf?name=with', '/job-description/file']) {
    assert.equal((await alex.get(`/jobs/999999${route}`)).status, 404, route);
  }
  assert.equal((await alex.del('/jobs/999999/job-description/file')).status, 404);
  assert.equal((await keep(alex, 999999, { name: 'jd.pdf', bytes: Buffer.from('%PDF-1.4') })).status, 404);
  await leftAsItWas(before);
});

test('a client’s user is sent exactly the same about their jobs with a file kept as without, and nobody’s job list carries it', async () => {
  const theirs = async () => Object.fromEntries(await Promise.all([
    '/jobs', `/jobs/${job.full}`, '/dashboard', '/reports', `/clients/${lumen}`, '/me',
  ].map(async (route) => { const res = await maya.get(route); assert.equal(res.status, 200, route); return [route, res.body]; })));
  const careers = async () => [(await session(base).get('/public/careers/lumen-health')).body, (await session(base).get(`/public/careers/lumen-health/jobs/${job.full}`)).body];
  const was = await theirs(), publicWas = await careers();
  const sent = await keep(priya, job.full, { name: 'Lumen Health - Senior Backend Engineer.pdf', bytes: Buffer.from('%PDF-1.4 the client’s own advert') });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const now = await theirs();
  for (const route of Object.keys(was)) {
    assert.deepEqual(Object.keys(now[route]), Object.keys(was[route]), route);
    assert.deepEqual(now[route], was[route], route);
    assert.equal(/jd_|client_file|Senior Backend Engineer\.pdf/.test(JSON.stringify(now[route])), false, route);
  }
  assert.deepEqual(await careers(), publicWas);
  assert.equal(/jd_|client_file/.test(JSON.stringify(publicWas)), false);
  // The agency sees it on the job, and nowhere else: its lists and dashboard carry no file and no stored name.
  const detail = (await priya.get(`/jobs/${job.full}`)).body.job;
  assert.deepEqual(Object.keys(detail.client_file).sort(), ['added_at', 'added_by', 'name', 'size']);
  assert.deepEqual([detail.client_file.name, detail.client_file.added_by], ['Lumen Health - Senior Backend Engineer.pdf', 'Priya Nair']);
  assert.equal(Object.keys(detail).some((k) => k.startsWith('jd_')), false);
  for (const route of ['/jobs', '/dashboard']) assert.equal(/jd_file|client_file/.test(JSON.stringify((await priya.get(route)).body)), false, route);
  assert.equal((await alex.del(`/jobs/${job.full}/job-description/file`)).status, 200);
  assert.deepEqual(await theirs(), was);
});

test('the file has to be a PDF, Word, RTF or text file of up to 8 MB, and not empty; nothing refused is left behind', async () => {
  const before = await steady();
  const tryWith = async (file, status, error) => {
    const answer = await keep(priya, job.full, file);
    assert.deepEqual([answer.status, answer.body.error], [status, error], file?.name);
    await leftAsItWas(before);
  };
  await tryWith({ name: 'advert.png', bytes: Buffer.from('not an advert') }, 400, 'The job description has to be a PDF, a Word document (.doc or .docx), an RTF or a text file.');
  await tryWith({ name: 'advert.exe', bytes: Buffer.from('MZ') }, 400, 'The job description has to be a PDF, a Word document (.doc or .docx), an RTF or a text file.');
  await tryWith({ name: 'advert.pdf', bytes: Buffer.alloc(8 * 1024 * 1024 + 1, 32) }, 400, 'That file is larger than 8 MB.');
  await tryWith({ name: 'advert.pdf', bytes: Buffer.alloc(0) }, 400, 'That file is empty.');
  await tryWith(null, 400, 'Choose the file to keep with the job.');
  assert.equal((await alex.get(`/jobs/${job.full}/job-description`)).body.file, null);
  for (const name of ['advert.doc', 'advert.DOCX', 'advert.rtf', 'advert.txt']) {
    const answer = await keep(priya, job.full, { name, bytes: Buffer.from(`the advert in ${name}`) }, true);
    assert.equal(answer.status, 200, name);
  }
  assert.equal((await alex.del(`/jobs/${job.full}/job-description/file`)).status, 200);
  await leftAsItWas(before);
});

test('an odd file name is kept without what cannot be seen, and comes back as a download under that name', async () => {
  // A slash would be taken as a folder (the part before it is dropped, as for a résumé), so there is none here.
  const odd = `Lumen "advert" v2\n\u202Efdp.exe ${'x'.repeat(300)}.pdf`;
  const answer = await keep(priya, job.full, { name: odd, bytes: Buffer.from('%PDF-1.4 odd') });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  const name = answer.body.file.name;
  assert.equal(name.length, 200);
  assert.equal(/[\u202E\n\r]/.test(name), false);
  assert.ok(name.startsWith('Lumen "advert" v2 fdp.exe xxx'), name);
  const download = await marcus.get(`/jobs/${job.full}/job-description/file`);
  assert.equal(download.status, 200);
  assert.equal(download.body.toString(), '%PDF-1.4 odd');
  const disposition = download.headers.get('content-disposition');
  assert.match(disposition, /^attachment; filename="[\w.\- ]+"; filename\*=UTF-8''[^\s"]+$/);
  assert.equal(decodeURIComponent(/filename\*=UTF-8''(.+)$/.exec(disposition)[1]), name);
  assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await alex.del(`/jobs/${job.full}/job-description/file`)).status, 200);
});

test('a file the job has is only replaced when the request says so; the one replaced, and one removed, go from the disk', async () => {
  const empty = await steady();
  const first = await keep(priya, job.full, { name: 'first.pdf', bytes: Buffer.from('%PDF-1.4 first') });
  assert.deepEqual([first.status, first.body.replaced], [200, false]);
  const withFirst = uploads();
  assert.equal(withFirst.length, empty.length + 1);
  const stored = db('SELECT jd_file FROM jobs WHERE id = ?', job.full)[0].jd_file;
  assert.ok(withFirst.includes(stored));

  const asked = await keep(priya, job.full, { name: 'second.pdf', bytes: Buffer.from('%PDF-1.4 second') });
  assert.deepEqual([asked.status, asked.body.file], [409, 'first.pdf']);
  assert.match(asked.body.error, /already has the client’s file \(first\.pdf\)/);
  await leftAsItWas(withFirst);
  assert.equal((await alex.get(`/jobs/${job.full}/job-description/file`)).body.toString(), '%PDF-1.4 first');

  const replaced = await keep(priya, job.full, { name: 'second.pdf', bytes: Buffer.from('%PDF-1.4 second') }, true);
  assert.deepEqual([replaced.status, replaced.body.replaced, replaced.body.file.name], [200, true, 'second.pdf']);
  await until(async () => uploads(), (now) => now.length === withFirst.length && !now.includes(stored));
  assert.equal((await alex.get(`/jobs/${job.full}/job-description/file`)).body.toString(), '%PDF-1.4 second');

  assert.equal((await priya.del(`/jobs/${job.full}/job-description/file`)).status, 200);
  await leftAsItWas(empty);
  assert.equal((await alex.get(`/jobs/${job.full}/job-description/file`)).status, 404);
  assert.equal((await priya.del(`/jobs/${job.full}/job-description/file`)).status, 404);
});

test('only the job’s account executive or an admin can change the file; anybody on the team can download it', async () => {
  const before = await steady();
  const refused = await keep(marcus, job.full, { name: 'marcus.pdf', bytes: Buffer.from('%PDF-1.4 marcus') });
  assert.deepEqual([refused.status, refused.body.error], [403, 'Only Priya Nair (this job’s account executive) or an admin can change the client’s file.']);
  await leftAsItWas(before);
  assert.equal((await keep(alex, job.full, { name: 'alex.pdf', bytes: Buffer.from('%PDF-1.4 alex') })).status, 200);
  assert.equal((await marcus.del(`/jobs/${job.full}/job-description/file`)).status, 403);
  assert.equal((await marcus.get(`/jobs/${job.full}/job-description/file`)).body.toString(), '%PDF-1.4 alex');
  const info = (await marcus.get(`/jobs/${job.full}/job-description`)).body;
  assert.deepEqual([info.can_change, info.account_executive, info.file.name, info.file.added_by], [false, 'Priya Nair', 'alex.pdf', 'Alex Morgan']);
  assert.equal((await priya.get(`/jobs/${job.full}/job-description`)).body.can_change, true);
  assert.equal((await priya.del(`/jobs/${job.full}/job-description/file`)).status, 200);
  await leftAsItWas(before);
});

test('a file dropped in the new-job form is kept once the job is created; deleting the job deletes the file', async () => {
  const before = await steady();
  // What the form does: create the job, then send the file it was given.
  const id = await newJob(priya, { client_id: lumen, title: 'Data Analyst', description: 'Analyse the data.' });
  const sent = await keep(priya, id, { name: 'Data Analyst JD.docx', bytes: Buffer.from('PK the client’s Word file') });
  assert.equal(sent.status, 200);
  assert.deepEqual([sent.body.file.name, sent.body.file.added_by, sent.body.file.size], ['Data Analyst JD.docx', 'Priya Nair', Buffer.from('PK the client’s Word file').length]);
  assert.equal(uploads().length, before.length + 1);
  // A recruiter cannot delete a job; an admin can, and the file goes with it.
  assert.equal((await priya.del(`/jobs/${id}`)).status, 403);
  assert.equal((await alex.del(`/jobs/${id}`)).status, 200);
  await leftAsItWas(before);
});

test('the PDF with the client’s name has the title, the client, the facts as the careers page gives them and every paragraph in order', async () => {
  const res = await pdfOf(priya, job.full, 'name=with&pay=1');
  assert.equal(res.status, 200, res.body.toString().slice(0, 300));
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('content-disposition'), `attachment; filename="Lumen Health - Senior Backend Engineer.pdf"; filename*=UTF-8''Lumen%20Health%20-%20Senior%20Backend%20Engineer.pdf`);
  const { text, pages, info } = await readPdf(res.body);
  assert.equal(pages.length, 1);
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  assert.deepEqual(lines.slice(0, 4), ['HARBOUR TALENT', 'Senior Backend Engineer', 'Lumen Health',
    serverWords.jobMeta({ location: 'London', work_mode: 'hybrid', employment_type: 'full_time', salary_min: 85000, salary_max: 105000 }, 'GBP').join(' · ')]);
  assert.equal(lines[3], 'London · Hybrid · Full-time · £85,000 – £105,000');
  // Every paragraph, list item and heading, in order (a bullet keeps its mark in front).
  let at = 0;
  for (const paragraph of PARAGRAPHS) {
    const found = flat(text).indexOf(paragraph, at);
    assert.ok(found >= at, `“${paragraph}” is in the PDF after what comes before it`);
    at = found + paragraph.length;
  }
  assert.match(text, /• Design and ship/);
  assert.match(lines.at(-1), /^Harbour Talent · \d{1,2} \w+ \d{4}$/);
  assert.deepEqual([info.Title, info.Author, info.Subject, info.Creator, info.Producer], ['Senior Backend Engineer - Lumen Health', 'Harbour Talent', 'Job description', 'The Book', 'The Book']);
  // Without the pay range, it is left out.
  const unpaid = await readPdf((await pdfOf(priya, job.full, 'name=with&pay=0')).body);
  assert.equal(unpaid.text.includes('£85,000'), false);
  assert.match(unpaid.text, /London · Hybrid · Full-time\n/);
});

test('a PDF is only made when it is said whether it names the client, and not for a job with no description', async () => {
  for (const query of ['', 'name=', 'name=yes', 'pay=1']) {
    const res = await pdfOf(priya, job.full, query);
    assert.deepEqual([res.status, res.body.error], [400, 'Choose whether the PDF gives the client’s name.'], query);
  }
  const info = (await priya.get(`/jobs/${job.empty}/job-description`)).body;
  assert.deepEqual([info.with, info.without], [false, false]);
  for (const name of ['with', 'without']) {
    const res = await pdfOf(priya, job.empty, `name=${name}&pay=1&anyway=1`);
    assert.deepEqual([res.status, res.body.error], [400, 'This job has no description to make a PDF from. Add one first: Edit, then the Job advert box.']);
    assert.equal((await priya.get(`/jobs/${job.empty}/job-description/check?name=${name}`)).status, 400);
  }
});

/** Everything that would give Lumen Health away, as it could appear anywhere in a file or a header. */
const TELLS = [/lumen/i, /0b6e99/i, /maya/i, /okonkwo/i];
async function givesNothingAway(res, label) {
  assert.equal(res.status, 200, `${label}: ${res.body.toString().slice(0, 300)}`);
  const { text, info } = await readPdf(res.body);
  const raw = res.body.toString('latin1');
  const headers = JSON.stringify([...res.headers]);
  for (const tell of TELLS) {
    assert.equal(tell.test(text), false, `${label}: ${tell} in the text`);
    assert.equal(tell.test(raw), false, `${label}: ${tell} in the bytes`);
    assert.equal(tell.test(JSON.stringify(info)), false, `${label}: ${tell} in the metadata`);
    assert.equal(tell.test(headers), false, `${label}: ${tell} in the headers`);
  }
  return { text, info };
}

test('the PDF without the client’s name has nothing of the client in its text, its bytes, its metadata or its headers', async () => {
  for (const pay of ['1', '0']) {
    const res = await pdfOf(priya, job.full, `name=without&pay=${pay}`);
    const { text, info } = await givesNothingAway(res, `pay=${pay}`);
    assert.equal(res.headers.get('content-disposition'), `attachment; filename="Senior Backend Engineer - Harbour Talent.pdf"; filename*=UTF-8''Senior%20Backend%20Engineer%20-%20Harbour%20Talent.pdf`);
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    assert.deepEqual(lines.slice(0, 5), ['HARBOUR TALENT', 'Senior Backend Engineer', 'With our client',
      pay === '1' ? 'London · Hybrid · Full-time · £85,000 – £105,000' : 'London · Hybrid · Full-time', 'The employer’s name is kept confidential at this stage.']);
    for (const paragraph of PARAGRAPHS) assert.ok(flat(text).includes(paragraph), paragraph);
    assert.deepEqual([info.Title, info.Author, info.Subject, info.Keywords], ['Senior Backend Engineer', 'Harbour Talent', 'Job description', undefined]);
  }
});

test('nothing from the brief, the fee, who we are looking for or who works on the job is in either PDF', async () => {
  for (const query of ['name=with&pay=1', 'name=without&pay=1']) {
    const { text, info } = await readPdf((await pdfOf(priya, job.full, query)).body);
    const all = `${text}\n${JSON.stringify(info)}`;
    for (const secret of Object.values(SECRET)) assert.equal(all.includes(secret.split(' ')[0]), false, `${query}: ${secret}`);
    // 23% of the salary range is the fee: £19,550 to £24,150.
    for (const word of ['19,550', '24,150', '23%', 'fee', 'Priya', 'Nair', 'Marcus', 'Alex Morgan', 'brief']) assert.equal(all.toLowerCase().includes(word.toLowerCase()), false, `${query}: ${word}`);
  }
});

test('with a confidential post, the PDF without the client’s name uses the post’s own title, location, text and pay', async () => {
  const post = { title: 'Senior Software Engineer (Backend)', location: 'Central London', description: 'Our client builds software for clinics.\n\nWhat you will do\n• Run the booking services', show_salary: false, round_salary: true, enabled: false };
  assert.equal((await priya.putJson(`/jobs/${job.full}/board`, post)).status, 200);
  const info = (await priya.get(`/jobs/${job.full}/job-description`)).body;
  assert.deepEqual(info.post, { enabled: false, wording: true, show_salary: false, round_salary: true });
  const check = (await priya.get(`/jobs/${job.full}/job-description/check?name=without&pay=1`)).body;
  assert.deepEqual([check.uses_post, check.findings], [true, []]);
  const res = await pdfOf(priya, job.full, 'name=without&pay=1');
  const { text } = await givesNothingAway(res, 'post');
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  // The pay range as the post rounds it.
  assert.deepEqual(lines.slice(1, 4), ['Senior Software Engineer (Backend)', 'With our client', 'Central London · Hybrid · Full-time · £80,000 – £110,000']);
  assert.ok(flat(text).includes('Our client builds software for clinics.'));
  assert.equal(text.includes('busy scheduling engine'), false, 'the job’s own advert is not used');
  assert.match(res.headers.get('content-disposition'), /filename\*=UTF-8''Senior%20Software%20Engineer%20%28Backend%29%20-%20Harbour%20Talent\.pdf$/);
  // The PDF with the client's name is the job's own, whatever the post says.
  assert.ok(flat((await readPdf((await pdfOf(priya, job.full, 'name=with&pay=1')).body)).text).includes('busy scheduling engine'));
  // A post with part of its wording missing is not used: the job's own is.
  write(`UPDATE board_posts SET location = '' WHERE job_id = ?`, job.full);
  assert.equal((await priya.get(`/jobs/${job.full}/job-description/check?name=without`)).body.uses_post, false);
  write(`DELETE FROM board_posts WHERE job_id = ?`, job.full);
});

test('the check refuses the PDF without the client’s name until the recruiter says to download it anyway, and lists what it found', async () => {
  const check = (await priya.get(`/jobs/${job.named}/job-description/check?name=without&pay=1`)).body;
  assert.equal(check.uses_post, false);
  const messages = check.findings.map((f) => f.message);
  assert.ok(messages.includes('The description mentions “Lumen Health” 3 times: the client’s name.'), messages.join('\n'));
  assert.ok(messages.some((m) => /“www\.lumenhealth\.example”/.test(m)), messages.join('\n'));
  assert.ok(check.findings.every((f) => f.field === 'description'));
  const refused = await pdfOf(priya, job.named, 'name=without&pay=1');
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /could give the client away/);
  assert.deepEqual(refused.body.findings, check.findings);
  for (const anyway of ['0', 'yes', '']) assert.equal((await pdfOf(priya, job.named, `name=without&pay=1&anyway=${anyway}`)).status, 409, anyway);
  const taken = await pdfOf(priya, job.named, 'name=without&pay=1&anyway=1');
  assert.equal(taken.status, 200);
  assert.ok((await readPdf(taken.body)).text.includes('Join Lumen Health as a designer.'), 'what was asked for, as it is');
  // With the client's name nothing is looked for.
  assert.equal((await pdfOf(priya, job.named, 'name=with&pay=1')).status, 200);
  assert.deepEqual((await priya.get(`/jobs/${job.named}/job-description/check?name=with`)).body.findings, []);
  // The title and the location are checked too.
  const titled = await newJob(priya, { client_id: lumen, title: 'Lumen Health Designer', location: 'Lumen House', description: 'Design things.' });
  const fields = (await priya.get(`/jobs/${titled}/job-description/check?name=without`)).body.findings.map((f) => f.field);
  assert.deepEqual([...new Set(fields)].sort(), ['location', 'title']);
});

test('an admin’s overrule on the job’s confidential post holds for its PDF too', async () => {
  const post = { title: 'Store Planner', location: 'Greater Toronto Area', description: 'Plan the stock for a retailer that sells in the north of the country.', show_salary: true, enabled: false };
  const view = (await alex.putJson(`/jobs/${job.north}/board`, post)).body;
  const alarm = view.check.problems.find((p) => p.can_overrule);
  assert.ok(alarm, JSON.stringify(view.check.problems));
  const before = (await priya.get(`/jobs/${job.north}/job-description/check?name=without&pay=1`)).body;
  assert.deepEqual(before.findings.map((f) => f.message), ['The description mentions “north”: the client’s name.']);
  assert.equal((await pdfOf(priya, job.north, 'name=without&pay=1')).status, 409);
  assert.equal((await alex.post(`/jobs/${job.north}/board/overrules`, { word: alarm.word, key: alarm.key })).status, 200);
  const after = (await priya.get(`/jobs/${job.north}/job-description/check?name=without&pay=1`)).body;
  assert.deepEqual([after.findings, after.overruled], [[], 1]);
  const res = await pdfOf(priya, job.north, 'name=without&pay=1');
  assert.equal(res.status, 200);
  assert.match((await readPdf(res.body)).text, /Greater Toronto Area · Hybrid · Full-time · CA\$60,000 – CA\$70,000|Greater Toronto Area · Hybrid · Full-time · \$60,000 – \$70,000/);
});

test('characters the fonts lack are left out cleanly, and accents, quotes, dashes, bullets and currency signs are printed', async () => {
  const description = `Café naïve “quoted” ‘single’ – en — em… £5 €6 $7 ₹8\n\uF0B7 Word bullet\n● Big ▪ small ☐ box\nEmoji 😀👍🏽 here. 中文字 here. مرحبا here.`;
  const id = await newJob(priya, { client_id: north, title: 'Café Lead – “Weekend”', location: 'Montréal', description });
  const check = (await priya.get(`/jobs/${id}/job-description/check?name=with`)).body;
  assert.equal(check.dropped, true);
  const res = await pdfOf(priya, id, 'name=with&pay=0');
  assert.equal(res.status, 200);
  const { text } = await readPdf(res.body);
  for (const kept of ['Café naïve “quoted” ‘single’ – en — em… £5 €6 $7 ₹8', '• Word bullet', '☐ box', 'Café Lead – “Weekend”', 'Montréal']) assert.ok(text.includes(kept), kept);
  assert.equal(/[一-鿿\u0600-ۿ\uF0B7]/.test(text), false, 'no Chinese, no Arabic, no Word private character');
  assert.match(flat(text), /here\. here\. here\./);
  assert.equal(text.includes('�'), false);
});

test('a description of 50,000 characters makes a PDF of many numbered pages in well under two seconds', async () => {
  const id = await newJob(priya, { client_id: north, title: 'Long Advert', description: 'Short for now.' });
  const paragraph = `What you will do\n• ${'Plan and forecast the stock for every store in the region. '.repeat(6)}\n${'This is a long paragraph about the role and the team. '.repeat(10)}\nhttps://example.com/${'a'.repeat(400)}\n\n`;
  write('UPDATE jobs SET description = ? WHERE id = ?', paragraph.repeat(Math.ceil(50000 / paragraph.length)).slice(0, 50000), id);
  const started = Date.now();
  const res = await pdfOf(priya, id, 'name=with&pay=0');
  const took = Date.now() - started;
  assert.equal(res.status, 200);
  assert.ok(took < 2000, `took ${took} ms`);
  const { pages } = await readPdf(res.body);
  assert.ok(pages.length > 3, `${pages.length} pages`);
  pages.forEach((page, i) => assert.match(page, new RegExp(`Page ${i + 1} of ${pages.length}`)));
  // The server answers other requests straight after.
  assert.equal((await priya.get('/me')).status, 200);
});

test('a client name or job title with quotes, slashes, line breaks, direction marks or 300 characters gives a safe file name', async () => {
  const id = await newJob(alex, { client_id: north, title: 'Planner', description: 'Plan things.' });
  const hostileTitle = `Ops "Lead" / Planner\\Two\r\n\u202Eexe.pdf ${'y'.repeat(300)}`;
  write('UPDATE jobs SET title = ? WHERE id = ?', hostileTitle, id);
  write('UPDATE clients SET name = ? WHERE id = ?', `North "Gear" / Co\n\u200F${'z'.repeat(300)}`, north);
  try {
    for (const name of ['with', 'without']) {
      const res = await pdfOf(alex, id, `name=${name}&pay=0&anyway=1`);
      assert.equal(res.status, 200, name);
      const disposition = res.headers.get('content-disposition');
      assert.equal(/[\r\n]/.test(disposition), false);
      assert.match(disposition, /^attachment; filename="[\w.\- ]+"; filename\*=UTF-8''[^\s"]+$/, name);
      const full = decodeURIComponent(/filename\*=UTF-8''(.+)$/.exec(disposition)[1]);
      assert.equal(/[\\/"\u202E\u200F\r\n:*?<>|]/.test(full), false, full);
      assert.ok(full.endsWith('.pdf') && full.length <= 220, `${full.length}: ${full}`);
      assert.ok(name === 'with' ? full.startsWith('North -Gear- - Co z') : full.startsWith('Ops -Lead- - Planner-Two exe.pdf y'), full);
    }
  } finally {
    write('UPDATE clients SET name = ? WHERE id = ?', 'North', north);
  }
});

test('the PDF gives the working pattern, contract and pay in the careers page’s own words', () => {
  for (const [min, max, currency] of [[85000, 105000, 'GBP'], [60000, null, 'CAD'], [null, 70000, 'USD'], [null, null, 'EUR'], [1500, 2500, 'INR']]) {
    assert.equal(serverWords.salaryRange(min, max, currency), appWords.salaryRange(min, max, currency), `${min}-${max} ${currency}`);
  }
  assert.deepEqual(serverWords.WORK_MODES, appWords.WORK_MODES);
  assert.deepEqual(serverWords.EMPLOYMENT, appWords.EMPLOYMENT);
  // jobMeta in the careers page: the same facts in the same order.
  const careers = fs.readFileSync(new URL('../src/pages/Careers.jsx', import.meta.url), 'utf8');
  assert.match(careers, /const jobMeta = \(job, currency\) => \[job\.location, WORK_MODES\[job\.work_mode\], EMPLOYMENT\[job\.employment_type\], salaryRange\(job\.salary_min, job\.salary_max, currency\)\]\.filter\(Boolean\);/);
});
