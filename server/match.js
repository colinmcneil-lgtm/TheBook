// Working out which candidate in The Book a conversation was with, from what is known about the people on it:
// their e-mail addresses, their phone numbers and their names.
//
// The rule throughout: never choose silently on weak evidence, and never choose at all when the evidence disagrees
// with itself. An e-mail address or a phone number that belongs to a candidate is strong. A candidate's exact full
// name is strong too. A first name alone, or part of a name, is never enough: "Kevin" with two Kevins on file is a
// question for the recruiter, and even with one Kevin he is only offered, not chosen. And when the address on a
// conversation is one candidate's while its number or its name is another's, or when two people on one call are two
// candidates, nobody is chosen: they are all offered, and a person decides.
//
// Every look-up runs in the database through an index (see db.js), so the cost does not grow with the number of
// candidates on file. Names come from outside The Book, so only a fixed length of any name is ever read.
import { q, tx } from './db.js';

export const MAX_SUGGESTIONS = 5;

/** Text with accents and capitals removed, so "Kévin" and "kevin" are the same word. */
export const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const TITLES = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'cpa', 'mba', 'phd', 'jr', 'sr']);

/** A person's name as plain words: "Tremblay, Kévin (Client)" gives ["kevin", "tremblay"]. Accents, case, brackets and titles are dropped. */
export function nameTokens(name) {
  let s = fold(String(name ?? '').slice(0, 200)).replace(/\([^)]*\)|\[[^\]]*\]/g, ' ');
  if (/^[^,]+,[^,]+$/.test(s)) { const [last, first] = s.split(','); s = `${first} ${last}`; }   // "Last, First"
  return s.replace(/[^a-z0-9' -]/g, ' ').split(/\s+/).filter((t) => t && !TITLES.has(t.replace(/\./g, '')));
}

/**
 * Could two names (as plain words) belong to one person? Yes when the first and last words agree, or when one name
 * is the other with something added ("Otto" and "Otto Vale", "Ana Ruiz" and "Ana Ruiz Ortega"). Anything else is a
 * different person, which is the safe answer: the caller then asks instead of choosing.
 */
export function namesAgree(a, b) {
  if (!a.length || !b.length) return false;
  if (a[0] === b[0] && a.at(-1) === b.at(-1)) return true;
  const [few, many] = a.length <= b.length ? [a, b] : [b, a];
  return few.every((word) => many.includes(word));
}

// "416-555-0183 ext 4", "416 555 0183 x12", "... poste 4": the extension is not part of the number.
const EXTENSION = /(?:\b(?:ext|extension|poste)\b\.?|[x#])\s*\d{1,6}\s*$/i;
/**
 * A phone number as it is compared: { tail, lead }, or null for anything that is not one number (fewer than ten
 * digits says too little to tell people apart; more than fifteen is not a number anybody can dial).
 *   tail  its last ten digits, so "+1 (647) 555-0199", "647.555.0199" and "647/555/0199 ext 4" are the same number
 *   lead  the digits before those, which is the country code: "44" for "+44 20 7946 0958". A ten-digit number with
 *         nothing in front is a North American one (this is an Ontario agency), so its lead is "1". A number written
 *         the way it is dialled inside another country, with a 0 in front ("020 7946 0958"), has an empty lead: which
 *         country is not known.
 */
export function phoneParts(number) {
  const digits = String(number ?? '').slice(0, 60).replace(EXTENSION, '').replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) return null;
  const lead = digits.slice(0, -10).replace(/^0+/, '');
  return { tail: digits.slice(-10), lead: lead || (digits.startsWith('0') ? '' : '1') };
}
/** The numbers in what somebody typed into a phone box: usually one, sometimes two ("416-555-0183 / 647-555-0199"). Three at most. */
export function phonesIn(typed) {
  const text = String(typed ?? '').slice(0, 120);
  const whole = phoneParts(text);
  if (whole) return [whole];
  return text.split(/[/,;|]|\b(?:or|and|ou|et)\b/i).map(phoneParts).filter(Boolean).slice(0, 3);
}
/**
 * Are two numbers (as `phoneParts` gives them) the same number? 2 when they are: the same ten digits in the same
 * country. 1 when they may be: the same ten digits, with the country known for one of them only and not North
 * America. 0 otherwise. So +44 20 7946 0958 and +1 207 946 0958 are different numbers, although their last ten
 * digits are the same.
 */
export function sameNumber(a, b) {
  if (!a || !b || !a.tail || a.tail !== b.tail) return 0;
  if (a.lead === b.lead) return 2;
  return (a.lead === '' && b.lead !== '1') || (b.lead === '' && a.lead !== '1') ? 1 : 0;
}

const marks = (n) => Array(n).fill('?').join(', ');
/** Run a query once per hundred values, for lists too long to put in one statement comfortably. */
function inChunks(values, run) {
  const rows = [];
  for (let i = 0; i < values.length; i += 100) rows.push(...run(values.slice(i, i + 100)));
  return rows;
}
/** A list of candidate records with each record in it once. */
const once = (records) => [...new Map(records.map((r) => [r.id, r])).values()];

/**
 * Candidates' names and phone numbers are looked up through two tables of their own (see db.js): the first and last
 * word of the name with accents removed, and the number as it is compared. The server fills them in here for
 * candidates who are new or whose name or number has changed. A few thousand at a time, so that catching up on a
 * large workspace never holds the server for long. Resolves to how many were dealt with.
 */
export function catchUpKeys(limit = 2000) {
  const waiting = q.all('SELECT d.candidate_id AS id, c.name, c.phone FROM candidate_name_dirty d LEFT JOIN candidates c ON c.id = d.candidate_id LIMIT ?', limit);
  if (!waiting.length) return 0;
  tx(() => {
    for (const { id, name, phone } of waiting) {
      if (name != null) {
        const words = nameTokens(name);
        q.run('INSERT INTO candidate_name_keys (candidate_id, first, last) VALUES (?, ?, ?) ON CONFLICT(candidate_id) DO UPDATE SET first = excluded.first, last = excluded.last',
          id, words[0] ?? '', words.length > 1 ? words.at(-1) : '');
        q.run('DELETE FROM candidate_phone_keys WHERE candidate_id = ?', id);
        // Something typed that is not a number still gets a row (with nothing in it), so it is not read again at every start.
        const numbers = phonesIn(phone);
        if (String(phone ?? '').trim()) for (const n of numbers.length ? numbers : [{ tail: '', lead: '' }]) q.run('INSERT INTO candidate_phone_keys (candidate_id, tail, lead) VALUES (?, ?, ?)', id, n.tail, n.lead);
      }
      q.run('DELETE FROM candidate_name_dirty WHERE candidate_id = ?', id);
    }
  });
  return waiting.length;
}
/** Bring the two tables fully up to date, however many candidates are waiting. */
function keysReady() {
  while (catchUpKeys() > 0) { /* a few thousand at a time */ }
}

const CANDIDATE = `c.id, c.name, lower(c.email) AS email, c.phone, substr(c.photo_file, 1, 8) AS photo`;

/**
 * Decide, from the records each kind of evidence found, which candidate one person on a conversation is.
 * @param found  { words, byEmail, byPhone, loose, byName, partial }: the person's name as plain words, and the
 *               candidate records ({ id, name, email, phone }) found by their e-mail addresses, by their phone
 *               numbers, by their exact full name, and by part of their name. `loose` says the numbers only may be
 *               the same (see sameNumber).
 * @param best   candidate record -> their application for this purpose, or undefined when they have none
 * @returns {{ person, how, sure, firm, offered }}
 *   person   the one record it certainly is, or null
 *   how      'email' | 'phone' | 'name': the evidence `person` rests on
 *   sure     true when an address or a number found one record, and only one, and nothing else about the person
 *            points anywhere else. Only then may anything be done without a person looking
 *   firm     true when this rests on an address, a number or an exact full name, even if nobody could be chosen;
 *            false when all there is to go on is part of a name
 *   offered  the records to offer when there is no certain one, each with the `how` it was found by
 */
export function decide({ words = [], byEmail = [], byPhone = [], loose = false, byName = [], partial = [] }, best) {
  const agrees = (record) => namesAgree(nameTokens(record.name), words);
  const onePerson = (records) => records.every((r) => namesAgree(nameTokens(r.name), nameTokens(records[0].name)));
  const tagged = (records, how) => records.filter(best).map((r) => ({ ...r, how }));
  const offer = (firm, ...kinds) => ({ person: null, how: kinds[0][1], sure: false, firm, offered: once(kinds.flatMap(([records, how]) => tagged(records, how))) });
  /**
   * `records` are believed to be one person. One record is a match. The same person filed under two clients is a
   * match only when exactly one of the records is still in progress; otherwise which record is meant is the
   * recruiter's call, and both are offered.
   */
  const settle = (records, how, alone) => {
    const usable = records.filter(best);
    const live = usable.filter((c) => best(c).status === 'active');
    const one = usable.length === 1 ? usable[0] : live.length === 1 ? live[0] : null;
    return { person: one, how, sure: Boolean(one) && alone, firm: true, offered: one ? [] : tagged(usable, how) };
  };

  const strong = [[byEmail, 'email'], [byPhone, 'phone']].filter(([records]) => records.length);
  if (strong.length) {
    const everyone = () => offer(true, ...strong, [byName, 'name']);
    // The records that share one address, or one number, are one person when their names agree (somebody filed
    // under two clients). When they do not (a household's number, a couple's address), the name on the conversation
    // says which of them it was, if it fits exactly one of them.
    const narrowed = strong.map(([records]) => {
      if (onePerson(records)) return records;
      const named = records.filter(agrees);
      return named.length && onePerson(named) ? named : null;
    });
    if (narrowed.includes(null)) return everyone();
    // The address and the number have to mean the same person, and so does the name, when somebody else on file
    // has exactly that name. Evidence that points two ways chooses nobody.
    const together = once(narrowed.flat());
    if (!onePerson(together)) return everyone();
    if (byName.length && !together.some(agrees)) return everyone();
    const alone = once(strong.flatMap(([records]) => records)).length === 1 && !loose;
    return settle(together, strong[0][1], alone);
  }
  if (byName.length) {
    // Two records with one name are one person only if something else says so (the same address or number).
    const numbers = byName.map((c) => phonesIn(c.phone)[0]);
    const same = byName.length === 1 || (byName.every((c) => c.email) && new Set(byName.map((c) => c.email)).size === 1)
      || numbers.every((n) => sameNumber(n, numbers[0]) === 2);
    return same ? settle(byName, 'name', false) : offer(true, [byName, 'name']);
  }
  return offer(false, [partial, 'name']);
}

/**
 * Put together what was decided about each person on one conversation. One call can have several people on the
 * other side. They choose a candidate only when everyone who could be placed is the same one candidate: a call with
 * two candidates on it belongs to neither for certain, so both are offered. Somebody known only by part of a name
 * is not evidence either way, and is only offered when there is nothing better.
 */
export function acrossPeople(verdicts) {
  const placed = verdicts.filter((v) => v.person || (v.firm && v.offered.length));
  if (!placed.length) return { person: null, how: 'name', sure: false, offered: once(verdicts.flatMap((v) => v.offered)) };
  const people = once(placed.flatMap((v) => (v.person ? [{ ...v.person, how: v.how }] : v.offered)));
  if (people.length > 1 || placed.some((v) => !v.person)) return { person: null, how: people[0].how, sure: false, offered: people };
  const strength = ['email', 'phone', 'name'];
  const [strongest] = [...placed].sort((a, b) => strength.indexOf(a.how) - strength.indexOf(b.how));
  return { person: strongest.person, how: strongest.how, sure: placed.some((v) => v.sure), offered: [] };
}

/**
 * Work out, for each conversation, the candidate it was with (`match`) or the people it might have been with
 * (`suggestions`).
 * @param conversations [{ key, people: [{ name, emails, phones }] }]: what is known about each person on it who
 *                      might be the candidate. Never pass the agency's own side of a call.
 * @param options       { suggestions: false } skips the people who are only offered on part of a name, for when all
 *                      that matters is whether there is a match
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
    people: (c.people || []).slice(0, 10).map((p) => ({
      words: nameTokens(p.name),
      emails: [...new Set((p.emails || []).map((e) => String(e ?? '').trim().toLowerCase()).filter((e) => e && e.length <= 200 && !own.has(e)))].slice(0, 10),
      numbers: (p.phones || []).slice(0, 10).map(phoneParts).filter(Boolean),
    })),
  }));
  const everybody = asked.flatMap((c) => c.people);

  keysReady();
  const emails = [...new Set(everybody.flatMap((p) => p.emails))];
  const tails = [...new Set(everybody.flatMap((p) => p.numbers.map((n) => n.tail)))];
  const byEmail = Map.groupBy(inChunks(emails, (some) => q.all(`SELECT ${CANDIDATE} FROM candidates c WHERE lower(c.email) IN (${marks(some.length)})`, ...some))
    .filter((c) => !own.has(c.email)), (c) => c.email);
  const byTail = Map.groupBy(inChunks(tails, (some) => q.all(
    `SELECT ${CANDIDATE}, k.tail, k.lead FROM candidate_phone_keys k JOIN candidates c ON c.id = k.candidate_id WHERE k.tail IN (${marks(some.length)}) LIMIT 500`, ...some))
    .filter((c) => !own.has(c.email)), (c) => c.tail);

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

  // First pass: who each person on each conversation might be, by each kind of evidence.
  for (const p of everybody) {
    p.byEmail = once(p.emails.flatMap((e) => byEmail.get(e) || []));
    // A number that is certainly the same counts; one that only may be the same counts when there is nothing better.
    const numbered = p.numbers.flatMap((n) => (byTail.get(n.tail) || []).map((record) => ({ record, level: sameNumber(n, record) }))).filter((found) => found.level);
    const certain = numbered.filter((found) => found.level === 2);
    p.byPhone = once((certain.length ? certain : numbered).map((found) => found.record));
    p.loose = numbered.length > 0 && !certain.length;
    p.byName = [];
    p.partial = [];
    const strong = [...p.byEmail, ...p.byPhone];
    // The exact full name is looked up when it is all there is, and when the address or the number found somebody
    // of another name: then it matters whether a different candidate has exactly this one.
    if (p.words.length > 1 && !strong.some((r) => namesAgree(nameTokens(r.name), p.words))) {
      const whole = p.words.join(' ');
      const close = peopleNamed(p.words[0], p.words.at(-1));
      p.byName = close.filter((r) => nameTokens(r.name).join(' ') === whole);
      if (suggestions && !strong.length) p.partial.push(...close);
    }
    if (strong.length || p.byName.length || !suggestions || !p.words.length || p.words[0].length < 2) continue;
    // Otherwise part of a name: everyone with that first name, those whose last name starts the same way first.
    const rest = p.words.length > 1 ? p.words.at(-1).replace(/\./g, '') : '';
    const called = peopleCalled(p.words[0]);
    const likelier = rest ? called.filter((r) => (nameTokens(r.name).at(-1) || '').startsWith(rest)) : [];
    p.partial = once([...p.partial, ...likelier, ...called]).slice(0, 40);
  }

  // The applications of everyone named, in one query: a match has to say which job the person is in for.
  const ids = [...new Set(everybody.flatMap((p) => [...p.byEmail, ...p.byPhone, ...p.byName, ...p.partial].map((r) => r.id)))];
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
    const { person, how, sure, offered } = acrossPeople(c.people.map((p) => decide(p, best)));
    results.set(c.key, {
      match: person ? shaped(person, how) : null,
      suggestions: suggestions ? offered.slice(0, MAX_SUGGESTIONS).map((r) => shaped(r, r.how)) : [],
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
