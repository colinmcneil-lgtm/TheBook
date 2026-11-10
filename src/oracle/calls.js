// Words and small rules about The Oracle's calls and its two tabs, kept apart from the screens so they can be
// checked on their own.

// ---- the two tabs ---------------------------------------------------------------------------------------------------------
/** The Oracle's tabs, as they are named in the address: Metaview's calls, and the calls recorded or uploaded in The Book. */
export const ORACLE_TABS = ['metaview', 'record'];
/** The tab to show: the one the address asks for, else the one this person used last, else the first. */
export const oracleTab = (asked, last) => (ORACLE_TABS.includes(asked) ? asked : ORACLE_TABS.includes(last) ? last : ORACLE_TABS[0]);
/** The address of one tab, so each can be linked to. */
export const oraclePath = (tab) => `/oracle?tab=${tab}`;
/** The tab a call is listed on, which is where its page goes back to. */
export const tabOfCall = (call) => (call?.source === 'metaview' ? 'metaview' : 'record');

// ---- words for a call -----------------------------------------------------------------------------------------------------
/**
 * How a call came to be in The Oracle and who made it: "Recorded by Alex", "Uploaded by Alex", "Brought in from
 * Metaview by Alex". A Metaview call that The Book brought in by itself has nobody to name. A call from an earlier
 * version that came in some other way is simply a recorded call.
 */
export function madeBy(call) {
  if (call.source === 'metaview') return call.created_by_name ? `Brought in from Metaview by ${call.created_by_name}` : 'Brought in from Metaview';
  return `${call.source === 'uploaded' ? 'Uploaded' : 'Recorded'} by ${call.created_by_name || 'someone who has left'}`;
}

/** When the conversation happened. A Metaview call took place before it was brought in; any other call when it was recorded. */
export const callWhen = (call) => call.took_place_at || call.created_at;

/** "45 sec", "12 min", "1 h 05 min". Empty while the length is not known yet. */
export function fmtLength(ms) {
  if (!ms || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} sec`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

// ---- a call in Metaview's list ----------------------------------------------------------------------------------------------
const MINUTE = 60_000;
const namesOf = (call, ...roles) => (call.people || []).filter((p) => roles.includes(p.role) && p.name?.trim()).map((p) => p.name.trim());
/** "Dana", "Dana and Alex", "Dana, Alex and Sam". */
export const nameList = (names) => (names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

/**
 * Who was on a Metaview call, in a few words: "Dana Whitlock with Alex Morgan". A call named after the candidate
 * ("Call with Dana Whitlock") does not repeat their name: "With Alex Morgan".
 */
export function peopleLine(call) {
  const title = String(call.title || '').toLowerCase();
  const them = namesOf(call, 'candidate', 'other').filter((name) => !title.includes(name.toLowerCase()));
  const us = namesOf(call, 'interviewer');
  if (them.length && us.length) return `${nameList(them)} with ${nameList(us)}`;
  return us.length ? `With ${nameList(us)}` : nameList(them);
}

/** What kind of conversation it was, how it was held and how long it lasted: "Job Interview · Phone · 25 min". */
export const kindLine = (call) => [call.kind, call.channel, call.minutes > 0 ? fmtLength(call.minutes * MINUTE) : ''].filter(Boolean).join(' · ');

/**
 * Whose call it is in The Book: 'matched' (it belongs to one candidate), 'choose' (it could be one of a few, so
 * somebody has to say which) or 'nobody' (nobody in The Book looks like the person on the call).
 */
export const whoseCall = (call) => (call.match ? 'matched' : call.suggestions?.length ? 'choose' : 'nobody');

/** Why The Book thinks a Metaview call belongs to a candidate. */
export const MATCHED_BY = { email: 'Same email address', phone: 'Same phone number', name: 'Same name', chosen: 'Chosen by your team' };

const count = (n) => Number(n || 0).toLocaleString('en-CA');
/**
 * Said quietly while The Book is still reading back through the calls in Metaview. How many there are in all is
 * said when the server gives it (`total`) and left out when it does not.
 */
export function readingLine(status) {
  if (!status?.catching_up) return '';
  return status.total > status.known
    ? `Reading your Metaview history: ${count(status.known)} of about ${count(status.total)} so far`
    : `Reading your Metaview history: ${count(status.known)} ${status.known === 1 ? 'call' : 'calls'} so far`;
}

/** How much of what is in Metaview The Book holds: "The Book knows about 2,100 Metaview calls. 38 of them are in The Book." */
export function knownLine(status) {
  const known = Number(status?.known || 0), here = Number(status?.in_the_book || 0);
  if (!known) return 'The Book has not found any calls in Metaview yet.';
  const inTheBook = known === 1 ? (here ? 'It is in The Book.' : 'It is not in The Book yet.')
    : here === 0 ? 'None of them are in The Book yet.' : here >= known ? 'All of them are in The Book.' : `${count(here)} of them ${here === 1 ? 'is' : 'are'} in The Book.`;
  return `The Book knows about ${count(known)} Metaview ${known === 1 ? 'call' : 'calls'}. ${inTheBook}`;
}
