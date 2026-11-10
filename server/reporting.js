// Reporting: the numbers a recruiter and a client are measured on (submissions, first interviews, placements,
// searches opened and filled, time to fill, billings).
//
// Two rules shape everything here.
//  1. Counting starts on a set day (Monday 16 November 2026 unless an admin changes it), at the start of that day in
//     Toronto. Nothing that happened before that moment is written down or counted, and "lifetime" means since then.
//  2. The numbers are recorded when things happen, not worked out afterwards from how the records look today. Each
//     moment is one row in report_events, with the recruiter credited and (for a placement) the fee as they were at
//     that moment. Reassigning a candidate or editing a client's terms later changes nothing that was recorded.
//
// The routes in api.js call the small functions in "writing things down" at the point where each thing happens;
// the reports only ever read report_events. Agency only: client users are refused on every route here.
import { q, getSetting, setSetting } from './db.js';
import { validDay, validZone, wallClock, zonedTimeToUtc, startOfDay } from './calendar-time.js';

const DAY = 86400000;
const DEFAULT_START = '2026-11-16';
const DEFAULT_ZONE = 'America/Toronto';

// ---------- the clock and the day counting starts ----------
let clock = () => new Date();
/** For the tests only: lets them say what time it is, so a story can be told either side of the start date without waiting. */
export function setReportClock(fn) { clock = fn || (() => new Date()); }
const reportNow = () => clock();
const stamp = () => reportNow().toISOString();

/** The time zone the start day (and "this month") is read in: Toronto, unless REPORTS_TIMEZONE names another real one. */
function reportZone() {
  const zone = process.env.REPORTS_TIMEZONE;
  return zone && validZone(zone) ? zone : DEFAULT_ZONE;
}
if (process.env.REPORTS_TIMEZONE && !validZone(process.env.REPORTS_TIMEZONE)) {
  console.error(`REPORTS_TIMEZONE is not a time zone this server knows, so reports use ${DEFAULT_ZONE}.`);
}

/** The day counting starts, the zone it is read in, the instant that is, and whether that instant has passed. */
export function reportStart() {
  const saved = getSetting('reports_start');
  const date = validDay(saved) ? saved : DEFAULT_START;
  const time_zone = reportZone();
  const at = startOfDay(date, time_zone).toISOString();
  return { date, time_zone, at, started: stamp() >= at };
}
/** Nothing is written down before the start: a real workspace keeps no record of anything earlier. */
const counting = () => reportStart().started;

// ---------- writing things down ----------
const eventOf = (applicationId, kind) => q.get('SELECT * FROM report_events WHERE application_id = ? AND kind = ?', applicationId, kind);
/** The application with what a record needs from around it: the candidate's name, the client and its terms. */
const context = (applicationId) => q.get(
  `SELECT a.id, a.job_id, a.stage_id, a.status, a.owner_id, a.submitted_by, c.name AS candidate_name, j.client_id, cl.fee_percent, cl.currency
   FROM applications a JOIN candidates c ON c.id = a.candidate_id JOIN jobs j ON j.id = a.job_id JOIN clients cl ON cl.id = j.client_id
   WHERE a.id = ?`, applicationId);
/** Once per candidate in a job: a second submission or interview finds the first one already there and adds nothing. */
const record = (kind, app, userId, at) => q.run(
  `INSERT OR IGNORE INTO report_events (kind, application_id, candidate_name, job_id, client_id, user_id, at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  kind, app.id, app.candidate_name, app.job_id, app.client_id, userId, at);
const workedOutFee = (salary, percent) => (salary != null && percent > 0 ? Math.round((salary * percent) / 100) : null);

/** A search is opened (kickoff) the first time its job becomes open. `before` is the job as it was, or nothing for a new one. */
export function searchOpened(jobId, status, before) {
  if (status !== 'open' || before?.opened_at || !counting()) return;
  const job = q.get('SELECT id, client_id FROM jobs WHERE id = ?', jobId);
  q.run(`INSERT OR IGNORE INTO report_events (kind, job_id, client_id, at) VALUES ('search_opened', ?, ?, ?)`, job.id, job.client_id, stamp());
}

/**
 * The candidate was submitted to the client's hiring team. Call before the application is updated: `before` is the
 * application as it was. Only the first submission counts, so one made before counting started is not made up for
 * by sending the candidate again afterwards.
 */
export function submitted(before, userId) {
  if (before.review_status || before.submitted_by || !counting()) return;
  const app = context(before.id), at = stamp();
  record('submission', app, userId, at);
  // Already sitting in a stage where the client meets them: the interview counts from this moment.
  const stage = q.get('SELECT kind, with_client FROM stages WHERE id = ?', app.stage_id);
  if (stage.kind === 'interview' && stage.with_client) record('first_interview', app, userId, at);
}

/**
 * A first interview with the client, for a candidate whose submission was counted. The credit goes to whoever
 * submitted them. Without a counted submission nothing is recorded: the ratio is interviews out of submissions.
 */
function firstInterview(applicationId) {
  const start = reportStart();
  if (!start.started) return;
  const submission = eventOf(applicationId, 'submission');
  if (!submission || submission.at < start.at) return;
  record('first_interview', context(applicationId), submission.user_id, stamp());
}
/** An interview was scheduled for the candidate in The Book. */
export const interviewScheduled = (applicationId) => firstInterview(applicationId);

/**
 * The candidate was marked hired: a placement. The credit goes to the recruiter who owns them in this job right now,
 * or to whoever submitted them when nobody does. The fee is the salary on their offer times the client's fee
 * percentage, both as they stand at this moment.
 */
function placed(applicationId) {
  q.run(`DELETE FROM report_events WHERE application_id = ? AND kind = 'placement'`, applicationId); // a new hire replaces whatever an earlier, undone one left
  if (!counting()) return;
  const app = context(applicationId), at = stamp();
  const offer = q.get('SELECT salary, status, accepted_at FROM offers WHERE application_id = ?', applicationId);
  const accepted = offer?.status === 'accepted' && offer.accepted_at && offer.accepted_at <= at ? offer.accepted_at : null;
  q.run(
    `INSERT INTO report_events (kind, application_id, candidate_name, job_id, client_id, user_id, at, filled_at, salary, fee_percent, fee, currency)
     VALUES ('placement', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    app.id, app.candidate_name, app.job_id, app.client_id, app.owner_id ?? app.submitted_by ?? null, at, accepted ?? at,
    offer?.salary ?? null, app.fee_percent, workedOutFee(offer?.salary, app.fee_percent), app.currency);
}

/**
 * The candidate arrived in a stage, by any road: moved on the board or the profile, approved by the client, or added
 * straight into it. Hired is a placement. Any other stage undoes one (a hire that fell through), and an interview
 * stage where the client meets them is their first interview if they have been submitted.
 */
export function arrivedIn(applicationId, stage) {
  if (stage.kind === 'hired') return placed(applicationId);
  q.run(`DELETE FROM report_events WHERE application_id = ? AND kind = 'placement'`, applicationId);
  if (stage.kind === 'interview' && stage.with_client) firstInterview(applicationId);
}

/** A hired candidate was rejected or withdrew: their placement stops counting, but is kept in case they are returned. */
export function leftPipeline(applicationId) {
  q.run(`UPDATE report_events SET set_aside_at = ? WHERE application_id = ? AND kind = 'placement' AND set_aside_at IS NULL`, stamp(), applicationId);
}
/**
 * The candidate was returned to the pipeline. If that makes them hired again, the placement that was set aside
 * counts again as it was (its date, credit and fee). Returning someone never creates a placement: a hire made
 * before counting started stays uncounted.
 */
export function returned(applicationId) {
  const app = q.get('SELECT status FROM applications WHERE id = ?', applicationId);
  if (app?.status === 'hired') q.run(`UPDATE report_events SET set_aside_at = NULL WHERE application_id = ? AND kind = 'placement'`, applicationId);
}

/**
 * The offer was saved. Notes when it became accepted (the end of "time to fill"), and fills in the fee of a
 * placement that had none because the offer had no salary yet when the candidate was hired.
 */
export function offerSaved(applicationId) {
  const offer = q.get('SELECT id, salary, status, accepted_at FROM offers WHERE application_id = ?', applicationId);
  if (!offer) return;
  if (offer.status === 'accepted' && !offer.accepted_at) q.run('UPDATE offers SET accepted_at = ? WHERE id = ?', stamp(), offer.id);
  if (offer.status !== 'accepted' && offer.accepted_at) q.run('UPDATE offers SET accepted_at = NULL WHERE id = ?', offer.id);
  const placement = eventOf(applicationId, 'placement');
  if (!placement || placement.fee != null || placement.fee_edited || offer.salary == null) return;
  const { fee_percent } = context(applicationId);
  q.run('UPDATE report_events SET salary = ?, fee_percent = ?, fee = ? WHERE id = ?', offer.salary, fee_percent, workedOutFee(offer.salary, fee_percent), placement.id);
}

/** What a hired candidate's profile shows the agency about their recorded placement; null when none is counted. */
export function placementOf(applicationId) {
  const p = eventOf(applicationId, 'placement');
  if (!p || p.set_aside_at || p.at < reportStart().at) return null;
  const credited = p.user_id ? q.get('SELECT name FROM users WHERE id = ?', p.user_id)?.name ?? null : null;
  return { at: p.at, fee: p.fee, currency: p.currency, fee_edited: Boolean(p.fee_edited), salary: p.salary, fee_percent: p.fee_percent, credited_to: credited };
}

// ---------- reading the numbers ----------
const round1 = (n) => Math.round(n * 10) / 10;
const percent = (part, whole) => (whole ? round1((part / whole) * 100) : null);
/** The same clock time twelve months ago, in the reporting zone. */
function yearAgo(now, zone) {
  const w = wallClock(now, zone);
  return zonedTimeToUtc(w.year - 1, w.month, w.day, w.hour, w.minute, w.second, zone);
}
const PERIODS = ['all', 'month', '30d', '90d', '12m'];
/** Where a period begins. Never before counting started. */
function periodFrom(period, start) {
  const now = reportNow(), zone = start.time_zone;
  let from = null;
  if (period === 'month') { const w = wallClock(now, zone); from = zonedTimeToUtc(w.year, w.month, 1, 0, 0, 0, zone); }
  if (period === '30d') from = new Date(now.getTime() - 30 * DAY);
  if (period === '90d') from = new Date(now.getTime() - 90 * DAY);
  if (period === '12m') from = yearAgo(now, zone);
  const iso = from?.toISOString();
  return iso && iso > start.at ? iso : start.at;
}

/** Everything that counts: recorded on or after the start, and not a placement that has been set aside. */
function countedEvents(start, clientId) {
  return q.all(
    `SELECT e.* FROM report_events e WHERE e.at >= ? AND e.set_aside_at IS NULL ${clientId ? 'AND e.client_id = ?' : ''} ORDER BY e.at, e.id`,
    start.at, ...(clientId ? [clientId] : []));
}

/**
 * Put rows in order by one of their values. A row with nothing to show for it (null) goes last whichever way the
 * rest are sorted, and rows that tie stay in name order.
 */
function sortRows(rows, valueOf, dir) {
  const sign = dir === 'asc' ? 1 : -1;
  const byName = (a, b) => String(a.name).localeCompare(String(b.name), 'en', { sensitivity: 'base' });
  return [...rows].sort((a, b) => {
    const x = valueOf(a), y = valueOf(b);
    if (x == null || y == null) return (x == null) - (y == null) || byName(a, b);
    return (typeof x === 'string' ? x.localeCompare(y, 'en', { sensitivity: 'base' }) : x - y) * sign || byName(a, b);
  });
}
const direction = (dir, fallback) => (dir === 'asc' || dir === 'desc' ? dir : fallback);

const INDIVIDUAL_SORTS = {
  name: (r) => r.name, submissions: (r) => r.submissions, interviews: (r) => r.interviews, ratio: (r) => r.ratio, placements: (r) => r.placements,
};
/**
 * One row per recruiter for a period. An admin gets everyone on the agency side who has anything recorded since
 * counting started, and the totals; a recruiter gets their own row and nothing about anybody else.
 */
function individualReport({ user, period, clientId, sort, dir }) {
  const start = reportStart();
  const chosen = PERIODS.includes(period) ? period : 'all';
  const from = periodFrom(chosen, start);
  const events = start.started ? countedEvents(start, clientId).filter((e) => e.kind !== 'search_opened') : [];
  const mine = user.role === 'admin' ? events : events.filter((e) => e.user_id === user.id);
  const rows = new Map();
  const rowFor = (id) => {
    if (!rows.has(id)) {
      const person = id ? q.get('SELECT name, active FROM users WHERE id = ?', id) : null;
      rows.set(id, { user_id: id, name: person?.name ?? 'No recruiter', active: person ? Boolean(person.active) : true, submissions: 0, interviews: 0, placements: 0 });
    }
    return rows.get(id);
  };
  if (user.role !== 'admin') rowFor(user.id); // a recruiter always sees their own row, even with nothing in it yet
  const column = { submission: 'submissions', first_interview: 'interviews', placement: 'placements' };
  for (const e of mine) {
    const row = rowFor(e.user_id ?? null); // listed even when all of theirs is outside the period
    if (e.at >= from) row[column[e.kind]]++;
  }
  const withRatio = (r) => ({ ...r, ratio: percent(r.interviews, r.submissions) });
  const list = [...rows.values()].map(withRatio);
  const sortKey = Object.hasOwn(INDIVIDUAL_SORTS, sort) ? sort : 'submissions';
  const sortDir = direction(dir, sortKey === 'name' ? 'asc' : 'desc');
  const sum = (key) => list.reduce((n, r) => n + r[key], 0);
  return {
    start, period: chosen, from, to: stamp(), sort: sortKey, dir: sortDir,
    rows: sortRows(list, INDIVIDUAL_SORTS[sortKey], sortDir),
    totals: user.role === 'admin' ? withRatio({ submissions: sum('submissions'), interviews: sum('interviews'), placements: sum('placements') }) : null,
  };
}

/** Money as written: one figure per currency, because fees in different currencies cannot be added together. */
function byCurrency(placements, average = false) {
  const totals = new Map();
  for (const p of placements) {
    const t = totals.get(p.currency) ?? { currency: p.currency, amount: 0, count: 0 };
    t.amount += p.fee; t.count++;
    totals.set(p.currency, t);
  }
  return [...totals.values()].map(({ currency, amount, count }) => ({ currency, amount: average ? Math.round(amount / count) : amount }));
}
/** For sorting: the figures added up as written. Nothing to show when there are none. */
const moneyValue = (list) => (list.length ? list.reduce((n, m) => n + m.amount, 0) : null);
const CLIENT_SORTS = {
  reqs: (r) => r.reqs || null, reqs_12m: (r) => r.reqs_12m || null, interview_pct: (r) => r.interview_pct, placement_pct: (r) => r.placement_pct,
  time_to_fill: (r) => r.time_to_fill, billings: (r) => moneyValue(r.billings), billings_12m: (r) => moneyValue(r.billings_12m), avg_fee: (r) => moneyValue(r.avg_fee),
};
/** One row per client: searches opened and filled, interviews out of submissions, time to fill, and placement fees. */
function clientReport({ clientId, sort, dir }) {
  const start = reportStart();
  const events = start.started ? countedEvents(start, clientId) : [];
  const since12 = periodFrom('12m', start);
  const openings = new Map(q.all('SELECT id, openings FROM jobs').map((j) => [j.id, j.openings]));
  const clients = q.all(`SELECT id, name, brand_color, currency, status, fee_percent FROM clients ${clientId ? 'WHERE id = ?' : ''} ORDER BY name`, ...(clientId ? [clientId] : []));
  const missingFees = [];
  const rows = clients.map((cl) => {
    const own = events.filter((e) => e.client_id === cl.id);
    const of = (kind) => own.filter((e) => e.kind === kind);
    const searches = of('search_opened'), placements = of('placement');
    // A search is filled when every opening on it has been hired into. Only searches that count can be filled.
    const hiredInto = (jobId) => placements.filter((p) => p.job_id === jobId).length;
    const filled = searches.filter((s) => hiredInto(s.job_id) >= (openings.get(s.job_id) ?? 1));
    // Time to fill: from kickoff to the accepted offer (or the hire), for placements on searches that count.
    const kickoff = new Map(searches.map((s) => [s.job_id, s.at]));
    const fills = placements.filter((p) => kickoff.has(p.job_id)).map((p) => Math.max(0, new Date(p.filled_at) - new Date(kickoff.get(p.job_id))) / DAY);
    const billed = placements.filter((p) => p.fee != null);
    if (cl.fee_percent > 0) for (const p of placements.filter((x) => x.fee == null)) missingFees.push({ application_id: p.application_id, candidate_name: p.candidate_name, client_name: cl.name });
    const submissions = of('submission').length, interviews = of('first_interview').length;
    return {
      id: cl.id, name: cl.name, brand_color: cl.brand_color, currency: cl.currency, status: cl.status,
      reqs: searches.length, reqs_12m: searches.filter((s) => s.at >= since12).length,
      submissions, interviews, interview_pct: percent(interviews, submissions),
      reqs_filled: filled.length, placement_pct: percent(filled.length, searches.length),
      placements: placements.length, fills: fills.length, time_to_fill: fills.length ? round1(fills.reduce((a, b) => a + b, 0) / fills.length) : null,
      billings: byCurrency(billed), billings_12m: byCurrency(billed.filter((p) => p.at >= since12)), avg_fee: byCurrency(billed, true),
    };
  });
  const sortKey = Object.hasOwn(CLIENT_SORTS, sort) ? sort : 'reqs';
  const sortDir = direction(dir, 'desc');
  const currencies = new Set(rows.flatMap((r) => r.billings.map((m) => m.currency)));
  return {
    start, since_12m: since12, to: stamp(), sort: sortKey, dir: sortDir,
    rows: sortRows(rows, CLIENT_SORTS[sortKey], sortDir),
    mixed_currencies: currencies.size > 1,
    missing_fees: missingFees,
  };
}

// ---------- routes ----------
export function registerReporting(api, { agencyOnly, adminOnly, bad, int, loadApp }) {
  const scope = (req) => int(req.query.client_id);

  // The day counting starts. Everyone on the agency side can see it; only an admin can move it.
  api.get('/reports/start', agencyOnly, (req, res) => res.json(reportStart()));
  api.put('/reports/start', adminOnly, (req, res) => {
    const date = req.body?.date;
    if (!validDay(date)) bad('Choose the day counting starts.');
    setSetting('reports_start', date);
    res.json(reportStart());
  });

  api.get('/reports/individual', agencyOnly, (req, res) => {
    res.json(individualReport({ user: req.user, period: req.query.period, clientId: scope(req), sort: req.query.sort, dir: req.query.dir }));
  });

  api.get('/reports/clients', agencyOnly, (req, res) => {
    res.json(clientReport({ clientId: scope(req), sort: req.query.sort, dir: req.query.dir }));
  });

  // Correct the fee recorded for a hired candidate (the invoice was different, a discount was agreed). An empty
  // value means no fee. Written to the record only: nothing here is put on the candidate's history, which the
  // client's hiring team can read.
  api.put('/applications/:id/placement-fee', agencyOnly, (req, res) => {
    const a = loadApp(req.params.id, req.user);
    if (!placementOf(a.id)) bad('No placement is recorded for this candidate. A placement is recorded when a candidate is marked hired after counting started.', 404);
    const given = req.body?.fee;
    const fee = given === '' || given == null ? null : int(given);
    if (given !== '' && given != null && (fee == null || fee < 0 || fee > 1e12)) bad('Enter the fee as a number, without a currency sign.');
    q.run(`UPDATE report_events SET fee = ?, fee_edited = 1 WHERE application_id = ? AND kind = 'placement'`, fee, a.id);
    res.json({ ok: true, placement: placementOf(a.id) });
  });
}
