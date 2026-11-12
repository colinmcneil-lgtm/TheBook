// The Cycles page's sentences about what it counts must be true of what server/cycles.js does, and use the words The
// Book itself uses for a job's status. Checked without a browser or a port: the sentences live in
// src/cycles-words.js, and the page is read to see that it uses them and has no older wording left in it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { NOT_LISTED, WHICH_JOBS, historyNote, lastCycleWords } from '../src/cycles-words.js';
import { JOB_STATUS } from '../src/lib.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const page = fs.readFileSync(path.join(ROOT, 'src/pages/Cycles.jsx'), 'utf8');

test('the jobs left out of the table are named by the statuses The Book has: paused, closed and draft', () => {
  const names = Object.values(JOB_STATUS).map((s) => (typeof s === 'string' ? s : s.label).toLowerCase());
  for (const status of ['paused', 'closed', 'draft']) assert.ok(names.includes(status), `The Book has a status "${status}" (${names})`);
  for (const words of [NOT_LISTED, WHICH_JOBS]) {
    assert.match(words, /closed/);
    assert.match(words, /paused/);
    assert.match(words, /draft/);
    // There is no "filled" status, and a paused job's badge says Paused, not "on hold".
    assert.doesNotMatch(words, /filled|on hold/i);
  }
  assert.doesNotMatch(page, /filled|on hold|put on hold/i, 'the page itself names no status The Book does not have');
  assert.match(page, /\{NOT_LISTED\}/);
  assert.match(page, /\{WHICH_JOBS\}/);
});

test('where history starts says that every job already ticked was counted, taken off the Done list or not', () => {
  const words = historyNote('12 November 2026');
  assert.match(words, /^Cycles are counted from 12 November 2026\./);
  // The first start copied every ticked job item that still existed, whether removed from Done or not (cycles.js).
  assert.match(words, /counted too, even if they had since been taken off the Done list/);
  assert.match(words, /account had already been removed/);
  assert.doesNotMatch(words, /only if they were still on/);
  assert.doesNotMatch(page, /count only if they were still on somebody/, 'the page has no older wording of it');
  assert.match(page, /historyNote\(/);
});

test('a screen reader is told the last cycle in words, not "16h ago"', () => {
  const at = new Date(Date.now() - 16 * 3600000 - 60000).toISOString();
  assert.equal(lastCycleWords(at, 'Priya Nair'), '16 hours ago, by Priya Nair');
  assert.equal(lastCycleWords(new Date(Date.now() - 3 * 86400000 - 60000).toISOString(), 'Sam Ode'), '3 days ago, by Sam Ode');
  // The page gives those words beside the short form, which is hidden from a screen reader.
  assert.match(page, /className="sr-only">\{lastCycleWords\(/);
  assert.match(page, /aria-hidden="true">\s*<span className="text-stone-900">\{ago\(row\.last_at\)\}/);
});

test('the summary\'s two counts are two sentences to a screen reader, and the tables have names', () => {
  assert.match(page, /aria-hidden="true"> · <\/span><span className="sr-only">\. <\/span>/);
  assert.match(page, /<table className="w-full text-sm" aria-label="Open jobs">/);
  assert.match(page, /aria-label=\{`By person, /);
});

test('on a phone the row opener is 40 pixels square, and a Sort by list stands in for the column headings', () => {
  assert.match(page, /large \? '[^']*size-10[^']*' : 'size-7'/);
  assert.match(page, /onToggle=\{\(\) => toggle\(row\.id\)\} large \/>/);
  assert.match(page, /<span className="font-medium">Sort by<\/span>/);
});
