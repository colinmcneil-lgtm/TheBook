// Phone calls and the calendar were taken out of The Book. A database that was in use before still holds what people
// saved for them: each recruiter's calendar link (sealed, but a link like that opens their whole calendar), what was
// remembered about their calendar events, and their mobile number and PIN for the phone line. Nothing reads any of it
// any more, nobody can remove it from inside the app any more, and the app never touches it by itself: removing a
// feature is no reason to delete people's data without being asked.
//
// This is the one deliberate way to clear it, for whoever looks after the database:
//
//   node server/forget-removed.js          says what is there and changes nothing
//   node server/forget-removed.js --yes    clears it
//
// It reads DATA_DIR like the app does, and can be run while the app is running. It leaves everything else alone,
// the calls that were made by phone among it: those are calls in The Oracle like any other. What is cleared is
// written over, not just marked as deleted. It does nothing on a database that never had these features.
import fs from 'node:fs';
import path from 'node:path';

const file = path.join(path.resolve(process.env.DATA_DIR || 'data'), 'app.db');
if (!fs.existsSync(file)) {
  console.error(`There is no database at ${file}. Set DATA_DIR to the folder the app keeps its data in.`);
  process.exit(1);
}
// Opened the way the app opens it, so the two can work side by side.
const { db, scrub } = await import('./db.js');
db.exec('PRAGMA busy_timeout = 5000');

const has = (table) => Boolean(db.prepare(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table));
const columnsOf = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
const count = (sql) => db.prepare(sql).get().n;

// What the removed features left that is somebody's own: [what it is, how many there are, how to clear it].
const left = [];
if (has('calendar_links')) left.push(['saved calendar links', count('SELECT COUNT(*) AS n FROM calendar_links'), 'DELETE FROM calendar_links']);
if (has('calendar_events')) left.push(['remembered calendar events', count('SELECT COUNT(*) AS n FROM calendar_events'), 'DELETE FROM calendar_events']);
const users = columnsOf('users');
if (users.includes('phone')) left.push(['saved mobile numbers', count('SELECT COUNT(*) AS n FROM users WHERE phone IS NOT NULL'), 'UPDATE users SET phone = NULL WHERE phone IS NOT NULL']);
if (users.includes('phone_pin_hash')) {
  // The PIN itself and, where they exist, the counters that went with it.
  const counters = [['phone_pin_fails', '0'], ['phone_locked_until', 'NULL'], ['phone_lock_level', '0'], ['phone_pin_wrong', '0'], ['phone_pin_wrong_since', 'NULL']].filter(([name]) => users.includes(name));
  left.push(['phone PINs', count('SELECT COUNT(*) AS n FROM users WHERE phone_pin_hash IS NOT NULL'),
    `UPDATE users SET phone_pin_hash = NULL${counters.map(([name, empty]) => `, ${name} = ${empty}`).join('')} WHERE phone_pin_hash IS NOT NULL`]);
}

const sure = process.argv.includes('--yes');
const total = left.reduce((sum, [, n]) => sum + n, 0);
if (!left.length || !total) {
  console.log('Nothing is left in this database from the calendar or the phone line.');
} else if (!sure) {
  console.log('Left in this database from the calendar and the phone line, which The Book no longer has:');
  for (const [what, n] of left) console.log(`  ${n} ${what}`);
  console.log('Nothing was changed. To clear these, run this again with --yes.');
} else {
  db.exec('BEGIN');
  try {
    for (const [, n, clear] of left) if (n) db.exec(clear);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  scrub();
  console.log('Cleared from this database:');
  for (const [what, n] of left) console.log(`  ${n} ${what}`);
  console.log('Anyone who had saved a calendar link can also reset their calendar\'s private address with their calendar provider, which makes the old link useless everywhere.');
}
db.close();
