// Small time-zone helpers for the calendar, built on the time-zone data that ships with Node.
// A recruiter's day is a day on their own clock, so "the 10th" means something different in Toronto and in
// Vancouver, and on the two days a year the clocks change it is 23 or 25 hours long.

const formatters = new Map();
function partsFormatter(timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    if (formatters.size > 200) formatters.clear();
    formatters.set(timeZone, f);
  }
  return f;
}

/** Is this a time zone Node knows ("America/Toronto")? */
export function validZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone || timeZone.length > 64) return false;
  try { partsFormatter(timeZone); return true; } catch { return false; }
}

/** What the clock on the wall reads at an instant, in a zone. */
export function wallClock(date, timeZone) {
  const p = {};
  for (const { type, value } of partsFormatter(timeZone).formatToParts(date)) p[type] = value;
  return {
    year: +p.year, month: +p.month, day: +p.day, hour: +p.hour, minute: +p.minute, second: +p.second,
    ymd: `${p.year}-${p.month}-${p.day}`,
  };
}

/** How far a zone is from UTC at an instant, in milliseconds (wall clock minus UTC). */
function offsetMs(date, timeZone) {
  const w = wallClock(date, timeZone);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(date.getTime() / 1000) * 1000;
}

/**
 * The instant at which the wall clock in a zone reads the given time. When the clocks go forward that time may not
 * exist (the later instant is returned); when they go back it happens twice (the earlier one is returned). These are
 * the choices the calendar standard makes.
 */
export function zonedTimeToUtc(y, m, d, hh, mm, ss, timeZone) {
  const guess = Date.UTC(y, m - 1, d, hh, mm, ss);
  const o1 = offsetMs(new Date(guess), timeZone);
  let t = guess - o1;
  const o2 = offsetMs(new Date(t), timeZone);
  if (o2 !== o1) {
    const t2 = guess - o2;
    const ok1 = offsetMs(new Date(t), timeZone) === o1;
    const ok2 = offsetMs(new Date(t2), timeZone) === o2;
    if (ok1 && ok2) t = Math.min(t, t2);
    else if (ok2) t = t2;
    else t = Math.max(t, t2);
  }
  return new Date(t);
}

/** Is this a real calendar date written YYYY-MM-DD? */
export function validDay(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof ymd === 'string' ? ymd : '');
  if (!m || +m[1] < 1970 || +m[1] > 2200) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

/** The start of a day in a zone and the start of the next one, as instants. */
export function dayWindow(ymd, timeZone) {
  const [y, mo, d] = ymd.split('-').map(Number);
  const next = new Date(Date.UTC(y, mo - 1, d + 1));
  return {
    start: zonedTimeToUtc(y, mo, d, 0, 0, 0, timeZone),
    end: zonedTimeToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, 0, timeZone),
  };
}

/** Midnight at the start of a day in a zone, as an instant. */
export const startOfDay = (ymd, timeZone) => dayWindow(ymd, timeZone).start;
