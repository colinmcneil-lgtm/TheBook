// What the calendar tests share: where their files are, the ports they use, a way to start The Book's API so that it
// reads calendar files from a folder, and a way to show a day as a list of lines.
//
// No real calendar is read by any of these tests. The calendar files are hand-written to look like what Google and
// Outlook publish, so the tests cannot prove what a real Google, Outlook or iCloud link contains.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseFeed, eventsForDay } from '../server/calendar-day.js';
import { wallClock } from '../server/calendar-time.js';
import { sleep } from './oracle-helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
export const CALENDARS = path.join(HERE, 'fixtures', 'calendar');
export const calendarFile = (name) => fs.readFileSync(path.join(CALENDARS, name), 'utf8');

// Ports: five in a row from CALENDAR_TEST_PORT (3640 unless set). Two for servers, then three for the stand-ins the
// reader of calendar links is attacked with. Keep them clear of the Oracle tests' ports and of 3659 (see oracle-helpers.mjs).
const BASE_PORT = Number(process.env.CALENDAR_TEST_PORT) || 3640;
export const PORTS = { api: BASE_PORT, production: BASE_PORT + 1, feeds: BASE_PORT + 2, feedsTls: BASE_PORT + 3, internal: BASE_PORT + 4 };

/**
 * Start The Book's API (test/calendar-server.mjs) on a data folder. With `files`, links to https://calendar.test/<name>.ics
 * are read from that folder. Resolves once it is listening; `stop()` ends it.
 */
export async function startApi({ port, dataDir, files, env = {} }) {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'test/calendar-server.mjs'], {
    cwd: ROOT,
    // TZ is passed on, so that running the tests with TZ set shows the day does not depend on where the server is.
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test', PORT: String(port), DATA_DIR: dataDir, ...(process.env.TZ ? { TZ: process.env.TZ } : {}), ...(files ? { CALENDAR_TEST_FILES: files } : {}), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  for (let waited = 0; !output.includes('is running on'); waited += 50) {
    if (child.exitCode !== null || waited > 15000) throw new Error(`The API did not start:\n${output}`);
    await sleep(50);
  }
  return { base: `http://127.0.0.1:${port}`, output: () => output, stop: async (signal = 'SIGTERM') => { child.kill(signal); await exited; } };
}

const hhmm = (date, zone) => { const w = wallClock(date, zone); return `${String(w.hour).padStart(2, '0')}:${String(w.minute).padStart(2, '0')}`; };
/** One line for an event: "09:30-10:15 Title", or "all day Title". Works on the reader's events and on the API's. */
export function line(event, zone) {
  if (event.allDay ?? event.all_day) return `all day ${event.title}`;
  return `${hhmm(new Date(event.start), zone)}-${hhmm(new Date(event.end), zone)} ${event.title}`;
}
/** A calendar file's day as lines, cancelled events left out, as the day view shows it. Also gives the events and warnings. */
export function dayOfFile(text, ymd, zone = 'America/Toronto') {
  const { events, warnings } = eventsForDay(parseFeed(text, zone), ymd);
  const shown = events.filter((e) => !e.cancelled);
  return { lines: shown.map((e) => line(e, zone)), events, shown, warnings };
}

// ---------- writing calendar files in a test ----------
const TORONTO = ['BEGIN:VTIMEZONE', 'TZID:America/Toronto', 'BEGIN:DAYLIGHT', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400', 'DTSTART:19700308T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'DTSTART:19701101T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'END:STANDARD', 'END:VTIMEZONE'];
/** One event, from its lines ("UID:x", "SUMMARY:y", ...). */
export const vevent = (...lines) => ['BEGIN:VEVENT', 'DTSTAMP:20261109T220000Z', ...lines, 'END:VEVENT'];
/** A whole calendar file from events, with the Toronto time zone defined as Google defines it. */
export const calendar = (...events) => `${['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//The Book tests//EN', ...TORONTO, ...events.flat(), 'END:VCALENDAR'].join('\r\n')}\r\n`;
/** A time in Toronto on a day, for a DTSTART or DTEND line: at('20261110', '0930') gives ";TZID=America/Toronto:20261110T093000". */
export const at = (day, time) => `;TZID=America/Toronto:${day}T${time}00`;
