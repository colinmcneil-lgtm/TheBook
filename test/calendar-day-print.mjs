// Prints several days of the calendar files as text. calendar-units.test.mjs runs this with the server's own time
// zone set to different places and checks that the answer never changes: a recruiter's day must not depend on
// where the server happens to run.
import { calendarFile, dayOfFile } from './calendar-helpers.mjs';

const DAYS = ['2026-07-14', '2026-10-27', '2026-10-31', '2026-11-01', '2026-11-03', '2026-11-06', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-17'];
const out = [];
for (const file of ['google-like.ics', 'outlook-like.ics', 'edge-cases.ics', 'floating-no-vtimezone.ics', 'this-and-following.ics', 'made-up-zones.ics', 'odd-zone-labels.ics']) {
  for (const zone of ['America/Toronto', 'America/Los_Angeles']) {
    for (const day of DAYS) {
      const { events, warnings } = dayOfFile(calendarFile(file), day, zone);
      out.push(`${file} ${zone} ${day}`, ...events.map((e) => `  ${e.start.toISOString()} ${e.end.toISOString()} ${e.allDay} ${e.cancelled} ${e.id} ${e.title}`), ...warnings.map((w) => `  ! ${w}`));
    }
  }
}
console.log(out.join('\n'));
