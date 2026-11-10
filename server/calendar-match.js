// Working out which candidate a calendar event is with, from names.
//
// The rule throughout: never choose silently on weak evidence. An e-mail address or a phone number that belongs to
// a candidate is strong (calendar.js looks those up in the database). A candidate's exact full name in the title, or
// as a guest's name, is strong too. A first name alone is never enough: "Call Kevin" with two Kevins on file is a
// question for the recruiter, and even with one Kevin it is only offered, not chosen.
//
// This file is the part that reads text, kept free of the database so it can be tested on its own. Everything it
// reads comes from an event, which a stranger may have written, so it only ever looks at text that has been cut to
// a fixed length first and its patterns cannot be made slow.
import { clip } from './calendar-links.js';

const fold = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const TITLES = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'cpa', 'mba', 'phd', 'jr', 'sr']);

/** A person's name as plain words: "Tremblay, Kévin (Client)" gives ["kevin", "tremblay"]. Accents, case, brackets and titles are dropped. */
export function nameTokens(name) {
  let s = fold(clip(name, 200)).replace(/\([^)]*\)|\[[^\]]*\]/g, ' ');
  if (/^[^,]+,[^,]+$/.test(s)) { const [last, first] = s.split(','); s = `${first} ${last}`; }   // "Last, First"
  return s.replace(/[^a-z0-9' -]/g, ' ').split(/\s+/).filter((t) => t && !TITLES.has(t.replace(/\./g, '')));
}
/** Any text as plain words, in order. */
export const wordsOf = (s) => fold(s).replace(/[^a-z0-9' -]/g, ' ').split(/\s+/).filter(Boolean);
/** Do the words of `needle` appear in `hay` next to each other, in that order? Whole words only: "Sam Lee" is not in "Samantha Lee". */
export function containsWords(hay, needle) {
  if (!needle.length) return false;
  for (let i = 0; i + needle.length <= hay.length; i++) if (needle.every((t, j) => hay[i + j] === t)) return true;
  return false;
}

// The look-behind at the front matters: without it the pattern re-reads a long run of letters from every position
// in it, and one event with 200,000 letters in its description kept the server busy for over half a minute.
const EMAIL_RE = /(?<![a-z0-9._%+'-])[a-z0-9._%+'-]{1,64}@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi;
// Addresses a calendar adds for rooms, shared calendars and its own notices. They are not people.
const NOT_A_PERSON = /@(resource\.calendar\.google\.com|group\.calendar\.google\.com|group\.v\.calendar\.google\.com|import\.calendar\.google\.com)$|^(noreply|no-reply|calendar-notification)@/i;

/** Every e-mail address an event names: its guests, and any address typed into the title or description. Lower case, no rooms. */
export function emailsOf(event) {
  const found = new Set();
  for (const guest of event.guests || []) if (guest.email) found.add(guest.email.toLowerCase());
  for (const m of `${clip(event.title, 500)}\n${clip(event.description)}`.match(EMAIL_RE) || []) found.add(m.toLowerCase());
  return [...found].filter((e) => e.length <= 200 && !NOT_A_PERSON.test(e)).slice(0, 60);
}

/** The words by which candidates are shortlisted for an event: every word of its title and of its guests' names. */
export function shortlistWords(event) {
  const words = new Set(wordsOf(clip(event.title, 500)));
  for (const guest of (event.guests || []).slice(0, 100)) for (const word of nameTokens(guest.name)) words.add(word);
  return [...words].filter((w) => w.length >= 2 && w.length <= 40).slice(0, 150);
}

/**
 * Which of the shortlisted candidates an event names.
 * @param event     { title, guests: [{ name, email }] }
 * @param people    [{ id, name }] (a short list, not everyone)
 * @param ownEmails addresses of the agency's own people, whose names as guests say nothing about the candidate
 * @returns {{ full: object[], first: object[] }}
 *   full   candidates whose whole name (two words or more) is in the title or is a guest's name
 *   first  candidates whose first name, and no more, is in the title
 */
export function namedIn(event, people, ownEmails = new Set()) {
  const title = wordsOf(clip(event.title, 500));
  const guestNames = new Set((event.guests || []).slice(0, 100).filter((g) => !ownEmails.has(g.email)).map((g) => nameTokens(g.name).join(' ')).filter(Boolean));
  const full = [], first = [];
  for (const person of people) {
    const name = nameTokens(person.name);
    if (!name.length) continue;
    if (name.length >= 2 && (containsWords(title, name) || containsWords(title, [...name].reverse()) || guestNames.has(name.join(' ')))) full.push(person);
    else if (name[0].length >= 2 && title.includes(name[0])) first.push(person);
  }
  return { full, first };
}

/**
 * People who are only named by their first name, the likeliest first. Someone counts as likelier for each further
 * sign that the event is about them: the initial of their last name follows the first name ("Kevin O."), a job they
 * are in for, that job's company or their own employer is named in the event, or The Book has an interview booked
 * with them at about that time (`near`, a set of candidate ids). None of this is enough to choose anyone: the list
 * is only ever offered.
 * @param people [{ id, name, job_titles: [string], client_names: [string], company }]
 */
export function likeliestFirst(event, people, near = new Set()) {
  const title = wordsOf(clip(event.title, 500));
  const everything = wordsOf(`${clip(event.title, 500)} ${clip(event.description)}`);
  const scored = people.slice(0, 60).map((person) => {
    const name = nameTokens(person.name);
    let signs = 0;
    if (name.length > 1 && title[title.indexOf(name[0]) + 1]?.replace(/\./g, '') === name.at(-1)[0]) signs++;
    if (near.has(person.id)) signs++;
    for (const named of [...(person.job_titles || []), ...(person.client_names || []), person.company].slice(0, 12)) {
      const words = wordsOf(clip(named, 200));
      if (words.length && containsWords(everything, words)) signs++;
    }
    return { person, signs };
  });
  scored.sort((a, b) => b.signs - a.signs || a.person.name.localeCompare(b.person.name));
  return scored.map((s) => s.person);
}
