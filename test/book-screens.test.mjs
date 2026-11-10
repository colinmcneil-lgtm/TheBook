// The words the screens use for someone saved to The Book without a job, and where their profile opens.
// These are the plain rules behind the screens, checked without a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { NO_JOB, jobLine, profilePath } from '../src/lib.js';

test('a job and its client are printed together, and someone with neither is "Not on a job yet"', () => {
  assert.equal(jobLine({ job_title: 'Staff Engineer', client_name: 'Lumen Health' }), 'Staff Engineer · Lumen Health');
  assert.equal(NO_JOB, 'Not on a job yet');
  assert.equal(jobLine({ job_title: null, client_name: null }), NO_JOB);
  assert.equal(jobLine({}), NO_JOB);
});

test('a missing job or client never leaves a stray separator, "null" or "undefined" behind', () => {
  // A call that is on a person but on none of their jobs still names their client.
  assert.equal(jobLine({ job_title: null, client_name: 'Lumen Health' }), 'Lumen Health');
  assert.equal(jobLine({ job_title: 'Staff Engineer' }), 'Staff Engineer');
  for (const row of [null, undefined, { job_title: '', client_name: '' }, { job_title: undefined, client_name: null }]) {
    assert.equal(jobLine(row), NO_JOB);
  }
});

test('a profile opens inside its job, or on the Candidates page for someone who is not on one', () => {
  assert.equal(profilePath(7, 42), '/jobs/7?c=42');
  assert.equal(profilePath(null, 42), '/candidates?c=42');
  assert.equal(profilePath(undefined, 42), '/candidates?c=42');
});
