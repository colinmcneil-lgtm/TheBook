// What Otterview tests share: a way to start the real server on a throwaway data folder, stand-ins for the two
// outside services it talks to (Deepgram for transcription, Anthropic for notes and write-ups), and a signed-in
// browser session.
//
// The stand-ins answer like the real services as far as the published descriptions go. Neither real service is
// called by the tests, so they cannot prove that Deepgram accepts a browser's actual recording.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
export const FIXTURES = path.join(HERE, 'fixtures');
/** A real nine-second recording made by Chromium's MediaRecorder: WebM with Opus sound and, as browsers write it, no length in its header. */
export const RECORDING = fs.readFileSync(path.join(FIXTURES, 'call.webm'));
export const CANNED = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'deepgram-canned.json'), 'utf8'));

// Ports: every test file's ports are counted from ORACLE_TEST_PORT (3610 unless set), thirty in a row in all.
//   +0 to +4    Otterview tests: three for servers, then one for each stand-in
//   +12, +13    the workspace tests: a server and a stand-in
//   +14, +15    people saved without a job (pool.test.mjs): a server and a stand-in for Metaview
//   +18, +19    the same file: a server with e-mail delivery connected, and a stand-in for its mail provider
//   +16, +17    the reporting tests: two servers
//   +20 to +29  the Metaview tests (see metaview-helpers.mjs)
// Node refuses to fetch from a few ports whatever is listening there (the list browsers refuse, among them 3659,
// 4045, 5060, 5061, 6000 and 6665 to 6669). Tests on such a port fail with nothing but "fetch failed", and one of
// them waits for minutes first. So a base that puts any of the thirty on one of them is refused here, before a
// single test runs, with a sentence that says which port and what to choose instead.
const REFUSED_BY_NODE = [1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139,
  143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061,
  6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080];
export const PORT_COUNT = 30;
/** Why this base cannot be used for the tests' thirty ports, as a sentence; nothing when it can. */
export function portsProblem(base) {
  if (!Number.isInteger(base) || base < 1024 || base + PORT_COUNT - 1 > 65535) return `ORACLE_TEST_PORT must be a whole number from 1024 to ${65536 - PORT_COUNT}: the tests use ${PORT_COUNT} ports in a row from it.`;
  const refused = REFUSED_BY_NODE.filter((port) => port >= base && port < base + PORT_COUNT);
  if (!refused.length) return null;
  const last = refused.at(-1);
  return `ORACLE_TEST_PORT=${base} cannot be used: the tests use the ${PORT_COUNT} ports ${base} to ${base + PORT_COUNT - 1}, and Node refuses to fetch from port ${refused.join(' and ')} `
    + `whatever is listening there. Choose a base above ${last} or below ${refused[0] - PORT_COUNT + 1} (and clear of ${REFUSED_BY_NODE.filter((port) => port > 1024).join(', ')}).`;
}
const BASE_PORT = Number(process.env.ORACLE_TEST_PORT) || 3610;
const problem = portsProblem(BASE_PORT);
if (problem) throw new Error(problem);
export const PORTS = { main: BASE_PORT, bare: BASE_PORT + 1, restart: BASE_PORT + 2, deepgram: BASE_PORT + 3, anthropic: BASE_PORT + 4, workspace: BASE_PORT + 12, workspaceAi: BASE_PORT + 13, pool: BASE_PORT + 14, metaview: BASE_PORT + 20 };

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const tempDir = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `the-book-${name}-`));

/** Start the real server. Resolves once it is listening; `stop()` ends it (pass 'SIGKILL' to pull the plug mid-work). */
export async function startServer({ port, dataDir, env = {} }) {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'production', PORT: String(port), DATA_DIR: dataDir, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  for (let waited = 0; !output.includes('is running on'); waited += 50) {
    if (child.exitCode !== null || waited > 15000) throw new Error(`The server did not start:\n${output}`);
    await sleep(50);
  }
  return {
    base: `http://127.0.0.1:${port}`,
    output: () => output,
    stop: async (signal = 'SIGTERM') => { child.kill(signal); await exited; },
  };
}

const listen = (server, port) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
const close = (server) => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });

/**
 * Stand-in for Deepgram's POST /v1/listen. It checks each request the way the real service would (and a few ways
 * it would not, noted as `problems`: things the real service lets through silently but that must be right).
 * What it answers is chosen by the API key, or by `mode` when a test sets it:
 *   good        the canned transcript          bad      401, key rejected        broke    402, out of credit
 *   busy        429 every time                 busy-once 429 once, then good     corrupt  400, audio unreadable
 *   gateway     504 with a web page as body    slow     never answers            silent   200 with no speech
 *   nodiarize   200 with no speaker numbers    newshape 400 in the newer error shape      text  500 as plain text
 *   olddiarize  400 naming diarize_model whenever it is sent, good with the older "diarize=true"
 * Setting `delay` (milliseconds) makes every answer take that long, as the real service does.
 */
export async function deepgramStandIn(port = PORTS.deepgram) {
  const state = { requests: [], mode: null, delay: 0, hanging: [] };
  let busyOnceSeen = false;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      if (state.delay) await sleep(state.delay);
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://x');
      const query = Object.fromEntries(url.searchParams);
      const auth = String(req.headers.authorization || '');
      const key = auth.startsWith('Token ') ? auth.slice(6) : null;
      const mode = state.mode || key;
      const problems = [];
      if (query.model !== 'nova-3') problems.push('model is not nova-3: the real service would quietly use an old model');
      for (const name of ['utterances', 'punctuate', 'smart_format', 'paragraphs']) if (query[name] !== 'true') problems.push(`${name} is not true: the real answer would lack that part`);
      if (query.mip_opt_out !== 'true') problems.push('mip_opt_out is not true: the call would be kept and used for training');
      if (query.multichannel === 'true') problems.push('multichannel=true was sent: speakers would be numbered by channel, not told apart by voice');
      if (!('diarize_model' in query) && query.diarize !== 'true') problems.push('diarize_model and diarize are both missing: no speaker numbers would come back');
      if (Number(req.headers['content-length']) !== body.length) problems.push('Content-Length does not match the body');
      state.requests.push({
        method: req.method, path: url.pathname, query, authorization: auth, contentType: req.headers['content-type'],
        contentLength: Number(req.headers['content-length']), bytes: body.length, head: body.subarray(0, 4).toString('hex'), mode, problems,
      });
      const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
      const err = (status, code, message) => send(status, { err_code: code, err_msg: message, request_id: 'req_stub' });
      if (req.method !== 'POST' || url.pathname !== '/v1/listen') return send(404, { err_code: 'NOT_FOUND', err_msg: 'Not found.' });
      if (!key || mode === 'bad') return err(401, 'INVALID_AUTH', 'Invalid credentials.');
      if (mode === 'broke') return err(402, 'ASR_PAYMENT_REQUIRED', 'Project does not have enough credits for an ASR request and does not have an overage agreement.');
      if (mode === 'busy' || (mode === 'busy-once' && !busyOnceSeen && (busyOnceSeen = true))) return err(429, 'TOO_MANY_REQUESTS', 'Too many requests. Please try again later.');
      if (mode === 'slow') return state.hanging.push(res);
      if (mode === 'gateway') { res.writeHead(504, { 'Content-Type': 'text/html' }); return res.end('<html>504 Gateway Time-out</html>'); }
      if (mode === 'text') { res.writeHead(500, { 'Content-Type': 'text/plain' }); return res.end('upstream connect error'); }
      if (mode === 'newshape') return send(400, { category: 'INVALID_REQUEST', message: 'The audio could not be decoded.', details: 'corrupt or unsupported data', request_id: 'req_stub' });
      if (mode === 'olddiarize' && 'diarize_model' in query) return err(400, 'INVALID_QUERY_PARAMETER', 'Invalid query parameter: diarize_model');
      if ('diarize' in query && 'diarize_model' in query) return err(400, 'INVALID_QUERY_PARAMETER', 'diarize and diarize_model cannot both be set.');
      // The start of a real recording: WebM, MP4 (as Safari records), or one of the other kinds people upload.
      const ascii = (from, to) => body.subarray(from, to).toString('latin1');
      const audio = body.subarray(0, 4).toString('hex') === '1a45dfa3' || ascii(4, 8) === 'ftyp' || ascii(0, 4) === 'OggS' || ascii(0, 4) === 'RIFF' || ascii(0, 3) === 'ID3';
      const envelope = /multipart\/form-data|x-www-form-urlencoded/.test(req.headers['content-type'] || '');
      if (mode === 'corrupt' || envelope || !body.length || !audio) return err(400, 'Bad Request', 'Bad Request: failed to process audio: corrupt or unsupported data');
      const quiet = () => ({ alternatives: [{ transcript: '', confidence: 0, words: [] }] });
      if (mode === 'silent') return send(200, { ...CANNED, results: { channels: [quiet()], utterances: [] } });
      if (mode === 'nodiarize') {
        const { diarize_info, ...metadata } = CANNED.metadata;
        return send(200, { metadata, results: { ...CANNED.results, utterances: CANNED.results.utterances.map(({ speaker, ...rest }) => rest) } });
      }
      send(200, CANNED);
    });
  });
  await listen(server, port);
  return Object.assign(state, {
    url: `http://127.0.0.1:${port}/v1/listen`,
    reset: () => { state.requests.length = 0; state.mode = null; state.delay = 0; busyOnceSeen = false; },
    stop: () => { state.hanging.forEach((res) => res.destroy()); return close(server); },
  });
}

export const NOTES_DRAFT = {
  overview: 'Sam leads six account executives at Varsity Freight and is open to a move for a bigger remit. Next step is a call with the hiring manager.',
  sections: [
    { heading: 'Background and current role', points: ['Leads six account executives at Varsity Freight.', 'The team closed 2.4 million last year.'] },
    { heading: 'Pay (current and expected)', points: ['Looking for around 90,000 base.'] },
    { heading: 'Next steps:', points: ['- Send the job description.'] },
    { heading: 'Notice period and availability', points: [] },
  ],
  speakers: [{ speaker: 0, role: 'recruiter', name: '' }, { speaker: 1, role: 'candidate', name: 'Sam' }],
};
export const SUBMISSION_DRAFT = { submission: 'I spoke to this candidate on Monday.\n\nThey lead a team of six account executives and closed 2.4 million last year. They are looking for around 90,000 base.' };

/**
 * Stand-in for the Anthropic Messages API. It tells the two Oracle requests apart by the answer shape each asks
 * for, and replies according to the API key, or `mode` when a test sets it:
 *   good  a valid answer      bad  401, key rejected      busy  429 every time      refuse  the model declines
 *   hang  takes the request and never answers
 * Setting `delay` (milliseconds) makes every answer take that long, as the real service does.
 */
export async function anthropicStandIn(port = PORTS.anthropic) {
  const state = { requests: [], mode: null, delay: 0, hanging: [] };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', async () => {
      if (state.delay) await sleep(state.delay);
      const key = req.headers['x-api-key'] || String(req.headers.authorization || '').replace(/^Bearer /, '');
      const body = raw ? JSON.parse(raw) : null;
      const mode = state.mode || key;
      const wants = body?.output_config?.format?.schema?.properties ?? {};
      const kind = 'submission' in wants ? 'submission' : 'overview' in wants ? 'notes' : 'other';
      state.requests.push({ method: req.method, url: req.url, key, beta: req.headers['anthropic-beta'], body, kind, mode });
      const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'request-id': 'req_stub' }); res.end(JSON.stringify(value)); };
      if (mode === 'hang') return state.hanging.push(res);
      if (mode === 'bad') return send(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
      if (mode === 'busy') return send(429, { type: 'error', error: { type: 'rate_limit_error', message: 'rate limited' } });
      const base = { id: 'msg_stub', type: 'message', role: 'assistant', model: body?.model, stop_sequence: null, usage: { input_tokens: 1000, output_tokens: 500 } };
      if (mode === 'refuse') return send(200, { ...base, content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: null, explanation: 'declined' } });
      send(200, { ...base, content: [{ type: 'text', text: JSON.stringify(kind === 'submission' ? SUBMISSION_DRAFT : NOTES_DRAFT) }], stop_reason: 'end_turn' });
    });
  });
  await listen(server, port);
  return Object.assign(state, {
    url: `http://127.0.0.1:${port}`,
    reset: () => { state.requests.length = 0; state.mode = null; state.delay = 0; },
    stop: () => { state.hanging.forEach((res) => res.destroy()); return close(server); },
  });
}

/** A browser session against the server: remembers the sign-in cookie and speaks JSON. Answers are { status, body, headers }. */
export function session(base) {
  let cookie = '';
  async function call(method, pathname, { json, body, headers = {} } = {}) {
    const res = await fetch(`${base}/api${pathname}`, {
      method,
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: json !== undefined ? JSON.stringify(json) : body,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  }
  const form = (fields) => {
    const data = new FormData();
    for (const [name, value] of Object.entries(fields)) {
      if (value && typeof value === 'object') data.append(name, new Blob([value.bytes]), value.name);
      else if (value !== undefined) data.append(name, String(value));
    }
    return data;
  };
  return {
    /** The sign-in cookie, for a test that has to make a request by hand. */
    cookie: () => cookie,
    get: (p, headers) => call('GET', p, { headers }),
    post: (p, json = {}) => call('POST', p, { json }),
    patch: (p, json = {}) => call('PATCH', p, { json }),
    del: (p) => call('DELETE', p),
    /** Send bytes as they are (a piece of a recording). */
    put: (p, bytes) => call('PUT', p, { body: bytes, headers: { 'Content-Type': 'application/octet-stream' } }),
    /** PUT with a JSON body (a setting). */
    putJson: (p, json = {}) => call('PUT', p, { json }),
    /** A form with files: { field: 'text', audio: { name: 'call.webm', bytes } }. */
    upload: (p, fields) => call('POST', p, { body: form(fields) }),
  };
}

/** Cut a recording into `count` pieces of roughly equal size, as a browser sends them. */
export function pieces(recording, count) {
  const size = Math.ceil(recording.length / count);
  return Array.from({ length: count }, (_, i) => recording.subarray(i * size, (i + 1) * size));
}

/** Ask `read()` again and again until `done(answer)` says yes; fails after `timeout` ms with the last answer. */
export async function until(read, done, timeout = 15000) {
  let last;
  for (const start = Date.now(); Date.now() - start < timeout;) {
    last = await read();
    if (done(last)) return last;
    await sleep(40);
  }
  throw new Error(`Timed out waiting. Last answer: ${JSON.stringify(last)?.slice(0, 600)}`);
}
