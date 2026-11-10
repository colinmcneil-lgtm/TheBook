// A stand-in for Metaview's connection, so The Book can be built and tested without ever reading a real workspace.
//
// It behaves the way the real server was seen to behave (November 2026):
//   - one address, POST /mcp, with "Authorization: Bearer <key>". Without a good key: 401, an empty body and a
//     www-authenticate header.
//   - stateless: tools/call works straight away, with no "initialize" first and no session.
//   - an answer is a text/event-stream of "event: message" blocks, each carrying one JSON-RPC message. There may be a
//     notification before the answer; the answer is the message with the request's id. `plainJson` makes it answer
//     with an ordinary application/json body, which the protocol also allows.
//   - a tool's answer is a JSON document, as a string, in result.content[0].text. With isError true the text is the reason.
//   - search_conversations lists conversations newest first, 50 at most, with limit, offset, conversation_ids and
//     fields, and says total_count and has_more. The transcript is one string of "Name (Role) @M:SS-M:SS: words"
//     lines. The notes ("default:summary") are written on demand: the first request for a conversation's notes
//     comes back without them and says they are being written; a later one has them.
//
// Everybody in it is invented. Phone numbers are from the range kept for fiction (555-01xx) and addresses end in
// ".example". There are about 130 conversations, the newest twenty minutes old and one roughly every nine hours
// before that, among them: people known only by a first name, people with a phone number and no address, calls
// with two interviewers, a few with no transcript, one over an hour long, phone calls and video meetings, and one
// whose caller Metaview has no name for, so that their phone number stands where the name would be (the real
// service was seen to do this for about one call in twenty-five).
//
// A second workspace can be added with a key of its own (`addWorkspace`), for what happens when the key is changed
// to one that belongs to somebody else's Metaview.
//
// Every request is kept in `requests`, so a test can prove that nothing but the read-only tools was ever called.
// Faults can be switched on for the next request (`faults.push('429')`) or for all of them (`fault = '500'`):
//   slow       takes the request and never answers           429, 500    that status
//   tool-error the tool answers with isError true            malformed   the tool's text is not JSON
//   garbage    the body is not an event stream at all        drop        the connection is cut half-way through the answer
//
// Run it by itself to build screens against it:  node test/metaview-standin.mjs 4310   (the key is "mv-standin-key")
import http from 'node:http';
import { fileURLToPath } from 'node:url';

export const GOOD_KEY = 'mv-standin-key';
export const WORKSPACE = 'Harbour Talent Partners';
export const READ_ONLY_TOOLS = ['get_user_context', 'search_conversations', 'list_fields', 'list_field_values'];
// Tools the real server also has, which write or cost money. The stand-in refuses them, and a test fails if one is ever asked for.
const OTHER_TOOLS = ['generate_notes', 'create_ai_field', 'create_report', 'create_snippet', 'manage_note_template', 'submit_feedback', 'enrich_candidate_contacts'];

const HOUR = 3600000;
const FIRST = ['Dana', 'Jonas', 'Amara', 'Kevin', 'Chloe', 'Farid', 'Grace', 'Hugo', 'Imani', 'Keiko', 'Liam', 'Mina', 'Noah', 'Olivia', 'Pedro', 'Quinn',
  'Rosa', 'Samir', 'Tara', 'Uma', 'Victor', 'Wren', 'Yusuf', 'Zoë', 'Anders', 'Bianca', 'Callum', 'Esme', 'Felix', 'Hana'];
const LAST = ['Whitlock', 'Brandt', 'Adeyemi', 'Tremblay', 'Castillo', 'Haddad', 'Greene', 'Fontaine', 'Okafor', 'Nakamura', 'Jensen', 'Kaur', 'Lindqvist',
  'Moreau', 'Petrov', 'Quigley', 'Rahman', 'Silva', 'Thackeray', 'Ueda', 'Vasquez', 'Yilmaz', 'Zamora', 'Ashby', 'Chowdhury', 'Delacroix', 'Ekwueme', 'Dunne', 'Eriksen', 'Ivanova'];
const AREAS = ['416', '647', '437', '905', '289', '613'];
const plain = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const uuid = (kind, n) => `${kind}0000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** The 48 invented people the conversations are with. Each has a name, an address and a number; a conversation may show only some of that. */
export const PEOPLE = Array.from({ length: 48 }, (_, n) => {
  // No two share a whole name, but some share a first name (the 4th and the 34th are both Kevin).
  const first = FIRST[n % FIRST.length], last = LAST[(n * 7 + 3 + Math.floor(n / FIRST.length) * 11) % LAST.length];
  return {
    n, name: `${first} ${last}`, first, email: `${plain(first)}.${plain(last)}@mail.example`,
    phone: `+1${AREAS[n % AREAS.length]}55501${String(n).padStart(2, '0')}`,
    job: ['Account Executive', 'Platform Engineer', 'Product Designer', 'Financial Controller'][n % 4], company: ['Brightwater', 'Coppermill', 'Ostrava Labs', 'Tidewell'][n % 4],
  };
});
/** The agency's own people, who take the calls. The first three have the names and addresses the tests give their users of The Book. */
export const INTERVIEWERS = [
  { name: 'Priya Nair', email: 'priya@agency.example', phone: '+16475550142' },
  { name: 'Sam Okoro', email: 'sam@agency.example', phone: null },
  { name: 'Alex Morgan', email: 'alex@agency.example', phone: null },
  { name: 'Jordan Reyes', email: 'jordan@agency.example', phone: '+14165550177' },
];
/** Somebody at a client, who is on a few meetings that have no candidate at all. */
export const CLIENT_CONTACT = { name: 'Maya Okonkwo', email: 'maya@kestrel.example', phone: null };

/** Which conversations are the unusual ones, by their place in the list (0 is the newest). */
export const SPECIAL = { hourLong: 20, noTranscript: [7, 58, 101], numberForName: 64 };

const clockOf = (seconds) => {
  const s = Math.floor(seconds), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};
const QUESTIONS = [
  'thanks for making the time today. How are things?', 'Can you tell me what you do now?', 'What is making you open to a move?', 'What are you looking for on pay?',
  'What is your notice period?', 'How do you feel about three days a week in the office?', 'Are you talking to anyone else at the moment?', 'Is there anything you would like to ask me?',
];
const ANSWERS = [
  'Good, thanks. How are you?', 'I lead a small team and I have been there four years.', 'I would like a bigger remit: the ratio here is 3:1 and it is not changing.',
  'Around 90,000 base (roughly) and a bonus on top.', 'One month, though they may let me go sooner.', 'That works for me @ the moment: two days at home is plenty.',
  'One other process, at an early stage.', 'When would you want somebody to start?',
];
/** The transcript of a conversation: one line per turn, as the real field holds it. */
function transcriptOf(c) {
  const turns = Math.max(8, Math.round(c.minutes * 2.2));
  const each = (c.minutes * 60) / turns;
  const lines = [];
  for (let t = 0; t < turns; t++) {
    const start = t * each + 1, end = start + each * (t % 5 === 4 ? 1.2 : 0.9); // every fifth turn runs on into the next one
    const asking = t % 2 === 0;
    const who = asking ? c.interviewers[(t / 2) % c.interviewers.length] : c.other;
    const words = asking ? `${t === 0 ? `Hi ${/^\+/.test(c.other.shown) ? 'there' : c.other.shown.split(' ')[0]}, ` : ''}${QUESTIONS[(t / 2) % QUESTIONS.length]}` : ANSWERS[((t - 1) / 2) % ANSWERS.length];
    lines.push(`${who.shown ?? who.name} (${asking ? 'Interviewer' : c.candidate ? 'Candidate' : 'Contact'}) @${clockOf(start)}-${clockOf(end)}: ${words}`);
    // One turn in a long call is written over two lines, as dictated notes sometimes are.
    if (c.minutes > 60 && t === 5) lines.push('I should add: the team is six people now.');
  }
  return lines.join('\n');
}
/** The notes Metaview writes for a conversation: a heading line, then "- " points, with a blank line or two between sections. */
const summaryOf = (c) => [
  `${c.kind} with ${c.other.shown}`,
  `Background\n- Leads a small team and has been in the role four years.\n- Works as ${c.other.job ?? 'a hiring manager'} at ${c.other.company ?? 'Kestrel Logistics'}.`,
  `Motivation\n- Wants a bigger remit.\n`,
  `Pay and notice\n- Looking for around 90,000 base and a bonus.\n- Notice period is one month.`,
  `Next steps\n- ${c.interviewers[0].name.split(' ')[0]} to send the job description.`,
].join('\n\n');

/** The invented conversations, newest first, as they stand at `now`. */
export function makeConversations(count = 130, now = Date.now()) {
  return Array.from({ length: count }, (_, i) => {
    const person = PEOPLE[i % PEOPLE.length];
    const noCandidate = i % 17 === 9;                        // a meeting with a client, nobody being interviewed
    const firstOnly = !noCandidate && i % 10 === 3;          // Metaview only knows a first name
    const numberForName = i === SPECIAL.numberForName;       // Metaview has no name at all: the number stands in for it
    const phoneOnly = firstOnly || numberForName || i % 4 === 1, emailOnly = !phoneOnly && i % 4 === 2;
    const video = i % 3 === 0;
    const interviewers = i % 13 === 5 ? [INTERVIEWERS[i % 4], INTERVIEWERS[(i + 1) % 4]] : [INTERVIEWERS[i % 4]];
    const other = noCandidate ? { ...CLIENT_CONTACT, shown: CLIENT_CONTACT.name, emails: [CLIENT_CONTACT.email], phones: [] }
      : { ...person, shown: numberForName ? person.phone : firstOnly ? person.first : person.name, emails: phoneOnly ? [] : [person.email], phones: emailOnly ? [] : [person.phone] };
    const started = new Date(now - 20 * 60000 - i * 9 * HOUR - ((i * 37) % 50) * 60000);
    const c = {
      index: i, id: 880000000 + (count - i) * 137, started, has_transcript: !SPECIAL.noTranscript.includes(i),
      kind: noCandidate ? 'Client Meeting' : i % 11 === 4 ? 'Screening Call' : 'Job Interview',
      channel: video ? ['Zoom', 'Google Meet', 'Teams'][(i / 3) % 3] : 'Phone',
      minutes: i === SPECIAL.hourLong ? 75 : 5 + ((i * 7) % 40), language: i % 29 === 0 && i ? 'French (Canada)' : 'English (US)',
      title: video ? `${other.shown} and ${interviewers[0].name.split(' ')[0]}: ${noCandidate ? 'hiring plan' : 'first conversation'}` : '',
      person: noCandidate ? null : person, candidate: !noCandidate, other, interviewers, notesAsked: 0,
    };
    c.url = `https://app.metaview.ai/notes/${c.id}`;
    return c;
  });
}

const FIELDS = {
  'default:start_time': ['Start time', 'datetime'], 'default:calendar_event_title': ['Calendar event title', 'string'], 'default:candidate': ['Candidate', 'participant_list'],
  'default:interviewer': ['Interviewer', 'participant_list'], 'default:contact': ['Contact', 'participant_list'], 'default:conversation_type': ['Conversation type', 'string'],
  'default:call_duration': ['Call duration', 'number'], 'default:video_conferencing_platform': ['Platform', 'string'], 'default:phone_number': ['Phone number', 'string_list'],
  'default:language': ['Language', 'string'], 'default:transcript': ['Transcript', 'text'], 'default:summary': ['Summary', 'ai_text'],
};
const one = (value, label = String(value)) => [{ value, label }];
/** A number that stands for somebody who is not one of PEOPLE, the same every time for the same person and different for different people. */
const numberFor = (p) => [...`${p.name}|${p.email ?? ''}|${p.phone ?? ''}`].reduce((sum, ch) => (sum * 31 + ch.codePointAt(0)) % 999999937, 7);
const participant = (kind, p) => ({ value: uuid(kind, p.n ?? numberFor(p)), label: p.shown ?? p.name,
  details: { name: p.shown ?? p.name, emails: p.emails ?? (p.email ? [p.email] : []), phone_numbers: p.phones ?? (p.phone ? [p.phone] : []) } });
/** One field of one conversation, in the shape the real server gives: always a list, which may be empty. */
function fieldOf(c, field, state) {
  // The real server writes times two ways; both are given here.
  const time = c.started.toISOString().replace('T', ' ').replace('Z', c.index % 2 ? '+00:00' : '643+00:00').replace(/\.\d+\+/, (m) => (c.index % 2 ? '+' : m));
  switch (field) {
    case 'default:start_time': return one(time, c.started.toUTCString());
    case 'default:calendar_event_title': return one(c.title, c.title);
    case 'default:candidate': return c.candidate ? [c.other, ...(c.also ?? [])].map((p) => participant('cand', p)) : [];
    case 'default:interviewer': return c.interviewers.map((p) => participant('intv', { ...p, n: INTERVIEWERS.indexOf(p) }));
    case 'default:contact': return [participant(c.candidate ? 'cand' : 'cont', c.other), ...(c.also ?? []).map((p) => participant('cand', p)), ...c.interviewers.map((p) => participant('intv', { ...p, n: INTERVIEWERS.indexOf(p) }))];
    case 'default:conversation_type': return one(uuid('type', c.kind.length), c.kind);
    case 'default:call_duration': return one(c.minutes);
    case 'default:video_conferencing_platform': return one(c.channel);
    case 'default:phone_number': return c.candidate && c.other.phones.length ? one(c.other.phones[0]) : c.index % 6 === 0 ? undefined : [];
    case 'default:language': return one(c.language);
    case 'default:transcript': return c.has_transcript ? one(c.transcript ?? transcriptOf(c), 'Transcript') : [];
    case 'default:summary': return c.has_transcript && c.notesAsked > state.notesAfter ? one(c.summary ?? summaryOf(c), 'Summary') : [];
    default: return undefined;
  }
}

function searchConversations(state, args) {
  if (Number(args.limit) > 50) throw new Error('limit must be 50 or less.');
  if (args.filters?.length) throw new Error('The stand-in does not know any filters: The Book is not meant to rely on them.');
  const fields = Array.isArray(args.fields) && args.fields.length ? args.fields : ['default:start_time', 'default:calendar_event_title', 'default:candidate', 'default:interviewer'];
  const unknown = fields.filter((f) => !FIELDS[f]);
  if (unknown.length) throw new Error(`Unknown field: ${unknown.join(', ')}`);
  let found = [...state.conversations].sort((a, b) => b.started - a.started || b.id - a.id);
  if (args.sort_ascending) found.reverse();
  if (Array.isArray(args.conversation_ids)) found = found.filter((c) => args.conversation_ids.includes(c.id));
  const offset = Math.max(0, Number(args.offset) || 0), limit = Math.max(1, Number(args.limit) || 10);
  const page = found.slice(offset, offset + limit);
  let pending = 0;
  const conversations = page.map((c) => {
    if (fields.includes('default:summary') && c.has_transcript) { c.notesAsked++; if (c.notesAsked <= state.notesAfter) pending++; }
    const out = {};
    for (const field of fields) { const value = fieldOf(c, field, state); if (value !== undefined) out[field] = value; }
    return { id: c.id, url: c.url, has_transcript: c.has_transcript, fields: out };
  });
  return {
    access_scope: 'organization', field_definitions: fields.map((f) => ({ field_id: f, name: FIELDS[f][0], type: FIELDS[f][1] })),
    conversations, total_count: found.length, has_more: offset + page.length < found.length,
    message: pending ? `AI field analysis in progress for ${pending} conversations. Retry in ~30 seconds for complete results.` : `Found ${found.length} conversations.`,
    ...(pending ? { ai_processing: { 'default:summary': { pending_count: pending, total_count: page.length } } } : {}),
  };
}

/** What a tool answers, as the document that goes in content[0].text. Throws the reason when the tool refuses. */
function runTool(state, name, args) {
  if (typeof args?.rationale !== 'string' || !args.rationale.trim()) throw new Error('rationale is required.');
  if (name === 'get_user_context') {
    return { access_scope: 'organization', organization_id: state.organizationId, workspace_name: state.workspace, user_id: 1000001, participant_id: uuid('user', 1),
      is_admin: true, is_paying_plan: true, data_access: 'You can see all conversations in the organization.' };
  }
  if (name === 'search_conversations') return searchConversations(state, args);
  if (name === 'list_fields') return { fields: Object.entries(FIELDS).map(([field_id, [label, type]]) => ({ field_id, name: label, type })), filter_formats: {} };
  if (name === 'list_field_values') return { values: [] };
  throw new Error(`The stand-in does not run ${name}: The Book only ever reads.`);
}

const listen = (server, port) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });

/**
 * Start the stand-in on a port. Resolves to its state, which a test may change as it goes:
 *   conversations   the list itself (change one, or use `add`)       keys        the keys that are accepted
 *   notesAfter      how many requests for a conversation's notes come back without them first (1; Infinity = never)
 *   fault, faults   see the top of this file                          plainJson   answer without the event stream
 *   delay           milliseconds every answer takes                   requests    every request received
 *   mostAtOnce      the most requests that were ever under way at the same moment
 */
export async function metaviewStandIn(port, { count = 130, now = Date.now(), keys = [GOOD_KEY] } = {}) {
  const state = {
    conversations: makeConversations(count, now), keys: new Set(keys), workspace: WORKSPACE, organizationId: 4242,
    others: new Map(),            // key -> { workspace, organizationId, conversations }: other workspaces, each reached with its own key
    notesAfter: 1, fault: null, faults: [], plainJson: false, delay: 0, requests: [], hanging: [], answered: 0,
    inFlight: 0, mostAtOnce: 0,   // how many requests were being dealt with at the same moment, at most
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    state.mostAtOnce = Math.max(state.mostAtOnce, ++state.inFlight);
    res.once('close', () => { state.inFlight--; });
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', async () => {
      let rpc = null;
      try { rpc = JSON.parse(raw); } catch { /* answered below */ }
      const key = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1] ?? null;
      const entry = {
        at: Date.now(), method: req.method, path: req.url, key, keyOk: state.keys.has(key) || state.others.has(key), rpc: rpc?.method ?? null,
        tool: rpc?.method === 'tools/call' ? rpc.params?.name ?? null : null, args: rpc?.params?.arguments ?? null,
        accept: req.headers.accept, contentType: req.headers['content-type'], protocol: req.headers['mcp-protocol-version'], fault: null,
      };
      state.requests.push(entry);
      if (state.delay) await new Promise((resolve) => setTimeout(resolve, state.delay));
      if (req.url !== '/mcp') { res.writeHead(404); return res.end(); }
      if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); return res.end(); }
      if (!entry.keyOk) {
        res.writeHead(401, { 'www-authenticate': 'Bearer resource_metadata="https://mcp.metaview.ai/.well-known/oauth-protected-resource/mcp"' });
        return res.end();
      }
      const fault = entry.fault = state.faults.shift() ?? state.fault;
      if (fault === 'slow') return state.hanging.push(res);
      if (fault === '429') { res.writeHead(429, { 'Content-Type': 'application/json' }); return res.end('{"error":"Too Many Requests"}'); }
      if (fault === '500') { res.writeHead(500, { 'Content-Type': 'text/plain' }); return res.end('Internal Server Error'); }
      if (fault === 'garbage') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); return res.end('<html>this is not what was asked for</html>'); }
      if (!rpc || rpc.jsonrpc !== '2.0') { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end('{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}'); }
      // A notification has no id and gets no answer.
      if (rpc.id === undefined) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(); }

      let message;
      if (rpc.method === 'initialize') {
        message = { result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'metaview-reports-mcp', version: '3.4.10' } } };
      } else if (rpc.method === 'tools/list') {
        message = { result: { tools: [...READ_ONLY_TOOLS, ...OTHER_TOOLS].map((name) => ({ name, inputSchema: { type: 'object', required: ['rationale'] } })) } };
      } else if (rpc.method === 'tools/call') {
        let text, isError = false;
        try {
          if (fault === 'tool-error') throw new Error('Something went wrong running this tool.');
          // A key for another workspace sees that workspace: its name and its conversations, nothing of this one's.
          const seen = state.others.has(key) ? { ...state, ...state.others.get(key) } : state;
          text = JSON.stringify(runTool(seen, rpc.params?.name, rpc.params?.arguments));
          if (fault === 'malformed') text = `Here is what I found: ${text.slice(0, 40)}`;
        } catch (err) { text = err.message; isError = true; }
        message = { result: { content: [{ type: 'text', text }], isError } };
      } else {
        message = { error: { code: -32601, message: 'Method not found' } };
      }
      const answer = JSON.stringify({ jsonrpc: '2.0', id: rpc.id, ...message });
      state.answered++;
      if (state.plainJson) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(answer); }
      // Every third answer has a notification in front of it, as the real server sometimes sends.
      const blocks = [];
      if (state.answered % 3 === 0) blocks.push(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'Working on it.' } })}\n\n`);
      blocks.push(`event: message\ndata: ${answer}\n\n`);
      const body = blocks.join('');
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      // Sent in two parts, because a stream does not arrive in one piece.
      const half = Math.floor(body.length / 2);
      res.write(body.slice(0, half));
      if (fault === 'drop') return setTimeout(() => res.destroy(), 20);
      setTimeout(() => res.end(body.slice(half)), 5);
    });
  });
  await listen(server, port);
  let added = 0;
  return Object.assign(state, {
    url: `http://127.0.0.1:${port}/mcp`,
    /** The conversation at a place in the list as it was made (0 was the newest). */
    at: (index) => state.conversations.find((c) => c.index === index),
    /** A new conversation, a minute old unless `minutesAgo` says otherwise. `person` is one of PEOPLE, or anything shaped like one. */
    add({ person, also = [], minutesAgo = 1, minutes = 12, channel = 'Phone', title = '', interviewers = [INTERVIEWERS[0]], emails, phones, shown, has_transcript = true, kind = 'Job Interview' } = {}) {
      const c = {
        index: -(++added), id: 990000000 + added, started: new Date(Date.now() - minutesAgo * 60000), has_transcript, kind, channel, minutes, language: 'English (US)', title,
        person, candidate: true, interviewers, notesAsked: 0,
        also: also.map((p) => ({ ...p, shown: p.name, emails: p.email ? [p.email] : [], phones: p.phone ? [p.phone] : [] })),   // more candidates on the same call
        other: { ...person, shown: shown ?? person.name, emails: emails ?? (person.email ? [person.email] : []), phones: phones ?? (person.phone ? [person.phone] : []) },
      };
      c.url = `https://app.metaview.ai/notes/${c.id}`;
      state.conversations.push(c);
      return c;
    },
    /** Another workspace, reached with `key`: its conversations have numbers of their own, so they can be told from this one's. */
    addWorkspace(key, { workspace = 'Another Agency', organizationId = 5151, count = 60 } = {}) {
      const conversations = makeConversations(count).map((c) => ({ ...c, id: c.id + 50000000, url: `https://app.metaview.ai/notes/${c.id + 50000000}` }));
      state.others.set(key, { workspace, organizationId, conversations });
      return conversations;
    },
    /** Only the requests that asked a tool to do something. */
    toolCalls: () => state.requests.filter((r) => r.tool),
    reset() { state.requests.length = 0; state.fault = null; state.faults.length = 0; state.plainJson = false; state.delay = 0; },
    stop() { state.hanging.forEach((res) => res.destroy()); server.closeAllConnections?.(); return new Promise((resolve) => server.close(resolve)); },
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2]) || 4310;
  const standIn = await metaviewStandIn(port);
  console.log(`The Metaview stand-in is answering on ${standIn.url} (the key is "${GOOD_KEY}").`);
  console.log(`Start The Book with METAVIEW_API_URL=${standIn.url} to read it.`);
}
