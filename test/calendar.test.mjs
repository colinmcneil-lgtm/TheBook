// Your calendar in The Oracle, end to end: The Book's real API on a throwaway data folder, reading calendar files
// that the test writes into a folder (see CALENDAR_TEST_FILES in server/calendar.js). Run with `npm test`.
//
// Nothing here reads a real calendar link: Google, Outlook and iCloud cannot be reached from where this was built.
// The files imitate what they publish. How the reader of links behaves on the network is in calendar-fetch.test.mjs.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, session, tempDir, sleep, RECORDING } from './oracle-helpers.mjs';
import { startApi, PORTS, calendar, vevent, at, line } from './calendar-helpers.mjs';

const TZ = 'America/Toronto';
const DAY = '2026-11-10';
// A calendar link's path is its password. This one must never come back in an answer, a log or the database.
const TOKEN = 'private-5f1c9a7e3b2d4c6f8a0b1c2d3e4f5a6b';
const LINK = `https://calendar.test/${TOKEN}.ics`;
const CONSENT = { confirmed: true, wording: 'I have told everyone on this call that it is being recorded and transcribed, and they have agreed.' };

let api, dataDir, files;
let alex, dana, sam, maya;                 // the owner, two recruiters and a client's hiring manager
const app = {};                            // application ids, by a short name
const answers = [];                        // the text of every answer the API gave during the tests
let earlierLog = '';                       // what the server printed before it was restarted

// Every answer is kept, so that the last test can check that the calendar link was never in any of them.
const realFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  const res = await realFetch(...args);
  answers.push(res.clone().text().catch(() => ''));
  return res;
};

/** PUT with a JSON body (the shared session helper only PUTs bytes). */
async function put(who, pathname, json) {
  const res = await fetch(`${api.base}/api${pathname}`, { method: 'PUT', headers: { Cookie: who.cookie(), 'Content-Type': 'application/json' }, body: JSON.stringify(json) });
  return { status: res.status, body: await res.json() };
}
const dayOf = async (who, date = DAY, extra = '') => (await who.get(`/calendar/day?date=${date}&tz=${TZ}${extra}`)).body;
/** The day again, with the calendar read afresh (the server otherwise keeps a calendar for five minutes). */
const freshDay = (who, date = DAY) => dayOf(who, date, '&refresh=1');
const lines = (day) => day.events.map((e) => line(e, TZ));
const titled = (day, start) => day.events.find((e) => e.title.startsWith(start));
const who = (event) => (event.match ? `${event.match.name} (${event.match.how})` : null);
const offered = (event) => event.suggestions.map((s) => s.name).sort();

// ---------- the calendar the tests read ----------
const DANA = 'ATTENDEE;CN=Dana Recruiter;PARTSTAT=ACCEPTED:mailto:dana.recruiter@example-agency.ca';
const guest = (email, name) => `ATTENDEE${name ? `;CN=${name}` : ''};PARTSTAT=NEEDS-ACTION:mailto:${email}`;
const timed = (uid, title, from, to, ...more) => vevent(`UID:${uid}`, `SUMMARY:${title}`, `DTSTART${at('20261110', from)}`, `DTEND${at('20261110', to)}`, ...more);
const HUDDLE = vevent('UID:huddle@test', 'SUMMARY:Morning Huddle', `DTSTART${at('20261020', '0900')}`, `DTEND${at('20261020', '0915')}`, 'RRULE:FREQ=WEEKLY;BYDAY=TU', `EXDATE${at('20261117', '0900')}`, DANA, guest('sam@agency.example', 'Sam Okoro'));
const huddleMoved = (from, to) => vevent('UID:huddle@test', `RECURRENCE-ID${at('20261110', '0900')}`, 'SUMMARY:Morning Huddle (moved)', `DTSTART${at('20261110', from)}`, `DTEND${at('20261110', to)}`);
const CALL_KEVIN = timed('call-kevin@test', 'Call Kevin', '1600', '1615', 'DESCRIPTION:Follow up on offer. Cell: +1 (416) 555-0142');
const ONE_TO_ONE = vevent('UID:weekly-priya@test', 'SUMMARY:Weekly check-in', `DTSTART${at('20261020', '1530')}`, `DTEND${at('20261020', '1545')}`, 'RRULE:FREQ=WEEKLY;BYDAY=TU');
const EVENTS = {
  huddle: HUDDLE, huddleMoved: huddleMoved('1030', '1045'),
  french: timed('french@test', 'Entrevue avec Jean-Francois Cote', '0800', '0830'),
  zoom: timed('zoom-priya@test', 'Zoom screen - Priya Nair', '1100', '1130', 'LOCATION:https://us02web.zoom.us/j/81234567890?pwd=QWxhZGRpbg'),
  cancelled: timed('coffee@test', 'Coffee with Alex', '1200', '1230', 'STATUS:CANCELLED'),
  marc: timed('marc@test', 'Chat with Marc', '1300', '1330'),
  interview: timed('interview@test', 'Second interview - Senior Accountant', '1400', '1445', DANA, guest('Kevin.Tremblay@example.com'), guest('maya@maple.example', 'Maya Okonkwo'),
    'X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij', 'DESCRIPTION:Join with Google Meet: https://meet.google.com/abc-defg-hij\\nOr dial: (CA) +1 647-555-0190 PIN: 123456789#'),
  nadia: timed('nadia@test', 'Intro call', '1500', '1530', guest('nadia@example.com', 'Nadia Petrov')),
  oneToOne: ONE_TO_ONE,
  callKevin: CALL_KEVIN,
  catchUp: timed('catch-up@test', 'Catch up with Kevin', '1630', '1645'),
  aisha: timed('aisha@test', 'Screening call with Aisha Khan', '1700', '1730'),
  panel: timed('panel@test', 'Panel', '1800', '1830', guest('k.osei@example.net'), guest('priya.nair@example.org')),
  away: vevent('UID:away@test', 'SUMMARY:Out of office', 'DTSTART;VALUE=DATE:20261109', 'DTEND;VALUE=DATE:20261111'),
  overnight: vevent('UID:overnight@test', 'SUMMARY:Overnight maintenance', `DTSTART${at('20261031', '2300')}`, `DTEND${at('20261101', '0300')}`),
};
const writeCalendar = (events = EVENTS, name = `${TOKEN}.ics`) => fs.writeFileSync(path.join(files, name), calendar(...Object.values(events)));

before(async () => {
  dataDir = tempDir('calendar');
  files = tempDir('calendar-files');
  writeCalendar();
  fs.writeFileSync(path.join(files, 'page.ics'), '<!DOCTYPE html><title>Sign in to your account</title>');
  api = await startApi({ port: PORTS.api, dataDir, files });

  alex = session(api.base);
  assert.equal((await alex.post('/setup', { agencyName: 'Harbour Talent', name: 'Alex Morgan', email: 'alex@agency.example', password: 'demo1234' })).status, 200);
  const maple = (await alex.post('/clients', { name: 'Maple Freight' })).body.id;
  const northline = (await alex.post('/clients', { name: 'Northline Dental' })).body.id;
  const join = async (role, name, email, extra = {}) => {
    const { token } = (await alex.post('/invites', { role, email, ...extra })).body;
    const person = session(api.base);
    assert.equal((await person.post(`/invites/${token}/accept`, { name, password: 'demo1234' })).status, 200);
    return person;
  };
  dana = await join('recruiter', 'Dana Recruiter', 'dana.recruiter@example-agency.ca');
  sam = await join('recruiter', 'Sam Okoro', 'sam@agency.example');
  maya = await join('client', 'Maya Okonkwo', 'maya@maple.example', { client_id: maple });
  const job = async (clientId, title) => (await alex.post('/jobs', { client_id: clientId, title, status: 'open' })).body.id;
  const accountant = await job(maple, 'Senior Accountant'), payroll = await job(maple, 'Payroll Specialist');
  const manager = await job(northline, 'Office Manager'), hygienist = await job(northline, 'Hygienist');
  const add = async (by, jobId, fields) => {
    const made = await by.upload('/applications', { job_id: jobId, ...fields });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    return made.body.id;
  };
  app.kevinT = await add(dana, accountant, { name: 'Kevin Tremblay', email: 'kevin.tremblay@example.com', phone: '(416) 555-0142' });
  app.kevinO = await add(dana, manager, { name: 'Kevin Osei', email: 'k.osei@example.net', phone: '647-555-0190' });
  app.priya = await add(dana, payroll, { name: 'Priya Nair', email: 'priya.nair@example.org' });
  app.marc = await add(dana, manager, { name: 'Marc Gagnon', email: 'marc.gagnon@example.org', phone: '+1 613 555 0111' });
  app.aisha1 = await add(dana, accountant, { name: 'Aïsha Khan', linkedin: 'https://www.linkedin.com/in/aisha-khan-1' });
  app.aisha2 = await add(dana, hygienist, { name: 'Aisha Khan', email: 'aisha.k@example.com' });
  app.cote = await add(dana, hygienist, { name: 'Jean-François Côté', email: 'jf.cote@example.ca' });
  // One person on file at two clients, in progress at both.
  app.nadiaMaple = await add(dana, payroll, { name: 'Nadia Petrov', email: 'nadia@example.com' });
  app.nadiaNorthline = await add(dana, hygienist, { name: 'Nadia Petrov', email: 'nadia@example.com' });
  app.omar = await add(sam, manager, { name: 'Omar Haddad', email: 'omar@example.com', phone: '905-555-0166' });   // Sam's candidate, not Dana's
});

after(async () => {
  await api?.stop();
  globalThis.fetch = realFetch;
  for (const dir of [dataDir, files]) fs.rmSync(dir, { recursive: true, force: true });
});

test('the calendar is for the agency only, and only when signed in', async () => {
  const stranger = session(api.base);
  for (const [who_, status] of [[maya, 403], [stranger, 401]]) {
    assert.equal((await who_.get('/calendar/status')).status, status);
    assert.equal((await who_.get(`/calendar/day?date=${DAY}&tz=${TZ}`)).status, status);
    assert.equal((await who_.del('/calendar/link')).status, status);
    assert.equal((await put(who_, '/calendar/link', { url: LINK })).status, status);
    assert.equal((await put(who_, '/calendar/events/AAAAAAAAAAAAAAAAAAAAAA', { added: true })).status, status);
  }
  assert.deepEqual((await maya.get('/calendar/status')).body, { error: 'Only the agency team can do this.' });
});

test('before a calendar is connected, the day is empty and says so', async () => {
  assert.deepEqual((await dana.get('/calendar/status')).body, { connected: false, provider: null, last_read_at: null, error: null });
  assert.deepEqual(await dayOf(dana), { date: DAY, tz: TZ, connected: false, events: [], warnings: [] });
  // A date and a time zone are checked; with neither, the answer is for today.
  assert.equal((await dana.get(`/calendar/day?date=2026-02-30&tz=${TZ}`)).status, 400);
  assert.equal((await dana.get(`/calendar/day?date=${DAY}&tz=Mars/Olympus`)).status, 400);
  const today = (await dana.get('/calendar/day')).body;
  assert.match(today.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(today.tz, TZ);
});

test('a link is read before it is accepted, and a link that does not open a calendar is not kept', async () => {
  const refused = async (url, sentence) => {
    const res = await put(dana, '/calendar/link', { url, tz: TZ });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.match(res.body.error, sentence);
    assert.doesNotMatch(res.body.error, /calendar\.test|127\.0\.0\.1|\.ics\b(?!\))/);   // the sentence never repeats the link
  };
  await refused('', /Paste your calendar link first/);
  await refused(undefined, /Paste your calendar link first/);
  await refused('my calendar', /space or a line break/);
  await refused('http://calendar.google.com/calendar/ical/x/basic.ics', /must start with https:\/\/ or webcal:\/\//);
  await refused('https://127.0.0.1/calendar.ics', /private or internal address/);
  await refused('https://169.254.169.254/latest/meta-data/', /private or internal address/);
  await refused('https://[::ffff:10.0.0.5]/calendar.ics', /private or internal address/);
  await refused('https://calendar.test/nothing-here.ics', /no longer works/);
  await refused('https://calendar.test/page.ics', /did not open a calendar/);            // a sign-in page, not a calendar
  await refused('https://calendar.test/../../etc/passwd', /no longer works/);
  assert.equal((await put(dana, '/calendar/link', { url: LINK, tz: 'Nowhere/At_All' })).status, 400);
  assert.equal((await dana.get('/calendar/status')).body.connected, false);

  const saved = await put(dana, '/calendar/link', { url: LINK, tz: TZ });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  // "other" because the test's link is not at Google, Outlook or iCloud. Today is not 10 November 2026 for ever,
  // so the number of today's events is only checked to be a number.
  assert.deepEqual({ ...saved.body, events_today: typeof saved.body.events_today }, { connected: true, provider: 'other', events_today: 'number' });
  const status = (await dana.get('/calendar/status')).body;
  assert.deepEqual({ ...status, last_read_at: typeof status.last_read_at }, { connected: true, provider: 'other', last_read_at: 'string', error: null });
  // A link that fails later does not replace the one that works.
  await refused('https://calendar.test/nothing-here.ics', /no longer works/);
  assert.equal((await dana.get('/calendar/status')).body.connected, true);
  assert.equal((await dayOf(dana)).events.length > 5, true);
});

test('the day in Toronto: times, cancelled events left out, links, phone numbers, guests', async () => {
  const day = await dayOf(dana);
  assert.deepEqual({ date: day.date, tz: day.tz, connected: day.connected, warnings: day.warnings }, { date: DAY, tz: TZ, connected: true, warnings: [] });
  assert.deepEqual(lines(day), [
    'all day Out of office',
    '08:00-08:30 Entrevue avec Jean-Francois Cote',
    '10:30-10:45 Morning Huddle (moved)',                 // this one date of the weekly huddle was moved from 09:00
    '11:00-11:30 Zoom screen - Priya Nair',
    '13:00-13:30 Chat with Marc',                         // "Coffee with Alex" at 12:00 was cancelled, so it is not here
    '14:00-14:45 Second interview - Senior Accountant',
    '15:00-15:30 Intro call',
    '15:30-15:45 Weekly check-in',
    '16:00-16:15 Call Kevin',
    '16:30-16:45 Catch up with Kevin',
    '17:00-17:30 Screening call with Aisha Khan',
    '18:00-18:30 Panel',
  ]);
  for (const event of day.events) {
    assert.deepEqual(Object.keys(event), ['key', 'source', 'title', 'start', 'end', 'all_day', 'join_url', 'join_kind', 'phone', 'guests', 'added', 'match', 'suggestions', 'call_id']);
    assert.match(event.key, /^[A-Za-z0-9_-]{22}$/);
    assert.deepEqual([event.source, event.added, event.call_id], ['calendar', false, null]);
  }
  assert.equal(new Set(day.events.map((e) => e.key)).size, day.events.length);
  const away = titled(day, 'Out of office');
  assert.deepEqual([away.all_day, away.start, away.end], [true, '2026-11-09T05:00:00.000Z', '2026-11-11T05:00:00.000Z']);
  const zoom = titled(day, 'Zoom screen');
  assert.deepEqual([zoom.start, zoom.end, zoom.join_kind, zoom.join_url], ['2026-11-10T16:00:00.000Z', '2026-11-10T16:30:00.000Z', 'zoom', 'https://us02web.zoom.us/j/81234567890?pwd=QWxhZGRpbg']);
  const interview = titled(day, 'Second interview');
  assert.deepEqual([interview.join_kind, interview.join_url], ['meet', 'https://meet.google.com/abc-defg-hij']);
  assert.deepEqual(interview.guests, [
    { name: 'Dana Recruiter', email: 'dana.recruiter@example-agency.ca' }, { name: null, email: 'kevin.tremblay@example.com' }, { name: 'Maya Okonkwo', email: 'maya@maple.example' }]);
  assert.equal(interview.phone, null);                    // the number in Meet's joining instructions is not somebody's phone
  assert.equal(titled(day, 'Call Kevin').phone, '+14165550142');
  assert.deepEqual([titled(day, 'Call Kevin').join_url, titled(day, 'Call Kevin').join_kind], [null, null]);

  // The day after: nothing but the all-day event's last... no: it ended at midnight. And the 17th has no huddle (that date was deleted).
  assert.deepEqual(lines(await dayOf(dana, '2026-11-11')), []);
  assert.deepEqual(lines(await dayOf(dana, '2026-11-17')), ['15:30-15:45 Weekly check-in']);
  assert.deepEqual(lines(await dayOf(dana, '2026-11-03')), ['09:00-09:15 Morning Huddle', '15:30-15:45 Weekly check-in']);
});

test('the day across a clock change, and from another time zone', async () => {
  // Clocks went back in Toronto on 1 November 2026. The overnight event is on both days; the weekly huddle stays at 09:00.
  for (const date of ['2026-10-31', '2026-11-01']) assert.deepEqual(lines(await dayOf(dana, date)), ['23:00-03:00 Overnight maintenance']);
  const before = await dayOf(dana, '2026-10-27'), afterwards = await dayOf(dana, '2026-11-03');
  assert.equal(titled(before, 'Morning Huddle').start, '2026-10-27T13:00:00.000Z');
  assert.equal(titled(afterwards, 'Morning Huddle').start, '2026-11-03T14:00:00.000Z');
  // The same calendar asked for in Los Angeles: the evening panel of the 10th in Toronto is still the 10th there,
  // the all-day event runs midnight to midnight on that clock, and each event keeps the key it has in Toronto.
  const west = (await dana.get(`/calendar/day?date=${DAY}&tz=America/Los_Angeles`)).body;
  assert.equal(west.tz, 'America/Los_Angeles');
  assert.equal(titled(west, 'Out of office').start, '2026-11-09T08:00:00.000Z');
  assert.equal(titled(west, 'Panel').start, '2026-11-10T23:00:00.000Z');
  const east = await dayOf(dana);
  assert.equal(titled(west, 'Panel').key, titled(east, 'Panel').key);
  assert.equal(titled(west, 'Morning Huddle').key, titled(east, 'Morning Huddle').key);
});

test('who an event is with: an e-mail address, a phone number or a full name decides; anything weaker is only offered', async () => {
  const day = await dayOf(dana);
  // A guest's address is a candidate's (written with capitals in the invitation).
  const interview = titled(day, 'Second interview');
  assert.deepEqual(interview.match, { application_id: app.kevinT, candidate_id: interview.match.candidate_id, name: 'Kevin Tremblay', photo: null, job_title: 'Senior Accountant', client_name: 'Maple Freight', how: 'email' });
  assert.deepEqual(interview.suggestions, []);
  // A person's phone number in the event is a candidate's. Stored as "(416) 555-0142", written "+1 (416) 555-0142".
  assert.equal(who(titled(day, 'Call Kevin')), 'Kevin Tremblay (phone)');
  assert.equal(titled(day, 'Call Kevin').match.application_id, app.kevinT);
  // The candidate's exact full name is in the title; accents do not matter.
  assert.equal(who(titled(day, 'Zoom screen')), 'Priya Nair (name)');
  assert.equal(who(titled(day, 'Entrevue avec')), 'Jean-François Côté (name)');

  // A first name is never enough. Two Kevins: both offered, neither chosen.
  const catchUp = titled(day, 'Catch up with Kevin');
  assert.equal(catchUp.match, null);
  assert.deepEqual(offered(catchUp), ['Kevin Osei', 'Kevin Tremblay']);
  assert.ok(catchUp.suggestions.every((s) => s.how === 'name' && s.application_id && s.job_title && s.client_name));
  // One Marc on file: still only offered.
  assert.equal(titled(day, 'Chat with Marc').match, null);
  assert.deepEqual(offered(titled(day, 'Chat with Marc')), ['Marc Gagnon']);
  // Two different people called Aisha Khan: a question for the recruiter.
  assert.equal(titled(day, 'Screening call').match, null);
  assert.deepEqual(offered(titled(day, 'Screening call')), ['Aisha Khan', 'Aïsha Khan']);
  // Two candidates among the guests.
  assert.equal(titled(day, 'Panel').match, null);
  assert.deepEqual(titled(day, 'Panel').suggestions.map((s) => `${s.name} ${s.how}`).sort(), ['Kevin Osei email', 'Priya Nair email']);
  // The same person on file at two clients and in progress at both: which record is meant is the recruiter's call.
  const intro = titled(day, 'Intro call');
  assert.equal(intro.match, null);
  assert.deepEqual(intro.suggestions.map((s) => `${s.name} at ${s.client_name}`).sort(), ['Nadia Petrov at Maple Freight', 'Nadia Petrov at Northline Dental']);
  // Colleagues and nobody at all.
  assert.deepEqual([titled(day, 'Morning Huddle').match, titled(day, 'Morning Huddle').suggestions], [null, []]);
  assert.deepEqual([titled(day, 'Out of office').match, titled(day, 'Out of office').suggestions], [null, []]);
  // The conference number in the interview's joining instructions is Kevin Osei's own number. It must not make the
  // event his: the guest's address decided, and a dial-in number never identifies anyone.
  assert.equal(interview.match.name, 'Kevin Tremblay');

  // Once one of Nadia's two applications is closed, the one still in progress is the match.
  assert.equal((await dana.post(`/applications/${app.nadiaNorthline}/reject`, { reason: 'Withdrew' })).status, 200);
  const later = titled(await dayOf(dana), 'Intro call');
  assert.equal(who(later), 'Nadia Petrov (email)');
  assert.deepEqual([later.match.application_id, later.match.client_name, later.suggestions], [app.nadiaMaple, 'Maple Freight', []]);
  // A candidate renamed in The Book is found by the new name straight away.
  assert.equal((await dana.patch(`/applications/${app.marc}`, { candidate: { name: 'Marc-André Gagnon', email: 'marc.gagnon@example.org', phone: '+1 613 555 0111' } })).status, 200);
  assert.deepEqual(offered(titled(await dayOf(dana), 'Chat with Marc')), []);
  assert.equal((await dana.patch(`/applications/${app.marc}`, { candidate: { name: 'Marc Gagnon', email: 'marc.gagnon@example.org', phone: '+1 613 555 0111' } })).status, 200);
  assert.deepEqual(offered(titled(await dayOf(dana), 'Chat with Marc')), ['Marc Gagnon']);
});

test('"+ Add" marks an event, and the recruiter\'s own choice of candidate wins over any match', async () => {
  const day = await dayOf(dana);
  const call = titled(day, 'Call Kevin'), catchUp = titled(day, 'Catch up with Kevin');
  const added = await put(dana, `/calendar/events/${call.key}`, { added: true });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.deepEqual(added.body, { ...call, added: true });                        // the event, in the same shape, as it now stands
  assert.equal(titled(await dayOf(dana), 'Call Kevin').added, true);
  assert.equal((await put(dana, `/calendar/events/${call.key}`, { added: false })).body.added, false);
  assert.equal((await put(dana, `/calendar/events/${call.key}`, { added: true })).body.added, true);

  // Choosing who a first-name-only event is with.
  const chose = await put(dana, `/calendar/events/${catchUp.key}`, { application_id: app.kevinO });
  assert.equal(chose.status, 200);
  assert.deepEqual([chose.body.match.name, chose.body.match.how, chose.body.match.application_id, chose.body.match.job_title, chose.body.suggestions], ['Kevin Osei', 'chosen', app.kevinO, 'Office Manager', []]);
  assert.equal(chose.body.added, false);                                         // choosing someone does not add the event
  // The choice wins over a match by e-mail address, and clearing it brings the match back.
  const interview = titled(day, 'Second interview');
  assert.equal(who((await put(dana, `/calendar/events/${interview.key}`, { application_id: app.priya, added: true })).body), 'Priya Nair (chosen)');
  assert.equal(who(titled(await dayOf(dana), 'Second interview')), 'Priya Nair (chosen)');
  const cleared = await put(dana, `/calendar/events/${interview.key}`, { application_id: null });
  assert.deepEqual([who(cleared.body), cleared.body.added], ['Kevin Tremblay (email)', true]);
  assert.equal((await put(dana, `/calendar/events/${interview.key}`, { added: false })).body.added, false);

  // What is refused.
  assert.equal((await put(dana, `/calendar/events/${call.key}`, {})).status, 400);
  assert.equal((await put(dana, `/calendar/events/${call.key}`, { added: 'yes' })).status, 400);
  assert.equal((await put(dana, `/calendar/events/${call.key}`, { application_id: 999999 })).status, 404);
  assert.equal((await put(dana, `/calendar/events/${call.key}`, { application_id: 'x' })).status, 404);
  assert.equal((await put(dana, '/calendar/events/AAAAAAAAAAAAAAAAAAAAAA', { added: true })).status, 404);
  assert.equal((await put(dana, '/calendar/events/not-a-key', { added: true })).status, 404);
  assert.equal(titled(await dayOf(dana), 'Call Kevin').added, true);
});

test('an event keeps its key, and its mark, when it is renamed or moved', async () => {
  const before = await dayOf(dana);
  const call = titled(before, 'Call Kevin'), huddle = titled(before, 'Morning Huddle');
  assert.equal((await put(dana, `/calendar/events/${huddle.key}`, { added: true })).body.added, true);
  // The call is renamed and moved to the next morning; the moved huddle is moved again, to 11:45.
  writeCalendar({ ...EVENTS, huddleMoved: huddleMoved('1145', '1200'),
    callKevin: vevent('UID:call-kevin@test', 'SUMMARY:Offer call with Kevin', `DTSTART${at('20261111', '0930')}`, `DTEND${at('20261111', '1000')}`, 'DESCRIPTION:Cell: +1 (416) 555-0142') });
  const tenth = await freshDay(dana), eleventh = await dayOf(dana, '2026-11-11');
  assert.equal(titled(tenth, 'Call Kevin'), undefined);
  const moved = titled(eleventh, 'Offer call with Kevin');
  assert.deepEqual([moved.key, moved.added, line(moved, TZ)], [call.key, true, '09:30-10:00 Offer call with Kevin']);
  const later = titled(tenth, 'Morning Huddle');
  assert.deepEqual([later.key, later.added, line(later, TZ)], [huddle.key, true, '11:45-12:00 Morning Huddle (moved)']);
  // The mark can still be changed where the event now is.
  assert.equal((await put(dana, `/calendar/events/${call.key}`, { added: false })).body.title, 'Offer call with Kevin');
  // Other weeks of the huddle are other events, with keys of their own and no mark.
  const otherWeek = titled(await dayOf(dana, '2026-11-03'), 'Morning Huddle');
  assert.notEqual(otherWeek.key, huddle.key);
  assert.equal(otherWeek.added, false);
  writeCalendar();
  assert.deepEqual([titled(await freshDay(dana), 'Call Kevin').key, titled(await dayOf(dana), 'Call Kevin').added], [call.key, false]);
  assert.equal((await put(dana, `/calendar/events/${call.key}`, { added: true })).body.added, true);
});

test('a mark is not lost when the calendar gives a repeating event a new identity', async () => {
  // Google does this when a repeating event is changed "from this date onwards": the earlier dates keep the old
  // identity and the later ones get a new one.
  const weekly = titled(await dayOf(dana), 'Weekly check-in');
  assert.equal((await put(dana, `/calendar/events/${weekly.key}`, { added: true, application_id: app.priya })).status, 200);
  writeCalendar({ ...EVENTS,
    oneToOne: vevent('UID:weekly-priya@test', 'SUMMARY:Weekly check-in', `DTSTART${at('20261020', '1530')}`, `DTEND${at('20261020', '1545')}`, 'RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20261110T045959Z'),
    oneToOneNew: vevent('UID:weekly-priya_R20261110T203000@test', 'SUMMARY:Weekly check-in', `DTSTART${at('20261110', '1530')}`, `DTEND${at('20261110', '1545')}`, 'RRULE:FREQ=WEEKLY;BYDAY=TU', 'LOCATION:Boardroom') });
  const after_ = titled(await freshDay(dana), 'Weekly check-in');
  assert.notEqual(after_.key, weekly.key);
  assert.deepEqual([after_.added, who(after_)], [true, 'Priya Nair (chosen)']);
  assert.equal((await put(dana, `/calendar/events/${weekly.key}`, { added: false })).status, 404);   // the old key is gone
  assert.equal((await put(dana, `/calendar/events/${after_.key}`, { added: false, application_id: null })).body.added, false);
  writeCalendar();
  await freshDay(dana);
});

test('one person cannot see or change another person\'s events', async () => {
  const danas = await dayOf(dana);
  const call = titled(danas, 'Call Kevin');
  // Sam has no calendar connected: he sees none of Dana's events, and her keys mean nothing in his hands.
  assert.deepEqual(await dayOf(sam), { date: DAY, tz: TZ, connected: false, events: [], warnings: [] });
  assert.equal((await sam.get('/calendar/status')).body.connected, false);
  for (const change of [{ added: false }, { application_id: app.omar }, { added: true, application_id: null }]) {
    const res = await put(sam, `/calendar/events/${call.key}`, change);
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'That event was not found. Open your day again and try once more.');
  }
  assert.equal((await put(alex, `/calendar/events/${call.key}`, { added: false })).status, 404);     // not even the owner
  assert.deepEqual(titled(await dayOf(dana), 'Call Kevin'), call);
  // Sam connects the very same calendar. The same meetings have different keys for him, and his marks are his own.
  fs.copyFileSync(path.join(files, `${TOKEN}.ics`), path.join(files, 'shared-with-sam.ics'));
  assert.equal((await put(sam, '/calendar/link', { url: 'https://calendar.test/shared-with-sam.ics', tz: TZ })).status, 200);
  const sams = await dayOf(sam);
  assert.deepEqual(lines(sams), lines(danas));
  const danasKeys = new Set(danas.events.map((e) => e.key));
  assert.ok(sams.events.every((e) => !danasKeys.has(e.key)));
  assert.equal(titled(sams, 'Call Kevin').added, false);
  assert.equal((await put(sam, `/calendar/events/${titled(sams, 'Catch up').key}`, { added: true, application_id: app.kevinT })).status, 200);
  assert.deepEqual(titled(await dayOf(dana), 'Catch up'), titled(danas, 'Catch up'));
  assert.equal((await put(dana, `/calendar/events/${titled(sams, 'Catch up').key}`, { added: false })).status, 404);
  // Removing his link leaves hers alone.
  assert.deepEqual((await sam.del('/calendar/link')).body, { ok: true });
  assert.equal((await dayOf(sam)).events.length, 0);
  assert.equal((await dayOf(dana)).events.length, danas.events.length);
});

test('a call recorded for an event is tied to it', async () => {
  const call = titled(await dayOf(dana), 'Call Kevin');
  const started = await dana.post('/oracle/recordings', { mimeType: 'audio/webm;codecs=opus', consent: CONSENT, application_id: app.kevinT, event_key: call.key });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  assert.equal(titled(await dayOf(dana), 'Call Kevin').call_id, started.body.call_id);
  assert.equal((await put(dana, `/calendar/events/${call.key}`, { added: true })).body.call_id, started.body.call_id);
  // Somebody else starting a recording with Dana's key: their recording starts as usual, and her event is untouched.
  const sams = await sam.post('/oracle/recordings', { mimeType: 'audio/webm;codecs=opus', consent: CONSENT, event_key: call.key });
  assert.equal(sams.status, 201);
  // A key that is nonsense never stops a recording either.
  for (const key of ['nonsense', 42, { a: 1 }, 'AAAAAAAAAAAAAAAAAAAAAA']) assert.equal((await dana.post('/oracle/recordings', { mimeType: 'audio/webm;codecs=opus', consent: CONSENT, event_key: key })).status, 201);
  assert.equal(titled(await dayOf(dana), 'Call Kevin').call_id, started.body.call_id);
  // The recording itself works as before with a key attached.
  assert.equal((await dana.put(`/oracle/recordings/${started.body.id}/chunks/0`, RECORDING)).status, 200);
  assert.equal((await dana.post(`/oracle/recordings/${started.body.id}/finish`, { chunks: 1, durationMs: 9400 })).status, 200);
  assert.equal(titled(await dayOf(dana), 'Call Kevin').call_id, started.body.call_id);
  // Deleting the call unties it.
  assert.equal((await dana.del(`/oracle/calls/${started.body.call_id}`)).status, 200);
  assert.equal(titled(await dayOf(dana), 'Call Kevin').call_id, null);
});

test('The Book\'s own interviews are in the day, with the candidate already known', async () => {
  const schedule = async (by, application_id, title, starts_at, extra = {}) => {
    const made = await by.post('/interviews', { application_id, title, starts_at, duration_min: 30, ...extra });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    return made.body.id;
  };
  const phoneScreen = await schedule(dana, app.kevinO, 'Phone screen', '2026-11-10T14:30:00.000Z', { kind: 'phone' });
  await schedule(dana, app.marc, 'Video interview', '2026-11-10T22:30:00.000Z', { kind: 'video', location: 'Zoom: https://zoom.us/j/5551112222' });
  await schedule(dana, app.priya, 'Tomorrow\'s interview', '2026-11-11T15:00:00.000Z');
  await schedule(sam, app.omar, 'Sam\'s interview with Omar', '2026-11-10T15:00:00.000Z');                 // not Dana's candidate, not her interview
  const day = await dayOf(dana);
  const mine = day.events.filter((e) => e.source === 'interview');
  assert.deepEqual(mine.map((e) => line(e, TZ)), ['09:30-10:00 Phone screen', '17:30-18:00 Video interview']);
  assert.deepEqual(lines(day).slice(0, 4), ['all day Out of office', '08:00-08:30 Entrevue avec Jean-Francois Cote', '09:30-10:00 Phone screen', '10:30-10:45 Morning Huddle (moved)']);
  const [screen, video] = mine;
  assert.deepEqual(screen.match, { application_id: app.kevinO, candidate_id: screen.match.candidate_id, name: 'Kevin Osei', photo: null, job_title: 'Office Manager', client_name: 'Northline Dental', how: 'interview' });
  assert.deepEqual([screen.phone, screen.join_url, screen.suggestions, screen.added], ['+16475550190', null, [], false]);   // a phone interview: the candidate's own number
  assert.deepEqual(screen.guests, [{ name: 'Kevin Osei', email: 'k.osei@example.net' }]);
  assert.deepEqual([video.join_kind, video.join_url, video.phone, who(video)], ['zoom', 'https://zoom.us/j/5551112222', null, 'Marc Gagnon (interview)']);
  // An interview can be added and recorded like any other event.
  assert.equal((await put(dana, `/calendar/events/${screen.key}`, { added: true })).body.added, true);
  // Sam sees his own interview and not Dana's; Dana does not see his.
  assert.deepEqual(lines(await dayOf(sam)), ['10:00-10:30 Sam\'s interview with Omar']);
  assert.equal((await put(sam, `/calendar/events/${screen.key}`, { added: false })).status, 404);
  // An interview Dana is on the panel of is hers too, whoever set it up.
  const dana_id = (await dana.get('/me')).body.user.id;
  await schedule(sam, app.omar, 'Panel interview with Omar', '2026-11-10T23:30:00.000Z', { panel: [dana_id] });
  assert.ok(lines(await dayOf(dana)).includes('18:30-19:00 Panel interview with Omar'));
  // A cancelled interview is left out.
  assert.equal((await dana.patch(`/interviews/${phoneScreen}`, { status: 'cancelled' })).status, 200);
  assert.equal((await dayOf(dana)).events.some((e) => e.title === 'Phone screen'), false);
});

test('a calendar event that is one of The Book\'s interviews is shown once, as the interview', async () => {
  const before = await dayOf(dana);
  const event = titled(before, 'Second interview');
  assert.equal(who(event), 'Kevin Tremblay (email)');
  assert.equal((await put(dana, `/calendar/events/${event.key}`, { added: true })).body.added, true);
  // The same meeting is put in The Book: same candidate, five minutes off the calendar's time.
  const made = await dana.post('/interviews', { application_id: app.kevinT, title: 'Second interview', starts_at: '2026-11-10T19:05:00.000Z', duration_min: 45, kind: 'video' });
  assert.equal(made.status, 200);
  const day = await dayOf(dana);
  const both = day.events.filter((e) => e.title.startsWith('Second interview'));
  assert.equal(both.length, 1);
  assert.deepEqual([both[0].source, line(both[0], TZ), who(both[0])], ['interview', '14:05-14:50 Second interview', 'Kevin Tremblay (interview)']);
  // What only the calendar knew (the link to join) is kept, and so is the mark made on the calendar event.
  assert.deepEqual([both[0].join_kind, both[0].join_url, both[0].added], ['meet', 'https://meet.google.com/abc-defg-hij', true]);
  assert.equal((await put(dana, `/calendar/events/${both[0].key}`, { added: false })).body.added, false);
  assert.equal(titled(await dayOf(dana), 'Second interview').added, false);
  // An interview with somebody else at that time hides nothing.
  assert.equal(titled(day, 'Intro call').source, 'calendar');
});

test('a calendar that breaks gives a warning, not an error page, and the day is still there', async () => {
  const good = lines(await dayOf(dana));
  const file = path.join(files, `${TOKEN}.ics`);
  // The link starts answering with a web page. The last good copy is shown, and the recruiter is told.
  fs.writeFileSync(file, '<html>Sign in</html>');
  let day = await freshDay(dana);
  assert.deepEqual(lines(day), good);
  assert.equal(day.warnings.length, 1);
  assert.match(day.warnings[0], /^That link did not open a calendar\. .* What is shown is your calendar as it was (a minute|\d+ minutes) ago\.$/);
  let status = (await dana.get('/calendar/status')).body;
  assert.deepEqual([status.connected, typeof status.last_read_at], [true, 'string']);
  assert.match(status.error, /did not open a calendar/);
  // The link stops working altogether (reset, or unpublished).
  fs.rmSync(file);
  day = await freshDay(dana);
  assert.deepEqual(lines(day), good);
  assert.match(day.warnings[0], /^That calendar link no longer works\. /);
  assert.match((await dana.get('/calendar/status')).body.error, /no longer works/);
  // It comes back: the warning and the error go.
  writeCalendar();
  day = await freshDay(dana);
  assert.deepEqual([lines(day), day.warnings], [good, []]);
  assert.equal((await dana.get('/calendar/status')).body.error, null);
  // A calendar with an event that repeats every minute and a time zone nobody knows: plain sentences, and the rest of the day.
  writeCalendar({ ...EVENTS,
    flood: vevent('UID:flood@test', 'SUMMARY:Every minute', 'DTSTART:20200101T000000Z', 'DTEND:20200101T000030Z', 'RRULE:FREQ=MINUTELY'),
    narnia: vevent('UID:narnia@test', 'SUMMARY:Somewhere else', 'DTSTART;TZID=Narnia/Lamp-post:20261110T193000', 'DTEND;TZID=Narnia/Lamp-post:20261110T200000') });
  day = await freshDay(dana);
  assert.ok(lines(day).includes('19:30-20:00 Somewhere else'));
  assert.deepEqual(day.warnings.sort(), [
    '"Every minute" was left out because it repeats every minute.',
    'Some events use a time zone this reader does not know ("Narnia/Lamp-post"), so their times are shown exactly as they were written. Check those events against your calendar.',
  ]);
  writeCalendar();
  await freshDay(dana);
});

test('a very large calendar is read without holding up the rest of the server', async () => {
  // About 3 MB: 4,000 single events and 400 weekly series. Read on the main thread this would stop every other
  // request for most of a second. It is read on a thread of its own.
  const events = [];
  for (let i = 0; i < 4000; i++) {
    const day = String(1 + (i % 28)).padStart(2, '0'), month = String(1 + (i % 12)).padStart(2, '0');
    events.push(vevent(`UID:big-${i}@test`, `SUMMARY:Meeting number ${i}`, `DTSTART${at(`2025${month}${day}`, '0900')}`, `DTEND${at(`2025${month}${day}`, '0930')}`, `DESCRIPTION:${'Notes about this meeting. '.repeat(20)}`));
  }
  for (let i = 0; i < 400; i++) events.push(vevent(`UID:series-${i}@test`, `SUMMARY:Series ${i}`, `DTSTART${at('20240102', String(600 + (i % 10) * 100).padStart(4, '0'))}`, `DTEND${at('20240102', String(630 + (i % 10) * 100).padStart(4, '0'))}`, 'RRULE:FREQ=WEEKLY;BYDAY=TU'));
  fs.writeFileSync(path.join(files, 'big.ics'), calendar(...events));
  assert.ok(fs.statSync(path.join(files, 'big.ics')).size > 2.5 * 1024 * 1024);

  let slowest = 0, pings = 0, reading = true;
  const pinging = (async () => {
    while (reading) {
      const started = Date.now();
      await realFetch(`${api.base}/api/bootstrap`).then((res) => res.arrayBuffer());
      slowest = Math.max(slowest, Date.now() - started);
      pings++;
      await sleep(15);
    }
  })();
  const started = Date.now();
  const saved = await put(sam, '/calendar/link', { url: 'https://calendar.test/big.ics', tz: TZ });
  const took = Date.now() - started;
  reading = false;
  await pinging;
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.ok(pings > 3, `only ${pings} other requests were answered while the calendar was read (${took} ms)`);
  assert.ok(slowest < 400, `another request waited ${slowest} ms while the calendar was being read (${took} ms)`);
  // The day is right, and asking for more days does not read the file again (so each is quick).
  const day = await dayOf(sam);
  assert.equal(day.events.filter((e) => e.title.startsWith('Series ')).length, 150);   // the first 150 of 400, with a sentence saying so
  assert.match(day.warnings.join(' '), /more than 150 events on this day/);
  const again = Date.now();
  for (const date of ['2026-11-11', '2026-11-12', '2026-11-13']) assert.equal((await dayOf(sam, date)).events.filter((e) => e.source === 'calendar').length, 0);
  assert.ok(Date.now() - again < 3000);
  assert.equal((await sam.del('/calendar/link')).status, 200);
});

test('marks and the saved link survive a restart; a calendar that cannot be read then gives only a warning', async () => {
  const before = await dayOf(dana);
  assert.equal(titled(before, 'Call Kevin').added, true);
  earlierLog += api.output();
  await api.stop();
  // While the server is down the link stops working, so after the restart there is no earlier copy to fall back on.
  fs.rmSync(path.join(files, `${TOKEN}.ics`));
  api = await startApi({ port: PORTS.api, dataDir, files });
  let day = await dayOf(dana);
  assert.equal(day.connected, true);
  assert.deepEqual(day.events.map((e) => e.source), ['interview', 'interview', 'interview']);        // The Book's own interviews are still there
  assert.deepEqual(day.warnings, ['That calendar link no longer works. It may have been reset or switched off: copy the link again from your calendar\'s settings.']);
  assert.match((await dana.get('/calendar/status')).body.error, /no longer works/);
  // A mark can still be changed on an interview, which does not need the calendar.
  assert.equal((await put(dana, `/calendar/events/${day.events[0].key}`, { added: true })).status, 200);
  // And a calendar event cannot be found while the calendar is unreadable: said plainly, nothing broken.
  assert.equal((await put(dana, `/calendar/events/${titled(before, 'Call Kevin').key}`, { added: true })).status, 404);
  writeCalendar();
  day = await freshDay(dana);
  assert.deepEqual(day.warnings, []);
  // Same keys as before the restart, and the mark is still there.
  assert.deepEqual(day.events.map((e) => e.key), before.events.map((e) => e.key));
  assert.equal(titled(day, 'Call Kevin').added, true);
});

test('removing the link removes what was noted about the calendar\'s events', async () => {
  const before = await dayOf(dana);
  const interviewKey = before.events.find((e) => e.source === 'interview').key;
  assert.equal((await put(dana, `/calendar/events/${interviewKey}`, { added: true })).body.added, true);
  assert.deepEqual((await dana.del('/calendar/link')).body, { ok: true });
  assert.deepEqual((await dana.get('/calendar/status')).body, { connected: false, provider: null, last_read_at: null, error: null });
  const without = await dayOf(dana);
  assert.equal(without.connected, false);
  assert.ok(without.events.length > 0 && without.events.every((e) => e.source === 'interview'));
  assert.equal(without.events.find((e) => e.key === interviewKey).added, true);                       // an interview's mark is not the calendar's
  assert.equal((await put(dana, `/calendar/events/${titled(before, 'Call Kevin').key}`, { added: true })).status, 404);
  assert.deepEqual((await dana.del('/calendar/link')).body, { ok: true });                            // removing twice is harmless
  // Connected again, the events are back with the same keys and without their old marks.
  assert.equal((await put(dana, '/calendar/link', { url: LINK, tz: TZ })).status, 200);
  const again = titled(await dayOf(dana), 'Call Kevin');
  assert.deepEqual([again.key, again.added], [titled(before, 'Call Kevin').key, false]);
});

test('deleting a candidate removes them from the day', async () => {
  const day = await dayOf(dana);
  const catchUp = titled(day, 'Catch up with Kevin');
  assert.equal(who((await put(dana, `/calendar/events/${catchUp.key}`, { application_id: app.kevinO })).body), 'Kevin Osei (chosen)');
  const kevinO = (await dana.get(`/applications/${app.kevinO}`)).body.candidate.id;
  assert.equal((await dana.del(`/candidates/${kevinO}`)).status, 200);
  const after_ = titled(await dayOf(dana), 'Catch up with Kevin');
  assert.equal(after_.match, null);                                   // the choice went with the person
  assert.deepEqual(offered(after_), ['Kevin Tremblay']);
  assert.deepEqual(titled(await dayOf(dana), 'Panel').suggestions.map((s) => s.name), []);            // one candidate among the guests now: a match
  assert.equal(who(titled(await dayOf(dana), 'Panel')), 'Priya Nair (email)');
});

test('saving a link can only be tried so many times an hour', async () => {
  for (let i = 0; i < 12; i++) assert.equal((await put(alex, '/calendar/link', { url: 'http://example.com/calendar.ics' })).status, 400);
  const res = await put(alex, '/calendar/link', { url: LINK });
  assert.equal(res.status, 429);
  assert.equal(res.body.error, 'That is a lot of tries in one hour. Try again a little later.');
});

test('reading calendar files from a folder is refused in production', async () => {
  const prodData = tempDir('calendar-production');
  const server = await startServer({ port: PORTS.production, dataDir: prodData, env: { CALENDAR_TEST_FILES: files } });
  try {
    assert.match(server.output(), /CALENDAR_TEST_FILES is only for tests and is ignored in production/);
    const owner = session(server.base);
    assert.equal((await owner.post('/setup', { agencyName: 'Harbour Talent', name: 'Alex Morgan', email: 'alex@agency.example', password: 'demo1234' })).status, 200);
    const res = await realFetch(`${server.base}/api/calendar/link`, { method: 'PUT', headers: { Cookie: owner.cookie(), 'Content-Type': 'application/json' }, body: JSON.stringify({ url: LINK, tz: TZ }) });
    // "calendar.test" is not a real site, so the link is simply not found; the file in the folder was not read.
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /could not be found|could not be reached|took too long/);
    assert.equal((await owner.get('/calendar/status')).body.connected, false);
    assert.doesNotMatch(server.output(), new RegExp(TOKEN));
  } finally {
    await server.stop();
    fs.rmSync(prodData, { recursive: true, force: true });
  }
});

test('the calendar link is never given back, logged, or stored where it can be read', async () => {
  const said = (await Promise.all(answers)).join('\n');
  assert.ok(said.length > 10000);
  assert.equal(said.includes(TOKEN), false, 'an answer contained the secret part of the calendar link');
  assert.equal(said.includes('calendar.test'), false, 'an answer named the calendar\'s server');
  const log = `${earlierLog}${api.output()}`;
  assert.equal(log.includes(TOKEN), false, 'the server\'s log contained the link');
  assert.equal(log.includes('calendar.test'), false);
  // In the data folder the link exists only sealed: neither the database nor any other file holds it as text.
  await api.stop();
  for (const name of fs.readdirSync(dataDir, { recursive: true })) {
    const file = path.join(dataDir, name);
    if (fs.statSync(file).isFile()) assert.equal(fs.readFileSync(file).includes(TOKEN), false, `${name} contains the link`);
  }
  // Nor does the database hold the titles of calendar events or the addresses of their guests.
  const db = fs.readFileSync(path.join(dataDir, 'app.db'));
  for (const text of ['Catch up with Kevin', 'Morning Huddle', 'Screening call']) assert.equal(db.includes(text), false, `the database contains "${text}"`);
  api = await startApi({ port: PORTS.api, dataDir, files });
});
