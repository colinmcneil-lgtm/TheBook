// The rules behind The Oracle's phone and calendar screens: when a reminder is due, what a call is called at each
// stage, how numbers are shown. Run with `npm test`.
// The screens themselves (React, the browser's notifications) were checked in a real browser against a stand-in for
// the phone and calendar routes; these are the parts that can be checked without one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LEAD, MINUTE, SOON, dayLabel, dueNow, endsAt, isDue, isNear, lengthOf, shiftDay } from '../src/oracle/day.js';
import { followed, headline, isOver, madeBy, showNumber, telHref, typedNumber } from '../src/oracle/calls.js';

const START = Date.parse('2026-11-10T19:00:00Z');
const event = (more = {}) => ({ key: 'e1', title: 'Call Kevin', start: new Date(START).toISOString(), end: new Date(START + 30 * MINUTE).toISOString(), all_day: false, added: true, call_id: null, ...more });

test('a reminder is due from two minutes before an added event until it ends', () => {
  const e = event();
  assert.equal(isDue(e, START - LEAD - 1000), false, 'not yet, a second before the two minutes');
  assert.equal(isDue(e, START - LEAD), true, 'two minutes before');
  assert.equal(isDue(e, START + 10 * MINUTE), true, 'while it is under way');
  assert.equal(isDue(e, START + 30 * MINUTE), false, 'not once it is over');
});

test('no reminder for an event that was not added, lasts all day, or already has its call', () => {
  assert.equal(isDue(event({ added: false }), START), false);
  assert.equal(isDue(event({ all_day: true }), START), false);
  assert.equal(isDue(event({ call_id: 7 }), START), false);
});

test('an event with no length is treated as five minutes long, so its reminder does not vanish at once', () => {
  const e = event({ end: new Date(START).toISOString() });
  assert.equal(endsAt(e), START + 5 * MINUTE);
  assert.equal(isDue(e, START + 4 * MINUTE), true);
  assert.equal(isDue(e, START + 5 * MINUTE), false);
});

test('reminders come soonest first, without the ones closed or being dealt with', () => {
  const later = event({ key: 'later', start: new Date(START + MINUTE).toISOString(), end: new Date(START + 20 * MINUTE).toISOString() });
  const first = event({ key: 'first' });
  const closed = event({ key: 'closed' });
  const calling = event({ key: 'calling' });
  const due = dueNow([later, first, closed, calling], START, { closed: new Set(['closed']), busyWith: 'calling' });
  assert.deepEqual(due.map((e) => e.key), ['first', 'later']);
  assert.deepEqual(dueNow(undefined, START), [], 'no day loaded yet');
});

test('Record and Call are offered from a quarter of an hour before an event until a quarter of an hour after it', () => {
  const e = event();
  assert.equal(isNear(e, START - SOON - 1000), false);
  assert.equal(isNear(e, START - SOON), true);
  assert.equal(isNear(e, START + 30 * MINUTE + SOON - 1000), true);
  assert.equal(isNear(e, START + 30 * MINUTE + SOON), false);
  assert.equal(isNear(event({ all_day: true }), START), false);
});

test('moving a day at a time crosses months, years and clock changes', () => {
  assert.equal(shiftDay('2026-11-30', 1), '2026-12-01');
  assert.equal(shiftDay('2026-12-31', 1), '2027-01-01');
  assert.equal(shiftDay('2027-01-01', -1), '2026-12-31');
  assert.equal(shiftDay('2028-02-28', 1), '2028-02-29');
  // The days around the autumn and spring clock changes in Ontario: each step is exactly one day wherever this runs.
  assert.equal(shiftDay('2026-10-31', 1), '2026-11-01');
  assert.equal(shiftDay('2026-11-01', 1), '2026-11-02');
  assert.equal(shiftDay('2027-03-13', 1), '2027-03-14');
  assert.equal(shiftDay('2027-03-15', -1), '2027-03-14');
});

test('the day is named Today, Tomorrow or Yesterday when it is one of them', () => {
  assert.match(dayLabel('2026-11-10', '2026-11-10'), /^Today, /);
  assert.match(dayLabel('2026-11-11', '2026-11-10'), /^Tomorrow, /);
  assert.match(dayLabel('2026-11-09', '2026-11-10'), /^Yesterday, /);
  assert.doesNotMatch(dayLabel('2026-11-13', '2026-11-10'), /Today|Tomorrow|Yesterday/);
  assert.match(dayLabel('2026-11-13', '2026-11-10'), /13/);
});

test('how long an event is', () => {
  const lasting = (minutes) => lengthOf(event({ end: new Date(START + minutes * MINUTE).toISOString() }));
  assert.equal(lasting(15), '15 min');
  assert.equal(lasting(60), '1 h');
  assert.equal(lasting(90), '1 h 30 min');
});

test('numbers are shown the way people write them, and anything else is left alone', () => {
  assert.equal(showNumber('+14165550142'), '(416) 555-0142');
  assert.equal(showNumber('+442079460958'), '+442079460958');
  assert.equal(showNumber('(416) 555 0142'), '(416) 555 0142');
  assert.equal(showNumber(null), '');
  assert.equal(telHref('+1 (416) 555-0142'), 'tel:+14165550142');
  assert.equal(telHref('416.555.0142 ext'), 'tel:4165550142');
});

test('what is typed is offered as a number to call only when it reads as one', () => {
  assert.equal(typedNumber(' 647 555 0199 '), '647 555 0199');
  assert.equal(typedNumber('+1 (647) 555-0199'), '+1 (647) 555-0199');
  assert.equal(typedNumber('555-01'), null, 'too short to be a number: it is a search');
  assert.equal(typedNumber('kevin 647'), null);
  assert.equal(typedNumber(''), null);
});

test('each stage of a call has its few words', () => {
  const call = (status, more = {}) => ({ status, outcome: null, candidate_name: 'Kevin Tremblay', to_display: '(647) 555-0199', ...more });
  assert.equal(headline(call('ringing_you')), 'Ringing your phone…');
  assert.equal(headline(call('waiting_for_you')), 'Answer and press 1');
  assert.equal(headline(call('calling_them')), 'Calling Kevin…');
  assert.equal(headline(call('calling_them', { candidate_name: null })), 'Calling (647) 555-0199…');
  assert.equal(headline(call('in_call')), 'On the call');
  assert.equal(headline(call('ended', { outcome: 'completed' })), 'Call ended');
  assert.equal(headline(call('ended', { outcome: 'busy' })), 'Busy');
  assert.equal(headline(call('ended', { outcome: 'no_answer' })), 'No answer');
  assert.equal(headline(call('ended', { outcome: 'you_did_not_answer' })), 'Nobody was called');
  assert.equal(headline(call('ended', { outcome: 'cancelled' })), 'Call cancelled');
  assert.equal(headline(call('failed', { outcome: 'failed' })), 'The call was not made');
  assert.equal(headline(call('failed')), 'The call was not made', 'a failure with no outcome given');
  // A call this page did not place: one that came in, and one rung in from the recruiter's own phone.
  assert.equal(headline(call('ringing_you', { direction: 'inbound' })), 'A call is coming in');
  assert.equal(headline(call('waiting_for_you', { direction: 'switchboard' })), 'Calling from your phone');
  assert.equal(isOver(call('ended')), true);
  assert.equal(isOver(call('failed')), true);
  assert.equal(isOver(call('in_call')), false);
});

test('the clock on a call counts from when this page saw the two connected', () => {
  const placed = { id: 1, status: 'calling_them', talkingSince: null, target: { to: '647 555 0199' } };
  const talking = followed(placed, { id: 1, status: 'in_call', message: 'You are talking to Kevin.' }, 5000);
  assert.equal(talking.talkingSince, 5000);
  assert.deepEqual(talking.target, placed.target, 'what was asked for is kept, so the call can be placed again');
  assert.equal(followed(talking, { id: 1, status: 'in_call' }, 9000).talkingSince, 5000, 'and does not start again on the next look');
  assert.equal(followed({ ...talking, lost: true }, { id: 1, status: 'in_call' }, 9000).lost, false, 'an answer means touch is back');
  // A call first seen when it was already under way (found after a reload) has no clock rather than a wrong one.
  assert.equal(followed({ id: 2, status: 'in_call', talkingSince: null }, { id: 2, status: 'in_call' }, 9000).talkingSince, null);
});

test('a call says how it came to be in The Oracle', () => {
  assert.equal(madeBy({ source: 'recorded', created_by_name: 'Alex Morgan' }), 'Recorded by Alex Morgan');
  assert.equal(madeBy({ source: 'uploaded', created_by_name: 'Alex Morgan' }), 'Uploaded by Alex Morgan');
  assert.equal(madeBy({ source: 'phone', direction: 'outbound', created_by_name: 'Alex Morgan' }), 'Phone call placed by Alex Morgan');
  assert.equal(madeBy({ source: 'phone', direction: 'inbound', created_by_name: 'Alex Morgan' }), 'Phone call taken by Alex Morgan');
  assert.equal(madeBy({ source: 'phone', direction: null, created_by_name: null }), 'Phone call made by someone who has left');
});
