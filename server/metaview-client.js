// The connection to Metaview: a small client for the one server The Book talks to, and the reading of its answers
// into plain shapes.
//
// Metaview is reached the way an AI assistant reaches it (the Model Context Protocol over HTTP): one address, a
// POST with the key in the Authorization header, and "tools" that are asked to do things. The server keeps no
// session, so every request stands alone. Its answer usually arrives as an event stream holding one or more
// messages, sometimes as plain JSON; either way the answer to a request is the message carrying the request's id,
// and what a tool found is a JSON document written as text inside it.
//
// Three rules are kept here so nothing else has to remember them:
//   - The Book only reads. Only the tools named in READ_ONLY can be asked for; anything else is refused before a
//     request is made.
//   - One request at a time, so The Book is never a burden on Metaview. Something a person is waiting for goes
//     ahead of background work, but never alongside it.
//   - The key is sent to Metaview and nowhere else: it is never part of an error, and never written to a log.

const DEFAULT_URL = 'https://mcp.metaview.ai/mcp';
/** Where Metaview is. METAVIEW_API_URL points the tests at a stand-in. */
export const metaviewUrl = () => (process.env.METAVIEW_API_URL || '').trim() || DEFAULT_URL;
// How long one request may take. Listing fifty conversations takes about a second and one transcript about the
// same, so half a minute means something is wrong.
const TIMEOUT = Number(process.env.METAVIEW_TIMEOUT_MS) || 30000;
const RETRY_PAUSE = Number(process.env.METAVIEW_RETRY_MS) || 2000;
const MAX_ANSWER_BYTES = 8 * 1024 * 1024;   // a long call's transcript is about 100 KB; nothing real comes near this
export const PAGE_SIZE = 50;                 // the most conversations Metaview lists in one answer

export const READ_ONLY = new Set(['get_user_context', 'search_conversations', 'list_fields', 'list_field_values']);

const PROBLEMS = {
  key: 'Metaview did not accept the key. Make a new one in Metaview (Settings, Integrations, MCP) and enter it again.',
  busy: 'Metaview is busy right now. The Book will try again by itself in a few minutes.',
  silent: 'Metaview is not answering right now. The Book will try again by itself in a few minutes.',
  unreadable: 'Metaview sent back something The Book could not read. It will try again by itself in a few minutes.',
  refused: 'Metaview could not answer that request. The Book will try again by itself in a few minutes.',
};
const RETRYABLE = new Set(['busy', 'silent']);

/** Something went wrong talking to Metaview. `message` is a sentence for a person; `kind` says which of the sentences it is. */
export class MetaviewError extends Error {
  constructor(kind, { status = null, detail = '', retryAfter = null, timedOut = false } = {}) {
    super(PROBLEMS[kind]);
    Object.assign(this, { kind, status, detail, retryAfter, timedOut });
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- one request at a time ----------
const lines = { first: [], then: [] };
let busy = false;
function next() {
  if (busy) return;
  const job = lines.first.shift() ?? lines.then.shift();
  if (!job) return;
  busy = true;
  // The next request leaves a moment after this one's answer has been handed over, not in the same breath: whoever
  // was waiting for the answer acts on it first. Entering another key ends the old connection that way before a
  // request queued for the old key can go out.
  job.work().then(job.resolve, job.reject).finally(() => setImmediate(() => { busy = false; next(); }));
}
/** Run `work` when no other request is under way. `urgent` is for something a person is waiting for: it goes before background work. */
const inTurn = (work, urgent) => new Promise((resolve, reject) => { (urgent ? lines.first : lines.then).push({ work, resolve, reject }); next(); });

// ---------- reading an answer ----------
/**
 * The JSON-RPC messages in a body. An event stream is blocks separated by a blank line, each with one or more
 * "data:" lines that together are one message; anything else in a block (the event's name, an id, a comment) is
 * skipped. A plain JSON body is one message, or a list of them.
 */
export function messagesIn(body, contentType = '') {
  const text = String(body ?? '');
  if (!/event-stream/i.test(contentType)) {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  const messages = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n');
    if (data) messages.push(JSON.parse(data));
  }
  return messages;
}

/** The body of an answer as text, given up on when it grows past any size Metaview would send. */
async function bodyOf(res) {
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body ?? []) {
    size += chunk.length;
    if (size > MAX_ANSWER_BYTES) throw new MetaviewError('unreadable', { status: res.status, detail: 'the answer was too large' });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

let lastId = 0;
/** One request to one tool. Resolves to the document the tool answered with; throws a MetaviewError. */
async function askOnce(key, name, args) {
  const id = ++lastId;
  let res, body;
  try {
    res = await fetch(metaviewUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
      redirect: 'error',                       // the key is for this address only: it does not follow the server anywhere else
      signal: AbortSignal.timeout(TIMEOUT),    // covers the whole answer, not just its first byte
    });
    body = await bodyOf(res);
  } catch (err) {
    if (err instanceof MetaviewError) throw err;
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    // Only the short code of what went wrong (ECONNREFUSED...) is kept, never the error's own words: this ends up in
    // the log, and a request that could not even be put together can quote its headers, the key among them.
    const code = String(err?.cause?.code ?? '');
    throw new MetaviewError('silent', { timedOut, detail: timedOut ? 'no answer in time' : /^[A-Z][A-Z0-9_]{2,40}$/.test(code) ? code : 'the request could not be made' });
  }
  if (res.status === 401 || res.status === 403) throw new MetaviewError('key', { status: res.status });
  if (res.status === 429) {
    const wait = Number(res.headers.get('retry-after'));
    throw new MetaviewError('busy', { status: 429, retryAfter: Number.isFinite(wait) && wait > 0 ? wait * 1000 : null });
  }
  if (res.status >= 500) throw new MetaviewError('silent', { status: res.status });
  if (!res.ok) throw new MetaviewError('refused', { status: res.status });
  let answer;
  try {
    answer = messagesIn(body, res.headers.get('content-type') || '').find((m) => m && m.id === id && ('result' in m || 'error' in m));
  } catch { /* not an event stream and not JSON: treated as no answer below */ }
  if (!answer) throw new MetaviewError('unreadable', { status: res.status, detail: 'no answer to the request was found' });
  if (answer.error) throw new MetaviewError('refused', { status: res.status, detail: `error ${Number(answer.error.code) || ''}`.trim() });
  const text = answer.result?.content?.[0]?.text;
  // What a tool says when it fails is kept out of the log: it may quote what it was asked about.
  if (answer.result?.isError) throw new MetaviewError('refused', { status: res.status, detail: 'the tool reported a problem' });
  try {
    const document = JSON.parse(text);
    if (!document || typeof document !== 'object') throw new Error('not a document');
    return document;
  } catch {
    throw new MetaviewError('unreadable', { status: res.status, detail: 'the tool did not answer with a document' });
  }
}

/**
 * Ask Metaview's tool `name` and resolve to the document it answers with. Waits its turn, and tries again (twice at
 * most, after a pause) when Metaview is busy or failing; a request that got no answer in time is not tried again
 * here, because it has already held the line for half a minute. `stillWanted` is asked when the request's turn
 * comes: when it says no (Metaview was disconnected while the request waited), nothing is sent.
 */
export function askMetaview(key, name, args, { urgent = false, stillWanted = () => true } = {}) {
  if (!READ_ONLY.has(name)) return Promise.reject(new Error(`The Book only reads from Metaview: ${name} is not something it asks for.`));
  return inTurn(async () => {
    for (let attempt = 1; ; attempt++) {
      if (!stillWanted()) throw new Error('This request to Metaview is no longer wanted.');
      try {
        return await askOnce(key, name, args);
      } catch (err) {
        if (!(err instanceof MetaviewError) || !RETRYABLE.has(err.kind) || err.timedOut || attempt >= 3) throw err;
        await sleep(Math.min(30000, err.retryAfter ?? RETRY_PAUSE * 2 ** (attempt - 1)));
      }
    }
  }, urgent);
}

// ---------- what Metaview's answers say ----------
/** Single-line text from outside: control characters removed, spaces collapsed, cut to a length. */
const line = (value, max = 200) => (typeof value === 'string' || typeof value === 'number'
  ? String(value).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
/** Every value of a field. Each field is a list of { value, label, details }, which may be empty or not there at all. */
const valuesOf = (conversation, field) => (Array.isArray(conversation?.fields?.[field]) ? conversation.fields[field].filter((v) => v && typeof v === 'object') : []);

/**
 * When a conversation started, as an ISO time, or null. Metaview writes "2026-11-09 23:40:45.014643+00:00", and
 * sometimes leaves the fraction out.
 */
export function startTime(value) {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(String(value ?? '').trim());
  if (!m) return null;
  const offset = !m[4] || m[4] === 'Z' ? 'Z' : m[4].includes(':') ? m[4] : `${m[4].slice(0, 3)}:${m[4].slice(3)}`;
  const time = new Date(`${m[1]}T${m[2]}.${(m[3] || '').padEnd(3, '0').slice(0, 3)}${offset}`);
  return Number.isNaN(time.getTime()) ? null : time.toISOString();
}

/** A link to a conversation's page in Metaview. Only an https address at metaview.ai is ever kept, because it is shown as a link. */
export function metaviewPage(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' && /(^|\.)metaview\.ai$/i.test(url.hostname) && url.href.length <= 300 ? url.href : null;
  } catch { return null; }
}

/**
 * Metaview calls somebody it has no name for by their phone number ("+16475550100" where the name would be). That
 * is how the real service shows a caller it does not know (seen in about one call in twenty-five).
 */
export const onlyANumber = (name) => /^\+?[\d\s().-]{7,}$/.test(String(name ?? '').trim());

const person = (entry, role) => ({
  name: line(entry.details?.name || entry.label, 120), role,
  emails: (Array.isArray(entry.details?.emails) ? entry.details.emails : []).map((e) => line(e, 200).toLowerCase()).filter((e) => /^[^\s@]+@[^\s@]+$/.test(e)).slice(0, 5),
  // An interviewer's own number is never needed (they are known by their address), so it is not taken.
  phones: role === 'interviewer' ? []
    : (Array.isArray(entry.details?.phone_numbers) ? entry.details.phone_numbers : []).map((n) => line(n, 40)).filter((n) => /\d/.test(n)).slice(0, 5),
});

/**
 * One conversation from a list, as The Book remembers it, or null when it has no number or no start time to file
 * it under: { id, url, startedAt, title, kind, channel, minutes, hasTranscript, people }. Each of `people` is
 * { name, role, emails, phones } with role candidate, interviewer or other. The number Metaview gives as the
 * conversation's own phone number is the candidate's, and is put with them.
 *
 * Only what The Book uses is taken. Addresses and numbers are kept for the people a conversation is matched by:
 * the candidates Metaview names, or, when it names none, everybody who is not an interviewer. An interviewer keeps
 * their address (for "my calls") and no number; anybody else on a call that has a candidate keeps their name only.
 */
export function readConversation(raw) {
  const id = Number(raw?.id);
  const startedAt = startTime(valuesOf(raw, 'default:start_time')[0]?.value);
  if (!Number.isSafeInteger(id) || id <= 0 || !startedAt) return null;
  const people = [], seen = new Set();
  const add = (entry, role) => {
    const key = entry.value != null ? String(entry.value) : `${role}:${entry.label}`;
    if (seen.has(key) || people.length >= 30) return;
    seen.add(key);
    const who = person(entry, role);
    if (!who.name && !who.emails.length && !who.phones.length) return;
    // A "name" that is really their number is kept as what to call them, and counts as their number too.
    if (role !== 'interviewer' && onlyANumber(who.name) && !who.phones.includes(who.name)) who.phones = [...who.phones, who.name].slice(0, 5);
    // "Everybody on the call" repeats the candidates and the interviewers. Should it ever name one of them under
    // another identity, they are still the same person: an interviewer must never turn up a second time as somebody else.
    if (role === 'other' && people.some((p) => (who.name && p.name === who.name) || p.emails.some((e) => who.emails.includes(e)))) return;
    people.push(who);
  };
  for (const entry of valuesOf(raw, 'default:candidate')) add(entry, 'candidate');
  for (const entry of valuesOf(raw, 'default:interviewer')) add(entry, 'interviewer');
  for (const entry of valuesOf(raw, 'default:contact')) add(entry, 'other');   // everybody on the call; the ones above are already in
  const numbers = valuesOf(raw, 'default:phone_number').map((v) => line(v.value, 40)).filter((n) => /\d/.test(n)).slice(0, 3);
  const theirs = people.find((p) => p.role === 'candidate') ?? people.find((p) => p.role === 'other');
  if (numbers.length && theirs) theirs.phones = [...new Set([...theirs.phones, ...numbers])].slice(0, 5);
  else if (numbers.length) people.push({ name: '', role: 'candidate', emails: [], phones: numbers });
  // With a candidate on the call, nobody else's contact details are needed to place it.
  if (people.some((p) => p.role === 'candidate')) for (const p of people) if (p.role === 'other') { p.emails = []; p.phones = []; }
  // The person the call was with first, then anybody else, then the agency's own side.
  const order = { candidate: 0, other: 1, interviewer: 2 };
  people.sort((a, b) => order[a.role] - order[b.role]);
  const minutes = Number(valuesOf(raw, 'default:call_duration')[0]?.value);
  return {
    id, url: metaviewPage(raw.url), startedAt,
    title: line(valuesOf(raw, 'default:calendar_event_title')[0]?.value, 160),
    kind: line(valuesOf(raw, 'default:conversation_type')[0]?.label, 60), channel: line(valuesOf(raw, 'default:video_conferencing_platform')[0]?.label, 40),
    minutes: Number.isFinite(minutes) && minutes >= 0 && minutes < 100000 ? Math.round(minutes) : null,
    hasTranscript: raw.has_transcript === true, people,
  };
}

// "Dana Whitlock (Candidate) @0:04-0:11: Good, thanks." Times are M:SS, or H:MM:SS past the hour.
const CLOCK = String.raw`(\d{1,3}(?::\d{2}){1,2})`;
const TURN = new RegExp(String.raw`^(.{0,120}?)\s*\(([^()]{1,40})\)\s*@${CLOCK}\s*-\s*${CLOCK}:\s?(.*)$`);
const secondsOf = (clock) => clock.split(':').reduce((total, part) => total * 60 + Number(part), 0);
const MAX_SPEAKERS = 40;

/**
 * Metaview's transcript (one string, one line per turn) as the turns The Oracle keeps, [{ speaker, start, end, text }]
 * with times in seconds, and the name of each speaker number. A line that is not the start of a turn carries on the
 * turn before it. Somebody Metaview has no name for, or only a phone number for, is called by their part in the
 * call ("Candidate"): The Oracle puts the candidate's own name there once the call is on a candidate.
 */
export function transcriptTurns(transcript) {
  const turns = [], names = [];
  let current = null;
  for (const raw of String(transcript ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const text = raw.replace(/[\t ]+/g, ' ').trim();
    if (!text) continue;
    const m = TURN.exec(text);
    if (!m) {
      if (current) current.text += (current.text ? ' ' : '') + text;
      continue;
    }
    const said = line(m[1], 60);
    const name = (onlyANumber(said) ? '' : said) || line(m[2], 60);
    let speaker = names.indexOf(name);
    if (speaker < 0) speaker = names.length < MAX_SPEAKERS ? names.push(name) - 1 : MAX_SPEAKERS - 1;
    const start = secondsOf(m[3]);
    current = { speaker, start, end: Math.max(start, secondsOf(m[4])), text: m[5].trim() };
    turns.push(current);
  }
  return { turns: turns.filter((turn) => turn.text), speakers: Object.fromEntries(names.map((name, i) => [i, name])) };
}

// ---------- the three things The Book asks ----------
const LIST_FIELDS = ['default:start_time', 'default:calendar_event_title', 'default:candidate', 'default:interviewer', 'default:contact', 'default:conversation_type',
  'default:call_duration', 'default:video_conferencing_platform', 'default:phone_number'];

/** Whose key this is: { workspace, organization }. Also the way a key is tried before it is kept. */
export async function whoAmI(key, options) {
  const context = await askMetaview(key, 'get_user_context', { rationale: 'The Book is checking that the key works and which workspace it belongs to.' }, options);
  return { workspace: line(context.workspace_name, 120) || null, organization: context.organization_id != null ? line(String(context.organization_id), 60) : null };
}

/**
 * One page of the list of conversations, newest first: { conversations, received, total, more }. With `ids` (fifty
 * at most), those conversations only: the ones Metaview still has come back.
 */
export async function listConversations(key, { offset = 0, limit = PAGE_SIZE, ids = null } = {}, options) {
  const found = await askMetaview(key, 'search_conversations', {
    rationale: 'The Book is listing recorded conversations so recruiters can find them on their candidates.',
    limit: Math.min(ids ? ids.length : limit, PAGE_SIZE), offset, fields: LIST_FIELDS, ...(ids ? { conversation_ids: ids.slice(0, PAGE_SIZE) } : {}),
  }, options);
  if (!Array.isArray(found.conversations)) throw new MetaviewError('unreadable', { detail: 'the list of conversations was missing' });
  return {
    conversations: found.conversations.map(readConversation).filter(Boolean), received: found.conversations.length,
    total: Number.isFinite(Number(found.total_count)) ? Number(found.total_count) : null, more: found.has_more === true,
  };
}

/**
 * One conversation with its transcript and its notes: { conversation, transcript, notes, notesPending }, or null when
 * Metaview no longer has it. The notes are written by Metaview when they are first asked for, so they may not be
 * there yet: `notesPending` says they are on their way.
 */
export async function oneConversation(key, id, options) {
  const found = await askMetaview(key, 'search_conversations', {
    rationale: 'The Book is bringing one conversation onto its candidate, with its transcript and notes.',
    limit: 1, offset: 0, conversation_ids: [id], fields: [...LIST_FIELDS, 'default:transcript', 'default:summary'],
  }, options);
  const raw = Array.isArray(found.conversations) ? found.conversations.find((c) => Number(c?.id) === id) : null;
  const conversation = raw ? readConversation(raw) : null;
  if (!conversation) return null;
  const text = (field) => { const value = valuesOf(raw, field)[0]?.value; return typeof value === 'string' && value.trim() ? value : null; };
  const notes = text('default:summary');
  return {
    conversation, transcript: text('default:transcript'), notes,
    notesPending: !notes && Number(found.ai_processing?.['default:summary']?.pending_count) > 0,
  };
}
