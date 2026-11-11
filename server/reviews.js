// Asking somebody on the team to review a candidate. One agency user asks another (the job's account executive,
// usually) to look at a candidate, with a note saying what to look at. The person asked finds it in their Inbox,
// under "For your review", and answers on the candidate's profile: "Good to go" or "Not a fit", each with a comment if
// they like. The answer goes back to the Inbox of whoever asked, until they mark it done.
//
// Three rules shape everything here.
//  1. It is the agency's business alone. Every route refuses a client's user, and nothing about a request is written
//     anywhere a client's user is shown from: not the history, the e-mails or the notes of the candidate, and no column
//     on applications or candidates. It all lives in one table (team_reviews, see db.js) that only this file reads, so
//     even a version of the app from before this one, run on the same database, has nothing of it to show anybody.
//  2. One open request for each candidate and person asked. Asking somebody else as well is allowed.
//  3. A request stays answerable by the person asked only while they are active on the agency team. Somebody
//     deactivated, or since made a client's user, or removed from the database, leaves their open requests answerable
//     by nobody: the profile says so, and whoever asked (or an admin) can take the request back and ask somebody else.
//
// What happens around a request: it goes with the candidate's application, so deleting the candidate, or removing
// them from a job they did not come to from The Book, deletes it (the database does that, see db.js). Somebody who
// goes back to The Book keeps their entry, and their requests with it. When an entry is folded into another
// application (two entries merged, or an entry joined to the application a client's record already has), api.js calls
// entryFolded() and the requests move with it. Rejecting or withdrawing a candidate leaves their requests open.
import { q, tx, now, getSetting } from './db.js';
import { notify, appUrl } from './mail.js';

const NOTE_MAX = 1000;
const ANSWERS = { good_to_go: 'Good to go', not_a_fit: 'Not a fit' };
/** Asked and not yet answered or taken back. */
const OPEN = 'r.answered_at IS NULL AND r.cancelled_at IS NULL';
/** Somebody who can be asked, and who can answer: active on the agency team. */
const ON_TEAM = `u.role != 'client' AND u.active = 1 AND u.pending = 0`;
const onTeam = (userId) => Boolean(userId && q.get(`SELECT 1 AS x FROM users u WHERE u.id = ? AND ${ON_TEAM}`, userId));

/**
 * Two applications became one and `goingId` is about to be deleted (inside the caller's transaction): every request
 * about it moves to `keptId`. An open request to somebody who also has one open about `keptId` is dropped, since one
 * person is asked about one candidate once at a time; the one that was already there stays.
 */
export function entryFolded(goingId, keptId) {
  q.run(`DELETE FROM team_reviews AS r WHERE r.application_id = ? AND ${OPEN}
         AND r.reviewer_id IN (SELECT k.reviewer_id FROM team_reviews k WHERE k.application_id = ? AND k.answered_at IS NULL AND k.cancelled_at IS NULL)`, goingId, keptId);
  q.run('UPDATE team_reviews SET application_id = ? WHERE application_id = ?', keptId, goingId);
}

/** In the Inbox for one client: that client's candidates, and always the people in The Book on no job. */
const inView = (clientId) => (clientId ? { sql: 'AND (j.client_id = ? OR a.job_id IS NULL)', p: [clientId] } : { sql: '', p: [] });

/**
 * What is waiting on this person, for the count beside Inbox and on the dashboard: requests for them to answer, and
 * answers that have come back to them and that they have not marked done. Follows the client chosen in the menu as the
 * Inbox does.
 */
export function waitingOn(userId, clientId) {
  const view = inView(clientId);
  const count = (who, state) => q.get(
    `SELECT COUNT(*) AS n FROM team_reviews r JOIN applications a ON a.id = r.application_id LEFT JOIN jobs j ON j.id = a.job_id
     WHERE r.${who} = ? AND ${state} ${view.sql}`, userId, ...view.p).n;
  const toAnswer = count('reviewer_id', OPEN);
  const answers = count('asked_by', 'r.answered_at IS NOT NULL AND r.done_at IS NULL');
  return { to_review: toAnswer, reviews: toAnswer + answers };
}

/** A request as the screens get it. `user` is whoever is looking, for what they may do with it. */
function shown(r, user) {
  const open = !r.answered_at && !r.cancelled_at;
  const canAnswer = Boolean(r.reviewer_id) && Boolean(r.reviewer_on_team);
  return {
    id: r.id, application_id: r.application_id,
    asked_by: r.asked_by, asked_by_name: r.asked_by_name ?? null,
    reviewer_id: r.reviewer_id, reviewer_name: r.reviewer_name ?? null,
    note: r.note, created_at: r.created_at,
    answer: r.answer, comment: r.comment, answered_at: r.answered_at,
    cancelled_at: r.cancelled_at, cancelled_by_name: r.cancelled_by_name ?? null, done_at: r.done_at,
    open,
    // Whether the person asked can still answer: they are active on the agency team.
    reviewer_can_answer: open && canAnswer,
    yours_to_answer: open && canAnswer && r.reviewer_id === user.id,
    can_cancel: open && (r.asked_by === user.id || user.role === 'admin'),
    can_mark_done: Boolean(r.answered_at) && !r.done_at && r.asked_by === user.id,
  };
}
const SELECT = `
  SELECT r.*, au.name AS asked_by_name, ru.name AS reviewer_name, cu.name AS cancelled_by_name,
    (ru.role != 'client' AND ru.active = 1 AND ru.pending = 0) AS reviewer_on_team
  FROM team_reviews r LEFT JOIN users au ON au.id = r.asked_by LEFT JOIN users ru ON ru.id = r.reviewer_id LEFT JOIN users cu ON cu.id = r.cancelled_by`;

/** The candidate, their job and its client, for the e-mail and the Inbox. */
const about = (applicationId) => q.get(
  `SELECT a.id, a.job_id, c.name AS candidate_name, j.title AS job_title, j.account_executive_id, cl.name AS client_name
   FROM applications a JOIN candidates c ON c.id = a.candidate_id LEFT JOIN jobs j ON j.id = a.job_id LEFT JOIN clients cl ON cl.id = j.client_id WHERE a.id = ?`, applicationId);

/**
 * Tell the person asked, by e-mail, when e-mail is connected. It is a message to somebody on the team, so it is not
 * kept on the candidate's record (notify() records nothing). Not waited for: a request is made whether or not the
 * message goes, and a failure is only logged.
 */
function tellReviewer({ reviewer, asker, app, note }) {
  const link = appUrl() ? `${appUrl()}/inbox?tab=reviews&c=${app.id}` : null;
  const job = app.job_id ? `${app.job_title} at ${app.client_name}` : 'Not on a job yet';
  const agency = getSetting('agency_name', 'The Book');
  notify({
    to: reviewer.email,
    subject: `${asker.name} asked you to review a candidate`,
    body: `Hi ${String(reviewer.name).split(/\s+/)[0]},\n\n${asker.name} asked you to review a candidate in The Book.\n\n` +
      `Candidate: ${app.candidate_name}\nJob: ${job}\n${note ? `What to look at: ${note}\n` : ''}\n` +
      `${link ? `Open their profile: ${link}` : 'You will find them in your Inbox, under For your review.'}\n\n` +
      `Answer "Good to go" or "Not a fit" at the top of their profile, and ${asker.name} is told.\n\n${agency}\n`,
  }).catch((err) => console.error('The review request e-mail could not be sent:', err));
}

// ---------- routes ----------
export function registerReviews(api, { agencyOnly, bad, text, int, loadApp, scopeOf }) {
  /** A request by its number, or one and the same answer whether it never existed or was deleted with its candidate. */
  const load = (req) => {
    const r = q.get(`${SELECT} WHERE r.id = ?`, int(req.params.id));
    if (!r) bad('That review request is no longer in The Book.', 404);
    return r;
  };
  const people = (userId) => q.all(`SELECT u.id, u.name FROM users u WHERE ${ON_TEAM} AND u.id != ? ORDER BY u.name, u.id`, userId);

  // A candidate's requests, newest first, for their profile: the open ones and a short history of the rest. With them,
  // who can be asked, and who is suggested: the job's account executive, when there is one and it is not you.
  api.get('/applications/:id/reviews', agencyOnly, (req, res) => {
    const a = loadApp(req.params.id, req.user);
    const app = about(a.id);
    const choices = people(req.user.id);
    const suggested = choices.some((p) => p.id === app.account_executive_id) ? app.account_executive_id : null;
    res.json({
      reviews: q.all(`${SELECT} WHERE r.application_id = ? ORDER BY r.created_at DESC, r.id DESC LIMIT 20`, a.id).map((r) => shown(r, req.user)),
      people: choices,
      suggested,
    });
  });

  // Ask somebody on the team to review this candidate.
  api.post('/applications/:id/reviews', agencyOnly, (req, res) => {
    const a = loadApp(req.params.id, req.user);
    const b = req.body || {};
    const reviewerId = typeof b.reviewer_id === 'number' || (typeof b.reviewer_id === 'string' && /^\d+$/.test(b.reviewer_id)) ? Number(b.reviewer_id) : null;
    if (reviewerId === req.user.id) bad('You cannot ask yourself. Choose somebody else on your team.');
    if (!onTeam(reviewerId)) bad('Choose somebody who is active on your team.');
    const note = text(b.note, NOTE_MAX);
    const reviewer = q.get('SELECT id, name, email FROM users WHERE id = ?', reviewerId);
    const app = about(a.id);
    const id = tx(() => {
      if (q.get(`SELECT 1 AS x FROM team_reviews r WHERE r.application_id = ? AND r.reviewer_id = ? AND ${OPEN}`, a.id, reviewerId)) {
        bad(`${reviewer.name} has already been asked to review ${app.candidate_name} and has not answered yet.`, 409);
      }
      return q.insert('INSERT INTO team_reviews (application_id, asked_by, reviewer_id, note, created_at) VALUES (?, ?, ?, ?, ?)', a.id, req.user.id, reviewerId, note, now());
    });
    tellReviewer({ reviewer, asker: req.user, app, note });
    res.json({ id });
  });

  // The Inbox tab: what is waiting on the signed-in person to answer, oldest first, then the answers that have come
  // back to them, oldest first. It follows the client chosen in the menu, but people on no job are always listed.
  api.get('/reviews', agencyOnly, (req, res) => {
    const view = inView(scopeOf(req));
    const rows = (where, order) => q.all(
      `SELECT r.*, au.name AS asked_by_name, ru.name AS reviewer_name, NULL AS cancelled_by_name, (ru.role != 'client' AND ru.active = 1 AND ru.pending = 0) AS reviewer_on_team,
         c.id AS candidate_id, c.name, substr(c.photo_file, 1, 8) AS photo, c.current_title, c.current_company,
         a.job_id, j.title AS job_title, cl.name AS client_name, cl.brand_color
       FROM team_reviews r JOIN applications a ON a.id = r.application_id JOIN candidates c ON c.id = a.candidate_id
       LEFT JOIN jobs j ON j.id = a.job_id LEFT JOIN clients cl ON cl.id = j.client_id
       LEFT JOIN users au ON au.id = r.asked_by LEFT JOIN users ru ON ru.id = r.reviewer_id
       WHERE ${where} ${view.sql} ORDER BY ${order}, r.id LIMIT 500`, req.user.id, ...view.p)
      .map((r) => ({ ...shown(r, req.user), candidate_id: r.candidate_id, name: r.name, photo: r.photo, current_title: r.current_title, current_company: r.current_company,
        job_id: r.job_id, job_title: r.job_title, client_name: r.client_name, brand_color: r.brand_color }));
    res.json({
      waiting: rows(`r.reviewer_id = ? AND ${OPEN}`, 'r.created_at'),
      answers: rows('r.asked_by = ? AND r.answered_at IS NOT NULL AND r.done_at IS NULL', 'r.answered_at'),
    });
  });

  // Answer a request: only the person asked, while it is open and they are on the team.
  api.post('/reviews/:id/answer', agencyOnly, (req, res) => {
    const r = load(req);
    const b = req.body || {};
    if (r.reviewer_id !== req.user.id) bad('Only the person who was asked can answer this.', 403);
    if (r.cancelled_at) bad('This request was taken back, so there is nothing to answer.', 409);
    if (r.answered_at) bad('You have already answered this.', 409);
    if (!Object.hasOwn(ANSWERS, b.answer)) bad('Choose Good to go or Not a fit.');
    const done = q.run(`UPDATE team_reviews AS r SET answer = ?, comment = ?, answered_at = ? WHERE r.id = ? AND ${OPEN}`, b.answer, text(b.comment, NOTE_MAX), now(), r.id).changes;
    if (!done) bad('This request is no longer open.', 409);
    res.json({ ok: true });
  });

  // Take a request back before it is answered: whoever asked, or an admin.
  api.post('/reviews/:id/cancel', agencyOnly, (req, res) => {
    const r = load(req);
    if (r.asked_by !== req.user.id && req.user.role !== 'admin') bad('Only whoever asked, or an admin, can take this request back.', 403);
    if (r.answered_at) bad(`${r.reviewer_name || 'They'} answered already, so it can no longer be taken back.`, 409);
    if (r.cancelled_at) return res.json({ ok: true }); // pressed twice, or in two tabs: it is taken back either way
    const done = q.run(`UPDATE team_reviews AS r SET cancelled_at = ?, cancelled_by = ? WHERE r.id = ? AND ${OPEN}`, now(), req.user.id, r.id).changes;
    if (!done) bad('This request was answered a moment ago, so it can no longer be taken back.', 409);
    res.json({ ok: true });
  });

  // Whoever asked has read the answer: it leaves their Inbox. It stays in the candidate's history.
  api.post('/reviews/:id/done', agencyOnly, (req, res) => {
    const r = load(req);
    if (r.asked_by !== req.user.id) bad('Only whoever asked can mark this done.', 403);
    if (!r.answered_at) bad('This has not been answered yet.', 409);
    if (!r.done_at) q.run('UPDATE team_reviews SET done_at = ? WHERE id = ?', now(), r.id);
    res.json({ ok: true });
  });
}

export { ANSWERS };
