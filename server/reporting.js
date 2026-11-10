// Reporting: the numbers a recruiter and a client are measured on (submissions, first interviews, placements,
// searches opened and filled, time to fill, billings).
//
// Two rules shape everything here.
//  1. Counting starts on a set day (Monday 16 November 2026 unless an admin changes it), at the start of that day in
//     Toronto. Nothing that happened before that moment is counted, and "lifetime" means since then. Nothing is
//     written down until counting first begins; from then on everything is, whatever the date is moved to later.
//  2. The numbers are recorded when things happen, not worked out afterwards from how the records look today. Each
//     moment is one row in report_events, with the recruiter credited and (for a placement) the fee as they were at
//     that moment. Reassigning a candidate or editing a client's terms later changes nothing that was recorded.
//
// The routes in api.js call the small functions in "writing things down" at the point where each thing happens;
// the reports only ever read report_events. Agency only: client users are refused on every route here.
import { q, getSetting, setSetting } from './db.js';
import { validDay, validZone, wallClock, zonedTimeToUtc, startOfDay } from './zoned-time.js';

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

// When this version first ran on this workspace. Moments are only written down while this code is running, so if it
// arrives after the start date the days in between were never recorded, and the page has to say so rather than
// claim to have counted from a day it was not there for.
const FIRST_RUN = 'reports_first_run';
if (!getSetting(FIRST_RUN)) setSetting(FIRST_RUN, new Date().toISOString());
// The moment counting first began here, kept from the first time an admin moves the date after that. Once counting
// has begun it stays begun: moving the date later, or into the future, only changes what is shown, not what is
// written down.
const BEGAN = 'reports_began';
/** The moment counting first began on this workspace, or null if it has not yet. */
const began = (at, started) => getSetting(BEGAN) ?? (started ? at : null);

/**
 * The day counting starts, the zone it is read in, the instant that is, and whether that instant has passed.
 * `recorded_from` is set only when the numbers do not reach back as far as that day: this version was installed
 * after it, or an admin has moved the date to before the day counting first began.
 */
export function reportStart() {
  const saved = getSetting('reports_start');
  const date = validDay(saved) ? saved : DEFAULT_START;
  const time_zone = reportZone();
  const at = startOfDay(date, time_zone).toISOString();
  const started = stamp() >= at;
  const firstRun = getSetting(FIRST_RUN), first = began(at, started);
  const from = first && firstRun > first ? firstRun : first;
  return { date, time_zone, at, started, recorded_from: started && from > at ? from : null };
}
/**
 * Is anything being written down yet? Not before counting first begins: a real workspace keeps no record of
 * anything earlier. After that, always, even while the date is set later than today.
 */
function counting() {
  const start = reportStart();
  return Boolean(began(start.at, start.started));
}
/**
 * An admin moves the start date. If counting had begun under the old date, that is remembered, so the new date does
 * not switch it off. If it begins only now, because the new date is already in the past, it begins at this moment:
 * the days between that date and today were not written down.
 */
function moveStart(date) {
  const old = reportStart();
  if (!getSetting(BEGAN) && old.started) setSetting(BEGAN, old.at);
  setSetting('reports_start', date);
  if (!getSetting(BEGAN) && reportStart().started) setSetting(BEGAN, stamp());
}

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
// Not a number on any report: a note that this candidate was hired in this job before anything was being written
// down, left when such a candidate is moved out of Hired.
const HIRED_EARLIER = 'hired_earlier';

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
 * A first interview with the client, for a candidate whose submission was recorded. The credit goes to whoever
 * submitted them. Without a recorded submission nothing is recorded: the ratio is interviews out of submissions.
 */
function firstInterview(applicationId) {
  const submission = eventOf(applicationId, 'submission');
  if (submission) record('first_interview', context(applicationId), submission.user_id, stamp());
}
/** An interview was scheduled for the candidate in The Book. */
export const interviewScheduled = (applicationId) => firstInterview(applicationId);

/**
 * The candidate was marked hired: a placement. The credit goes to the recruiter who owns them in this job right now,
 * or to whoever submitted them when nobody does. The fee is the salary on their offer times the client's fee
 * percentage, both as they stand at this moment.
 *
 * A candidate is placed in a job once. If they were hired here before and the card was moved away and put back,
 * this is the same hire: the placement recorded then counts again exactly as it was (its date, credit and fee), and
 * a hire from before counting started stays uncounted. `before` is the application as it was before the move.
 */
function placed(applicationId, before) {
  const earlier = eventOf(applicationId, 'placement');
  if (earlier) return void q.run('UPDATE report_events SET set_aside_at = NULL WHERE id = ?', earlier.id);
  // Already hired when this move began (rejected while hired, then dragged back into Hired), or hired before
  // anything was being written down: not a new placement.
  if (before?.hired_at || eventOf(applicationId, HIRED_EARLIER) || !counting()) return;
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
 * A hired candidate was moved out of Hired. Their placement stops counting, but the record is kept: anybody who can
 * move a card (the client's hiring team included) can drop one in the wrong column, and putting it back must not
 * change the date, the credit or the fee that were fixed at the hire. The one exception is a hire undone within a
 * day of being made, with no fee entered by hand: that was the slip, so it is forgotten, and a later hire of the
 * same candidate is recorded afresh.
 */
function leftHired(applicationId, before) {
  const placement = eventOf(applicationId, 'placement');
  if (!placement) {
    // Hired, but with nothing recorded: the hire is from before counting started. Note that, so that putting the
    // card back in Hired is not taken for a new placement.
    if (before?.hired_at && counting()) record(HIRED_EARLIER, context(applicationId), null, stamp());
    return;
  }
  if (placement.set_aside_at) return;
  const slip = !placement.fee_edited && new Date(stamp()) - new Date(placement.at) < DAY;
  if (slip) q.run('DELETE FROM report_events WHERE id = ?', placement.id);
  else q.run('UPDATE report_events SET set_aside_at = ? WHERE id = ?', stamp(), placement.id);
}

/**
 * The candidate arrived in a stage, by any road: moved on the board or the profile, approved by the client, or added
 * straight into it. Hired is a placement. Any other stage sets one aside (a hire that fell through), and an
 * interview stage where the client meets them is their first interview if they have been submitted. `before` is
 * the application as it was before the move; nothing for somebody just added.
 */
export function arrivedIn(applicationId, stage, before) {
  if (stage.kind === 'hired') return placed(applicationId, before);
  leftHired(applicationId, before);
  if (stage.kind === 'interview' && stage.with_client) firstInterview(applicationId);
}

/** A hired candidate was rejected or withdrew: their placement stops counting, but is kept in case they are returned. */
export function leftPipeline(applicationId) {
  q.run(`UPDATE report_events SET set_aside_at = ? WHERE application_id = ? AND kind = 'placement' AND set_aside_at IS NULL`, stamp(), applicationId);
}
/**
 * Somebody who was in The Book before this job goes back to it without a job (the job was deleted, or they were
 * removed from it). Anyone else's application is deleted at that point, and what was counted for it goes with it.
 * Theirs is kept, under the same id, to be put on another job later, so what was counted for it in this job is
 * removed here: the next job's submission, interview and placement are then recorded as that job's own.
 */
export function leftJob(applicationId) {
  q.run('DELETE FROM report_events WHERE application_id = ?', applicationId);
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
 * placement that had none because the offer had no salary yet when the candidate was hired. That fee uses the
 * client's fee percentage as it was recorded at the hire, like the currency beside it, not the terms as they are now.
 */
export function offerSaved(applicationId) {
  const offer = q.get('SELECT id, salary, status, accepted_at FROM offers WHERE application_id = ?', applicationId);
  if (!offer) return;
  if (offer.status === 'accepted' && !offer.accepted_at) q.run('UPDATE offers SET accepted_at = ? WHERE id = ?', stamp(), offer.id);
  if (offer.status !== 'accepted' && offer.accepted_at) q.run('UPDATE offers SET accepted_at = NULL WHERE id = ?', offer.id);
  const placement = eventOf(applicationId, 'placement');
  if (!placement || placement.fee != null || placement.fee_edited || offer.salary == null) return;
  q.run('UPDATE report_events SET salary = ?, fee = ? WHERE id = ?', offer.salary, workedOutFee(offer.salary, placement.fee_percent), placement.id);
}

/** The placement recorded for this candidate in this job, if it counts: not set aside, and not from before the start date. */
function countedPlacement(applicationId) {
  const p = eventOf(applicationId, 'placement');
  return p && !p.set_aside_at && p.at >= reportStart().at ? p : null;
}
/** What a hired candidate's profile shows the agency about their recorded placement; null when none is counted. */
export function placementOf(applicationId) {
  const p = countedPlacement(applicationId);
  if (!p) return null;
  const credited = p.user_id ? q.get('SELECT name FROM users WHERE id = ?', p.user_id)?.name ?? null : null;
  return { at: p.at, fee: p.fee, currency: p.currency, fee_edited: Boolean(p.fee_edited), salary: p.salary, fee_percent: p.fee_percent, credited_to: credited };
}
/**
 * For the overview's list of hires: the fee and currency recorded for this hire, so that the overview, the Clients
 * report and the candidate's profile all show one figure. Nothing for a hire with no placement on record (one from
 * before counting started), which leaves the overview's own estimate from the client's terms today in place.
 */
export function recordedFee(applicationId) {
  const p = countedPlacement(applicationId);
  return p ? { fee: p.fee ?? 0, currency: p.currency } : {};
}

// ---------- reading the numbers ----------
const round1 = (n) => Math.round(n * 10) / 10;
/** A whole percentage. Rounded here, once: the page shows it as it comes, so 5 of 11 is 45%, not 45.5% rounded again to 46%. */
const percent = (part, whole) => (whole ? Math.round((part / whole) * 100) : null);
/** The same as a fraction, unrounded, for putting rows in order: two rows that both show 45% still sort by what is behind it. */
const share = (part, whole) => (whole ? part / whole : null);
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

/**
 * Everything that counts: recorded on or after the start, and not a placement that has been set aside. A first
 * interview counts only when the submission it follows counts too (the start date can be moved to fall between
 * them), because the ratio is interviews out of submissions.
 */
function countedEvents(start, clientId) {
  return q.all(
    `SELECT e.* FROM report_events e WHERE e.at >= ? AND e.set_aside_at IS NULL AND e.kind != '${HIRED_EARLIER}'
       AND (e.kind != 'first_interview' OR EXISTS (SELECT 1 FROM report_events s WHERE s.application_id = e.application_id AND s.kind = 'submission' AND s.at >= ?))
       ${clientId ? 'AND e.client_id = ?' : ''} ORDER BY e.at, e.id`,
    start.at, start.at, ...(clientId ? [clientId] : []));
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
  name: (r) => r.name, submissions: (r) => r.submissions, interviews: (r) => r.interviews, ratio: (r) => share(r.interviews, r.submissions), placements: (r) => r.placements,
};
/**
 * One row per recruiter for a period. An admin gets everyone on the agency side who has anything recorded since
 * counting started, and the totals; a recruiter gets their own row and nothing about anybody else.
 */
function individualReport({ user, period, clientId, sort, dir }) {
  const start = reportStart();
  const chosen = PERIODS.includes(period) ? period : 'all';
  const from = periodFrom(chosen, start);
  const column = { submission: 'submissions', first_interview: 'interviews', placement: 'placements' };
  const events = start.started ? countedEvents(start, clientId).filter((e) => column[e.kind]) : [];
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
// Nought is a figure like any other: a client with no searches, or with placements and nothing billed, sorts as 0.
// Only what cannot be worked out at all (a percentage of nothing, a time to fill with nothing filled) goes last.
const CLIENT_SORTS = {
  reqs: (r) => r.reqs, reqs_12m: (r) => r.reqs_12m, interview_pct: (r) => share(r.interviews, r.submissions), placement_pct: (r) => share(r.reqs_filled, r.reqs),
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
    // Placements with nothing billed are a real nought, in the currency the latest placement was recorded in. With
    // no placements at all there are no billings to speak of.
    const billings = (list) => (list.length || !placements.length ? byCurrency(list) : [{ currency: placements.at(-1).currency ?? cl.currency, amount: 0 }]);
    // A fee still to be entered: none could be worked out, and nobody has said by hand that there is none.
    if (cl.fee_percent > 0) for (const p of placements.filter((x) => x.fee == null && !x.fee_edited)) missingFees.push({ application_id: p.application_id, candidate_name: p.candidate_name, client_name: cl.name });
    const submissions = of('submission').length, interviews = of('first_interview').length;
    return {
      id: cl.id, name: cl.name, brand_color: cl.brand_color, currency: cl.currency, status: cl.status,
      reqs: searches.length, reqs_12m: searches.filter((s) => s.at >= since12).length,
      submissions, interviews, interview_pct: percent(interviews, submissions),
      reqs_filled: filled.length, placement_pct: percent(filled.length, searches.length),
      placements: placements.length, fills: fills.length, time_to_fill: fills.length ? round1(fills.reduce((a, b) => a + b, 0) / fills.length) : null,
      billings: billings(billed), billings_12m: billings(billed.filter((p) => p.at >= since12)), avg_fee: byCurrency(billed, true),
    };
  });
  const sortKey = Object.hasOwn(CLIENT_SORTS, sort) ? sort : 'reqs';
  const sortDir = direction(dir, 'desc');
  const currencies = new Set(rows.flatMap((r) => r.billings.filter((m) => m.amount).map((m) => m.currency)));
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
    moveStart(date);
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
