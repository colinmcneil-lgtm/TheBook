// Your calendar in The Oracle: the recruiter's day, with the calls in it ready to be recorded.
//
// How it works:
//   1. Each agency user may save one private calendar link (Google's "secret address in iCal format", Outlook's
//      published ICS link, or an iCloud public calendar link). The link is read once before it is accepted, through
//      the careful reader in calendar-fetch.js, and stored sealed. No route ever gives it back and it is never
//      written to a log: to change it, the person pastes a new one.
//   2. The day view reads that calendar (kept for five minutes, then asked again), works out the day's events on
//      the recruiter's own clock, and adds The Book's own interviews for that person. For each calendar event it
//      says who the event is probably with: a guest's e-mail address that is a candidate's, then a phone number
//      that is a candidate's, then a candidate's exact full name in the title. Anything weaker is only offered as a
//      suggestion. Nothing weak is ever chosen silently.
//   3. "+ Add" marks an event to be recorded, and the recruiter may say who it is with themselves; their choice
//      wins over any match. A call recorded for an event is tied to it, so the event shows the call.
//
// Every event has a key that stays the same when the event is renamed or moved, and that is different for each
// person, so one person's key means nothing in anybody else's hands. A person only ever sees and changes their own.
//
// Agency only: client users are refused on every route.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { q, now, tx, PHONE_TAIL } from './db.js';
import { keyFor, seal, unseal } from './secret.js';
import { safeFetchIcs, normalizeFeedUrl, providerOf, createFeedCache, FeedFetchError } from './calendar-fetch.js';
import { readDay, forgetRead, CalendarReadError } from './calendar-worker.js';
import { validZone, validDay, dayWindow, wallClock } from './calendar-time.js';
import { clip, findJoinLink, findPhones, toE164 } from './calendar-links.js';
import { nameTokens, wordsOf, emailsOf, shortlistWords, namedIn, likeliestFirst } from './calendar-match.js';

const MINUTE = 60000, HOUR = 3600000, DAY = 86400000;
const DEFAULT_ZONE = 'America/Toronto';
const MAX_EVENTS = 150;                  // of one day; a calendar with more than this in a day is not a diary
const MAX_SUGGESTIONS = 5;
const SAME_MEETING = 10 * MINUTE;        // a calendar event this close to one of The Book's interviews, with the same person, is that interview
const NEAR_INTERVIEW = 30 * MINUTE;      // an interview this close to an event counts as a sign the event is with that person
const KEEP_SEEN = 30 * DAY;              // how long an event nobody did anything with is remembered
const KEEP_MARKED = 400 * DAY;           // and one that was added, given a candidate or recorded
const KEY = /^[A-Za-z0-9_-]{22}$/;

// ---------- keys ----------
const short = (purpose, ...parts) => crypto.createHmac('sha256', keyFor(purpose)).update(parts.join('\n')).digest('base64url').slice(0, 22);
/**
 * The key an event goes by outside the server. It is worked out from who is looking and from the event's own
 * lasting identity, with a secret only this server holds: the same event always gets the same key for the same
 * person, nobody can work out a key from a calendar they have seen, and two people looking at one shared meeting
 * hold different keys.
 */
const keyOf = (userId, source, id) => short('calendar-event-key', userId, source, id);
/** A fingerprint of an event's title and start, used to find a marked event again after its calendar gave it a new identity. */
const printOf = (userId, title, start) => short('calendar-event-print', userId, title, start.toISOString());

// ---------- reading calendars ----------
// For the tests only: with CALENDAR_TEST_FILES naming a folder, a link to https://calendar.test/<name>.ics is read
// from that folder, so the real server can be tested on calendar files without an internet. The name "calendar.test"
// can never be a real site. This is refused outright when the server runs in production.
const TEST_FILES = process.env.CALENDAR_TEST_FILES && process.env.NODE_ENV !== 'production' ? path.resolve(process.env.CALENDAR_TEST_FILES) : null;
if (process.env.CALENDAR_TEST_FILES && !TEST_FILES) console.error('CALENDAR_TEST_FILES is only for tests and is ignored in production.');

async function readTestFile(u) {
  const name = path.basename(u.pathname);
  if (!/^[\w.-]+\.ics$/.test(name)) throw new FeedFetchError('http_status', 'That calendar link no longer works. It may have been reset or switched off: copy the link again from your calendar\'s settings.');
  const text = await fs.promises.readFile(path.join(TEST_FILES, name), 'utf8').catch(() => null);
  if (text === null) throw new FeedFetchError('http_status', 'That calendar link no longer works. It may have been reset or switched off: copy the link again from your calendar\'s settings.');
  if (!/^\s*BEGIN:VCALENDAR/i.test(text.slice(0, 200))) throw new FeedFetchError('not_a_calendar', 'That link did not open a calendar. Make sure you copied the iCal (.ics) link from your calendar\'s settings, not the address of the calendar page.');
  return { text };
}
async function fetchCalendar(url, options, conditional) {
  if (TEST_FILES) {
    const u = normalizeFeedUrl(url);
    if (u.hostname === 'calendar.test') return readTestFile(u);
  }
  return safeFetchIcs(url, options, conditional);
}

// Downloads are kept for five minutes per person, then the calendar is asked whether it has changed. The text of
// all of them together is capped, so many large calendars cannot fill the server's memory.
const cache = createFeedCache({ fetcher: fetchCalendar, ttlMs: 5 * MINUTE, staleMs: 6 * HOUR, maxEntries: 200, maxBytes: 48 * 1024 * 1024 });

const READ_PROBLEMS = {
  not_a_calendar: 'What your calendar link gave back could not be read as a calendar. Copy the link again from your calendar\'s settings.',
  broken: 'Your calendar was opened, but part of it is written in a way this reader could not understand, so its events are not shown.',
  too_slow: 'Your calendar took too long to read. Try again in a minute.',
  unreadable: 'Your calendar could not be read just now. Try again in a minute.',
};
/** A plain sentence for whatever stopped a calendar being read. Never contains the link. */
const problemOf = (err) => (err instanceof FeedFetchError ? err.message : READ_PROBLEMS[err instanceof CalendarReadError ? err.code : 'unreadable'] ?? READ_PROBLEMS.unreadable);

const linkOf = (userId) => q.get('SELECT * FROM calendar_links WHERE user_id = ?', userId) ?? null;
/** Note how the last read went, writing only when something changed, so looking at a day does not write to the database every time. */
function noteRead(link, { readAt = link.last_read_at, error = null, tz = link.tz }) {
  if (readAt === link.last_read_at && error === link.last_error && tz === link.tz) return;
  q.run('UPDATE calendar_links SET last_read_at = ?, last_error = ?, tz = ? WHERE user_id = ?', readAt, error, tz, link.user_id);
}

/**
 * The events of one day from a person's calendar, cancelled ones left out. Never throws: a calendar that is slow,
 * huge, broken or gone gives no events and a sentence in `warnings`.
 */
async function calendarDay(link, ymd, tz, force) {
  const warnings = [];
  try {
    const url = unseal(link.link_sealed, 'calendar-link');
    if (!url) throw new FeedFetchError('sealed', 'Your saved calendar link can no longer be opened. Paste it in again in Settings, under "Your calendar".');
    const feed = await cache.get(link.user_id, url, { force });
    const read = await readDay({ version: feed.version, text: feed.text, zone: tz, ymd });
    if (feed.stale) {
      // The calendar could not be read this time. The last copy is shown, and the recruiter is told why and how old it is.
      const minutes = Math.max(1, Math.round((Date.now() - feed.fetchedAt) / MINUTE));
      warnings.push(`${problemOf(feed.error)} What is shown is your calendar as it was ${minutes === 1 ? 'a minute' : `${minutes} minutes`} ago.`);
    }
    noteRead(link, { readAt: new Date(feed.fetchedAt).toISOString(), error: feed.stale ? problemOf(feed.error) : null, tz });
    let events = read.events.filter((e) => !e.cancelled);
    if (events.length > MAX_EVENTS) {
      events = events.slice(0, MAX_EVENTS);
      warnings.push(`Your calendar has more than ${MAX_EVENTS} events on this day. Only the first ${MAX_EVENTS} are shown.`);
    }
    return { events, warnings: [...warnings, ...read.warnings] };
  } catch (err) {
    const problem = problemOf(err);
    // Only what kind of failure it was goes to the log. The link, and anything read from it, never does.
    if (!(err instanceof FeedFetchError) && !(err instanceof CalendarReadError)) console.error(`Calendar: reading a calendar failed (${err?.code || err?.name || 'error'}).`);
    try { noteRead(link, { error: problem, tz }); } catch { /* the day is still shown without its calendar */ }
    return { events: [], warnings: [problem] };
  }
}

// ---------- who an event is with ----------
const marks = (n) => Array(n).fill('?').join(', ');
/** Run a query once per hundred values, for lists too long to put in one statement comfortably. */
function inChunks(values, run) {
  const rows = [];
  for (let i = 0; i < values.length; i += 100) rows.push(...run(values.slice(i, i + 100)));
  return rows;
}

/**
 * Candidates' names are looked up through a table of their first and last word with accents removed (see db.js),
 * which the server fills in here for candidates who are new or have been renamed. A few thousand at a time, so that
 * catching up on a large workspace never holds the server for long.
 */
function catchUpNames(limit = 2000) {
  const waiting = q.all('SELECT d.candidate_id AS id, c.name FROM candidate_name_dirty d LEFT JOIN candidates c ON c.id = d.candidate_id LIMIT ?', limit);
  if (!waiting.length) return 0;
  tx(() => {
    for (const { id, name } of waiting) {
      if (name != null) {
        const words = nameTokens(name);
        q.run('INSERT INTO candidate_name_keys (candidate_id, first, last) VALUES (?, ?, ?) ON CONFLICT(candidate_id) DO UPDATE SET first = excluded.first, last = excluded.last',
          id, words[0] ?? '', words.length > 1 ? words.at(-1) : '');
      }
      q.run('DELETE FROM candidate_name_dirty WHERE candidate_id = ?', id);
    }
  });
  return waiting.length;
}

const CANDIDATE = `c.id, c.name, lower(c.email) AS email, c.phone, c.current_company AS company, substr(c.photo_file, 1, 8) AS photo`;

/**
 * Work out, for each calendar event, the candidate it is with (`match`) or the people it might be with
 * (`suggestions`). The e-mail, phone and name look-ups are done in the database through indexes, so the cost does
 * not grow with the number of candidates on file (a day of 25 events took 40 to 70 ms with 100,000 of them).
 * `interviews` are The Book's interviews of the day, used as one more sign for an event that only has a first name.
 */
function matchEvents(events, interviews) {
  if (!events.length) return;
  // The agency's own people are guests of nearly every meeting; their addresses and names say nothing about the candidate.
  const own = new Set(q.all(`SELECT lower(email) AS email FROM users WHERE role != 'client'`).map((u) => u.email));
  for (const ev of events) {
    ev.emails = emailsOf(ev).filter((e) => !own.has(e));
    ev.numbers = ev.phones.filter((p) => p.person).map((p) => p.e164);
    ev.words = shortlistWords(ev);
  }
  const emails = [...new Set(events.flatMap((e) => e.emails))];
  const numbers = [...new Set(events.flatMap((e) => e.numbers))];
  const words = [...new Set(events.flatMap((e) => e.words))];

  const byEmail = inChunks(emails, (some) => q.all(`SELECT ${CANDIDATE} FROM candidates c WHERE lower(c.email) IN (${marks(some.length)})`, ...some));
  const byPhone = inChunks(numbers.map((n) => n.slice(-10)), (some) => q.all(`SELECT ${CANDIDATE} FROM candidates c WHERE c.phone IS NOT NULL AND ${PHONE_TAIL} IN (${marks(some.length)}) LIMIT 500`, ...some))
    .map((c) => ({ ...c, e164: toE164(c.phone) }));
  catchUpNames();
  // Which of the day's words are somebody's first name.
  const firstNames = new Set(inChunks(words, (some) => q.all(`SELECT DISTINCT first FROM candidate_name_keys WHERE first IN (${marks(some.length)})`, ...some)).map((r) => r.first));
  /**
   * The people with a first name. When very many share it (thousands of Kevins in a large workspace), the forty whose
   * applications in progress were touched most recently: those are the ones a recruiter is likeliest to be meeting,
   * and all that happens to them is that they are offered.
   */
  const sharing = new Map();
  const peopleCalled = (first) => {
    if (!sharing.has(first)) {
      sharing.set(first, q.all(
        `SELECT ${CANDIDATE} FROM candidate_name_keys k JOIN candidates c ON c.id = k.candidate_id WHERE k.first = ?
         ORDER BY (SELECT MAX(a.updated_at) FROM applications a WHERE a.candidate_id = c.id AND a.status = 'active') DESC, c.id DESC LIMIT 40`, first));
    }
    return sharing.get(first);
  };

  // First pass: who each event names, by each kind of evidence.
  for (const ev of events) {
    ev.byEmail = byEmail.filter((c) => ev.emails.includes(c.email));
    ev.byPhone = byPhone.filter((c) => c.e164 && ev.numbers.includes(c.e164));
    ev.byFullName = [];
    ev.byFirstName = [];
    const firsts = ev.byEmail.length || ev.byPhone.length ? [] : ev.words.filter((w) => firstNames.has(w)).slice(0, 20);
    if (!firsts.length) continue;
    // A full name: somebody whose first and last words are both among the event's words. Then checked properly.
    const candidates = q.all(
      `SELECT ${CANDIDATE} FROM candidate_name_keys k JOIN candidates c ON c.id = k.candidate_id
       WHERE k.first IN (${marks(firsts.length)}) AND k.last IN (${marks(ev.words.length)}) LIMIT 200`, ...firsts, ...ev.words);
    ev.byFullName = namedIn(ev, candidates, own).full;
    if (ev.byFullName.length) continue;
    // Otherwise a first name on its own, which has to be in the title to count for anything.
    const inTitle = new Set(wordsOf(clip(ev.title, 500)));
    ev.byFirstName = namedIn(ev, firsts.filter((w) => inTitle.has(w)).slice(0, 5).flatMap(peopleCalled), own).first.slice(0, 60);
  }

  // The applications of everyone named, in one query: a match has to say which job the person is in for.
  const ids = [...new Set(events.flatMap((e) => [...e.byEmail, ...e.byPhone, ...e.byFullName, ...e.byFirstName].map((c) => c.id)))];
  const applications = new Map();
  for (const a of inChunks(ids, (some) => q.all(
    `SELECT a.id AS application_id, a.candidate_id, a.status, a.updated_at, j.title AS job_title, cl.name AS client_name
     FROM applications a JOIN jobs j ON j.id = a.job_id JOIN clients cl ON cl.id = j.client_id WHERE a.candidate_id IN (${marks(some.length)})`, ...some))) {
    if (!applications.has(a.candidate_id)) applications.set(a.candidate_id, []);
    applications.get(a.candidate_id).push(a);
  }
  // A person's application for this purpose: one still in progress if there is one, and of those the one touched last.
  const best = (c) => [...(applications.get(c.id) || [])].sort((a, b) => (b.status === 'active') - (a.status === 'active') || (a.updated_at < b.updated_at ? 1 : -1))[0];
  const shaped = (c, how) => {
    const a = best(c);
    return a ? { application_id: a.application_id, candidate_id: c.id, name: c.name, photo: c.photo, job_title: a.job_title, client_name: a.client_name, how } : null;
  };
  const offer = (people, how) => people.map((c) => shaped(c, how)).filter(Boolean).slice(0, MAX_SUGGESTIONS);
  /**
   * `records` are believed to be one person. One record is a match. The same person filed under two clients is a
   * match only when exactly one of the records is still in progress; otherwise which record is meant is the
   * recruiter's call, and both are offered.
   */
  const settle = (records, how) => {
    const usable = records.filter(best);
    const live = usable.filter((c) => best(c).status === 'active');
    const one = usable.length === 1 ? usable[0] : live.length === 1 ? live[0] : null;
    return one ? { match: shaped(one, how), suggestions: [] } : { match: null, suggestions: offer(usable, how) };
  };
  const onePerson = (records, field) => new Set(records.map((c) => c[field])).size === 1;
  const withDetails = (c) => ({ ...c, job_titles: (applications.get(c.id) || []).map((a) => a.job_title), client_names: (applications.get(c.id) || []).map((a) => a.client_name) });

  for (const ev of events) {
    let found;
    if (ev.byEmail.length) found = onePerson(ev.byEmail, 'email') ? settle(ev.byEmail, 'email') : { match: null, suggestions: offer(ev.byEmail, 'email') };
    else if (ev.byPhone.length) found = onePerson(ev.byPhone, 'e164') ? settle(ev.byPhone, 'phone') : { match: null, suggestions: offer(ev.byPhone, 'phone') };
    else if (ev.byFullName.length) {
      // Two records with one name are one person only if something else says so (the same address or number).
      const same = ev.byFullName.length === 1 || (ev.byFullName.every((c) => c.email) && onePerson(ev.byFullName, 'email'))
        || (ev.byFullName.every((c) => toE164(c.phone)) && new Set(ev.byFullName.map((c) => toE164(c.phone))).size === 1);
      found = same ? settle(ev.byFullName, 'name') : { match: null, suggestions: offer(ev.byFullName, 'name') };
    } else {
      const near = new Set(interviews.filter((i) => Math.abs(new Date(i.starts_at) - ev.start) <= NEAR_INTERVIEW).map((i) => i.candidate_id));
      found = { match: null, suggestions: offer(likeliestFirst(ev, ev.byFirstName.map(withDetails), near), 'name') };
    }
    ev.match = found.match;
    ev.suggestions = found.suggestions;
  }
}

// ---------- The Book's own interviews ----------
/** The interviews of one day that are this person's: candidates they own, interviews they set up, and ones they are on the panel of. */
function interviewsOf(user, from, to) {
  return q.all(
    `SELECT i.id, i.title, i.kind, i.starts_at, i.duration_min, i.location, i.notes,
       a.id AS application_id, c.id AS candidate_id, c.name, c.email, c.phone, substr(c.photo_file, 1, 8) AS photo, j.title AS job_title, cl.name AS client_name
     FROM interviews i JOIN applications a ON a.id = i.application_id JOIN candidates c ON c.id = a.candidate_id
     JOIN jobs j ON j.id = a.job_id JOIN clients cl ON cl.id = j.client_id
     WHERE i.status != 'cancelled' AND i.starts_at >= ? AND i.starts_at < ?
       AND (a.owner_id = ? OR i.created_by = ? OR EXISTS (SELECT 1 FROM interview_panel p WHERE p.interview_id = i.id AND p.user_id = ?))
     ORDER BY i.starts_at, i.id LIMIT 100`, from.toISOString(), to.toISOString(), user.id, user.id, user.id);
}
function interviewEvent(i) {
  const where = { title: i.title, location: i.location, description: i.notes };
  const start = new Date(i.starts_at);
  const typed = findPhones(where).find((p) => p.person)?.e164 ?? null;
  return {
    source: 'interview', id: String(i.id), title: i.title, allDay: false, start, end: new Date(start.getTime() + i.duration_min * MINUTE),
    join: findJoinLink(where),
    // A phone interview is a call to the candidate, so their own number is the one to ring when none was typed in.
    phone: typed ?? (i.kind === 'phone' ? toE164(i.phone) : null),
    guests: [{ name: i.name, email: i.email || null }],
    match: { application_id: i.application_id, candidate_id: i.candidate_id, name: i.name, photo: i.photo, job_title: i.job_title, client_name: i.client_name, how: 'interview' },
    suggestions: [],
  };
}

// ---------- what a person has done with their events ----------
const rowsOf = (userId, keys) => new Map(inChunks(keys, (some) => q.all(`SELECT * FROM calendar_events WHERE user_id = ? AND event_key IN (${marks(some.length)})`, userId, ...some)).map((r) => [r.event_key, r]));

let lastTidy = 0;
/** Forget events nobody has looked at for a month, and marked ones after about a year. At most once an hour. */
function tidy() {
  if (Date.now() - lastTidy < HOUR) return;
  lastTidy = Date.now();
  q.run('DELETE FROM calendar_events WHERE seen_at < ? AND (seen_at < ? OR (added = 0 AND application_id IS NULL AND call_id IS NULL))',
    new Date(Date.now() - KEEP_SEEN).toISOString(), new Date(Date.now() - KEEP_MARKED).toISOString());
}

/**
 * Give every event of the day its key and its row, making rows for events seen for the first time.
 * Two things are put right here as well:
 *   - A calendar sometimes gives an event a new identity (Google does when a repeating event is changed "from this
 *     date onwards"). A marked event that has vanished is matched to a new one with the same title and start time,
 *     so the mark is not lost.
 *   - A calendar event that is one of The Book's interviews hands its marks to the interview, which is the one shown.
 */
function remember(user, events, ymd, tz) {
  for (const ev of events) {
    ev.key = keyOf(user.id, ev.source, ev.id);
    ev.print = printOf(user.id, ev.title, ev.start);
  }
  const rows = rowsOf(user.id, events.map((e) => e.key));
  const fresh = events.filter((e) => !rows.has(e.key));
  const stamp = now();
  const changes = [];
  if (fresh.length) {
    const lost = inChunks([...new Set(fresh.map((e) => e.print))], (some) => q.all(
      `SELECT * FROM calendar_events WHERE user_id = ? AND fingerprint IN (${marks(some.length)}) AND (added = 1 OR application_id IS NOT NULL OR call_id IS NOT NULL)`, user.id, ...some))
      .filter((r) => !rows.has(r.event_key));
    for (const ev of fresh) {
      const old = lost.filter((r) => r.fingerprint === ev.print && r.source === ev.source);
      if (old.length === 1 && !old[0].taken) {
        old[0].taken = true;
        changes.push(() => q.run('UPDATE calendar_events SET event_key = ?, day = ?, tz = ?, seen_at = ? WHERE user_id = ? AND event_key = ?', ev.key, ymd, tz, stamp, user.id, old[0].event_key));
        rows.set(ev.key, { ...old[0], event_key: ev.key, day: ymd, tz, seen_at: stamp });
      } else {
        changes.push(() => q.run('INSERT OR IGNORE INTO calendar_events (user_id, event_key, source, day, tz, fingerprint, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)', user.id, ev.key, ev.source, ymd, tz, ev.print, stamp));
        rows.set(ev.key, { user_id: user.id, event_key: ev.key, source: ev.source, day: ymd, tz, fingerprint: ev.print, added: 0, application_id: null, call_id: null, seen_at: stamp });
      }
    }
  }
  for (const ev of events) {
    const row = rows.get(ev.key);
    // Where it was last seen is kept up to date (an event can move to another day); "seen" is refreshed once a day at most.
    if (row.day !== ymd || row.tz !== tz || row.fingerprint !== ev.print || Date.parse(stamp) - Date.parse(row.seen_at) > DAY) {
      changes.push(() => q.run('UPDATE calendar_events SET day = ?, tz = ?, fingerprint = ?, seen_at = ? WHERE user_id = ? AND event_key = ?', ymd, tz, ev.print, stamp, user.id, ev.key));
      Object.assign(row, { day: ymd, tz, fingerprint: ev.print, seen_at: stamp });
    }
    ev.row = row;
  }
  // A calendar event that is one of The Book's interviews: the interview is shown, with whatever the calendar adds.
  for (const interview of events.filter((e) => e.source === 'interview')) {
    for (const twin of events.filter((e) => e.source === 'calendar' && !e.allDay && !e.hidden)) {
      const who = twin.row.application_id ? q.get('SELECT candidate_id FROM applications WHERE id = ?', twin.row.application_id)?.candidate_id : twin.match?.candidate_id;
      if (who !== interview.match.candidate_id || Math.abs(twin.start - interview.start) > SAME_MEETING) continue;
      twin.hidden = true;
      interview.join ||= twin.join;
      interview.phone ||= twin.phone;
      if (twin.row.added || twin.row.call_id) {
        const added = interview.row.added || twin.row.added, callId = interview.row.call_id ?? twin.row.call_id;
        changes.push(() => {
          q.run('UPDATE calendar_events SET added = ?, call_id = ? WHERE user_id = ? AND event_key = ?', added, callId, user.id, interview.key);
          q.run('UPDATE calendar_events SET added = 0, call_id = NULL WHERE user_id = ? AND event_key = ?', user.id, twin.key);
        });
        Object.assign(interview.row, { added, call_id: callId });
      }
      break;
    }
  }
  if (changes.length) tx(() => changes.forEach((change) => change()));
  tidy();
}

/** The candidate a person chose for an event themselves, in the shape of a match; null when the application has gone. */
function chosen(applicationId) {
  const a = q.get(
    `SELECT a.id AS application_id, c.id AS candidate_id, c.name, substr(c.photo_file, 1, 8) AS photo, j.title AS job_title, cl.name AS client_name
     FROM applications a JOIN candidates c ON c.id = a.candidate_id JOIN jobs j ON j.id = a.job_id JOIN clients cl ON cl.id = j.client_id WHERE a.id = ?`, applicationId);
  return a ? { ...a, how: 'chosen' } : null;
}

/** An event as the routes give it. Only what is listed here leaves the server: descriptions and locations do not. */
function shape(ev) {
  const own = ev.row.application_id ? chosen(ev.row.application_id) : null;
  return {
    key: ev.key, source: ev.source, title: ev.title, start: ev.start.toISOString(), end: ev.end.toISOString(), all_day: ev.allDay,
    join_url: ev.join?.url ?? null, join_kind: ev.join?.kind ?? null, phone: ev.phone ?? null,
    guests: ev.guests.map((g) => ({ name: g.name ?? null, email: g.email ?? null })),
    added: Boolean(ev.row.added),
    match: own ?? ev.match ?? null,
    suggestions: own || ev.match ? [] : ev.suggestions ?? [],
    call_id: ev.row.call_id ?? null,
  };
}

/** A person's day: their calendar's events and their interviews in The Book, in the order they happen. */
async function dayOf(user, ymd, tz, { force = false } = {}) {
  const link = linkOf(user.id);
  const { start, end } = dayWindow(ymd, tz);
  const fromCalendar = link ? await calendarDay(link, ymd, tz, force) : { events: [], warnings: [] };
  const interviews = interviewsOf(user, start, end);
  const calendarEvents = fromCalendar.events.map((e) => ({ ...e, source: 'calendar', phone: e.phones.find((p) => p.person)?.e164 ?? null }));
  matchEvents(calendarEvents, interviews);
  const events = [...calendarEvents, ...interviews.map(interviewEvent)];
  remember(user, events, ymd, tz);
  const shown = events.filter((e) => !e.hidden)
    .sort((a, b) => (a.allDay === b.allDay ? a.start - b.start || a.title.localeCompare(b.title) || (a.key < b.key ? -1 : 1) : a.allDay ? -1 : 1));
  return { date: ymd, tz, connected: Boolean(link), events: shown.map(shape), warnings: [...new Set(fromCalendar.warnings)].slice(0, 10) };
}

/**
 * Tie a recorded call to the calendar event it was made for, so the event shows that its call was recorded and links
 * to it. Used when a recording or a phone call is started with an `event_key`. It never throws and never stops a
 * call: a key that is not one of this person's events is simply not tied, and the answer is false.
 */
export function tieCallToEvent(userId, eventKey, callId) {
  if (typeof eventKey !== 'string' || !KEY.test(eventKey) || !Number.isInteger(callId)) return false;
  try {
    return q.run('UPDATE calendar_events SET call_id = ? WHERE user_id = ? AND event_key = ?', callId, userId, eventKey).changes > 0;
  } catch {
    return false;
  }
}

export function registerCalendar(api, { agencyOnly, bad, takeHit, loadApp }) {
  // Catch up on candidates' names a batch at a time once the server is up, without holding it up.
  const catchUp = () => { try { if (catchUpNames() > 0) setImmediate(catchUp); } catch { /* tried again when a day is next looked at */ } };
  setImmediate(catchUp);

  /** The time zone a request is for: the one the browser gave, or the one this person last used. */
  const zoneOf = (given, link) => {
    if (given == null || given === '') return link?.tz && validZone(link.tz) ? link.tz : DEFAULT_ZONE;
    return validZone(given) ? given : bad('That time zone was not recognised.');
  };

  api.get('/calendar/status', agencyOnly, (req, res) => {
    const link = linkOf(req.user.id);
    res.json({ connected: Boolean(link), provider: link?.provider ?? null, last_read_at: link?.last_read_at ?? null, error: link?.last_error ?? null });
  });

  // Save a calendar link. It is read once first: a link that does not open a calendar is not kept.
  api.put('/calendar/link', agencyOnly, async (req, res) => {
    const b = req.body || {};
    if (typeof b.url !== 'string' || !b.url.trim()) bad('Paste your calendar link first.');
    const tz = zoneOf(b.tz, linkOf(req.user.id));
    // Every try makes this server fetch an address somebody typed, so tries are limited.
    if (!takeHit(`calendar-link:${req.user.id}`, 12, HOUR)) bad('That is a lot of tries in one hour. Try again a little later.', 429);
    let url, read;
    try {
      url = normalizeFeedUrl(b.url);
      const feed = await cache.get(req.user.id, url.href, { force: true });
      if (feed.stale) throw feed.error;                                   // an old copy does not prove the link works now
      read = await readDay({ version: feed.version, text: feed.text, zone: tz, ymd: wallClock(new Date(), tz).ymd });
    } catch (err) {
      if (err?.status) throw err;
      if (!(err instanceof FeedFetchError) && !(err instanceof CalendarReadError)) console.error(`Calendar: checking a link failed (${err?.code || err?.name || 'error'}).`);
      // The link that was saved before, if any, is left as it was. What was read while trying this one is not kept.
      forgetRead(cache.forget(req.user.id));
      bad(problemOf(err));
    }
    const provider = providerOf(url);
    q.run(
      `INSERT INTO calendar_links (user_id, provider, link_sealed, tz, created_at, last_read_at, last_error) VALUES (?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(user_id) DO UPDATE SET provider = excluded.provider, link_sealed = excluded.link_sealed, tz = excluded.tz, created_at = excluded.created_at, last_read_at = excluded.last_read_at, last_error = NULL`,
      req.user.id, provider, seal(url.href, 'calendar-link'), tz, now(), now());
    res.json({ connected: true, provider, events_today: read.events.filter((e) => !e.cancelled).length });
  });

  // Remove the link, what was read from it, and what was noted about its events.
  api.delete('/calendar/link', agencyOnly, (req, res) => {
    tx(() => {
      q.run('DELETE FROM calendar_links WHERE user_id = ?', req.user.id);
      q.run(`DELETE FROM calendar_events WHERE user_id = ? AND source = 'calendar'`, req.user.id);
    });
    forgetRead(cache.forget(req.user.id));
    res.json({ ok: true });
  });

  api.get('/calendar/day', agencyOnly, async (req, res) => {
    const tz = zoneOf(req.query.tz, linkOf(req.user.id));
    const ymd = req.query.date == null || req.query.date === '' ? wallClock(new Date(), tz).ymd : req.query.date;
    if (!validDay(ymd)) bad('That date could not be read. Use the form 2026-11-10.');
    // "refresh=1" reads the calendar again now, not in up to five minutes. Asked for too often, it is quietly not done.
    const force = req.query.refresh === '1' && takeHit(`calendar-refresh:${req.user.id}`, 12, 10 * MINUTE);
    res.json(await dayOf(req.user, ymd, tz, { force }));
  });

  // "+ Add", and choosing who an event is with. Answers with the event as it now stands.
  api.put('/calendar/events/:key', agencyOnly, async (req, res) => {
    const b = req.body || {};
    const missing = 'That event was not found. Open your day again and try once more.';
    // Looked up among this person's own events only, so somebody else's key finds nothing.
    const row = KEY.test(req.params.key) ? q.get('SELECT * FROM calendar_events WHERE user_id = ? AND event_key = ?', req.user.id, req.params.key) : null;
    if (!row) bad(missing, 404);
    const sets = [], values = [];
    if (b.added !== undefined) {
      if (typeof b.added !== 'boolean') bad('"added" must be true or false.');
      sets.push('added = ?'); values.push(b.added ? 1 : 0);
    }
    if (b.application_id !== undefined) {
      let app = null;
      if (b.application_id !== null) {
        try { app = loadApp(b.application_id, req.user); } catch { bad('That candidate was not found. They may have been removed.', 404); }
      }
      sets.push('application_id = ?'); values.push(app?.id ?? null);
    }
    if (!sets.length) bad('Say whether the event is added, or who it is with.');
    q.run(`UPDATE calendar_events SET ${sets.join(', ')} WHERE user_id = ? AND event_key = ?`, ...values, req.user.id, row.event_key);
    const day = await dayOf(req.user, row.day, validZone(row.tz) ? row.tz : DEFAULT_ZONE);
    const event = day.events.find((e) => e.key === row.event_key);
    if (!event) bad('That event is no longer in your calendar on that day. Open your day again to see it as it is now.', 404);
    res.json(event);
  });
}
