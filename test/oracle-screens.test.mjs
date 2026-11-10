// The rules behind The Oracle's screens: which tab opens, what a call is called, what a Metaview call's row says and
// whose it is in The Book. Run with `npm test`.
// The screens themselves (React) were checked in a real browser against a stand-in for the Metaview routes; these
// are the parts that can be checked without one. Everyone named here is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MATCHED_BY, OFFERED_BY, ORACLE_TABS, callWhen, fmtLength, kindLine, knownLine, madeBy, nameList, oraclePath, oracleTab, peopleLine, readingLine, tabOfCall, whoseCall,
} from '../src/oracle/calls.js';
import { telHref } from '../src/lib.js';

const call = (more = {}) => ({
  id: 9001, url: 'https://app.metaview.example/notes/9001', started_at: '2026-11-09T21:40:00.000Z', title: 'Call with Dana Whitlock', kind: 'Job Interview', channel: 'Phone',
  minutes: 25, people: [{ name: 'Dana Whitlock', role: 'candidate' }, { name: 'Alex Morgan', role: 'interviewer' }], has_transcript: true, call_id: null, match: null, suggestions: [], ...more,
});
const person = (more = {}) => ({ application_id: 7, candidate_id: 3, name: 'Dana Whitlock', photo: null, job_title: 'Financial Controller', client_name: 'Northwind', how: 'phone', ...more });

test('The Oracle opens on the tab in the address, else the one used last, else Metaview', () => {
  assert.deepEqual(ORACLE_TABS, ['metaview', 'record']);
  assert.equal(oracleTab('record', 'metaview'), 'record');
  assert.equal(oracleTab(null, 'record'), 'record', 'the tab used last');
  assert.equal(oracleTab(null, null), 'metaview', 'the first tab, the first time');
  assert.equal(oracleTab('calendar', 'phone'), 'metaview', 'a tab that no longer exists, in the address or remembered from before');
  assert.equal(oraclePath('record'), '/oracle?tab=record');
});

test('a call goes back to the tab it is listed on', () => {
  assert.equal(tabOfCall({ source: 'metaview' }), 'metaview');
  assert.equal(tabOfCall({ source: 'recorded' }), 'record');
  assert.equal(tabOfCall({ source: 'uploaded' }), 'record');
  assert.equal(tabOfCall({ source: 'phone' }), 'record', 'a call from an earlier version is with the recorded ones');
  assert.equal(tabOfCall(null), 'record');
});

test('a call says how it came to be in The Oracle', () => {
  assert.equal(madeBy({ source: 'recorded', created_by_name: 'Alex Morgan' }), 'Recorded by Alex Morgan');
  assert.equal(madeBy({ source: 'uploaded', created_by_name: 'Alex Morgan' }), 'Uploaded by Alex Morgan');
  assert.equal(madeBy({ source: 'recorded', created_by_name: null }), 'Recorded by someone who has left');
  // The person a Metaview call belongs to is whoever took it, not whoever brought it in, so nobody is named.
  assert.equal(madeBy({ source: 'metaview', created_by_name: 'Alex Morgan' }), 'Brought in from Metaview');
  assert.equal(madeBy({ source: 'metaview', created_by_name: null }), 'Brought in from Metaview', 'brought in by The Book itself');
  // A call left over from an earlier version still reads as a call, with nothing about how it was placed.
  assert.equal(madeBy({ source: 'phone', direction: 'outbound', created_by_name: 'Alex Morgan' }), 'Recorded by Alex Morgan');
});

test('a Metaview call is dated by when it took place, any other call by when it was recorded', () => {
  assert.equal(callWhen({ created_at: '2026-11-10T15:00:00Z', took_place_at: '2026-11-09T21:40:00Z' }), '2026-11-09T21:40:00Z');
  assert.equal(callWhen({ created_at: '2026-11-10T15:00:00Z', took_place_at: null }), '2026-11-10T15:00:00Z');
  assert.equal(callWhen({ created_at: '2026-11-10T15:00:00Z' }), '2026-11-10T15:00:00Z');
});

test('how long a call was', () => {
  assert.equal(fmtLength(45_000), '45 sec');
  assert.equal(fmtLength(12 * 60_000), '12 min');
  assert.equal(fmtLength(65 * 60_000), '1 h 05 min');
  assert.equal(fmtLength(null), '');
  assert.equal(fmtLength(0), '');
});

test('names are listed the way people say them', () => {
  assert.equal(nameList([]), '');
  assert.equal(nameList(['Dana']), 'Dana');
  assert.equal(nameList(['Dana', 'Alex']), 'Dana and Alex');
  assert.equal(nameList(['Dana', 'Alex', 'Sam']), 'Dana, Alex and Sam');
});

test('a Metaview call says who was on it, without repeating a name that is in its title', () => {
  assert.equal(peopleLine(call()), 'With Alex Morgan');
  assert.equal(peopleLine(call({ title: 'Controller intro' })), 'Dana Whitlock with Alex Morgan');
  assert.equal(peopleLine(call({ title: 'CALL WITH DANA WHITLOCK' })), 'With Alex Morgan', 'however the title is written');
  const panel = [{ name: 'Dana Whitlock', role: 'candidate' }, { name: 'Alex Morgan', role: 'interviewer' }, { name: 'Sam Okafor', role: 'interviewer' }, { name: 'Priya Nair', role: 'other' }];
  assert.equal(peopleLine(call({ title: 'Panel interview', people: panel })), 'Dana Whitlock and Priya Nair with Alex Morgan and Sam Okafor');
  assert.equal(peopleLine(call({ title: 'Voicemail', people: [{ name: 'Dana Whitlock', role: 'candidate' }] })), 'Dana Whitlock', 'nobody from the agency named');
  assert.equal(peopleLine(call({ people: [{ name: ' ', role: 'candidate' }, { name: null, role: 'interviewer' }] })), '', 'people without a name are left out');
  assert.equal(peopleLine(call({ people: undefined })), '');
});

test('a Metaview call says what kind it was, how it was held and how long it lasted', () => {
  assert.equal(kindLine(call()), 'Job Interview · Phone · 25 min');
  assert.equal(kindLine(call({ minutes: 75, channel: 'Zoom' })), 'Job Interview · Zoom · 1 h 15 min');
  assert.equal(kindLine(call({ minutes: null })), 'Job Interview · Phone', 'the length is not always known');
  assert.equal(kindLine(call({ kind: '', channel: null, minutes: 0 })), '');
});

test('whose a Metaview call is in The Book', () => {
  assert.equal(whoseCall(call({ match: person() })), 'matched');
  assert.equal(whoseCall(call({ suggestions: [person({ how: 'name' }), person({ application_id: 8, candidate_id: 4 })] })), 'choose');
  assert.equal(whoseCall(call()), 'nobody');
  assert.equal(whoseCall(call({ suggestions: undefined })), 'nobody');
  assert.equal(whoseCall(call({ match: person(), suggestions: [person()] })), 'matched', 'a match needs nobody to choose');
});

test('somebody offered for a call by name is said to have a similar name, not the same one', () => {
  assert.equal(MATCHED_BY.name, 'Same name', 'a match by name is the whole name');
  assert.equal(OFFERED_BY.name, 'Similar name', 'an offer by name is a first name or part of one');
  assert.equal(OFFERED_BY.phone, MATCHED_BY.phone);
  assert.equal(OFFERED_BY.email, MATCHED_BY.email);
});

test('while the history is being read, the tab says how far it has got', () => {
  assert.equal(readingLine({ catching_up: true, known: 600, total: 2100 }), 'Reading your Metaview history: 600 of about 2,100 so far');
  assert.equal(readingLine({ catching_up: true, known: 600 }), 'Reading your Metaview history: 600 calls so far', 'when how many there are in all is not known');
  assert.equal(readingLine({ catching_up: true, known: 1 }), 'Reading your Metaview history: 1 call so far');
  assert.equal(readingLine({ catching_up: true, known: 2100, total: 2100 }), 'Reading your Metaview history: 2,100 calls so far');
  assert.equal(readingLine({ catching_up: false, known: 2100 }), '', 'nothing once it has caught up');
  assert.equal(readingLine(null), '');
});

test('settings say how many Metaview calls The Book can see and how many have been brought in', () => {
  assert.equal(knownLine({ known: 2100, in_the_book: 38 }), 'The Book can see 2,100 Metaview calls. 38 of them have been brought in.');
  assert.equal(knownLine({ known: 2100, in_the_book: 1 }), 'The Book can see 2,100 Metaview calls. 1 of them has been brought in.');
  assert.equal(knownLine({ known: 2100, in_the_book: 0 }), 'The Book can see 2,100 Metaview calls. None of them have been brought in yet.');
  assert.equal(knownLine({ known: 3, in_the_book: 3 }), 'The Book can see 3 Metaview calls. All of them have been brought in.');
  assert.equal(knownLine({ known: 1, in_the_book: 0 }), 'The Book can see 1 Metaview call. It has not been brought in yet.');
  assert.equal(knownLine({ known: 1, in_the_book: 1 }), 'The Book can see 1 Metaview call. It has been brought in.');
  assert.equal(knownLine({ known: 0, in_the_book: 0 }), 'The Book has not found any calls in Metaview yet.');
});

test('a phone number on a profile is a link that dials it, however it was typed', () => {
  assert.equal(telHref('+1 (416) 555-0142'), 'tel:+14165550142');
  assert.equal(telHref('416.555.0142 ext'), 'tel:4165550142');
  assert.equal(telHref(null), 'tel:');
});
