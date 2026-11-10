// Metaview in The Oracle: the conversations the agency records in Metaview, listed in The Book, matched to the
// candidates they were with, and brought in as calls.
//
// How it works:
//   1. An admin enters a Metaview key (or the host sets METAVIEW_API_KEY). The key is tried against Metaview
//      before it is kept, and kept sealed with the server's secret (secret.js). No route ever returns it.
//   2. In the background The Book reads Metaview's list of conversations: the newest page every ten minutes, and,
//      the first time, back through the whole history a page at a time with a pause between pages. How far it got
//      is kept in the database, so a restart carries on from there. Only what is needed to list a conversation and
//      to work out who it was with is remembered (metaview_calls): no transcripts and no notes. Once a week the
//      whole list is read again, which is how a conversation deleted in Metaview leaves The Book's list.
//   3. Each conversation is matched to a candidate: by a participant's e-mail address, then by phone number, then
//      by exact full name. Anything weaker is only offered (see match.js).
//   4. Bringing a conversation in fetches its transcript and Metaview's notes, once, and makes it a call in The
//      Oracle (oracle.js), on the candidate. A person does this by opening it. With "auto" on, recent conversations
//      that an address or a number ties to exactly one candidate are brought in with nobody clicking, up to a
//      daily limit.
//
// The Book only reads from Metaview: nothing here changes anything there. A failure or a refusal is written down
// as a sentence for the status, and tried again later; it never stops the rest of The Book.
// Everything here is for the agency only: client users are refused on every route.
import { q, now, tx, getSetting, setSetting } from './db.js';
import { seal, unseal } from './secret.js';
import { fold, nameTokens, phoneTail, matchConversations, chosenMatch } from './match.js';
import { MetaviewError, whoAmI, listConversations, oneConversation, transcriptTurns, onlyANumber } from './metaview-client.js';
import { addOutsideCall, fillOutsideCall, putCallOn, whenNotesAwaited, UNTITLED } from './oracle.js';

// ---------- timings and limits ----------
const MINUTE = 60000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const setting = (name, fallback) => (Number(process.env[name]) > 0 ? Number(process.env[name]) : fallback);
const POLL = setting('METAVIEW_POLL_MS', 10 * MINUTE);            // how often the newest conversations are looked for
const PAGE_PAUSE = setting('METAVIEW_PAGE_PAUSE_MS', 3000);       // the pause between two pages of history, and between two calls brought in unasked
const START_DELAY = setting('METAVIEW_START_MS', 5000);           // after the server starts, before the first look
const BACKOFF = setting('METAVIEW_BACKOFF_MS', 30000);            // the first pause after a failure; doubled each time, up to POLL
// Metaview writes a conversation's notes when they are first asked for, which takes about half a minute. They are
// asked for again after each of these pauses, and after the last one the call says that there are none.
const NOTES_WAITS = [30000, 30000, 60000, 2 * MINUTE, 5 * MINUTE].map((ms) => Math.round(ms * setting('METAVIEW_NOTES_PACE', 1)));
const REWALK = setting('METAVIEW_REWALK_MS', 7 * DAY);            // how often the whole list is read again from the top
const AUTO_DAYS = 14;                                             // only conversations this recent are brought in unasked
const AUTO_PER_DAY = setting('METAVIEW_AUTO_PER_DAY', 50);        // so a mistake cannot bring in hundreds
const AUTO_AT_ONCE = 3;                                           // between looks at what else is due
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const json = (value, fallback) => { try { return JSON.parse(value) ?? fallback; } catch { return fallback; } };

const NO_TRANSCRIPT = 'Metaview has no transcript for this conversation yet. If one is written later, The Book brings it in by itself.';
const NO_NOTES = 'Metaview has not written notes for this conversation. You can have them written here, or write your own.';
const RECORDED_IN_METAVIEW = 'This conversation was recorded in Metaview, not in The Book. The Book brought in its transcript and notes.';
const TROUBLE = 'The Book could not read Metaview just now. It will try again by itself in a few minutes.';
const LOST_KEY = 'The Metaview key saved here can no longer be read. Enter it again.';

// ---------- the key and what is known about the connection ----------
const KEY_PURPOSE = 'metaview-key';
const forget = (...names) => { for (const name of names) q.run('DELETE FROM settings WHERE key = ?', `metaview_${name}`); };
/** The key in use and where it comes from: one an admin entered wins over one set where The Book is hosted. */
function currentKey() {
  const sealed = getSetting('metaview_key');
  const saved = sealed ? unseal(sealed, KEY_PURPOSE) : null;
  if (saved) return { key: saved, source: 'settings' };
  const fromServer = (process.env.METAVIEW_API_KEY || '').trim();
  if (fromServer) return { key: fromServer, source: 'server' };
  return { key: null, source: null, lost: Boolean(sealed) };
}
const autoOn = () => getSetting('metaview_auto', '1') !== '0';
const historyDone = () => getSetting('metaview_history_done') === '1';

function statusFor(user) {
  const { key, source, lost } = currentKey();
  const counts = q.get('SELECT COUNT(*) AS known, COUNT(call_id) AS in_the_book FROM metaview_calls');
  return {
    connected: Boolean(key), workspace: key ? getSetting('metaview_workspace') || null : null, source, can_manage: user.role === 'admin',
    last_checked_at: key ? getSetting('metaview_checked_at') : null, known: counts.known, in_the_book: counts.in_the_book,
    catching_up: Boolean(key) && !historyDone(), error: key ? getSetting('metaview_error') : lost ? LOST_KEY : null, auto: autoOn(),
    // How many conversations Metaview says it has in all, so the screens can say "600 of about 2,100 so far" while
    // the history is read. Null until Metaview has said.
    total: key ? Number(getSetting('metaview_total')) || null : null,
  };
}

/** Forget every conversation that was never brought in, and how far the history had been read. Calls in The Oracle stay, with their link to Metaview. */
function forgetUnbrought() {
  q.run('DELETE FROM metaview_calls WHERE call_id IS NULL');
  q.run('UPDATE metaview_calls SET fetch_next_at = NULL, fetch_tries = 0');
  forget('history_offset', 'history_done', 'walked_at', 'walk_started_at', 'walk_offset', 'total');
}
/** Keep how many conversations Metaview says there are in all, when a page of the whole list says so. */
const noteTotal = (page) => { if (page.total != null) setSetting('metaview_total', String(page.total)); };
/** Keep what Metaview says about whose key this is. A key for a different workspace starts the list afresh: what was listed belonged to the other one. */
function noteWorkspace(who) {
  const before = getSetting('metaview_org');
  if (before && who.organization && before !== who.organization) forgetUnbrought();
  setSetting('metaview_org', who.organization ?? '');
  setSetting('metaview_workspace', who.workspace ?? '');
}

// ---------- what The Book remembers about a conversation ----------
/** The people on a conversation who might be the candidate: the ones Metaview calls candidates, or, when it names none, everybody who is not an interviewer. */
function otherSide(people) {
  const candidates = people.filter((p) => p.role === 'candidate');
  return candidates.length ? candidates : people.filter((p) => p.role === 'other');
}
/** What a remembered conversation is matched by, in the shape match.js reads. */
const evidenceOf = (row) => {
  const others = otherSide(json(row.people, []));
  // A phone number standing where a name would be says nothing about what the person is called.
  return { key: row.id, emails: others.flatMap((p) => p.emails || []), phones: others.flatMap((p) => p.phones || []), names: others.map((p) => p.name).filter((name) => name && !onlyANumber(name)) };
};
const nameOfOther = (people) => otherSide(people).find((p) => p.name)?.name || null;

/**
 * Keep what a page of Metaview's list says: new conversations are added, and ones already known are brought up to
 * date (a corrected name, a transcript that has arrived since). Resolves to how many were new.
 */
function remember(conversations) {
  return tx(() => {
    let fresh = 0;
    for (const c of conversations) {
      const people = JSON.stringify(c.people);
      const others = otherSide(c.people);
      const search = fold([c.title, ...c.people.flatMap((p) => [p.name, ...p.emails, ...p.phones.map((n) => n.replace(/\D/g, ''))])].filter(Boolean).join(' ')).slice(0, 4000);
      const known = q.get('SELECT people, has_transcript, call_id FROM metaview_calls WHERE id = ?', c.id);
      if (!known) {
        fresh++;
        q.run(`INSERT INTO metaview_calls (id, url, started_at, title, kind, channel, minutes, language, has_transcript, people, search, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          c.id, c.url, c.startedAt, c.title || null, c.kind || null, c.channel || null, c.minutes, c.language || null, c.hasTranscript ? 1 : 0, people, search, now());
      } else {
        q.run(`UPDATE metaview_calls SET url = ?, started_at = ?, title = ?, kind = ?, channel = ?, minutes = ?, language = ?, has_transcript = ?, people = ?, search = ?, seen_at = ? WHERE id = ?`,
          c.url, c.startedAt, c.title || null, c.kind || null, c.channel || null, c.minutes, c.language || null, c.hasTranscript ? 1 : 0, people, search, now(), c.id);
        // A call that was brought in before Metaview had written it out: its transcript is fetched now that there is one.
        if (known.call_id && !known.has_transcript && c.hasTranscript && q.get('SELECT 1 AS x FROM calls WHERE id = ? AND transcript IS NULL', known.call_id)) {
          q.run('UPDATE metaview_calls SET fetch_next_at = ?, fetch_tries = 0 WHERE id = ?', now(), c.id);
        }
        if (known.people === people) continue;
        q.run('DELETE FROM metaview_people WHERE call_id = ?', c.id);
      }
      // The facts the look-ups run on (see db.js): one row each.
      const add = (kind, value, first = null, last = null) => q.run('INSERT INTO metaview_people (call_id, kind, value, first, last) VALUES (?, ?, ?, ?, ?)', c.id, kind, value, first, last);
      for (const p of others) {
        for (const email of p.emails) add('email', email);
        for (const tail of new Set(p.phones.map(phoneTail).filter(Boolean))) add('phone', tail);
        const words = onlyANumber(p.name) ? [] : nameTokens(p.name);
        if (words.length) add('name', words.join(' '), words[0], words.length > 1 ? words.at(-1) : '');
      }
      for (const p of c.people) if (p.role === 'interviewer') for (const email of p.emails) add('interviewer', email);
    }
    return fresh;
  });
}

// ---------- bringing a conversation into The Oracle ----------
const rowOf = (id) => q.get('SELECT * FROM metaview_calls WHERE id = ?', id) ?? null;
/** The call in The Oracle that a conversation already is, if it is still there. */
const callOf = (id) => q.get('SELECT k.id FROM metaview_calls m JOIN calls k ON k.id = m.call_id WHERE m.id = ?', id)?.id ?? null;
/** Whose call it is in The Book: an interviewer who has a login here, else whoever opened it, else the first admin. */
function ownerOf(people, openedBy) {
  for (const email of people.filter((p) => p.role === 'interviewer').flatMap((p) => p.emails)) {
    const user = q.get(`SELECT id FROM users WHERE lower(email) = ? AND role != 'client' AND active = 1 AND pending = 0`, email);
    if (user) return user.id;
  }
  return openedBy ?? q.get(`SELECT id FROM users WHERE role = 'admin' AND active = 1 ORDER BY id LIMIT 1`)?.id ?? null;
}

class Gone extends Error {}
/**
 * Fetch one conversation's transcript and notes and keep it as a call. `applicationId` is the candidate a person
 * chose; without one it goes on the candidate it certainly was with, if there is one. `unasked` is the background
 * bringing calls in by itself: it only does so while an address or a number still points at exactly one candidate.
 * Resolves to the call's id, or to null when `unasked` found nothing certain.
 */
async function fetchAndKeep(id, key, { applicationId = null, userId = null, unasked = false }) {
  const got = await oneConversation(key, id, { urgent: !unasked });
  if (!got) {
    q.run('DELETE FROM metaview_calls WHERE id = ? AND call_id IS NULL', id);
    throw new Gone();
  }
  remember([got.conversation]);
  const row = rowOf(id);
  const people = json(row.people, []);
  let onto = applicationId;
  if (!onto) {
    const found = matchConversations([evidenceOf(row)], { suggestions: false }).get(id);
    if (unasked && !found?.sure) return null;
    onto = found?.match?.application_id ?? null;
  }
  const { turns, speakers } = transcriptTurns(got.transcript);
  const lengthMs = row.minutes > 0 ? row.minutes * MINUTE : turns.length ? Math.round(Math.max(...turns.map((turn) => turn.end)) * 1000) : null;
  const owner = ownerOf(people, userId);
  // Notes Metaview has not finished writing are asked for again shortly (see fetchOwed), and so is a transcript it
  // says it has but did not send. With no transcript at all there is nothing for it to write notes from.
  const owed = (turns.length ? !got.notes : row.has_transcript) ? new Date(Date.now() + NOTES_WAITS[0]).toISOString() : null;
  const callId = addOutsideCall({
    source: 'metaview', where: 'Metaview', title: row.title, withName: nameOfOther(people), turns, speakers, notes: got.notes, noTranscript: NO_TRANSCRIPT,
    durationMs: lengthMs, externalUrl: row.url, tookPlaceAt: row.started_at, wording: RECORDED_IN_METAVIEW, createdBy: owner, addedBy: userId ?? owner, applicationId: onto,
    then: (newId) => q.run('UPDATE metaview_calls SET call_id = ?, brought_in_at = COALESCE(brought_in_at, ?), auto_at = ?, fetch_tries = 0, fetch_next_at = ? WHERE id = ?',
      newId, now(), unasked ? now() : row.auto_at, owed, id),
  });
  if (owed) wake(NOTES_WAITS[0]);
  return callId;
}

// Opening the same conversation twice at once must give one call, so the second waits for the first.
const opening = new Map();
async function bringIn(id, key, options) {
  while (opening.has(id)) await opening.get(id).catch(() => {});
  const already = callOf(id);
  if (already) {
    if (options.applicationId) putCallOn(already, options.applicationId, options.userId);
    return already;
  }
  const work = fetchAndKeep(id, key, options);
  opening.set(id, work);
  try { return await work; } finally { opening.delete(id); }
}

// ---------- the background work ----------
/** Read the newest page of the list, and carry on down while everything on a page is new (more than a page arrived since the last look). */
async function readNewest(key) {
  for (let offset = 0, pages = 0; pages < 100; pages++) {
    const page = await listConversations(key, { offset });
    const fresh = remember(page.conversations);
    noteTotal(page);
    setSetting('metaview_checked_at', now());
    offset += page.received;
    // The first look at a workspace is also the first page of its history.
    if (!historyDone() && !Number(getSetting('metaview_history_offset', '0'))) setSetting('metaview_history_offset', String(offset));
    if (!page.more) {
      if (pages === 0) setSetting('metaview_history_done', '1');   // the whole list fitted on one page
      break;
    }
    if (!historyDone() || fresh < page.conversations.length || !page.received) break;
    await sleep(PAGE_PAUSE);
  }
}
/** Read one more page of the history, from where the last one stopped. */
async function readHistoryPage(key) {
  const offset = Number(getSetting('metaview_history_offset', '0')) || 0;
  const page = await listConversations(key, { offset });
  remember(page.conversations);
  noteTotal(page);
  setSetting('metaview_checked_at', now());
  tx(() => {
    setSetting('metaview_history_offset', String(offset + page.received));
    if (!page.more || !page.received) setSetting('metaview_history_done', '1');
  });
}

/**
 * Once a week the whole list is read again, a page a round like the first time. That brings older conversations up
 * to date, and it is how one that was deleted in Metaview leaves The Book's list: whatever the reading did not come
 * across is asked for by its number, and what Metaview no longer has is forgotten. Only conversations that were
 * never brought in are forgotten this way; a call in The Oracle is The Book's own and stays.
 * Resolves to true while the reading is under way.
 */
async function readAgain(key) {
  const startedAt = getSetting('metaview_walk_started_at');
  if (!startedAt) {
    const last = getSetting('metaview_walked_at');
    if (!last) setSetting('metaview_walked_at', now());   // the first reading of the history has only just finished
    if (!last || Date.now() - Date.parse(last) < REWALK) return false;
    tx(() => { setSetting('metaview_walk_started_at', now()); setSetting('metaview_walk_offset', '0'); });
    return true;
  }
  const offset = Number(getSetting('metaview_walk_offset', '0')) || 0;
  const page = await listConversations(key, { offset });
  remember(page.conversations);
  if (page.more && page.received) {
    setSetting('metaview_walk_offset', String(offset + page.received));
    return true;
  }
  // The end of the list. What was not seen on the way down may have been missed (the list moves while it is read),
  // so each is asked for by name before it is believed to be gone. A thousand at most in one go.
  const missed = q.all('SELECT id FROM metaview_calls WHERE seen_at < ? AND call_id IS NULL AND brought_in_at IS NULL ORDER BY id LIMIT 1000', startedAt).map((row) => row.id);
  for (let i = 0; i < missed.length; i += 50) {
    const some = missed.slice(i, i + 50);
    if (i) await sleep(PAGE_PAUSE);
    remember((await listConversations(key, { ids: some })).conversations);
    q.run(`DELETE FROM metaview_calls WHERE seen_at < ? AND call_id IS NULL AND brought_in_at IS NULL AND id IN (${some.join(',')})`, startedAt);
  }
  tx(() => { setSetting('metaview_walked_at', now()); forget('walk_started_at', 'walk_offset'); });
  return false;
}

/**
 * Fetch what is still owed to calls already in The Oracle: notes Metaview had not finished writing, and transcripts
 * that arrived after the call was brought in. A few at a time. Each conversation is asked for a limited number of
 * times, so one that Metaview cannot answer for never holds up the rest.
 */
async function fetchOwed(key) {
  const due = q.all('SELECT id, call_id, fetch_tries FROM metaview_calls WHERE fetch_next_at IS NOT NULL AND fetch_next_at <= ? ORDER BY fetch_next_at LIMIT 3', now());
  for (const row of due) {
    const state = () => (row.call_id ? q.get('SELECT transcript IS NOT NULL AS has_transcript, notes IS NOT NULL AS has_notes FROM calls WHERE id = ?', row.call_id) : null);
    const settle = (nextAt, tries) => q.run('UPDATE metaview_calls SET fetch_next_at = ?, fetch_tries = ? WHERE id = ?', nextAt, tries, row.id);
    const tries = row.fetch_tries + 1;
    /** Ask again after the next pause. After the last one, stop, and say on the call why it has no notes (when it has a transcript they could have been written from). */
    const later = (hasTranscript) => {
      if (tries < NOTES_WAITS.length) return settle(new Date(Date.now() + NOTES_WAITS[tries]).toISOString(), tries);
      if (hasTranscript) fillOutsideCall(row.call_id, { where: 'Metaview', notesProblem: NO_NOTES });
      settle(null, 0);
    };
    const before = state();
    if (!before || (before.has_transcript && before.has_notes)) { settle(null, 0); continue; }   // the call is gone, or somebody has written what was missing
    let got;
    try {
      got = await oneConversation(key, row.id);
    } catch (err) {
      later(before.has_transcript);
      throw err;
    }
    if (!got) { later(before.has_transcript); continue; }   // Metaview does not have it just now, or any more
    remember([got.conversation]);
    const { turns, speakers } = transcriptTurns(got.transcript);
    fillOutsideCall(row.call_id, { where: 'Metaview', turns, speakers, notes: got.notes });
    const after = state();
    if (!after || after.has_notes) settle(null, 0);
    else if (after.has_transcript || got.conversation.hasTranscript) later(after.has_transcript);   // notes still being written, or a transcript Metaview says it has and did not send
    else settle(null, 0);   // still no transcript: the day one arrives is noticed when the list is next read
  }
}
/** When the next thing owed falls due, in milliseconds from now; null when nothing is owed. */
function nextOwedIn() {
  const next = q.get('SELECT MIN(fetch_next_at) AS at FROM metaview_calls WHERE fetch_next_at IS NOT NULL')?.at;
  return next ? Math.max(0, Date.parse(next) - Date.now()) : null;
}

/**
 * Bring in, with nobody clicking, recent conversations that an address or a number ties to exactly one candidate.
 * Never one that was brought in before (somebody may have deleted it on purpose), never more than the daily limit.
 * Resolves to true when there may be more to do.
 */
async function bringInUnasked(key) {
  if (!autoOn()) return false;
  const room = AUTO_PER_DAY - q.get('SELECT COUNT(*) AS n FROM metaview_calls WHERE auto_at > ?', new Date(Date.now() - DAY).toISOString()).n;
  if (room <= 0) return false;
  const waiting = q.all(
    `SELECT * FROM metaview_calls WHERE call_id IS NULL AND brought_in_at IS NULL AND has_transcript = 1 AND fetch_tries < 3 AND started_at >= ?
     ORDER BY started_at DESC LIMIT 300`, new Date(Date.now() - AUTO_DAYS * DAY).toISOString());
  if (!waiting.length) return false;
  const found = matchConversations(waiting.map(evidenceOf), { suggestions: false });
  const certain = waiting.filter((row) => found.get(row.id)?.sure);
  const batch = certain.slice(0, Math.min(room, AUTO_AT_ONCE));
  for (const [i, row] of batch.entries()) {
    if (i) await sleep(PAGE_PAUSE);
    try {
      await bringIn(row.id, key, { unasked: true });
    } catch (err) {
      if (err instanceof Gone) continue;
      // Counted, so a conversation Metaview cannot answer for is left to a person after a few tries.
      q.run('UPDATE metaview_calls SET fetch_tries = fetch_tries + 1 WHERE id = ? AND call_id IS NULL', row.id);
      throw err;
    }
  }
  return certain.length > batch.length && room > batch.length;
}

let checkedKey = null;      // the key Metaview has accepted since this server started
let lastLook = 0;           // when the newest page was last read
let lookAsked = false;      // somebody pressed "refresh"
let failures = 0;
/** One round of background work. Resolves to how long to wait before the next, or to null when there is no key to work with. */
async function round() {
  const { key } = currentKey();
  if (!key) return null;
  if (checkedKey !== key) {
    noteWorkspace(await whoAmI(key));
    checkedKey = key;
  }
  if (lookAsked || Date.now() - lastLook >= POLL) {
    lookAsked = false;
    await readNewest(key);
    lastLook = Date.now();
  }
  await fetchOwed(key);
  const moreToBring = await bringInUnasked(key);
  if (!historyDone()) await readHistoryPage(key);
  const readingAgain = historyDone() && await readAgain(key);
  if (moreToBring || !historyDone() || readingAgain) return PAGE_PAUSE;
  return Math.max(1000, Math.min(lastLook + POLL - Date.now(), nextOwedIn() ?? POLL));
}

/** Write down what went wrong, for the status and (without anything private) the log. Resolves to how long to wait before trying again. */
function noteProblem(err) {
  const known = err instanceof MetaviewError;
  console.error(`Metaview: ${known ? `${err.kind}${err.status ? ` (${err.status})` : ''}${err.detail ? `, ${err.detail}` : ''}` : `reading failed: ${err?.message ?? err}`}`);
  setSetting('metaview_error', known ? err.message : TROUBLE);
  if (known && err.kind === 'key') checkedKey = null;
  return known && err.kind === 'key' ? POLL : Math.min(POLL, BACKOFF * 2 ** Math.min(failures++, 10));
}

let timer = null, dueAt = 0, running = false, again = false;
/** Have the background work run after `delay` milliseconds, unless it is already due sooner. */
function wake(delay = 0) {
  const at = Date.now() + delay;
  if (timer && dueAt <= at) return;
  clearTimeout(timer);
  dueAt = at;
  timer = setTimeout(() => { timer = null; run(); }, delay);
  timer.unref();
}
async function run() {
  if (running) { again = true; return; }
  running = true;
  let wait = null;
  try {
    wait = await round();
    failures = 0;
    forget('error');
  } catch (err) {
    // The database may be closing as the server stops: then there is nothing left to do, and nothing to say.
    try { wait = noteProblem(err); } catch { wait = null; }
  } finally {
    running = false;
  }
  if (again) { again = false; wait = 0; }
  if (wait != null) wake(wait);
}

// ---------- the routes ----------
export function registerMetaview(api, { agencyOnly, adminOnly, bad, clean, int, takeHit }) {
  whenNotesAwaited((callId) => q.get('SELECT 1 AS x FROM metaview_calls WHERE call_id = ? AND fetch_next_at IS NOT NULL', callId));
  if (currentKey().key) wake(START_DELAY);

  const limit = (name, user, max) => { if (!takeHit(`metaview-${name}:${user.id}`, max, HOUR)) bad('That is a lot in one hour. Try again a little later.', 429); };
  /** Refuse with the sentence for what went wrong at Metaview, and keep it for the status. */
  const metaviewSaid = (err, status = 502) => {
    if (!(err instanceof MetaviewError)) throw err;
    try { noteProblem(err); } catch { /* the refusal below still says it */ }
    bad(err.message, status);
  };

  api.get('/metaview/status', agencyOnly, (req, res) => res.json(statusFor(req.user)));

  // Enter or replace the key. It is tried first: a key Metaview refuses is never kept.
  api.put('/metaview/key', agencyOnly, adminOnly, async (req, res) => {
    const typed = typeof req.body?.key === 'string' ? req.body.key.trim().replace(/^Bearer\s+/i, '') : '';
    if (!typed) bad('Paste the key from Metaview first.');
    if (typed.length < 8 || typed.length > 500 || !/^[\x21-\x7e]+$/.test(typed)) bad('That does not look like a Metaview key. Copy it again from Metaview (Settings, Integrations, MCP).');
    limit('key', req.user, 20);
    const who = await whoAmI(typed, { urgent: true }).catch((err) => (err instanceof MetaviewError ? bad(err.message, err.kind === 'key' ? 400 : 502) : Promise.reject(err)));
    tx(() => {
      noteWorkspace(who);
      setSetting('metaview_key', seal(typed, KEY_PURPOSE));
      setSetting('metaview_checked_at', now());
      forget('error');
    });
    checkedKey = typed;
    failures = 0;
    lookAsked = true;
    wake(0);
    res.json(statusFor(req.user));
  });

  // Forget the key, and with it everything remembered about conversations that were never brought in.
  api.delete('/metaview/key', agencyOnly, adminOnly, (req, res) => {
    if (!getSetting('metaview_key') && currentKey().source === 'server') {
      bad('This key is set where The Book is hosted (METAVIEW_API_KEY), so it cannot be removed here. Remove that setting there.', 409);
    }
    tx(() => {
      forget('key', 'workspace', 'org', 'checked_at', 'error');
      forgetUnbrought();
    });
    checkedKey = null;
    if (currentKey().key) wake(0);   // a key set where The Book is hosted is still there, and takes over
    res.json({ ok: true });
  });

  api.put('/metaview/settings', agencyOnly, adminOnly, (req, res) => {
    if (typeof req.body?.auto !== 'boolean') bad('Say whether calls are brought in by themselves: auto must be true or false.');
    setSetting('metaview_auto', req.body.auto ? '1' : '0');
    if (req.body.auto && currentKey().key) wake(0);
    res.json(statusFor(req.user));
  });

  // Look for new conversations now, without waiting for the next ten minutes to pass.
  api.post('/metaview/refresh', agencyOnly, (req, res) => {
    if (!currentKey().key) bad('Metaview is not connected yet. An admin can connect it with a key from Metaview.', 409);
    limit('refresh', req.user, 60);
    lookAsked = true;
    wake(0);
    res.status(202).json({ ok: true });
  });

  /** A remembered conversation as the list gives it. Addresses and numbers stay on the server: only names and roles go out. */
  function shape(row, found) {
    const people = json(row.people, []);
    const computed = found.get(row.id) ?? { match: null, suggestions: [] };
    let match = computed.match, suggestions = computed.suggestions;
    if (row.call_id) {
      // Once a conversation is a call in The Oracle, who that call is on is the answer, whoever put it there.
      const onto = row.on_application ?? (row.on_candidate
        ? q.get(`SELECT id FROM applications WHERE candidate_id = ? ORDER BY status = 'active' DESC, updated_at DESC LIMIT 1`, row.on_candidate)?.id : null);
      match = onto ? chosenMatch(onto, computed.match?.candidate_id === row.on_candidate ? computed.match.how : 'chosen') : null;
      suggestions = [computed.match, ...computed.suggestions].filter(Boolean).slice(0, 5);
    }
    const name = nameOfOther(people);
    return {
      id: row.id, url: row.url, started_at: row.started_at, title: row.title || (name ? `Call with ${name}` : UNTITLED), kind: row.kind, channel: row.channel, minutes: row.minutes,
      people: people.filter((p) => p.name).map((p) => ({ name: p.name, role: p.role })), has_transcript: Boolean(row.has_transcript), call_id: row.call_id,
      match, suggestions: match ? [] : suggestions,
    };
  }

  api.get('/metaview/calls', agencyOnly, (req, res) => {
    const { who = 'everyone', show = 'all' } = req.query;
    if (!['mine', 'everyone'].includes(who)) bad('Whose calls to list is "mine" or "everyone".');
    if (!['all', 'new', 'unmatched'].includes(show)) bad('Which calls to list is "all", "new" or "unmatched".');
    const size = Math.min(100, Math.max(1, int(req.query.limit) ?? 30)), offset = Math.max(0, int(req.query.offset) ?? 0);
    const where = [], p = [];
    // The search box: every word typed has to be somewhere in the names, addresses, numbers or title. Something
    // typed like a phone number is looked for by its digits, however it was punctuated.
    const typed = fold(clean(req.query.q, 100) ?? '');
    const digits = typed.replace(/\D/g, '');
    const words = /^[\d\s().+-]+$/.test(typed) && digits.length >= 3 ? [digits] : typed.split(/\s+/).filter(Boolean).slice(0, 6);
    for (const word of words) { where.push(`m.search LIKE ? ESCAPE '\\'`); p.push(`%${word.replace(/[\\%_]/g, '\\$&')}%`); }
    if (who === 'mine') { where.push(`m.id IN (SELECT call_id FROM metaview_people WHERE kind = 'interviewer' AND value = ?)`); p.push(String(req.user.email).toLowerCase()); }
    if (show === 'new') where.push('m.call_id IS NULL');

    // One candidate's conversations: the ones their address, their number or their exact full name is on, and the
    // ones somebody has put on them by hand.
    let candidate = null;
    if (req.query.candidate_id !== undefined) {
      candidate = q.get('SELECT id, name, lower(email) AS email, phone FROM candidates WHERE id = ?', int(req.query.candidate_id)) ?? bad('That candidate was not found. They may have been removed.', 404);
      const facts = [`m.call_id IN (SELECT id FROM calls WHERE candidate_id = ?)`], values = [candidate.id];
      const add = (kind, value) => { if (value) { facts.push(`m.id IN (SELECT call_id FROM metaview_people WHERE kind = '${kind}' AND value = ?)`); values.push(value); } };
      add('email', candidate.email);
      add('phone', phoneTail(candidate.phone));
      add('name', nameTokens(candidate.name).length > 1 ? nameTokens(candidate.name).join(' ') : null);
      where.push(`(${facts.join(' OR ')})`); p.push(...values);
    }
    const from = `FROM metaview_calls m LEFT JOIN calls k ON k.id = m.call_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
    const select = `SELECT m.*, k.application_id AS on_application, k.candidate_id AS on_candidate ${from} ORDER BY m.started_at DESC, m.id DESC`;

    let total, page;
    if (candidate || show === 'unmatched') {
      // Whether a conversation has a match is worked out here, not stored, so it is always true of the candidates
      // on file now. That means looking at every conversation the other filters leave, which stays quick because
      // the look-ups go through indexes.
      const rows = q.all(select, ...p);
      const found = matchConversations(rows.filter((row) => !row.call_id).map(evidenceOf), { suggestions: false });
      const kept = rows.filter((row) => {
        const on = row.call_id ? row.on_candidate : found.get(row.id)?.match?.candidate_id ?? null;
        // For a candidate: theirs unless it is plainly somebody else's. A conversation nobody could be chosen for stays, because it may be theirs.
        if (candidate && on && on !== candidate.id) return false;
        return show !== 'unmatched' || !on;
      });
      total = kept.length;
      page = kept.slice(offset, offset + size);
    } else {
      total = q.get(`SELECT COUNT(*) AS n ${from}`, ...p).n;
      page = q.all(`${select} LIMIT ? OFFSET ?`, ...p, size, offset);
    }
    const found = matchConversations(page.map(evidenceOf));
    res.json({ total, calls: page.map((row) => shape(row, found)) });
  });

  // Open a conversation as a call in The Oracle, bringing it in first if it is not there yet.
  api.post('/metaview/calls/:id/open', agencyOnly, async (req, res) => {
    const id = int(req.params.id);
    if (!rowOf(id)) bad('This Metaview call was not found. It may be older than The Book has read so far.', 404);
    const given = req.body?.application_id;
    let applicationId = null;
    if (given !== undefined && given !== null && given !== '') {
      applicationId = int(given);
      if (!q.get('SELECT 1 AS x FROM applications WHERE id = ?', applicationId)) bad('That candidate was not found. They may have been removed.', 404);
    }
    const { key } = currentKey();
    if (!key && !callOf(id)) bad('Metaview is not connected, so this call cannot be brought in. An admin can connect it with a key from Metaview.', 409);
    limit('open', req.user, 240);
    const callId = await bringIn(id, key, { applicationId, userId: req.user.id }).catch((err) => {
      if (err instanceof Gone) bad('Metaview no longer has this conversation.', 404);
      return metaviewSaid(err);
    });
    res.json({ call_id: callId });
  });
}
