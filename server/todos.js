// To do: each agency user's own list of what they mean to get to. Three lists, each in the order its owner puts it
// in, each item tickable as done:
//   job      jobs the person has picked to work on
//   prep     candidates to prepare before an interview
//   debrief  candidates to speak to after an interview
//
// Three rules shape everything here.
//  1. A list belongs to one person. Every route acts on the signed-in person's own items; an item's number sent by
//     anybody else answers "Not found", exactly as a number that does not exist. Agency only: client users are
//     refused on every route.
//  2. The Book fills the two people lists by itself from the interviews scheduled in it. A candidate goes on the To
//     prep list of the recruiter who owns them in that job (failing that, of whoever scheduled the interview) from
//     seven days before the interview starts. When the interview's end has passed, their prep is ticked and they go
//     on that person's To debrief list. A cancelled interview takes its items with it, and a moved one keeps them
//     (they show the new time).
//  3. What a person took off their list, or ticked, is theirs to decide: The Book never puts the same person back
//     for the same interview. That is why a removed item is kept as a row and only marked removed.
//
// Nothing here runs on a timer. The lists are brought up to date for the time it is now whenever somebody asks for
// their list or for the menu's count (catchUp), and at once when an interview is scheduled, changed or cancelled:
// the routes in api.js call interviewChanged() at those points. Interviews are only ever deleted along with their
// candidate or job, and the database removes those items by itself (see the table in db.js).
import { q, tx, now, getSetting, setSetting } from './db.js';

const DAY = 86400000;
const WEEK = 7 * DAY;
const PEOPLE = ['prep', 'debrief'];
const KINDS = ['job', ...PEOPLE];
const NOTE_MAX = 300;
/** Still to do: neither ticked nor taken off the list. */
const OPEN = 'done_at IS NULL AND removed_at IS NULL';

// ---------- the clock ----------
let clock = () => new Date();
/** For the tests only: lets them say what time it is, so an interview can come up and pass without waiting. */
export function setTodoClock(fn) { clock = fn || (() => new Date()); }
const stamp = () => clock().toISOString();

// When this version first ran on this workspace. Nobody is put on a debrief list for an interview that had already
// ended by then: the lists start with what is coming up, not with every interview of the week before.
const SINCE = 'todos_since';
if (!getSetting(SINCE)) setSetting(SINCE, new Date().toISOString());
const since = Date.parse(getSetting(SINCE));

// ---------- interviews, as the lists see them ----------
/** A candidate's interviews in a job, earliest first, each with when it starts and ends and whether it is over. */
function interviewsOf(applicationId, at) {
  return q.all('SELECT id, title, kind, starts_at, duration_min, status, created_by FROM interviews WHERE application_id = ? ORDER BY starts_at, id', applicationId).map((i) => {
    const start = Date.parse(i.starts_at), end = start + i.duration_min * 60000;
    const cancelled = i.status === 'cancelled';
    // Over when its end has passed, or when somebody has already marked it completed (a scorecard does that).
    return { ...i, start, end, cancelled, over: !cancelled && (i.status === 'completed' || end <= at) };
  });
}
/** The interview to prepare for: the next one that has not been held. */
const nextUp = (interviews) => interviews.find((i) => !i.cancelled && !i.over);
/** The interview to debrief: the latest one that has been held. */
const lastOver = (interviews) => interviews.filter((i) => i.over).at(-1);

/** This person, if items can go on their list: somebody active on the agency team. */
const onTeam = (userId) => (userId && q.get(`SELECT 1 AS x FROM users WHERE id = ? AND role != 'client' AND active = 1 AND pending = 0`, userId) ? userId : null);

// ---------- adding and ordering ----------
/** The place after the last item still to do on a list. */
const endOf = (userId, kind) => q.get(`SELECT COALESCE(MAX(position), -1) + 1 AS n FROM todos WHERE user_id = ? AND kind = ? AND ${OPEN}`, userId, kind).n;

/** Add an item at the end of a list. */
function insert({ userId, kind, jobId = null, applicationId = null, interviewId = null, note = null, auto = 0 }) {
  return q.insert('INSERT INTO todos (user_id, kind, job_id, application_id, interview_id, note, position, auto, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    userId, kind, jobId, applicationId, interviewId, note, endOf(userId, kind), auto, stamp());
}

/** Put an item at a place among what is still to do on its list (0 is the top), and number the rest around it. */
function place(item, position) {
  const order = q.all(`SELECT id FROM todos WHERE user_id = ? AND kind = ? AND ${OPEN} AND id != ? ORDER BY position, id`, item.user_id, item.kind, item.id).map((r) => r.id);
  order.splice(Math.min(Math.max(position, 0), order.length), 0, item.id);
  order.forEach((id, n) => q.run('UPDATE todos SET position = ? WHERE id = ?', n, id));
}

// ---------- what The Book does by itself ----------
/**
 * Bring the people lists up to date with one candidate's interviews in a job, for the time it is now. It can be run
 * any number of times: it only changes what no longer matches.
 *
 * To prep follows the next interview that has not been held, from seven days before it starts; To debrief follows
 * the latest one that has, for seven days after it ended. One at a time for each, so two interviews in a week do not
 * put the same person on a list twice. The item goes to the recruiter who owns the candidate in that job, or to
 * whoever scheduled the interview when nobody on the team owns them.
 */
function settle(applicationId) {
  const app = q.get('SELECT id, owner_id, status FROM applications WHERE id = ?', applicationId);
  if (!app) return;
  const at = clock().getTime(), t = stamp();
  const interviews = interviewsOf(app.id, at);
  if (!interviews.length) return;
  // Somebody rejected or withdrawn has nothing to be prepared for; what already happened can still be debriefed.
  const next = app.status === 'active' || app.status === 'hired' ? nextUp(interviews) : undefined;
  const last = lastOver(interviews);
  let rows = q.all('SELECT * FROM todos WHERE application_id = ?', app.id);
  const open = (r) => !r.done_at && !r.removed_at;
  // Each change is written and made to the copy in hand, so that the steps below see what the steps above did.
  const set = (r, fields) => {
    q.run(`UPDATE todos SET ${Object.keys(fields).map((key) => `${key} = ?`).join(', ')} WHERE id = ?`, ...Object.values(fields), r.id);
    Object.assign(r, fields);
  };
  const remove = (r) => { q.run('DELETE FROM todos WHERE id = ?', r.id); rows = rows.filter((x) => x !== r); };
  const owner = onTeam(app.owner_id);
  const schedulers = new Map();
  const scheduler = (userId) => { if (!schedulers.has(userId)) schedulers.set(userId, onTeam(userId)); return schedulers.get(userId); };

  for (const i of interviews) {
    const wanted = { prep: i === next && at >= i.start - WEEK, debrief: i === last && at < i.end + WEEK && i.end >= since };
    const who = owner ?? scheduler(i.created_by);

    // What is already on somebody's list for this interview.
    for (const r of rows.filter((x) => x.interview_id === i.id && !x.removed_at)) {
      // A prep The Book ticked because the time had passed is to do again if the interview turns out not to have
      // been held: it was moved to a later time afterwards.
      const twin = rows.some((x) => x !== r && x.user_id === r.user_id && x.kind === r.kind && open(x));
      if (r.done_at && r.kind === 'prep' && r.auto_done && !i.over && !i.cancelled && !twin) set(r, { done_at: null, auto_done: 0, position: endOf(r.user_id, 'prep') });
      if (r.done_at) continue;
      // An item the person added themselves stays on their list without the interview; one The Book added goes.
      const letGo = () => (r.auto ? remove(r) : set(r, { interview_id: null }));
      if (r.kind === 'prep') {
        if (i.over) set(r, { done_at: t, auto_done: 1 });   // too late to prepare them: it comes off, as done
        else if (i.cancelled) letGo();
        // Moved to more than a week away, or the candidate now belongs to somebody else: it is added again, to
        // the right list, when it is due.
        else if (r.auto && (!wanted.prep || (who && r.user_id !== who))) remove(r);
      } else if (!i.over) letGo();                           // cancelled, or moved to a time that has not come yet
      else if (r.auto && wanted.debrief && who && r.user_id !== who) remove(r);
    }

    for (const kind of PEOPLE) {
      if (!wanted[kind]) continue;
      // Anybody who put this candidate on their own list with no interview to go by now has one.
      for (const r of rows.filter((x) => x.kind === kind && open(x) && !x.interview_id)) set(r, { interview_id: i.id });
      // Already there, or dealt with: ticked or taken off for this interview, it is not put back.
      if (!who || rows.some((x) => x.user_id === who && x.kind === kind && x.interview_id === i.id)) continue;
      const theirs = rows.find((x) => x.user_id === who && x.kind === kind && open(x));
      if (theirs) set(theirs, { interview_id: i.id });       // on their list for an earlier interview: it follows this one now
      else rows.push(q.get('SELECT * FROM todos WHERE id = ?', insert({ userId: who, kind, applicationId: app.id, interviewId: i.id, auto: 1 })));
    }
  }
}

/**
 * The same, never failing the work it follows: scheduling an interview, or drawing the menu, must not stop because
 * a to-do list could not be brought up to date. Whatever was missed is put right the next time anybody looks.
 */
function settleQuietly(applicationId) {
  try { settle(applicationId); } catch (err) { console.error('A to-do list could not be brought up to date:', err); }
}

/** An interview was scheduled, changed or cancelled for this candidate in a job: their items follow at once. */
export const interviewChanged = (applicationId) => settleQuietly(applicationId);

/**
 * Bring everybody's people lists up to date for the time it is now: interviews that have come within a week, and
 * interviews whose end has passed. Looks only at candidates with an interview near today or with an item that is
 * tied to one, so it stays quick however much history there is.
 */
export function catchUp() {
  const at = clock().getTime();
  const iso = (ms) => new Date(ms).toISOString();
  // An interview lasts eight hours at most, so one that ended within the last week started within the last eight days.
  // Soonest first, so that when several people are added at once they arrive in the order of their interviews.
  const near = q.all(
    `SELECT application_id AS id, MIN(CASE WHEN starts_at >= ? THEN starts_at END) AS coming FROM interviews WHERE starts_at >= ? AND starts_at <= ?
     GROUP BY application_id ORDER BY coming IS NULL, coming, MIN(starts_at), application_id`, iso(at), iso(at - WEEK - DAY), iso(at + WEEK));
  const tied = q.all(`SELECT DISTINCT application_id AS id FROM todos WHERE interview_id IS NOT NULL AND ${OPEN}`);
  for (const id of new Set([...near, ...tied].map((r) => r.id))) settleQuietly(id);
}

/** How many things this person still has to do, for the count in the menu. */
export function openCount(userId) {
  catchUp();
  return q.get(`SELECT COUNT(*) AS n FROM todos WHERE user_id = ? AND ${OPEN}`, userId).n;
}

// ---------- reading a list ----------
/**
 * The interview a person's item is about: the one it is tied to, or, for an item with none, the next one coming up
 * (to prep for) or the last one held (to debrief).
 */
function interviewFor(row, at) {
  let i = row.interview_id ? q.get('SELECT id, title, kind, starts_at, duration_min, status FROM interviews WHERE id = ?', row.interview_id) : null;
  if (!i && !row.done_at) {
    const all = interviewsOf(row.application_id, at);
    i = row.kind === 'prep' ? nextUp(all) : lastOver(all);
  }
  return i ? { id: i.id, title: i.title, kind: i.kind, starts_at: i.starts_at, duration_min: i.duration_min, status: i.status } : null;
}

/** One person's three lists: what is still to do in their order, and what was ticked in the last seven days, newest first. */
function listsOf(userId) {
  const at = clock().getTime();
  const shown = 't.user_id = ? AND t.removed_at IS NULL AND (t.done_at IS NULL OR t.done_at >= ?)';
  const order = 'ORDER BY t.done_at IS NOT NULL, t.done_at DESC, t.position, t.id';
  const p = [userId, new Date(at - WEEK).toISOString()];
  const jobs = q.all(
    `SELECT t.id, t.kind, t.note, t.done_at, j.id AS job_id, j.title, j.status, j.opened_at, cl.name AS client_name, cl.brand_color,
       (SELECT COUNT(*) FROM applications a WHERE a.job_id = j.id AND a.status = 'active') AS in_pipeline
     FROM todos t JOIN jobs j ON j.id = t.job_id JOIN clients cl ON cl.id = j.client_id
     WHERE t.kind = 'job' AND ${shown} ${order}`, ...p);
  const people = q.all(
    `SELECT t.id, t.kind, t.note, t.done_at, t.auto, t.interview_id, a.id AS application_id, a.status, c.id AS candidate_id, c.name, substr(c.photo_file, 1, 8) AS photo,
       j.id AS job_id, j.title AS job_title, cl.name AS client_name, cl.brand_color, s.name AS stage_name, s.kind AS stage_kind
     FROM todos t JOIN applications a ON a.id = t.application_id JOIN candidates c ON c.id = a.candidate_id
     JOIN jobs j ON j.id = a.job_id JOIN clients cl ON cl.id = j.client_id JOIN stages s ON s.id = a.stage_id
     WHERE t.kind != 'job' AND ${shown} ${order}`, ...p)
    .map(({ interview_id, auto, ...row }) => ({ ...row, auto: Boolean(auto), interview: interviewFor({ ...row, interview_id }, at) }));
  const split = (rows) => ({ open: rows.filter((r) => !r.done_at), done: rows.filter((r) => r.done_at) });
  const lists = { job: split(jobs), prep: split(people.filter((r) => r.kind === 'prep')), debrief: split(people.filter((r) => r.kind === 'debrief')) };
  const counts = Object.fromEntries(KINDS.map((kind) => [kind, lists[kind].open.length]));
  return { ...lists, counts: { ...counts, total: KINDS.reduce((n, kind) => n + counts[kind], 0) } };
}

// ---------- routes ----------
export function registerTodos(api, { agencyOnly, bad, clean, text, int }) {
  /** The item a request names, if it is on the signed-in person's own list. Anybody else's is "Not found". */
  const mine = (req) => {
    const item = q.get('SELECT * FROM todos WHERE id = ? AND user_id = ? AND removed_at IS NULL', int(req.params.id), req.user.id);
    if (!item) bad('Not found', 404);
    return item;
  };
  const onList = (userId, kind, column, id) => q.get(`SELECT 1 AS x FROM todos WHERE user_id = ? AND kind = ? AND ${column} = ? AND ${OPEN}`, userId, kind, id);

  // The page in one request: the three lists, what was ticked in the last seven days, and the counts.
  api.get('/todos', agencyOnly, (req, res) => {
    catchUp();
    res.json(listsOf(req.user.id));
  });

  // The picker beside "Jobs to work on": every open job, with a search box and a client filter.
  api.get('/todos/jobs', agencyOnly, (req, res) => {
    const where = [`j.status = 'open'`], p = [req.user.id];
    if (int(req.query.client_id)) { where.push('j.client_id = ?'); p.push(int(req.query.client_id)); }
    if (clean(req.query.q)) {
      where.push('(j.title LIKE ? OR cl.name LIKE ?)');
      const like = `%${clean(req.query.q, 100)}%`;
      p.push(like, like);
    }
    res.json(q.all(
      `SELECT j.id, j.title, j.opened_at, j.client_id, cl.name AS client_name, cl.brand_color,
         (SELECT COUNT(*) FROM applications a WHERE a.job_id = j.id AND a.status = 'active') AS in_pipeline,
         EXISTS (SELECT 1 FROM todos t WHERE t.user_id = ? AND t.kind = 'job' AND t.job_id = j.id AND t.done_at IS NULL AND t.removed_at IS NULL) AS on_list
       FROM jobs j JOIN clients cl ON cl.id = j.client_id WHERE ${where.join(' AND ')} ORDER BY cl.name, j.title, j.id`, ...p)
      .map((j) => ({ ...j, on_list: Boolean(j.on_list) })));
  });

  // The picker beside the two people lists: candidates in an interview stage of an open job, the signed-in person's
  // own unless ?whose=all. A search (?q=) finds any candidate by name, whoever owns them and wherever they stand.
  api.get('/todos/people', agencyOnly, (req, res) => {
    const t = stamp();
    const name = clean(req.query.q, 100);
    const where = [], p = [t, t, req.user.id, req.user.id];
    if (name) { where.push('c.name LIKE ?'); p.push(`%${name}%`); }
    else {
      where.push(`a.status = 'active' AND s.kind = 'interview' AND j.status = 'open'`);
      if (req.query.whose !== 'all') { where.push('a.owner_id = ?'); p.push(req.user.id); }
    }
    const onMine = (kind) => `EXISTS (SELECT 1 FROM todos t WHERE t.user_id = ? AND t.kind = '${kind}' AND t.application_id = a.id AND t.done_at IS NULL AND t.removed_at IS NULL)`;
    res.json(q.all(
      `SELECT a.id AS application_id, a.status, ou.name AS owner_name, c.id AS candidate_id, c.name, substr(c.photo_file, 1, 8) AS photo,
         j.id AS job_id, j.title AS job_title, cl.name AS client_name, cl.brand_color, s.name AS stage_name, s.kind AS stage_kind,
         (SELECT MIN(i.starts_at) FROM interviews i WHERE i.application_id = a.id AND i.status = 'scheduled' AND i.starts_at >= ?) AS next_interview,
         (SELECT MAX(i.starts_at) FROM interviews i WHERE i.application_id = a.id AND i.status != 'cancelled' AND i.starts_at < ?) AS last_interview,
         ${onMine('prep')} AS on_prep, ${onMine('debrief')} AS on_debrief
       FROM applications a JOIN candidates c ON c.id = a.candidate_id JOIN jobs j ON j.id = a.job_id JOIN clients cl ON cl.id = j.client_id
       JOIN stages s ON s.id = a.stage_id LEFT JOIN users ou ON ou.id = a.owner_id
       WHERE ${where.join(' AND ')}
       ORDER BY ${name ? `a.status = 'active' DESC,` : ''} next_interview IS NULL, next_interview, c.name, a.id LIMIT ${name ? 50 : 200}`, ...p)
      .map((r) => ({ ...r, on_prep: Boolean(r.on_prep), on_debrief: Boolean(r.on_debrief) })));
  });

  // Put a job, or a person to prep or debrief, on the signed-in person's list: at a place when one is given (it
  // was dragged in), otherwise at the end.
  api.post('/todos', agencyOnly, (req, res) => {
    const b = req.body || {};
    if (!KINDS.includes(b.kind)) bad('Say which list this goes on.');
    const id = tx(() => {
      let about;
      if (b.kind === 'job') {
        const job = q.get('SELECT id, title FROM jobs WHERE id = ?', int(b.job_id));
        if (!job) bad('That job is no longer in The Book.', 404);
        if (onList(req.user.id, 'job', 'job_id', job.id)) bad(`${job.title} is already on your list.`, 409);
        about = { jobId: job.id };
      } else {
        const app = q.get('SELECT a.id, c.name FROM applications a JOIN candidates c ON c.id = a.candidate_id WHERE a.id = ?', int(b.application_id));
        if (!app) bad('That candidate is no longer in The Book.', 404);
        if (onList(req.user.id, b.kind, 'application_id', app.id)) bad(`${app.name} is already on this list.`, 409);
        // Tied to the interview it is about when there is one, so that it follows that interview like the rest.
        const all = interviewsOf(app.id, clock().getTime());
        about = { applicationId: app.id, interviewId: (b.kind === 'prep' ? nextUp(all) : lastOver(all))?.id ?? null };
      }
      const made = insert({ userId: req.user.id, kind: b.kind, note: clean(b.note, NOTE_MAX), ...about });
      if (int(b.position) != null) place({ id: made, user_id: req.user.id, kind: b.kind }, int(b.position));
      return made;
    });
    res.json({ id });
  });

  // Change an item: its note, or whether it is done. Ticking a debrief can carry what the candidate said, which is
  // saved on their profile as an agency-only note so that it is not lost in a to-do list.
  api.patch('/todos/:id', agencyOnly, (req, res) => {
    const item = mine(req);
    const b = req.body || {};
    if (b.done !== undefined && typeof b.done !== 'boolean') bad('done must be true or false.');
    const noteId = tx(() => {
      if (b.note !== undefined) q.run('UPDATE todos SET note = ? WHERE id = ?', clean(b.note, NOTE_MAX), item.id);
      if (b.done === true && !item.done_at) {
        q.run('UPDATE todos SET done_at = ?, auto_done = 0 WHERE id = ?', stamp(), item.id);
        const said = item.kind === 'debrief' ? text(b.debrief, 10000) : null;
        if (!said) return null;
        const interview = interviewFor(item, clock().getTime());
        q.run('UPDATE applications SET updated_at = ? WHERE id = ?', now(), item.application_id);
        return q.insert('INSERT INTO notes (application_id, user_id, body, private, created_at) VALUES (?, ?, ?, 1, ?)',
          item.application_id, req.user.id, `${interview ? `Debrief after ${interview.title}` : 'Debrief'}:\n${said}`, now());
      }
      if (b.done === false && item.done_at) {
        if (onList(req.user.id, item.kind, item.kind === 'job' ? 'job_id' : 'application_id', item.job_id ?? item.application_id)) {
          bad(item.kind === 'job' ? 'This job is already on your list again.' : 'This person is already on this list again.', 409);
        }
        q.run('UPDATE todos SET done_at = NULL, auto_done = 0, position = ? WHERE id = ?', endOf(req.user.id, item.kind), item.id);
        // A prep for an interview that has been held (or cancelled) would be ticked again at once. Un-ticked by
        // hand, it is the person's own item from here on, with no interview behind it.
        const held = item.kind === 'prep' && item.interview_id ? interviewsOf(item.application_id, clock().getTime()).find((i) => i.id === item.interview_id) : null;
        if (held && (held.over || held.cancelled)) q.run('UPDATE todos SET interview_id = NULL, auto = 0 WHERE id = ?', item.id);
      }
      return null;
    });
    res.json({ ok: true, ...(noteId ? { note_id: noteId } : {}) });
  });

  // Move an item to a place among what is still to do on its own list. Prep and debrief are separate items, so
  // there is no moving from one to the other.
  api.post('/todos/:id/move', agencyOnly, (req, res) => {
    const item = mine(req);
    const position = int(req.body?.position);
    if (position == null || position < 0) bad('Say where in the list to move it to.');
    if (item.done_at) bad('This is already done. Un-tick it to put it back in the list.');
    tx(() => place(item, position));
    res.json({ ok: true });
  });

  // Take an item off the list. The row stays, marked as removed, so that The Book does not put it back by itself.
  api.delete('/todos/:id', agencyOnly, (req, res) => {
    const item = mine(req);
    q.run('UPDATE todos SET removed_at = ? WHERE id = ?', stamp(), item.id);
    res.json({ ok: true });
  });
}
