// Working out which candidate in The Book a conversation was with, from what is known about the people on it:
// their e-mail addresses, their phone numbers and their names.
//
// The rule throughout: never choose silently on weak evidence. An e-mail address or a phone number that belongs to
// a candidate is strong. A candidate's exact full name is strong too. A first name alone, or part of a name, is
// never enough: "Kevin" with two Kevins on file is a question for the recruiter, and even with one Kevin he is only
// offered, not chosen.
//
// Every look-up runs in the database through an index (see db.js), so the cost does not grow with the number of
// candidates on file. Names come from outside The Book, so only a fixed length of any name is ever read.
import { q, tx, PHONE_TAIL } from './db.js';

export const MAX_SUGGESTIONS = 5;

/** Text with accents and capitals removed, so "Kévin" and "kevin" are the same word. */
export const fold = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const TITLES = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'cpa', 'mba', 'phd', 'jr', 'sr']);

/** A person's name as plain words: "Tremblay, Kévin (Client)" gives ["kevin", "tremblay"]. Accents, case, brackets and titles are dropped. */
export function nameTokens(name) {
  let s = fold(String(name ?? '').slice(0, 200)).replace(/\([^)]*\)|\[[^\]]*\]/g, ' ');
  if (/^[^,]+,[^,]+$/.test(s)) { const [last, first] = s.split(','); s = `${first} ${last}`; }   // "Last, First"
  return s.replace(/[^a-z0-9' -]/g, ' ').split(/\s+/).filter((t) => t && !TITLES.has(t.replace(/\./g, '')));
}

/**
 * The last ten digits of a phone number, which is what two numbers are compared by: "+1 (647) 555-0199",
 * "647.555.0199" and "16475550199" are then the same number. Null for anything with fewer than ten digits, because
 * a short number says too little to tell people apart.
 */
export function phoneTail(number) {
  const digits = String(number ?? '').slice(0, 60).replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

const marks = (n) => Array(n).fill('?').join(', ');
/** Run a query once per hundred values, for lists too long to put in one statement comfortably. */
function inChunks(values, run) {
  const rows = [];
  for (let i = 0; i < values.length; i += 100) rows.push(...run(values.slice(i, i + 100)));
  return rows;
}

/**
 * Candidates' names are looked up through a table of their first and last word with accents removed (see db.js),
 * which the server fills in here for candidates who are new or have been renamed. A few thousand at a time, so that
 * catching up on a large workspace never holds the server for long. Resolves to how many were dealt with.
 */
export function catchUpNames(limit = 2000) {
  const waiting = q.all('SELECT d.candidate_id AS id, c.name FROM candidate_name_dirty d LEFT JOIN candidates c ON c.id = d.candidate_id LIMIT ?', limit);
  if (!waiting.length) return 0;
  tx(() => {
    for (const { id, name } of waiting) {
      if (name != null) {
        const words = nameTokens(name);
        q.run('INSERT INTO candidate_name_keys (candidate_id, first, last) VALUES (?, ?, ?) ON CONFLICT(candidate_id) DO UPDATE SET first = excluded.first, last = excluded.last',
          id, words[0] ?? '', words.length > 1 ? words.at(-1) : '');
      }
      q.run('DELETE FROM candidate_name_dirty WHERE candidate_id = ?', id);
    }
  });
  return waiting.length;
}
/** Bring the table of names fully up to date, however many candidates are waiting. */
function namesReady() {
  while (catchUpNames() > 0) { /* a few thousand at a time */ }
}

const CANDIDATE = `c.id, c.name, lower(c.email) AS email, c.phone, substr(c.photo_file, 1, 8) AS photo`;

/**
 * Decide, from the records each kind of evidence found, who a conversation was with.
 * @param found  { byEmail, byPhone, byName, partial }: candidate records ({ id, name, email, phone }) found by an
 *               e-mail address, by a phone number, by an exact full name, and by part of a name
 * @param best   candidate record -> their application for this purpose, or undefined when they have none
 * @returns {{ person, how, sure, offered }}
 *   person   the one record it certainly is, or null
 *   how      'email' | 'phone' | 'name': the evidence `person` or `offered` rests on
 *   sure     true when one record, and only one, was found by an address or a number. Only then may anything be
 *            done without a person looking
 *   offered  the records to offer when there is no certain one
 */
export function decide({ byEmail = [], byPhone = [], byName = [], partial = [] }, best) {
  const onePerson = (records, field) => new Set(records.map((c) => c[field])).size === 1;
  /**
   * `records` are believed to be one person. One record is a match. The same person filed under two clients is a
   * match only when exactly one of the records is still in progress; otherwise which record is meant is the
   * recruiter's call, and both are offered.
   */
  const settle = (records, how) => {
    const usable = records.filter(best);
    const live = usable.filter((c) => best(c).status === 'active');
    const one = usable.length === 1 ? usable[0] : live.length === 1 ? live[0] : null;
    return { person: one, how, sure: Boolean(one) && records.length === 1 && how !== 'name', offered: one ? [] : usable };
  };
  const offer = (records, how) => ({ person: null, how, sure: false, offered: records.filter(best) });
  if (byEmail.length) return onePerson(byEmail, 'email') ? settle(byEmail, 'email') : offer(byEmail, 'email');
  if (byPhone.length) return onePerson(byPhone, 'tail') ? settle(byPhone, 'phone') : offer(byPhone, 'phone');
  if (byName.length) {
    // Two records with one name are one person only if something else says so (the same address or number).
    const same = byName.length === 1 || (byName.every((c) => c.email) && onePerson(byName, 'email'))
      || (byName.every((c) => phoneTail(c.phone)) && new Set(byName.map((c) => phoneTail(c.phone))).size === 1);
    return same ? settle(byName, 'name') : offer(byName, 'name');
  }
  return offer(partial, 'name');
}

/**
 * Work out, for each conversation, the candidate it was with (`match`) or the people it might have been with
 * (`suggestions`).
 * @param conversations [{ key, emails, phones, names }]: what is known about the people on each who might be the
 *                      candidate. Never pass the agency's own side of a call.
 * @param options       { suggestions: false } skips the people who are only offered, for when all that matters is
 *                      whether there is a match
 * @returns Map key -> { match, suggestions, sure }. `match` and each suggestion are
 *          { application_id, candidate_id, name, photo, job_title, client_name, how }; `sure` is as in `decide`.
 */
export function matchConversations(conversations, { suggestions = true } = {}) {
  const results = new Map();
  if (!conversations.length) return results;
  // People with a login to The Book are never candidates, whatever a conversation calls them.
  const own = new Set(q.all('SELECT lower(email) AS email FROM users').map((u) => u.email));
  const asked = conversations.map((c) => ({
    key: c.key,
    emails: [...new Set((c.emails || []).map((e) => String(e ?? '').trim().toLowerCase()).filter((e) => e && e.length <= 200 && !own.has(e)))].slice(0, 20),
    tails: [...new Set((c.phones || []).map(phoneTail).filter(Boolean))].slice(0, 20),
    names: (c.names || []).slice(0, 10).map(nameTokens).filter((words) => words.length),
  }));

  const emails = [...new Set(asked.flatMap((c) => c.emails))];
  const tails = [...new Set(asked.flatMap((c) => c.tails))];
  const byEmail = Map.groupBy(inChunks(emails, (some) => q.all(`SELECT ${CANDIDATE} FROM candidates c WHERE lower(c.email) IN (${marks(some.length)})`, ...some))
    .filter((c) => !own.has(c.email)), (c) => c.email);
  const byTail = Map.groupBy(inChunks(tails, (some) => q.all(
    `SELECT ${CANDIDATE}, ${PHONE_TAIL} AS tail FROM candidates c WHERE c.phone IS NOT NULL AND ${PHONE_TAIL} IN (${marks(some.length)}) LIMIT 500`, ...some))
    .filter((c) => !own.has(c.email)), (c) => c.tail);

  // Names are only looked at for a conversation that no address and no number has settled.
  namesReady();
  const named = new Map();   // "first last" -> the records whose first and last words are those
  const peopleNamed = (first, last) => {
    const key = `${first} ${last}`;
    if (!named.has(key)) {
      named.set(key, q.all(`SELECT ${CANDIDATE} FROM candidate_name_keys k JOIN candidates c ON c.id = k.candidate_id WHERE k.first = ? AND k.last = ? LIMIT 50`, first, last)
        .filter((c) => !own.has(c.email)));
    }
    return named.get(key);
  };
  /**
   * The people with a first name. When very many share it (thousands of Kevins in a large workspace), the forty whose
   * applications in progress were touched most recently: those are the ones a recruiter is likeliest to have spoken
   * to, and all that happens to them is that they are offered.
   */
  const sharing = new Map();
  const peopleCalled = (first) => {
    if (!sharing.has(first)) {
      sharing.set(first, q.all(
        `SELECT ${CANDIDATE} FROM candidate_name_keys k JOIN candidates c ON c.id = k.candidate_id WHERE k.first = ?
         ORDER BY (SELECT MAX(a.updated_at) FROM applications a WHERE a.candidate_id = c.id AND a.status = 'active') DESC, c.id DESC LIMIT 40`, first)
        .filter((c) => !own.has(c.email)));
    }
    return sharing.get(first);
  };

  // First pass: who each conversation names, by each kind of evidence.
  for (const c of asked) {
    c.byEmail = c.emails.flatMap((e) => byEmail.get(e) || []);
    c.byPhone = c.tails.flatMap((t) => byTail.get(t) || []);
    c.byName = [];
    c.partial = [];
    if (c.byEmail.length || c.byPhone.length) continue;
    const seen = new Set();
    const once = (records) => records.filter((r) => !seen.has(r.id) && seen.add(r.id));
    for (const words of c.names) {
      if (words.length < 2) continue;
      // A full name: somebody whose first and last words are the same. It only counts when every word agrees.
      const whole = words.join(' ');
      const close = peopleNamed(words[0], words.at(-1));
      c.byName.push(...once(close.filter((r) => nameTokens(r.name).join(' ') === whole)));
      if (suggestions) c.partial.push(...once(close));
    }
    if (c.byName.length || !suggestions) continue;
    // Otherwise part of a name: everyone with that first name, those whose last name starts the same way first.
    for (const words of c.names) {
      if (words[0].length < 2) continue;
      const rest = words.length > 1 ? words.at(-1).replace(/\./g, '') : '';
      const called = peopleCalled(words[0]);
      const likelier = rest ? called.filter((r) => (nameTokens(r.name).at(-1) || '').startsWith(rest)) : [];
      c.partial.push(...once(likelier), ...once(called));
    }
    c.partial = c.partial.slice(0, 40);
  }

  // The applications of everyone named, in one query: a match has to say which job the person is in for.
  const ids = [...new Set(asked.flatMap((c) => [...c.byEmail, ...c.byPhone, ...c.byName, ...c.partial].map((r) => r.id)))];
  const applications = new Map();
  for (const a of inChunks(ids, (some) => q.all(
    `SELECT a.id AS application_id, a.candidate_id, a.status, a.updated_at, j.title AS job_title, cl.name AS client_name
     FROM applications a JOIN jobs j ON j.id = a.job_id JOIN clients cl ON cl.id = j.client_id WHERE a.candidate_id IN (${marks(some.length)})`, ...some))) {
    if (!applications.has(a.candidate_id)) applications.set(a.candidate_id, []);
    applications.get(a.candidate_id).push(a);
  }
  // A person's application for this purpose: one still in progress if there is one, and of those the one touched last.
  const best = (c) => [...(applications.get(c.id) || [])].sort((a, b) => (b.status === 'active') - (a.status === 'active') || (a.updated_at < b.updated_at ? 1 : -1))[0];
  const shaped = (c, how) => {
    const a = best(c);
    return { application_id: a.application_id, candidate_id: c.id, name: c.name, photo: c.photo, job_title: a.job_title, client_name: a.client_name, how };
  };
  for (const c of asked) {
    const { person, how, sure, offered } = decide(c, best);
    results.set(c.key, {
      match: person ? shaped(person, how) : null,
      suggestions: suggestions ? offered.slice(0, MAX_SUGGESTIONS).map((r) => shaped(r, how)) : [],
      sure,
    });
  }
  return results;
}

/** An application in the shape of a match, for a candidate a person chose themselves; null when the application has gone. */
export function chosenMatch(applicationId, how = 'chosen') {
  const a = q.get(
    `SELECT a.id AS application_id, c.id AS candidate_id, c.name, substr(c.photo_file, 1, 8) AS photo, j.title AS job_title, cl.name AS client_name
     FROM applications a JOIN candidates c ON c.id = a.candidate_id JOIN jobs j ON j.id = a.job_id JOIN clients cl ON cl.id = j.client_id WHERE a.id = ?`, applicationId);
  return a ? { ...a, how } : null;
}
