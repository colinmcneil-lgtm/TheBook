// The calendar's pure parts, with no server: reading a day out of a calendar file, finding the call in an event, and
// working out from names who an event is with. Run with `npm test`.
//
// The calendar files in test/fixtures/calendar are hand-written to look like what Google and Outlook publish. No
// real calendar link was read, so these tests cannot prove what a real link contains.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseFeed, eventsForDay } from '../server/calendar-day.js';
import { dayWindow, validDay, validZone, wallClock } from '../server/calendar-time.js';
import { findJoinLink, findPhones, unwrapUrl, toE164 } from '../server/calendar-links.js';
import { nameTokens, emailsOf, shortlistWords, namedIn, likeliestFirst } from '../server/calendar-match.js';
import { readDay, forgetRead, stopReader, CalendarReadError } from '../server/calendar-worker.js';
import { calendarFile, dayOfFile, calendar, vevent, at } from './calendar-helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const google = calendarFile('google-like.ics'), outlook = calendarFile('outlook-like.ics');
const titled = (events, start) => events.find((e) => e.title.startsWith(start));

// ---------- a day, on the recruiter's clock ----------
test('a Google-style calendar: one day in Toronto', () => {
  const day = dayOfFile(google, '2026-11-10');
  assert.deepEqual(day.lines, [
    'all day Sam out of office (2 days, all-day)',
    '10:30-10:45 Morning Huddle (moved to 10:30)',          // one date of a weekly event, moved from 09:00
    '11:00-11:30 Zoom screen - Priya Nair',
    '12:00-13:00 Lunch (floating time, no zone)',           // written with no time zone: read as the recruiter's clock
    '14:00-14:45 Interview: Kevin Tremblay - Senior Accountant',
    '16:00-16:15 Call Kevin',
  ]);
  assert.deepEqual(day.warnings, []);
  // The cancelled event is still handed over, flagged, so the caller is the one who leaves it out.
  assert.equal(titled(day.events, 'Coffee with Alex').cancelled, true);
  // "Remembrance Day" is all day on the 11th. It must not spill into the 10th, whatever zone the server is in.
  assert.equal(titled(day.events, 'Remembrance Day'), undefined);
  assert.deepEqual(dayOfFile(google, '2026-11-11').lines, ['all day Remembrance Day']);
  // An all-day event's start and end are the midnights of its first day and of the day after its last, in the recruiter's zone.
  const away = titled(day.events, 'Sam out of office');
  assert.equal(away.start.toISOString(), '2026-11-09T05:00:00.000Z');
  assert.equal(away.end.toISOString(), '2026-11-11T05:00:00.000Z');
});

test('guests, the link to join and phone numbers are read from an event', () => {
  const { events } = dayOfFile(google, '2026-11-10');
  const interview = titled(events, 'Interview: Kevin Tremblay');
  assert.deepEqual(interview.guests, [
    { email: 'dana.recruiter@example-agency.ca', name: 'Dana Recruiter' },
    { email: 'kevin.tremblay@example.com', name: null },                        // Google repeats the address as the name; that is not a name
    { email: 'morgan.lee@client-corp.example', name: 'Lee, Morgan (Client)' },
  ]);
  assert.deepEqual(interview.join, { kind: 'meet', url: 'https://meet.google.com/abc-defg-hij' });
  // The number in Meet's joining instructions reaches a conference bridge, not a person.
  assert.deepEqual(interview.phones, [{ e164: '+16475550123', person: false }]);
  assert.deepEqual(titled(events, 'Zoom screen').join, { kind: 'zoom', url: 'https://us02web.zoom.us/j/81234567890?pwd=QWxhZGRpbjpvcGVuIHNlc2FtZQ' });
  assert.deepEqual(titled(events, 'Call Kevin').phones, [{ e164: '+14165550142', person: true }]);
  assert.equal(titled(events, 'Call Kevin').join, null);
});

test('the days either side of a clock change in Toronto', () => {
  // Clocks went back on 1 November 2026, so that day is 25 hours long and the one before is 24.
  assert.equal(dayWindow('2026-11-01', 'America/Toronto').end - dayWindow('2026-11-01', 'America/Toronto').start, 25 * 3600000);
  assert.equal(dayWindow('2026-10-31', 'America/Toronto').end - dayWindow('2026-10-31', 'America/Toronto').start, 24 * 3600000);
  assert.equal(dayWindow('2026-03-08', 'America/Toronto').end - dayWindow('2026-03-08', 'America/Toronto').start, 23 * 3600000);
  // An event from 23:00 on the 31st to 03:00 on the 1st is five hours long that night, and is on both days.
  for (const day of ['2026-10-31', '2026-11-01']) {
    const { events, lines } = dayOfFile(google, day);
    assert.deepEqual(lines, ['23:00-03:00 Overnight job-board maintenance (crosses end of DST)']);
    assert.equal(events[0].end - events[0].start, 5 * 3600000);
  }
  assert.deepEqual(dayOfFile(google, '2026-11-02').lines, []);
  // A weekly 09:00 meeting stays at 09:00 on the wall before and after the change: an hour apart in UTC.
  const before = dayOfFile(google, '2026-10-27'), after = dayOfFile(google, '2026-11-03');
  assert.deepEqual([before.lines, after.lines], [['09:00-09:15 Morning Huddle'], ['09:00-09:15 Morning Huddle']]);
  assert.equal(before.events[0].start.toISOString(), '2026-10-27T13:00:00.000Z');
  assert.equal(after.events[0].start.toISOString(), '2026-11-03T14:00:00.000Z');
  // The same meeting seen from Los Angeles is three hours earlier on the clock.
  assert.deepEqual(dayOfFile(google, '2026-11-03', 'America/Los_Angeles').lines, ['06:00-06:15 Morning Huddle']);
});

test('a repeating event with one date moved, one deleted and one cancelled', () => {
  // Moved: the huddle of the 10th is at 10:30, and there is no second copy at 09:00.
  assert.equal(dayOfFile(google, '2026-11-10').lines.filter((l) => l.includes('Huddle')).length, 1);
  // Deleted: the huddle of the 17th is gone.
  assert.deepEqual(dayOfFile(google, '2026-11-17').lines, []);
  // Cancelled: the review of the 12th is flagged and so left out of the day; the week before it is there.
  const twelfth = dayOfFile(google, '2026-11-12');
  assert.deepEqual(twelfth.lines, []);
  assert.equal(titled(twelfth.events, 'Pipeline review').cancelled, true);
  assert.deepEqual(dayOfFile(google, '2026-11-05').lines, ['15:00-16:00 Pipeline review']);
  // A date moved to another day shows on the day it was moved to, not the one it came from.
  const edge = calendarFile('edge-cases.ics');
  assert.ok(dayOfFile(edge, '2026-11-10').lines.includes('16:30-17:00 E1 moved from Wed Nov 11 to Tue Nov 10 16:30'));
  assert.equal(dayOfFile(edge, '2026-11-11').lines.some((l) => l.includes('E1')), false);
});

test('an Outlook-style calendar: Windows time-zone names, a web-page description, wrapped links', () => {
  const day = dayOfFile(outlook, '2026-11-10');
  assert.deepEqual(day.lines, [
    '08:00-08:30 Vendor demo (Webex)',
    '09:30-10:15 Teams interview - Marc Gagnon (Controller role)',          // "Eastern Standard Time", defined in the file
    '11:00-11:30 Screening call with Aisha Khan',
    '12:00-12:30 Private Appointment',
    '13:00-13:30 West coast client call (Pacific zone, no VTIMEZONE block)', // "Pacific Standard Time", defined nowhere: 10:00 there
    '15:00-15:30 Weekly client sync (moved to 3 pm)',
    '16:15-16:45 One changed occurrence whose series is outside the published window',
    '17:00-17:30 Old Outlook desktop zone label',                            // "(UTC-05:00) Eastern Time (US & Canada)"
  ]);
  assert.equal(titled(day.events, 'Canceled: Budget review').cancelled, true); // Outlook marks a cancelled meeting in its title
  assert.equal(titled(day.events, 'Vendor demo').join.kind, 'webex');
  const teams = titled(day.events, 'Teams interview');
  assert.equal(teams.join.kind, 'teams');
  assert.match(teams.join.url, /^https:\/\/teams\.microsoft\.com\/l\/meetup-join\//);
  // The organiser counts as a guest: when a candidate sends the invitation, theirs is the address that matters.
  assert.deepEqual(teams.guests, [{ email: 'dana@example-agency.ca', name: 'Dana Recruiter' }, { email: 'marc.gagnon@example.org', name: 'Marc Gagnon' }]);
  assert.deepEqual(teams.phones, [{ e164: '+16475550199', person: false }]);
  // The Zoom link was inside a web-page description, wrapped by Outlook's link checker.
  assert.deepEqual(titled(day.events, 'Screening call').join, { kind: 'zoom', url: 'https://example-agency.zoom.us/j/92345678901?pwd=abcDEF123' });
  assert.deepEqual(titled(day.events, 'West coast').phones, [{ e164: '+16045550177', person: true }]);
});

test('time-zone labels seen in real calendars all read as Eastern time', () => {
  const labels = calendarFile('odd-zone-labels.ics');
  const winter = dayOfFile(labels, '2026-11-10');
  assert.equal(winter.lines.length, 17);
  assert.ok(winter.lines.every((l) => l.startsWith('10:00-10:15 ')), winter.lines.join('\n'));
  // In summer a label that is only an offset ("UTC-05:00", "EST") really is an hour behind Toronto's clock; the
  // rest follow the clock change. "(GMT-05:00) Eastern Time (US & Canada)" is read by its name, so it follows too.
  const summer = dayOfFile(labels, '2026-07-14');
  const late = summer.lines.filter((l) => l.startsWith('11:00-11:15 ')).map((l) => l.slice(21)).sort();
  assert.deepEqual(late, ['[EST]', '[Etc/GMT+5]', '[GMT-0500]', '[UTC-05:00]']);
  assert.equal(summer.lines.filter((l) => l.startsWith('10:00-10:15 ')).length, 13);
  // The two labels nobody knows are read as the recruiter's clock, and the recruiter is told.
  assert.equal(winter.warnings.length, 1);
  assert.match(winter.warnings[0], /time zone this reader does not know \("Eastern Standard Time 1", "US-Eastern"\)/);
});

test('time zones that exist only as a definition inside the file', () => {
  const made = calendarFile('made-up-zones.ics');
  const day = dayOfFile(made, '2026-11-10');
  const starts = Object.fromEntries(day.lines.map((l) => [l.split(' ')[1], l.split(' ')[0]]));
  assert.equal(starts.B1, '09:15-09:45');      // 20:00 at +05:45
  assert.equal(starts.B5, '03:30-04:00');      // 18:00 at +09:30, defined after the events that use it
  assert.equal(starts.B6, '09:00-09:30');      // a made-up name with Eastern rules
  assert.equal(starts.B7, '10:00-10:30');      // a made-up name with central European rules
  assert.equal(starts.B8, '09:00-09:30');      // 19:30 at +05:30
  assert.equal(starts.B4, '13:00-13:30');      // defined nowhere: shown as written, with a warning
  assert.match(day.warnings[0], /Narnia\/Lamp-post/);
  // Europe and Canada change their clocks on different dates: in the week between, the Paris meeting is an hour later in Toronto.
  assert.ok(dayOfFile(made, '2026-10-27').lines.some((l) => l.startsWith('11:00-11:30 B7')));
  // The made-up Eastern zone keeps its weekly meeting at 09:00 across the change, and its deleted date stays deleted.
  assert.ok(dayOfFile(made, '2026-10-27').lines.some((l) => l.startsWith('09:00-09:30 B6')));
  assert.equal(dayOfFile(made, '2026-11-03').lines.some((l) => l.includes('B6')), false);
});

test('a repeating event changed "from this date onwards"', () => {
  const split = calendarFile('this-and-following.ics');
  // The way Google writes it (the old series is ended and a new one begins): no duplicate and no gap.
  assert.deepEqual(dayOfFile(split, '2026-11-10').lines, [
    '08:45-09:00 A4 Standup',
    '09:00-09:15 A3 Tue 09:00, UNTIL = Nov 10 occurrence itself',
    '14:00-14:30 A1 new series Tue 14:00 (from Nov 10)',
    '17:00-17:30 A5 moved to 17:00 (override comes first in file)',
  ]);
  assert.ok(dayOfFile(split, '2026-11-03').lines.includes('09:00-09:30 A1 old series Tue 09:00 (ends before Nov 10)'));
  // The standard's own way of writing it changes one date only here, and the recruiter is warned about that.
  assert.match(dayOfFile(split, '2026-11-10').warnings[0], /from this date onwards/);
});

test('the rarer ways of writing an event', () => {
  const edge = calendarFile('edge-cases.ics');
  assert.deepEqual(dayOfFile(edge, '2026-11-10').lines, [
    '22:00-02:00 E18 started Nov 9 22:00 and runs to Nov 10 02:00',                       // began the evening before
    '10:00-10:30 E19 weekly Tuesday defined in UTC 15:00Z (local time shifts with DST)',
    '11:15-11:45 E8 Outlook "Customized Time Zone" 11:15',
    '13:00-14:00 E14 monthly second Tuesday 13:00',
    '15:00-15:30 E20 Outlook tzone://Microsoft/Utc 20:00Z',
    '16:30-17:00 E1 moved from Wed Nov 11 to Tue Nov 10 16:30',
    '18:00-18:45 E6 DURATION PT45M instead of DTEND',
  ]);
  assert.deepEqual(dayOfFile(edge, '2026-11-06').lines, ['all day E2 Timesheets due (weekly all-day Friday)', '11:00-11:15 E4 daily 11:00 with two UTC EXDATEs (Nov 10 and 11)']);
  // A file with no time-zone information at all: every time is the recruiter's clock.
  assert.deepEqual(dayOfFile(calendarFile('floating-no-vtimezone.ics'), '2026-11-10').lines,
    ['09:00-09:30 F2 floating weekly 09:00 (Tuesdays)', '12:00-12:30 F1 floating 12:00 in a file with no VTIMEZONE at all']);
});

test('the answer is the same wherever the server runs', () => {
  const print = (zone) => {
    const run = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(HERE, 'calendar-day-print.mjs')], { env: { PATH: process.env.PATH, TZ: zone }, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout;
  };
  const utc = print('UTC');
  assert.ok(utc.split('\n').length > 300);
  for (const zone of ['America/Toronto', 'Asia/Tokyo', 'Pacific/Auckland']) assert.equal(print(zone), utc, `the server in ${zone} gave a different answer`);
});

test('an event keeps its identity when it is renamed or moved', () => {
  const idOf = (text, day, title) => titled(dayOfFile(text, day).events, title).id;
  // One date of a repeating event: named by the time it was first set for, so moving it changes nothing.
  assert.equal(idOf(google, '2026-11-10', 'Morning Huddle'), 'huddle-weekly-001@google.com#2026-11-10T14:00:00.000Z');
  assert.equal(idOf(google, '2026-11-03', 'Morning Huddle'), 'huddle-weekly-001@google.com#2026-11-03T14:00:00.000Z');
  // One date of an all-day repeating event is named by its date.
  assert.equal(idOf(calendarFile('edge-cases.ics'), '2026-11-06', 'E2 Timesheets'), 'edge-allday-weekly-2#2026-11-06');
  // ...and keeps that name when the one date is moved to another day.
  const timesheets = calendar(
    vevent('UID:ad@test', 'SUMMARY:Timesheets', 'DTSTART;VALUE=DATE:20261002', 'DTEND;VALUE=DATE:20261003', 'RRULE:FREQ=WEEKLY;BYDAY=FR'),
    vevent('UID:ad@test', 'RECURRENCE-ID;VALUE=DATE:20261106', 'SUMMARY:Timesheets (moved to Thursday)', 'DTSTART;VALUE=DATE:20261105', 'DTEND;VALUE=DATE:20261106'));
  assert.equal(idOf(timesheets, '2026-11-05', 'Timesheets'), 'ad@test#2026-11-06');
  assert.deepEqual(dayOfFile(timesheets, '2026-11-06').lines, []);
  // A single event: renamed, and moved to another day and time.
  const first = calendar(vevent('UID:one@test', 'SUMMARY:Call Kevin', `DTSTART${at('20261110', '1600')}`, `DTEND${at('20261110', '1615')}`));
  const later = calendar(vevent('UID:one@test', 'SUMMARY:Call Kevin Tremblay (moved)', `DTSTART${at('20261112', '0930')}`, `DTEND${at('20261112', '1000')}`));
  assert.equal(idOf(first, '2026-11-10', 'Call Kevin'), 'one@test');
  assert.equal(idOf(later, '2026-11-12', 'Call Kevin'), 'one@test');
  // Every event of a day has an identity of its own.
  for (const file of ['google-like.ics', 'outlook-like.ics', 'edge-cases.ics', 'this-and-following.ics']) {
    const ids = dayOfFile(calendarFile(file), '2026-11-10').events.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length, file);
  }
});

test('what is not a calendar, and what would flood one', () => {
  assert.throws(() => parseFeed(calendarFile('not-ics.html'), 'America/Toronto'), /not a calendar/);
  assert.throws(() => parseFeed('', 'America/Toronto'), /not a calendar/);
  // Rules that repeat every second or every minute are left out, with a sentence saying so; a daily one since 1990 is fine.
  const started = Date.now();
  const hostile = dayOfFile(calendarFile('hostile.ics'), '2026-11-10');
  assert.deepEqual(hostile.lines, ['08:00-08:15 H3 daily since 1990 (legit but old)']);
  assert.deepEqual(hostile.warnings, [
    '"H1 every second since 2020" was left out because it repeats every second.',
    '"H2 every minute since 2020" was left out because it repeats every minute.',
  ]);
  assert.ok(Date.now() - started < 3000);
  // What leaves the reader is cut to length, however long the calendar made it.
  const long = calendar(vevent('UID:long@test', `SUMMARY:${'T'.repeat(5000)}`, `LOCATION:${'L'.repeat(50000)}`, `DESCRIPTION:${'D'.repeat(300000)}`, `DTSTART${at('20261110', '0900')}`, `DTEND${at('20261110', '0930')}`,
    ...Array.from({ length: 700 }, (_, i) => `ATTENDEE;CN=Guest ${i}:mailto:guest${i}@example.com`)));
  const [event] = dayOfFile(long, '2026-11-10').events;
  assert.deepEqual([event.title.length, event.location.length, event.description.length, event.guests.length], [300, 2000, 20000, 100]);
});

test('text written to make the reader slow does not', () => {
  // Anyone can send a recruiter an invitation, so the text of an event is a stranger's. Before the patterns were
  // rewritten, the first of these took 83 seconds and the second 37.
  const descriptions = {
    'a run of "<"': `<b>x</b>${'<'.repeat(200000)}`,
    'letters only': 'a'.repeat(200000),
    '"<a " repeated': `<b>x</b>${'<a '.repeat(66000)}`,
    'digits and dashes': '4-'.repeat(100000),
    '"+1 " repeated': '+1 '.repeat(66000),
    'half an address': `${'a.'.repeat(100000)}@`,
    'links': 'https://a.'.repeat(20000),
  };
  for (const [name, description] of Object.entries(descriptions)) {
    const text = calendar(vevent('UID:h@test', 'SUMMARY:Call Kevin', `DESCRIPTION:${description}`, `DTSTART${at('20261110', '0900')}`, `DTEND${at('20261110', '0930')}`));
    const started = Date.now();
    const [event] = dayOfFile(text, '2026-11-10').events;
    emailsOf(event); shortlistWords(event);
    namedIn(event, [{ id: 1, name: 'Kevin Tremblay' }]);
    likeliestFirst(event, [{ id: 1, name: 'Kevin Tremblay', job_titles: ['Senior Accountant'], client_names: ['Maple Freight'], company: 'Acme' }]);
    assert.ok(Date.now() - started < 2000, `${name} took ${Date.now() - started} ms`);
  }
});

test('calendars are read on a thread of their own, which may fail without taking anything with it', async () => {
  const ask = (text, version, ymd = '2026-11-10') => readDay({ version, text, zone: 'America/Toronto', ymd });
  try {
    // The same answer as reading it directly.
    const direct = eventsForDay(parseFeed(google, 'America/Toronto'), '2026-11-10');
    const read = await ask(google, 'v1');
    assert.deepEqual(read, direct);
    assert.ok(read.events[1].start instanceof Date);
    // What is not a calendar, or is one that cannot be understood, is an ordinary refusal, remembered so it is not read twice.
    for (let i = 0; i < 2; i++) await assert.rejects(ask('<html>Sign in</html>', 'v2'), (err) => err instanceof CalendarReadError && err.code === 'not_a_calendar');
    // The thread stops in the middle of a request (as it would if it ran out of memory): the request is refused,
    // nothing else is harmed, and the next request starts a fresh thread.
    const interrupted = ask(calendar(...Array.from({ length: 3000 }, (_, i) => vevent(`UID:e${i}`, `SUMMARY:Event ${i}`, `DTSTART${at('20261110', '0900')}`, `DTEND${at('20261110', '0930')}`))), 'v3');
    stopReader();
    await assert.rejects(interrupted, (err) => err instanceof CalendarReadError && err.code === 'unreadable');
    assert.deepEqual((await ask(google, 'v1', '2026-11-03')).events.map((e) => e.title), ['Morning Huddle']);
    // Forgetting a download only means it is read again when next asked for.
    forgetRead('v1');
    assert.equal((await ask(google, 'v1')).events.length, direct.events.length);
  } finally {
    stopReader();
  }
});

// ---------- the call inside an event ----------
test('links to join a meeting', () => {
  const found = (text, where = 'description') => { const r = findJoinLink({ [where]: text }); return r ? `${r.kind} ${r.url}` : null; };
  assert.equal(found('Join with Google Meet: https://meet.google.com/abc-defg-hij\nOr dial'), 'meet https://meet.google.com/abc-defg-hij');
  assert.equal(found('https://meet.google.com/abc-defg-hij?authuser=0.'), 'meet https://meet.google.com/abc-defg-hij?authuser=0');
  assert.equal(found('meet at https://meet.google.com/lookup/team-standup'), 'meet https://meet.google.com/lookup/team-standup');
  assert.equal(found('https://us02web.zoom.us/j/81234567890?pwd=QWxhZGRpbg', 'location'), 'zoom https://us02web.zoom.us/j/81234567890?pwd=QWxhZGRpbg');
  assert.equal(found('Zoom: https://zoom.us/j/5551112222'), 'zoom https://zoom.us/j/5551112222');
  assert.equal(found('https://acme.zoom.us/my/dana.recruiter'), 'zoom https://acme.zoom.us/my/dana.recruiter');
  assert.equal(found('https://app.zoom.us/wc/join/81234567890'), 'zoom https://app.zoom.us/wc/join/81234567890');
  assert.equal(found('https://www.zoomgov.com/j/1612345678?pwd=abc'), 'zoom https://www.zoomgov.com/j/1612345678?pwd=abc');
  assert.equal(found('Join: https://teams.microsoft.com/l/meetup-join/19%3ameeting_MjA0%40thread.v2/0?context=%7b%22Tid%22%3a%221%22%7d\nMeeting ID'),
    'teams https://teams.microsoft.com/l/meetup-join/19%3ameeting_MjA0%40thread.v2/0?context=%7b%22Tid%22%3a%221%22%7d');
  assert.equal(found('https://teams.microsoft.com/meet/23456789012345?p=AbCdEf123'), 'teams https://teams.microsoft.com/meet/23456789012345?p=AbCdEf123');
  assert.equal(found('https://teams.live.com/meet/9361234567890?p=xyz'), 'teams https://teams.live.com/meet/9361234567890?p=xyz');
  assert.equal(found('https://gov.teams.microsoft.us/l/meetup-join/19%3ameeting_x%40thread.v2/0'), 'teams https://gov.teams.microsoft.us/l/meetup-join/19%3ameeting_x%40thread.v2/0');
  assert.equal(found('https://acme.webex.com/acme/j.php?MTID=m0123456789abcdef'), 'webex https://acme.webex.com/acme/j.php?MTID=m0123456789abcdef');
  assert.equal(found('https://acme.webex.com/meet/dana.recruiter'), 'webex https://acme.webex.com/meet/dana.recruiter');
  assert.equal(found('<a href="https://acme.webex.com/join/dana">Join</a>'), 'webex https://acme.webex.com/join/dana');
  // Links wrapped by a mail system are unwrapped.
  assert.equal(found('https://can01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fus06web.zoom.us%2Fj%2F123456789%3Fpwd%3Dabc&data=05%7C02&reserved=0'), 'zoom https://us06web.zoom.us/j/123456789?pwd=abc');
  assert.equal(found('<a href="https://www.google.com/url?q=https://meet.google.com/xyz-abcd-efg&amp;sa=D">link</a>'), 'meet https://meet.google.com/xyz-abcd-efg');
  assert.equal(unwrapUrl('https://example.com/a?b=c'), 'https://example.com/a?b=c');
  // Things that look close but are not a way into a meeting.
  for (const not of ['Learn more about Meet at: https://support.google.com/a/users/answer/9282720', 'More phone numbers: https://tel.meet/abc-defg-hij?pin=123',
    'Download Zoom: https://zoom.us/download', 'Boardroom, 2nd floor', 'javascript:alert(1)//meet.google.com/abc-defg-hij', 'http://meet.google.com/abc-defg-hij',
    'https://meet.google.com.evil.example/abc-defg-hij', 'https://evil.example/?u=https://zoom.us.evil.example/j/1']) assert.equal(found(not), null, not);
  // The calendar's own line for its meeting is believed before the location, and the location before the description.
  assert.equal(findJoinLink({ conferenceProps: ['https://meet.google.com/aaa-bbbb-ccc'], description: 'old link https://zoom.us/j/111' }).kind, 'meet');
  assert.equal(findJoinLink({ location: 'https://zoom.us/j/222', description: 'https://meet.google.com/aaa-bbbb-ccc' }).kind, 'zoom');
});

test('phone numbers: a person\'s, or the meeting\'s', () => {
  const phones = (ev) => findPhones(ev).map((p) => `${p.e164}${p.person ? '' : ' dial-in'}`);
  assert.deepEqual(phones({ description: 'Follow up on offer. Cell: +1 (416) 555-0142' }), ['+14165550142']);
  assert.deepEqual(phones({ location: '416-555-0142' }), ['+14165550142']);
  assert.deepEqual(phones({ title: 'Call Kevin 647.555.0190' }), ['+16475550190']);
  assert.deepEqual(phones({ description: '<a href="tel:+16135550111">call</a>' }), ['+16135550111']);
  assert.deepEqual(phones({ description: 'Office 905-555-0100 ext. 204' }), ['+19055550100']);
  assert.deepEqual(phones({ description: 'Recruiter in London: +44 20 7946 0958' }), ['+442079460958']);
  assert.deepEqual(phones({ description: 'Notes\n-::~:~::~:~:\nJoin with Google Meet: https://meet.google.com/abc-defg-hij\nOr dial: (CA) +1 647-555-0123 PIN: 123456789#' }), ['+16475550123 dial-in']);
  assert.deepEqual(phones({ description: 'Dial in by phone\n+1 647-555-0199,,123456789# Canada, Toronto\nPhone conference ID: 123 456 789#' }), ['+16475550199 dial-in']);
  assert.deepEqual(phones({ description: 'Candidate cell 416-555-0142\n\nOne tap mobile\n+16475580588,,81234567890# Canada' }), ['+14165550142', '+16475580588 dial-in']);
  // Not phone numbers: a meeting number, ten digits with nothing between them, a date and a time.
  assert.deepEqual(phones({ description: 'Meeting ID: 812 3456 7890\nPasscode: 123456' }), []);
  assert.deepEqual(phones({ description: 'ref 4165550142' }), []);
  assert.deepEqual(phones({ description: 'On 2026-11-10 at 14:00-14:45, room 2045551' }), []);
  assert.deepEqual(['(416) 555-0142', '1 416 555 0142', '+44 20 7946 0958', '555-0142', 'call me'].map(toE164), ['+14165550142', '+14165550142', '+442079460958', null, null]);
});

// ---------- who an event is with, from names ----------
const PEOPLE = [
  { id: 101, name: 'Kevin Tremblay', job_titles: ['Senior Accountant'], client_names: ['Maple Freight'], company: 'Ledgerline' },
  { id: 102, name: 'Kevin Osei', job_titles: ['Office Manager'], client_names: ['Northline Dental'], company: null },
  { id: 103, name: 'Priya Nair' }, { id: 105, name: 'Aïsha Khan' }, { id: 106, name: 'Aisha Khan' },
  { id: 107, name: 'Jean-François Côté' }, { id: 108, name: 'Sam Lee' }, { id: 109, name: 'Samantha Lee' }, { id: 111, name: 'Cher' },
];
const named = (event, own) => { const r = namedIn({ guests: [], ...event }, PEOPLE, own); return { full: r.full.map((p) => p.id), first: r.first.map((p) => p.id) }; };

test('a full name in the title or as a guest\'s name is strong; a first name is not', () => {
  assert.deepEqual(named({ title: 'Zoom screen - Priya Nair' }), { full: [103], first: [] });
  assert.deepEqual(named({ title: 'Interview', guests: [{ email: 'someone@unknown.example', name: 'Nair, Priya' }] }), { full: [103], first: [] });
  assert.deepEqual(named({ title: 'Entrevue avec Jean-Francois Cote' }), { full: [107], first: [] });                   // accents ignored
  assert.deepEqual(named({ title: 'TREMBLAY KEVIN - second round' }), { full: [101], first: [102] });                    // last name first
  assert.deepEqual(named({ title: 'Screening call with Aisha Khan' }), { full: [105, 106], first: [] });                 // two people: the caller must ask
  assert.deepEqual(named({ title: 'Coffee with Sam Lee' }), { full: [108], first: [] });                                 // not Samantha Lee
  assert.deepEqual(named({ title: 'Coffee with Samantha' }), { full: [], first: [109] });
  assert.deepEqual(named({ title: 'Call Kevin' }), { full: [], first: [101, 102] });
  assert.deepEqual(named({ title: 'Call Cher' }), { full: [], first: [111] });                                           // one word is never a full name
  assert.deepEqual(named({ title: 'Morning Huddle' }), { full: [], first: [] });
  // A colleague's name as a guest says nothing about the candidate.
  assert.deepEqual(named({ title: 'Catch-up', guests: [{ email: 'priya@agency.example', name: 'Priya Nair' }] }, new Set(['priya@agency.example'])), { full: [], first: [] });
  assert.deepEqual(nameTokens('Tremblay, Kévin (Client)'), ['kevin', 'tremblay']);
  assert.deepEqual(nameTokens('Dr. Priya Nair CPA'), ['priya', 'nair']);
});

test('people named only by a first name are offered likeliest first', () => {
  const order = (event, near) => likeliestFirst({ description: '', ...event }, [PEOPLE[0], PEOPLE[1]], near).map((p) => p.id);
  assert.deepEqual(order({ title: 'Call Kevin' }), [102, 101]);                                         // nothing to tell them apart: by name
  assert.deepEqual(order({ title: 'Call Kevin T.' }), [101, 102]);                                      // the initial of the last name follows
  assert.deepEqual(order({ title: 'Kevin - Senior Accountant second round' }), [101, 102]);             // the job is named
  assert.deepEqual(order({ title: 'Call Kevin', description: 'About the Maple Freight role' }), [101, 102]);
  assert.deepEqual(order({ title: 'Call Kevin', description: 'He is at Ledgerline now' }), [101, 102]);
  assert.deepEqual(order({ title: 'Call Kevin' }, new Set([101])), [101, 102]);                         // an interview is booked with him at that time
});

test('the addresses and words an event is looked up by', () => {
  const event = {
    title: 'Intro: send to PRIYA.NAIR@example.org', description: 'cc k.osei@example.net, not a@b or @nobody.',
    guests: [{ email: 'Kevin.Tremblay@Example.com', name: 'Kevin Tremblay' }, { email: 'room-12@resource.calendar.google.com', name: 'Boardroom' }, { email: 'calendar-notification@google.com', name: null }],
  };
  assert.deepEqual(emailsOf(event).sort(), ['k.osei@example.net', 'kevin.tremblay@example.com', 'priya.nair@example.org']);
  assert.deepEqual(shortlistWords({ title: 'Call Kévin O. re: offer', guests: [{ name: 'Nair, Priya', email: null }] }).sort(), ['call', 'kevin', 'nair', 'offer', 'priya', 're']);
});

test('dates and time zones a request may ask for', () => {
  assert.deepEqual(['2026-11-10', '2024-02-29', '2026-02-30', '2026-13-01', '10/11/2026', '', null, '1026-11-10'].map(validDay), [true, true, false, false, false, false, false, false]);
  assert.deepEqual(['America/Toronto', 'America/Vancouver', 'UTC', 'Mars/Olympus', '', null, 'x'.repeat(100)].map(validZone), [true, true, true, false, false, false, false]);
  assert.equal(wallClock(new Date('2026-11-10T04:59:00Z'), 'America/Toronto').ymd, '2026-11-09');
  assert.equal(wallClock(new Date('2026-11-10T05:00:00Z'), 'America/Toronto').ymd, '2026-11-10');
});
