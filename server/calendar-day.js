// One day's events out of a calendar file (ICS), on the recruiter's own clock.
//
// The reading and the working-out of repeating events is done by node-ical. This file wraps it, because on its own
// it gets several things wrong that matter here:
//   - All-day events come back as "midnight where the server is". They are compared as dates here, never as
//     instants, or they would spill into the day before or after for anyone in another time zone.
//   - A time written with no zone at all is read as the recruiter's wall clock, not the server's.
//   - Time-zone labels are settled before node-ical sees the file (see settleZones): it only honours a zone defined
//     inside the file when the label has one of two particular spellings, and otherwise quietly uses the server's
//     zone, which put a 20:00 meeting at 15:00.
//   - Cancelled events and cancelled single dates of a repeating event are flagged, so the caller can leave them out.
//   - A rule that repeats every second or minute cannot flood the list.
//   - A web page handed over in place of a calendar is refused (node-ical would return an empty calendar).
//   - What leaves here is bounded: titles, descriptions, locations and guest lists are cut to sensible lengths.
//
// Reading a large file takes about a second for 5,000 events, and nothing else can happen on the same thread
// meanwhile, so the server runs this in a worker thread (calendar-worker.js) and reads each download once.
import nodeIcal from 'node-ical';
import { dayWindow, zonedTimeToUtc } from './calendar-time.js';
import { clip, findJoinLink, findPhones } from './calendar-links.js';

const PAD_MS = 36 * 3600000;             // look a day and a half either side, then keep exactly what falls on the day
const DAY_BUDGET_MS = 8000;       // how long working out one day's repeating events may take before the rest are left out
const MAX_OCCURRENCES = 24;              // of one event in that window; more than this is not a meeting
const MAX_TITLE = 300, MAX_LOCATION = 2000, MAX_DESCRIPTION = 20000, MAX_GUESTS = 100, MAX_NAME = 200, MAX_WARNINGS = 8;

/** node-ical hands some values back as { params, val } (a title with a language, for one). This gives the value. */
const val = (v) => (v && typeof v === 'object' && !(v instanceof Date) && 'val' in v ? v.val : v);
const text = (v) => { const x = val(v); return x == null ? '' : String(x); };
const pad2 = (n) => String(n).padStart(2, '0');
/** The date node-ical built for an all-day event, read back as the date it was written as. */
const localYmd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
/** A time with no zone was built on the server's clock; read the same wall-clock time in the recruiter's zone. */
const refloat = (d, zone) => zonedTimeToUtc(d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), zone);
const quoted = (title) => `"${clip(title, 80)}"`;

// ---------- time-zone labels ----------
// Each label used in the file is settled in one of four ways before node-ical reads it:
//   keep     a real zone name, or one node-ical recognises by itself (it knows the Windows names Outlook writes)
//   rename   to a name node-ical knows, or to "Customized Time Zone N", the one spelling for which it uses the
//            definition inside the file; the result is then checked on two dates against that definition
//   shift    the label is only an offset ("UTC-05:00"): the times are rewritten in UTC
//   local    nothing usable: the times are read as the recruiter's wall clock, and a warning says so
const zoneOk = (z) => { try { new Intl.DateTimeFormat('en', { timeZone: z }); return true; } catch { return false; } };
const probe = (lines) => {
  try { return Object.values(nodeIcal.sync.parseICS(['BEGIN:VCALENDAR', 'VERSION:2.0', ...lines, 'END:VCALENDAR'].join('\r\n'))).filter((x) => x.type === 'VEVENT'); } catch { return []; }
};
const knownNames = new Map();
/** Does node-ical turn this label, by its name alone, into a real zone? Asked of node-ical itself, once per label. */
function knownByName(tzid) {
  if (knownNames.has(tzid)) return knownNames.get(tzid);
  let ok = false;
  if (!/["\r\n]/.test(tzid) && tzid.length <= 120) {
    const start = probe(['BEGIN:VEVENT', 'UID:probe', `DTSTART;TZID="${tzid}":20260115T120000`, 'END:VEVENT'])[0]?.start;
    ok = start instanceof Date && !Number.isNaN(start.getTime()) && typeof start.tz === 'string' && zoneOk(start.tz) && !/^(Customized Time Zone|tzone:)/i.test(tzid);
  }
  if (knownNames.size > 2000) knownNames.clear();
  knownNames.set(tzid, ok);
  return ok;
}
const offsetMinutes = (s) => { const m = /^([+-])(\d{2})(\d{2})(\d{2})?$/.exec(String(s || '').trim()); return m ? (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +m[3]) : null; };
/** What a zone definition in the file states: its winter and summer offsets, and the month each begins. */
function readDefinition(block) {
  const parts = [];
  let cur = null, m;
  for (const line of block) {
    if ((m = /^BEGIN:(STANDARD|DAYLIGHT)$/i.exec(line))) cur = { type: m[1].toUpperCase(), year: 0, month: 0, to: null };
    else if (/^END:(STANDARD|DAYLIGHT)$/i.test(line)) { if (cur && cur.to !== null) parts.push(cur); cur = null; }
    else if (cur && (m = /^TZOFFSETTO:(.+)$/i.exec(line))) cur.to = offsetMinutes(m[1]);
    else if (cur && (m = /^DTSTART[^:]*:(\d{4})(\d{2})/i.exec(line))) { cur.year = +m[1]; cur.month ||= +m[2]; }
    else if (cur && (m = /^RRULE:.*BYMONTH=(\d{1,2})/i.exec(line))) cur.month = +m[1];
  }
  const newest = (type) => parts.filter((p) => p.type === type).sort((a, b) => b.year - a.year)[0];
  const std = newest('STANDARD') || newest('DAYLIGHT');
  const dst = newest('STANDARD') ? newest('DAYLIGHT') : null;
  if (!std) return null;
  return { std: std.to, stdMonth: std.month, dst: dst && dst.to !== std.to ? dst.to : null, dstMonth: dst ? dst.month : 0 };
}
const stampUtc = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}Z`; };
const wallMs = (v) => Date.UTC(+v.slice(0, 4), +v.slice(4, 6) - 1, +v.slice(6, 8), +v.slice(9, 11), +v.slice(11, 13), +v.slice(13, 15));
/** Once a definition is renamed to `alias`, does node-ical give the offsets it states? Tried mid-month, a month after each change of clocks. */
function definitionWorks(block, alias, def) {
  const tests = [[(def.stdMonth % 12) + 1 || 1, def.std]];
  if (def.dst !== null) tests.push([(def.dstMonth % 12) + 1 || 7, def.dst]);
  const lines = block.map((l) => (/^TZID:/i.test(l) ? `TZID:${alias}` : l));
  tests.forEach(([month], i) => lines.push('BEGIN:VEVENT', `UID:probe${i}`, `DTSTART;TZID=${alias}:2026${pad2(month)}15T120000`, 'END:VEVENT'));
  const got = probe(lines);
  return tests.every(([month, offset], i) => {
    const start = got.find((e) => e.uid === `probe${i}`)?.start;
    return start instanceof Date && start.getTime() === Date.UTC(2026, month - 1, 15, 12) - offset * 60000;
  });
}

/**
 * Rewrite a calendar file so that reading it gives the same answer wherever the server runs:
 *   - a time with no zone gets the recruiter's zone;
 *   - every time-zone label is settled as described above;
 *   - zone definitions are moved in front of the first event, because node-ical only finds one it has already read
 *     and the standard lets them sit anywhere.
 * Returns the new text and, as `unknownZones` and `rangeChanges`, what the caller should warn about.
 */
export function settleZones(icsText, zone) {
  const lines = icsText.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);   // join continued lines, then work line by line
  // First pass: lift the zone definitions out.
  const blocks = new Map(), body = [];
  let cur = null;
  for (const line of lines) {
    if (/^BEGIN:VTIMEZONE$/i.test(line)) { cur = [line]; continue; }
    if (cur) {
      cur.push(line);
      if (/^END:VTIMEZONE$/i.test(line)) {
        const id = cur.map((l) => /^TZID(?:;[^:]*)?:(.*)$/i.exec(l)).find(Boolean)?.[1].replace(/^"(.*)"$/, '$1').trim();
        if (id && !blocks.has(id)) blocks.set(id, { lines: cur, alias: null });
        cur = null;
      }
      continue;
    }
    body.push(line);
  }
  if (cur) body.push(...cur);                                          // a definition that never ends is left where it was

  const unknownZones = [], decided = new Map();
  let aliases = 0, rangeChanges = 0;
  const decide = (tzid) => {
    if (decided.has(tzid)) return decided.get(tzid);
    const fixed = (sign, h, m) => {                                    // a label that is only an offset from UTC
      const minutes = (sign === '-' ? -1 : 1) * (+h * 60 + +(m || 0));
      return Math.abs(minutes) <= 14 * 60 ? { action: 'shift', minutes } : null;
    };
    let d, m;
    if (/^tzone:\/\/Microsoft\/Utc$/i.test(tzid)) d = { action: 'rename', to: 'Etc/UTC' };
    else if (/^(Customized Time Zone|tzone:\/\/Microsoft\/|\(no TZ description\))/i.test(tzid)) d = blocks.has(tzid) ? { action: 'keep' } : { action: 'local' };
    else if (zoneOk(tzid) && !/^[+-]/.test(tzid)) d = { action: 'keep' };
    else if (knownByName(tzid)) d = { action: 'keep' };
    // "(GMT-05:00) Eastern Time (US & Canada)": an older Outlook spelling. Read by the name, or it would be a fixed
    // offset and an hour out all summer.
    else if ((m = /^\((?:GMT|UTC)\s*[+-]\d{1,2}:?\d{2}\)\s*(.+)$/i.exec(tzid)) && knownByName(m[1])) d = { action: 'rename', to: m[1] };
    // "/mozilla.org/20050126_1/America/Toronto"
    else if (tzid.startsWith('/') && (m = /\/([A-Za-z_]+\/[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)?)$/.exec(tzid)) && zoneOk(m[1])) d = { action: 'rename', to: m[1] };
    else if (blocks.has(tzid)) {
      const block = blocks.get(tzid), def = readDefinition(block.lines), alias = `Customized Time Zone ${++aliases}`;
      if (def && definitionWorks(block.lines, alias, def)) { block.alias = alias; d = { action: 'rename', to: alias }; }
      else if (def && def.dst === null) d = { action: 'shift', minutes: def.std };
      else d = { action: 'local' };
    } else if ((m = /^(?:UTC|GMT)?\s*([+-])(\d{1,2})(?::?(\d{2}))?$/i.exec(tzid)) || (m = /^\((?:GMT|UTC)\s*([+-])(\d{1,2}):?(\d{2})\)/i.exec(tzid))) d = fixed(m[1], m[2], m[3]) || { action: 'local' };
    else d = { action: 'local' };
    if (d.action === 'local') unknownZones.push(tzid);
    decided.set(tzid, d);
    return d;
  };

  // Second pass: the date lines of events. The last ":<dates>" on the line ends the parameters, so a label may itself contain ":".
  const DATE_LINE = /^(DTSTART|DTEND|DUE|RECURRENCE-ID|EXDATE|RDATE)((?:;.*)?):(\d{8}T\d{6}Z?(?:,\d{8}T\d{6}Z?)*)$/i;
  const out = body.map((line) => {
    const m = DATE_LINE.exec(line);
    if (!m) return line;
    const [, name, params, value] = m;
    if (/^RECURRENCE-ID$/i.test(name) && /;RANGE=THISANDFUTURE/i.test(params)) rangeChanges++;
    const tz = /;TZID=(?:"([^"]*)"|([^;]*))/i.exec(params);
    if (!tz) {
      if (/VALUE=DATE(;|$)|VALUE=PERIOD/i.test(params) || /Z/.test(value)) return line;
      return `${name}${params};TZID=${zone}:${value}`;                 // no zone at all: the recruiter's wall clock
    }
    if (/Z/.test(value)) return line;                                  // already in UTC; the label means nothing
    const d = decide((tz[1] ?? tz[2]).trim());
    const rest = params.replace(tz[0], '');
    if (d.action === 'keep') return line;
    if (d.action === 'rename') return `${name}${rest};TZID=${d.to}:${value}`;
    if (d.action === 'shift') return `${name}${rest}:${value.split(',').map((v) => stampUtc(wallMs(v) - d.minutes * 60000)).join(',')}`;
    return `${name}${rest};TZID=${zone}:${value}`;
  });

  // Put the definitions back in front of the first event, renamed where a new name was chosen.
  const defs = [...blocks.values()].flatMap((b) => (b.alias ? b.lines.map((l) => (/^TZID(?:;[^:]*)?:/i.test(l) ? `TZID:${b.alias}` : l)) : b.lines));
  const at = out.findIndex((l) => /^BEGIN:(?!VCALENDAR)/i.test(l));
  return { text: (at < 0 ? [...out, ...defs] : [...out.slice(0, at), ...defs, ...out.slice(at)]).join('\r\n'), unknownZones, rangeChanges };
}

/** The guests (or the organiser) of an event as a plain list. node-ical gives one object for one guest and a list for several. */
function people(v) {
  if (!v) return [];
  return (Array.isArray(v) ? v : [v]).slice(0, MAX_GUESTS * 2).map((a) => {
    const email = text(a).slice(0, 330).replace(/^mailto:/i, '').trim().toLowerCase();
    const cn = a?.params?.CN ? String(a.params.CN).slice(0, MAX_NAME).replace(/^"|"$/g, '').trim() : '';
    return {
      email: /^[^\s@]+@[^\s@]+$/.test(email) ? email : null,
      name: cn && cn.toLowerCase() !== email ? cn : null,
      // A meeting room or a piece of equipment booked with the meeting is not a person.
      room: /^(ROOM|RESOURCE)$/i.test(a?.params?.CUTYPE || ''),
    };
  }).filter((p) => (p.email || p.name) && !p.room).slice(0, MAX_GUESTS).map(({ room, ...person }) => person);
}

/**
 * Read a calendar file once. The result is handed to eventsForDay for as many days as are wanted: nearly all the
 * time goes on the reading, so a download is read once and kept, not read again for each day.
 * Throws when the text is not a calendar at all.
 */
export function parseFeed(icsText, zone) {
  if (!/^\uFEFF?\s*BEGIN:VCALENDAR/i.test(String(icsText).slice(0, 200))) throw new Error('not a calendar');
  const settled = settleZones(icsText, zone);
  const warnings = [];
  if (settled.unknownZones.length) {
    warnings.push(`Some events use a time zone this reader does not know (${settled.unknownZones.slice(0, 3).map(quoted).join(', ')}), so their times are shown exactly as they were written. Check those events against your calendar.`);
  }
  if (settled.rangeChanges) {
    warnings.push('A repeating event in your calendar was changed "from this date onwards" in a way this reader only applies to the first changed date. Later dates of that event may show at their old time.');
  }
  return { parsed: true, zone, data: nodeIcal.sync.parseICS(settled.text), warnings };
}

/**
 * The events of one day ("YYYY-MM-DD") on the clock of `zone`, from what parseFeed returned.
 * Each event: { id, title, allDay, start, end (instants; for an all-day event the first and last midnight in the zone),
 * cancelled, location, description, guests: [{ name, email }], join: { kind, url } | null, phones: [{ e164, person }] }.
 * `id` names the event for good: the event's own identifier plus, for one date of a repeating event, the time that
 * date was first set for. So it stays the same when the event is renamed, and when that one date is moved.
 * Cancelled events are included and flagged, so the caller decides. `warnings` are plain sentences for the recruiter.
 */
/** Roughly how many times a day a repeating rule comes round at its busiest, from the hours, minutes and seconds it lists. */
function timesADay(options, freq) {
  const listed = (list) => (Array.isArray(list) && list.length ? list.length : 1);
  const hours = freq === 'HOURLY' ? Math.ceil(24 / Math.max(1, Number(options.interval) || 1)) : listed(options.byHour);
  return hours * listed(options.byMinute) * listed(options.bySecond);
}

export function eventsForDay(feed, ymd) {
  const zone = feed.zone;
  const { start: dayStart, end: dayEnd } = dayWindow(ymd, zone);
  const warnings = [...feed.warnings], events = [];
  const skip = (title, why) => { if (warnings.length < MAX_WARNINGS) warnings.push(`${quoted(title || 'An event')} was left out because ${why}.`); };
  const began = Date.now();
  let outOfTime = false;

  for (const ev of Object.values(feed.data)) {
    if (ev.type !== 'VEVENT') continue;
    const masterTitle = text(ev.summary);
    const freq = String(ev.rrule?.options?.freq ?? '').toUpperCase();
    if (freq === 'SECONDLY' || freq === 'MINUTELY') { skip(masterTitle, `it repeats every ${freq === 'SECONDLY' ? 'second' : 'minute'}`); continue; }
    // A rule can also list many minutes and seconds of every hour, which comes to the same thing and is far slower
    // to work out than to refuse: twenty such events in a small file held the reader for most of a minute.
    if (freq && timesADay(ev.rrule.options, freq) > MAX_OCCURRENCES) { skip(masterTitle, 'it repeats too often to be a meeting'); continue; }
    // One day gets a few seconds. Whatever repeating events are left after that are left out, and the recruiter is told.
    if (freq && Date.now() - began > DAY_BUDGET_MS) {
      if (!outOfTime) warnings.unshift('Your calendar has so many repeating events that reading this day took too long, so some of them are not shown.');
      outOfTime = true;
      continue;
    }
    if (!(ev.start instanceof Date) || Number.isNaN(ev.start.getTime())) { skip(masterTitle, 'its start time could not be read'); continue; }

    let occurrences;
    try {
      occurrences = nodeIcal.expandRecurringEvent(ev, { from: new Date(dayStart.getTime() - PAD_MS), to: new Date(dayEnd.getTime() + PAD_MS), expandOngoing: true, maxIterations: 5000 });
    } catch { skip(masterTitle, 'the way it repeats could not be read'); continue; }
    if (occurrences.length > MAX_OCCURRENCES) { skip(masterTitle, 'it repeats too often to be a meeting'); continue; }

    for (const occ of occurrences) {
      const src = occ.event || ev;                     // the changed copy, when this one date of a series was edited
      let start = occ.start, end = occ.end;
      if (occ.isFullDay) {
        const firstDay = localYmd(start);
        let dayAfter = localYmd(end);
        if (dayAfter <= firstDay) dayAfter = localYmd(new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1));
        if (!(firstDay <= ymd && ymd < dayAfter)) continue;
        start = dayWindow(firstDay, zone).start;
        end = dayWindow(dayAfter, zone).start;
      } else {
        if (!start.tz) { start = refloat(start, zone); end = refloat(end, zone); }
        // An event with no length belongs to the day it starts on; any other to every day it overlaps.
        if (end.getTime() <= start.getTime() ? !(start >= dayStart && start < dayEnd) : !(start < dayEnd && end > dayStart)) continue;
      }
      const title = clip(text(src.summary) || masterTitle || '(no title)', MAX_TITLE);
      const status = text(src.status).toUpperCase();
      const description = clip(text(src.description), MAX_DESCRIPTION);
      const webPage = clip(text(src['ALT-DESC']), MAX_DESCRIPTION);   // Outlook sends the description again as a web page
      const location = clip(text(src.location), MAX_LOCATION);
      const callText = { title, location, description: [description, webPage].filter(Boolean).join('\n') };
      // One date of a repeating event is named by the time it was first set for. For an all-day one that is a date,
      // not an instant: node-ical builds those as midnight where the server is, which differs from server to server.
      const original = src.recurrenceid instanceof Date ? src.recurrenceid : (occ.isRecurring ? occ.start : null);
      const originalTime = !original ? '' : original.dateOnly || (occ.isFullDay && !(src.recurrenceid instanceof Date)) ? localYmd(original) : original.toISOString();
      events.push({
        id: `${clip(ev.uid || `${title}@${ev.start.toISOString()}`, 500)}${originalTime ? `#${originalTime}` : ''}`,
        // Which repeating event this is one date of. When the whole series is moved to another time every date gets
        // a new id, and this is what still says they are the same meetings.
        series: originalTime && ev.uid ? clip(ev.uid, 500) : null,
        title, allDay: Boolean(occ.isFullDay), start: new Date(start.getTime()), end: new Date(end.getTime()),
        cancelled: status === 'CANCELLED' || /^cancel{1,2}ed\s*:/i.test(title),
        location, description: description || clip(callText.description, MAX_DESCRIPTION),
        guests: [...people(src.organizer), ...people(src.attendee)].filter((p, i, all) => all.findIndex((o) => (o.email || o.name) === (p.email || p.name)) === i).slice(0, MAX_GUESTS),
        join: findJoinLink({
          ...callText, url: clip(text(src.url), MAX_LOCATION),
          conferenceProps: ['GOOGLE-CONFERENCE', 'MICROSOFT-SKYPETEAMSMEETINGURL', 'MICROSOFT-ONLINEMEETINGEXTERNALLINK', 'MICROSOFT-ONLINEMEETINGCONFLINK'].map((k) => clip(text(src[k]), MAX_LOCATION)).filter(Boolean),
        }),
        phones: findPhones(callText),
      });
    }
  }
  // All-day events first, then by start time, then by title so that the order never depends on the file's order.
  events.sort((a, b) => (a.allDay === b.allDay ? a.start - b.start || a.title.localeCompare(b.title) : a.allDay ? -1 : 1));
  return { events, warnings };
}
