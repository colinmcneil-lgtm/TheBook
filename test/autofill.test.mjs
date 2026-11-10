// The no-AI reader for job descriptions: run with `npm test`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { basicAutofill, findSalary } from '../server/autofill.js';

test('salary ranges in the forms people write them', () => {
  const cases = {
    '$120k–$150k': [120000, 150000, 'USD'], '85-105k GBP': [85000, 105000, 'GBP'], '£85-105k': [85000, 105000, 'GBP'],
    '€70.000 - €85.000': [70000, 85000, 'EUR'], 'salary up to £60,000 per annum': [60000, 60000, 'GBP'],
    'between 55,000 and 65,000 USD': [55000, 65000, 'USD'], '£85,000 to £105,000': [85000, 105000, 'GBP'], 'CHF 120000': [120000, 120000, 'CHF'],
  };
  for (const [text, [min, max, currency]] of Object.entries(cases)) assert.deepEqual(findSalary(text), { min, max, currency }, text);
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
  const { job, brief } = basicAutofill('', 'Ruth wants a hunter. Could stretch to £70,000.');
  assert.equal(job.title, '');
  assert.match(brief.about, /Ruth wants a hunter/);
  assert.equal(brief.must_haves, undefined);
  assert.equal(job.salary_min, 70000); // a salary stated in the notes is still picked up
});

test('nothing recognisable gives empty fields, not guesses', () => {
  const { job, brief } = basicAutofill('We are a friendly company and we would love to hear from you. Please get in touch with any questions.', '');
  assert.equal(job.title, '');
  assert.equal(job.salary_min, null);
  assert.equal(job.work_mode, 'unknown');
  assert.deepEqual(Object.keys(brief), []);
});
