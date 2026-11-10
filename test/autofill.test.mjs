// The no-AI reader for job descriptions: run with `npm test`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { basicAutofill, findSalary } from '../server/autofill.js';

test('salary ranges in the forms people write them', () => {
  const cases = {
    '$120k–$150k': [120000, 150000, ''], '85-105k GBP': [85000, 105000, 'GBP'], '£85-105k': [85000, 105000, 'GBP'],
    '€70.000 - €85.000': [70000, 85000, 'EUR'], 'salary up to £60,000 per annum': [60000, 60000, 'GBP'],
    'between 55,000 and 65,000 USD': [55000, 65000, 'USD'], '£85,000 to £105,000': [85000, 105000, 'GBP'], 'CHF 120000': [120000, 120000, 'CHF'],
  };
  for (const [text, [min, max, currency]] of Object.entries(cases)) assert.deepEqual(findSalary(text), { min, max, currency }, text);
});

test('ranges written with cents or a unit keep their top end', () => {
  const cases = {
    '$120,000.00 - $150,000.00 per year': [120000, 150000, ''], '$75,000/yr – $90,000/yr': [75000, 90000, ''], 'C$95,000 - C$110,000': [95000, 110000, 'CAD'],
    'Salary: 60,000 - 70,000 per annum': [60000, 70000, ''], 'Salary: 85k-105k': [85000, 105000, ''], "CHF 120'000": [120000, 120000, 'CHF'],
  };
  for (const [text, [min, max, currency]] of Object.entries(cases)) assert.deepEqual(findSalary(text), { min, max, currency }, text);
});

test('the currency is the one the text names; a dollar sign alone is nobody\'s dollar', () => {
  const cases = {
    '$95,000 - $110,000 CAD': 'CAD', 'CAD $95,000 to $110,000 per year': 'CAD', 'Salary: $95,000–$110,000 (Canadian dollars)': 'CAD', 'CA$95,000 - CA$110,000': 'CAD', '70-85K CAD': 'CAD',
    'NZ$90,000': 'NZD', 'HK$600,000': 'HKD', 'S$120,000': 'SGD', 'US$120,000': 'USD', 'Salary: $95,000 - $110,000 per year': '',
  };
  for (const [text, currency] of Object.entries(cases)) assert.equal(findSalary(text)?.currency, currency, text);
});

test('money that is not the salary is passed over', () => {
  const cases = {
    'Kestrel has raised $42,000,000 from investors.\nCompensation: $135,000.00 - $165,000.00 per year': [135000, 165000],
    'You will own a £2,000,000 marketing budget. Salary £60,000 - £70,000': [60000, 70000],
    'OTE £120,000 (base £60,000)': [60000, 60000], '£55k basic, £90k OTE': [55000, 55000],
    '$150,000 - $180,000 base + $40,000 bonus': [150000, 180000],
    'Monday to Friday, 8 hours a day. Salary: £32,000': [32000, 32000], // "a day" is about the hours
    'Our 10,000 customers love us. Salary: £50,000': [50000, 50000],
  };
  for (const [text, [min, max]] of Object.entries(cases)) { const s = findSalary(text); assert.deepEqual([s?.min, s?.max], [min, max], text); }
  for (const text of ['AED 25,000 - 30,000 per month', '$8,500 - $10,500 per month', 'Sign-on bonus of $10,000. Hourly rate $38-$44', 'We have 50,000 users and 85k-105k downloads']) assert.equal(findSalary(text), null, text);
});

test('several different salaries in one text leave the boxes empty', () => {
  assert.equal(findSalary('Account Executive: £45,000 - £55,000\nAccount Manager: £50,000 - £60,000\nSDR: £28,000'), null);
  // The same range said twice is one salary, and a line that is there to state it wins over a passing mention.
  assert.deepEqual(findSalary('Salary: £60,000 - £70,000\nFor someone exceptional we have paid a base of £75,000 before.'), { min: 60000, max: 70000, currency: 'GBP' });
});

test('things that are not a yearly salary', () => {
  for (const text of ['£450 per day', '£30 an hour', 'Founded in 2015 with 2,000 staff', 'ages 18-65 and 2019-2024 growth', 'Call 020 7946 0991']) assert.equal(findSalary(text), null, text);
});

test('a labelled job description', () => {
  const { job, brief } = basicAutofill(`Senior Backend Engineer
Location: London (Hybrid)
Department: Engineering
Salary: £85,000 - £105,000 plus equity

What you will do
• Design and ship backend services

What we're looking for
• 5+ years building production backend systems
• Strong SQL

Nice to have
- Healthcare experience

What we offer
• 28 days holiday

Full-time, permanent.`, '');
  assert.equal(job.title, 'Senior Backend Engineer');
  assert.equal(job.department, 'Engineering');
  assert.equal(job.location, 'London');
  assert.equal(job.work_mode, 'hybrid');
  assert.equal(job.employment_type, 'full_time');
  assert.deepEqual([job.salary_min, job.salary_max, job.salary_currency], [85000, 105000, 'GBP']);
  assert.deepEqual(brief.must_haves, ['5+ years building production backend systems', 'Strong SQL']);
  assert.deepEqual(brief.nice_to_haves, ['Healthcare experience']);
  assert.deepEqual(brief.selling_points, ['28 days holiday']); // the closing sentence is not a benefit
  assert.deepEqual(brief.search_titles, ['Senior Backend Engineer']);
});

test('intake notes are kept as written, never interpreted', () => {
  const { job, brief, notes_cut } = basicAutofill('', 'Ruth wants a hunter. Could stretch to £70,000.');
  assert.equal(job.title, '');
  assert.match(brief.about, /Ruth wants a hunter/);
  assert.equal(brief.must_haves, undefined);
  assert.equal(notes_cut, false);
});

test('a figure in the private intake notes never reaches the salary boxes', () => {
  // The salary boxes are shown on the careers page; the notes hold fees, budgets and how far the client would stretch.
  for (const notes of ['Ruth says advertise as competitive. Budget is 60 to 65 but for the right person she could stretch to £78,000. Do not tell candidates.',
    'Their last agency charged £18,000 for the hire. Salary for this one is £52,000.']) {
    const { job } = basicAutofill('Account Director\nLocation: Leeds\nCompetitive salary.\nRequirements\n• Agency background', notes);
    assert.deepEqual([job.salary_min, job.salary_max, job.salary_currency], [null, null, ''], notes);
  }
});

test('notes longer than the brief holds are cut at a line end, and the reader says so', () => {
  const notes = `${Array.from({ length: 400 }, (_, i) => `Ruth: point ${i} about what she wants from the person in this role.`).join('\n')}\nLAST LINE: must not come from Varsity Freight.`;
  const { brief, notes_cut } = basicAutofill('', notes);
  assert.equal(notes_cut, true);
  assert.ok(brief.about.length <= 6000);
  assert.match(brief.about, /in this role\.$/); // a whole line, not half a word
});

test('titles keep their hyphens and are not taken from the company line, a bullet or a label that means something else', () => {
  const title = (text) => basicAutofill(text, '').job.title;
  assert.equal(title('Full-Stack Developer - Remote (Canada)\n\nWe build things.'), 'Full-Stack Developer');
  assert.equal(title('Front-End Developer – London\n\nWe build things.'), 'Front-End Developer');
  assert.equal(title('E-commerce Manager | Full-time\n\nWe sell things.'), 'E-commerce Manager');
  assert.equal(title('Non-Executive Director, UK charity\n'), 'Non-Executive Director, UK charity');
  assert.equal(title('Co-ordinator, Events (12 month contract)\n'), 'Co-ordinator, Events (12 month contract)');
  assert.equal(title('Account Manager - Enterprise\n'), 'Account Manager - Enterprise');
  assert.equal(title('Kestrel Robotics\nSenior Robotics Engineer\nBoston, MA'), 'Senior Robotics Engineer');
  assert.equal(title('Dispatch Supervisor\nPosition: Permanent, full time\n'), 'Dispatch Supervisor');
  assert.equal(title('Dispatch Supervisor\nRole: Reporting to the Operations Director, you will run the night dispatch desk and its six staff.\n'), 'Dispatch Supervisor');
  assert.equal(title('We are hiring:\n• Account Executive: 3 years closing B2B deals\n• SDR: no experience needed'), '');
  assert.equal(title('Position: Dispatch Supervisor\nAbout us\nWe move freight.'), 'Dispatch Supervisor');
});

test('working pattern and contract are read where they are stated, not from a word in passing', () => {
  const read = (text) => { const { job } = basicAutofill(text, ''); return [job.work_mode, job.employment_type]; };
  assert.deepEqual(read('Lab Technician\nPlease note this is not a hybrid or remote role; you will be in the lab every day.'), ['unknown', 'unknown']);
  assert.deepEqual(read('Nurse Educator\nLocation: Leeds\n\nRequirements\n• Experience with remote patient monitoring devices\n\nThis role is on-site five days a week.'), ['unknown', 'unknown']);
  assert.deepEqual(read('Finance Manager\nFull-time, permanent. Part-time and job-share applications are welcome.'), ['unknown', 'unknown']);
  assert.deepEqual(read('Site Manager\nPermanent. You will manage a team of sub-contractors on a fixed-term programme of works.'), ['unknown', 'unknown']);
  assert.deepEqual(read('Planner\nLocation - Birmingham, 2 days a week on-site'), ['hybrid', 'unknown']);
  assert.deepEqual(read('Full-Stack Engineer (Remote)\nContract type: Permanent'), ['remote', 'full_time']);
  assert.deepEqual(read('Interim Finance Partner\nHours: Full-time\nContract: 6-month contract'), ['unknown', 'contract']);
});

test('a list ends at a heading the reader does not know', () => {
  const { brief } = basicAutofill(`Front-End Engineer

What you'll bring
• 4+ years of professional front-end experience
• TypeScript and React

Compensation
$135,000 - $165,000 per year

Our stack
• React, TypeScript, Rust
• Postgres

Why Kestrel
• Medical, dental and vision
• 20 days PTO

Desirable
• Design systems

Interview process
• 30 minute telephone screen
• Panel interview with a ten minute presentation

Benefits
• Pension

Next steps
• Send your CV to jobs@example.com`, '');
  assert.deepEqual(brief.must_haves, ['4+ years of professional front-end experience', 'TypeScript and React']);
  assert.deepEqual(brief.nice_to_haves, ['Design systems']);
  assert.deepEqual(brief.selling_points, ['Pension']);
  // An item of a plain list that starts like a heading stays an item.
  assert.deepEqual(basicAutofill('Planner\n\nRequirements\nRequirements gathering with stakeholders\nBenefits administration knowledge\nExcel\n', '').brief.must_haves,
    ['Requirements gathering with stakeholders', 'Benefits administration knowledge', 'Excel']);
});

test('nothing recognisable gives empty fields, not guesses', () => {
  const { job, brief } = basicAutofill('We are a friendly company and we would love to hear from you. Please get in touch with any questions.', '');
  assert.equal(job.title, '');
  assert.equal(job.salary_min, null);
  assert.equal(job.work_mode, 'unknown');
  assert.deepEqual(Object.keys(brief), []);
});
