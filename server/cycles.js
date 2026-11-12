// Cycles: the agency team works its open jobs in passes. Each time anybody on the team ticks a job on their own Jobs
// to work on list (see todos.js), that is one cycle on that job, by that person, at that moment. This page shows the
// whole team, for every open job, how many cycles it has had, when it was last touched and by whom, and above all
// which jobs nobody has touched.
//
// What counts, and what does not:
//  - A tick of a JOB on anybody's Jobs to work on list. The same person ticking the same job again later (it went
//    back on their list) is another cycle; two people ticking it are two. Ticks on People to prep and People to
//    debrief never count: they are about a candidate, and The Book ticks some of those by itself.
//  - Un-ticking takes that tick's cycle away: it was a mistake. Ticking it again counts once, at the new time.
//  - Nothing else takes a cycle away: not taking the ticked job off the Done list, not the seven days running out,
//    not the person being deactivated or removed. A cycle is history. Deleting the job deletes its cycles.
//
// What the team sees of somebody's list: only that they ticked a job, and when, and which jobs are on their list
// right now ("On a list now"). Never the note on an item, which is not even copied into a cycle, nor the order of
// their list, nor anything of their prep and debrief lists. Agency only: client users are refused on every route.
//
// The cycles are written by todos.js, in the same transaction as the tick or un-tick; this module only reads them,
// apart from the one-time copy of what was already ticked when this version first started (below).
import { q, tx, getSetting, setSetting } from './db.js';
import { todoNow } from './todos.js';
import { reportZone } from './reporting.js';
import { wallClock, zonedTimeToUtc } from './zoned-time.js';

const DAY = 86400000;
const PERIODS = ['week', '7d', '30d', 'all'];
/** How many of a job's cycles its history shows at a time, newest first, before "Show earlier". */
const PAGE = 20;
/** Somebody on the agency team today: the only people listed under "By person" when they have no cycles. */
const ON_TEAM = `u.role != 'client' AND u.active = 1 AND u.pending = 0`;

// Once, at the first start of this version: every job somebody had ticked on their list, and whose to-do row still
// exists (taken off the Done list since, or not), becomes a cycle at the time it was ticked, by the person whose list
// it was on. History therefore starts with what the lists still held: a tick whose row is gone (its person was
// removed) cannot be known. Safe on an empty database, on one from before To do existed (the table is there, made by
// db.js, and empty), and when it runs again: each item makes at most one cycle (idx_cycles_todo). A setting says it
// has been done, and when, which the page uses to say where its history starts.
const COPIED = 'cycles_copied';
if (!getSetting(COPIED)) {
  try {
    const ticked = `FROM todos WHERE kind = 'job' AND job_id IS NOT NULL AND done_at IS NOT NULL`;
    tx(() => {
      // Only when there is something to copy: an insert of nothing still leaves a mark in SQLite's id counters, and a
      // database with no ticked job is left exactly as it was, but for the setting.
      if (q.get(`SELECT 1 AS x ${ticked} LIMIT 1`)) q.run(`INSERT OR IGNORE INTO cycles (job_id, user_id, todo_id, at) SELECT job_id, user_id, id, done_at ${ticked} ORDER BY done_at, id`);
      setSetting(COPIED, new Date().toISOString());
    });
  } catch (err) { console.error('The jobs already ticked on to-do lists could not be counted as cycles:', err); }
}

// ---------- periods ----------
/**
 * Where a period begins, or null for all time. "This week" is the week as the reports count it: from Monday at
 * midnight on the agency's own clock (reportZone), so a tick at 23:59 on Sunday and one at 00:01 on Monday fall in
 * different weeks whatever the server's own zone is, and the week the clocks change is 167 or 169 hours long.
 */
function periodFrom(period, now, zone) {
  if (period === 'all') return null;
  if (period === '7d') return new Date(now.getTime() - 7 * DAY);
  if (period === '30d') return new Date(now.getTime() - 30 * DAY);
  const w = wallClock(now, zone);
  const back = (new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay() + 6) % 7; // days since Monday
  const monday = new Date(Date.UTC(w.year, w.month - 1, w.day - back));
  return zonedTimeToUtc(monday.getUTCFullYear(), monday.getUTCMonth() + 1, monday.getUTCDate(), 0, 0, 0, zone);
}

// ---------- the order of the table ----------
const SORTS = ['last', 'job', 'ae', 'period', 'total', 'on_list', 'open'];
/** Which way a column sorts on its first click: names A to Z, the longest-neglected first, numbers high to low. */
const firstDirection = (sort) => (['job', 'ae', 'last'].includes(sort) ? 'asc' : 'desc');
// One collator, made once: localeCompare with options makes a new one for every comparison, and sorting 300 rows
// that way took longer than reading them.
const collator = new Intl.Collator('en', { sensitivity: 'base' });
const byText = (a, b) => collator.compare(String(a), String(b));
/**
 * The order the page opens in, and the tie-breaker for every other: longest since its last cycle first, and the
 * jobs never touched at all above every one of those, the longest open of them first. The neglected jobs lead.
 */
function neglectedFirst(a, b) {
  if (!a.last_at !== !b.last_at) return a.last_at ? 1 : -1;
  if (!a.last_at) return byText(a.opened_at, b.opened_at) || a.id - b.id;
  return byText(a.last_at, b.last_at) || a.id - b.id;
}
function sortRows(rows, sort, dir) {
  const sign = dir === 'asc' ? 1 : -1;
  const value = {
    job: (r) => `${r.title}\u0000${r.client_name}`, ae: (r) => r.account_executive_name, period: (r) => r.cycles_period, total: (r) => r.cycles_total,
    on_list: (r) => r.on_list.length, open: (r) => r.days_open,
  }[sort];
  return [...rows].sort((a, b) => {
    if (sort === 'last') return sign * neglectedFirst(a, b);
    const x = value(a), y = value(b);
    // A job with nobody as its account executive goes last whichever way the column is sorted.
    if (x == null || y == null) return (x == null) - (y == null) || neglectedFirst(a, b);
    return sign * (typeof x === 'string' ? byText(x, y) : x - y) || neglectedFirst(a, b);
  });
}

// ---------- reading ----------
/** Who a cycle was by, as the page shows them: a name, and whether they are still on the team. */
const person = (userId, name, onTeam) => ({ user_id: userId ?? null, name: name ?? null, on_team: Boolean(onTeam) });

/**
 * The page in one answer. A fixed handful of queries, one for each thing it reads (the open jobs with their cycles,
 * the lists they are on now, the cycles in the period by person, the team), however many jobs and cycles there are.
 */
function cyclesPage({ period, clientId, accountExecutive, untouched, sort, dir }) {
  const now = todoNow(), zone = reportZone();
  const from = periodFrom(period, now, zone)?.toISOString() ?? null;
  // A period runs from its start up to this moment. (Only the tests' clock can put a tick after "now".)
  const since = from ?? '', to = now.toISOString();
  const inScope = clientId ? 'AND j.client_id = ?' : '';
  const scoped = clientId ? [clientId] : [];

  // Every open job in view, with its cycles: how many in all and in the period, and the latest with who made it.
  // Closed, filled, on-hold and draft jobs are not in the table; their cycles are kept, and count in the summary and
  // By person. Each count is a seek on idx_cycles_job for that one job, so 300 jobs with 20,000 cycles between
  // them take a millisecond or two, where counting every cycle row by row took several.
  const jobs = q.all(
    `SELECT j.id, j.title, j.client_id, cl.name AS client_name, cl.brand_color, COALESCE(j.opened_at, j.created_at) AS opened_at,
       j.account_executive_id, ae.name AS account_executive_name, (ae.role != 'client' AND ae.active = 1) AS account_executive_on_team,
       (SELECT COUNT(*) FROM cycles c WHERE c.job_id = j.id) AS total,
       (SELECT COUNT(*) FROM cycles c WHERE c.job_id = j.id AND c.at >= ? AND c.at <= ?) AS in_period,
       (SELECT json_array(l.at, l.user_id) FROM cycles l WHERE l.job_id = j.id ORDER BY l.at DESC, l.id DESC LIMIT 1) AS latest
     FROM jobs j JOIN clients cl ON cl.id = j.client_id LEFT JOIN users ae ON ae.id = j.account_executive_id
     WHERE j.status = 'open' ${inScope}`, since, to, ...scoped);
  // Who has each of them on their Jobs to work on right now, not ticked: people on the team only. (The partial index
  // idx_todos_job_once holds exactly the items still to do.)
  const onList = new Map();
  for (const r of q.all(
    `SELECT t.job_id, u.id, u.name FROM todos t JOIN users u ON u.id = t.user_id JOIN jobs j ON j.id = t.job_id
     WHERE t.kind = 'job' AND t.done_at IS NULL AND t.removed_at IS NULL AND j.status = 'open' AND ${ON_TEAM} ${inScope} ORDER BY u.name, u.id`, ...scoped)) {
    if (!onList.has(r.job_id)) onList.set(r.job_id, []);
    onList.get(r.job_id).push({ user_id: r.id, name: r.name });
  }
  // Everybody's cycles in the period, on any job in view, open or not: read from idx_cycles_at alone (it holds who
  // and which job beside when), so nothing else is looked up for each cycle. With the client picker, only that
  // client's jobs are looked at, each by its own seek on idx_cycles_job.
  const byPerson = q.all(
    `SELECT c.user_id, COUNT(*) AS cycles, COUNT(DISTINCT c.job_id) AS jobs FROM cycles c
     WHERE c.at >= ? AND c.at <= ? ${clientId ? 'AND c.job_id IN (SELECT j.id FROM jobs j WHERE j.client_id = ?)' : ''} GROUP BY c.user_id`, since, to, ...scoped);
  // The team, for the people with no cycles in the period (a zero is worth seeing here), and the names of the
  // people who made the cycles.
  const users = new Map(q.all(`SELECT u.id, u.name, (${ON_TEAM}) AS on_team FROM users u`).map((u) => [u.id, u]));

  const all = jobs.map((j) => {
    const [lastAt, lastUser] = j.latest ? JSON.parse(j.latest) : [null, null];
    const by = lastUser != null ? users.get(lastUser) : null;
    return {
      id: j.id, title: j.title, client_id: j.client_id, client_name: j.client_name, brand_color: j.brand_color, opened_at: j.opened_at,
      days_open: Math.max(0, Math.floor((now.getTime() - Date.parse(j.opened_at)) / DAY)),
      account_executive_id: j.account_executive_id, account_executive_name: j.account_executive_name ?? null, account_executive_on_team: Boolean(j.account_executive_on_team),
      cycles_period: j.in_period, cycles_total: j.total, last_at: lastAt,
      // Who made the latest cycle. An account since removed has no name: the page says "somebody no longer on the team".
      last_by: lastAt ? person(by?.id, by?.name, by?.on_team) : null,
      on_list: onList.get(j.id) ?? [],
    };
  });

  // The summary, from everything in view whatever the table's own filters say, and adding up in plain sight: the
  // cycles on open jobs plus those on jobs that are no longer open are all of them; touched plus not touched are
  // all the open jobs.
  const cycles = byPerson.reduce((n, r) => n + r.cycles, 0);
  const onOpen = all.reduce((n, r) => n + r.cycles_period, 0);
  const touched = all.filter((r) => r.cycles_period > 0).length;
  const summary = { cycles, on_open_jobs: onOpen, on_other_jobs: cycles - onOpen, open_jobs: all.length, touched, untouched: all.length - touched };

  // The account executives of the open jobs in view, for the filter.
  const executives = new Map();
  for (const r of all) if (r.account_executive_id != null) executives.set(r.account_executive_id, { id: r.account_executive_id, name: r.account_executive_name, on_team: r.account_executive_on_team });
  const sortKey = SORTS.includes(sort) ? sort : 'last';
  const sortDir = dir === 'asc' || dir === 'desc' ? dir : firstDirection(sortKey);
  let rows = all;
  if (accountExecutive === 'none') rows = rows.filter((r) => r.account_executive_id == null);
  else if (accountExecutive != null) rows = rows.filter((r) => r.account_executive_id === accountExecutive);
  if (untouched) rows = rows.filter((r) => r.cycles_period === 0);

  // By person: each active teammate, with none or some; anybody else only for what they did in the period. Those
  // whose account was removed are one row, since nothing says who they were.
  const counts = new Map(byPerson.map((r) => [r.user_id, r]));
  const people = [...users.values()].filter((u) => u.on_team).map((u) => ({ ...person(u.id, u.name, true), cycles: counts.get(u.id)?.cycles ?? 0, jobs: counts.get(u.id)?.jobs ?? 0 }));
  for (const r of byPerson) {
    const u = users.get(r.user_id);
    if (!u?.on_team) people.push({ ...person(r.user_id, u?.name, false), cycles: r.cycles, jobs: r.jobs });
  }
  people.sort((a, b) => b.cycles - a.cycles || b.on_team - a.on_team || byText(a.name ?? '￿', b.name ?? '￿') || (a.user_id ?? 0) - (b.user_id ?? 0));

  return {
    // The day the period starts on the agency's clock, for the page to say ("from Monday 9 November").
    period, from, from_day: from ? wallClock(new Date(from), zone).ymd : null, to, time_zone: zone, history_from: getSetting(COPIED),
    summary, rows: sortRows(rows, sortKey, sortDir), sort: sortKey, dir: sortDir,
    account_executives: [...executives.values()].sort((a, b) => byText(a.name, b.name)), people,
  };
}

/** One job's cycles, newest first, a page at a time, with how many it has had and the latest. */
function jobCycles(jobId, before) {
  const total = q.get('SELECT COUNT(*) AS n FROM cycles WHERE job_id = ?', jobId).n;
  const after = before ? 'AND (c.at < ? OR (c.at = ? AND c.id < ?))' : '';
  const rows = q.all(
    `SELECT c.id, c.at, c.user_id, u.name, (${ON_TEAM}) AS on_team FROM cycles c LEFT JOIN users u ON u.id = c.user_id
     WHERE c.job_id = ? ${after} ORDER BY c.at DESC, c.id DESC LIMIT ?`, jobId, ...(before ? [before.at, before.at, before.id] : []), PAGE + 1);
  const cycles = rows.slice(0, PAGE).map((r) => ({ id: r.id, at: r.at, ...person(r.user_id, r.name, r.on_team) }));
  return { job_id: jobId, total, cycles, more: rows.length > PAGE };
}

// ---------- routes ----------
export function registerCycles(api, { agencyOnly, bad, int }) {
  /** A whole number above nought written as one, or nothing: anything else is not an id. */
  const id = (value) => (typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value) ? Number(value) : null);

  // The page: every open job with its cycles, the summary and By person for a period. client_id is the sidebar's
  // client picker, honoured as the other agency pages honour it; account_executive (a person's id, or "none") and
  // untouched=1 narrow the table only.
  api.get('/cycles', agencyOnly, (req, res) => {
    const period = req.query.period || 'week';
    if (!PERIODS.includes(period)) bad('Choose a period: this week, the last 7 days, the last 30 days or all time.');
    const ae = req.query.account_executive;
    let accountExecutive = null;
    if (ae === 'none') accountExecutive = 'none';
    else if (ae) {
      accountExecutive = id(ae);
      if (accountExecutive == null) bad('That account executive is not one The Book knows.');
    }
    res.json(cyclesPage({
      period, clientId: int(req.query.client_id), accountExecutive, untouched: req.query.untouched === '1' || req.query.untouched === 'true',
      sort: req.query.sort, dir: req.query.dir,
    }));
  });

  // One job's cycles, newest first, twenty at a time: ?before=<the last cycle shown> for the twenty before those.
  // For a row opened on the page, and the line on the job's own page.
  api.get('/cycles/jobs/:id', agencyOnly, (req, res) => {
    const job = q.get('SELECT id FROM jobs WHERE id = ?', id(req.params.id));
    if (!job) bad('That job is no longer in The Book.', 404);
    let before = null;
    if (req.query.before !== undefined) {
      before = q.get('SELECT id, at FROM cycles WHERE id = ? AND job_id = ?', id(req.query.before), job.id);
      if (!before) bad('Those cycles could not be found. Open the job again to see its latest.');
    }
    res.json(jobCycles(job.id, before));
  });
}
