// Dates and timing for the "Your calendar" card and its reminders, kept apart from the screens so they can be
// checked on their own. Times are compared as instants; days are the recruiter's own calendar days.
import { todayLocal } from '../lib.js';

export const MINUTE = 60_000;
export const LEAD = 2 * MINUTE; // the reminder comes this long before an event starts, so a slow timer in a background tab does no harm
export const SOON = 15 * MINUTE; // an added event offers Record and Call from this long before it starts until this long after it ends

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
/** The day `days` after (or before) "2026-11-10". Worked out from midday, so the hour a clock change takes or gives cannot skip or repeat a day. */
export const shiftDay = (day, days) => {
  const d = new Date(`${day}T12:00`);
  d.setDate(d.getDate() + days);
  return ymd(d);
};
/** "Today, Tue 10 Nov", "Tomorrow, Wed 11 Nov", "Fri 13 Nov". */
export function dayLabel(day, today = todayLocal()) {
  const near = day === today ? 'Today' : day === shiftDay(today, 1) ? 'Tomorrow' : day === shiftDay(today, -1) ? 'Yesterday' : null;
  const date = new Date(`${day}T12:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  return near ? `${near}, ${date}` : date;
}
/** "15 min", "1 h", "1 h 30 min". */
export const lengthOf = (event) => {
  const minutes = Math.round((Date.parse(event.end) - Date.parse(event.start)) / MINUTE);
  return minutes < 60 ? `${minutes} min` : minutes % 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes / 60} h`;
};
export const startsAt = (event) => Date.parse(event.start);
/** When an event is over. One with no length (a reminder-style entry) is treated as five minutes long. */
export const endsAt = (event) => Math.max(Date.parse(event.end), startsAt(event) + 5 * MINUTE);
/** Is this the moment to offer Record and Call for an event: shortly before it, during it, or just after it? */
export const isNear = (event, now) => !event.all_day && now >= startsAt(event) - SOON && now < endsAt(event) + SOON;
/** Should the recruiter be reminded of this event now? Only events they added, that have no call yet, from two minutes before until they end. */
export const isDue = (event, now) => Boolean(event.added) && !event.all_day && !event.call_id && now >= startsAt(event) - LEAD && now < endsAt(event);
/**
 * The events to remind about right now, soonest first. `closed` holds the keys of reminders the recruiter closed,
 * and `busyWith` is the key of the event a call is being made for this minute (no reminder for that one).
 */
export const dueNow = (events, now, { closed = new Set(), busyWith = null } = {}) =>
  (events || []).filter((e) => isDue(e, now) && !closed.has(e.key) && e.key !== busyWith).sort((a, b) => startsAt(a) - startsAt(b));
