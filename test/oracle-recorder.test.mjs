// The Oracle's uploader: what happens to a recording that was cut off. Run with `npm test`.
// The browser pieces it leans on (fetch, localStorage, window events) are stood in for here; the recorder itself
// (microphone, audio mix) only exists in a browser and was checked there.
import test from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.window = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };

const { ChunkUploader, formatElapsed } = await import('../src/oracle/recorder.js');

const MARKER = 'oracle:active-recording';
const ID = 'a'.repeat(32);
const longAgo = Date.now() - 60_000;
const mark = (extra = {}) => store.set(MARKER, JSON.stringify({ id: ID, call_id: 7, userId: 1, startedAt: longAgo, beat: longAgo, elapsedMs: 12_000, ...extra }));

/** A stand-in server: `routes` maps "METHOD /path" to a reply; every request is kept in `seen`. */
function server(routes) {
  const seen = [];
  globalThis.fetch = async (url, opts = {}) => {
    const key = `${opts.method || 'GET'} ${url}`;
    seen.push({ key, body: typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body });
    const reply = typeof routes[key] === 'function' ? routes[key]() : routes[key];
    if (!reply) throw new TypeError('Failed to fetch');
    const [status, data] = reply;
    return { ok: status < 400, status, headers: { get: () => 'application/json' }, json: async () => data };
  };
  return seen;
}

test('nothing to recover when no recording was in progress', async () => {
  store.clear();
  const seen = server({});
  assert.equal(await ChunkUploader.recover({ userId: 1 }), null);
  assert.equal(seen.length, 0);
});

test('someone else’s interrupted recording on a shared computer is left for them', async () => {
  store.clear(); mark({ userId: 2 });
  const seen = server({});
  assert.equal(await ChunkUploader.recover({ userId: 1 }), null);
  assert.equal(seen.length, 0);
  assert.ok(store.has(MARKER));
  assert.equal(ChunkUploader.interrupted(1), false);
  assert.equal(ChunkUploader.interrupted(2), true);
});

test('a recording still going in another tab is not finished from this one', async () => {
  store.clear(); mark({ beat: Date.now() });
  const seen = server({});
  // Where the runtime has the Web Locks API, "the other tab" is whoever holds the lock; elsewhere, a fresh heartbeat.
  let letGo = () => {};
  if (globalThis.navigator?.locks) await new Promise((held) => { navigator.locks.request('oracle-recording', () => new Promise((release) => { letGo = release; held(); })); });
  assert.deepEqual(await ChunkUploader.recover({ userId: 1 }), { busy: true });
  assert.equal(seen.length, 0);
  assert.ok(store.has(MARKER));
  letGo();
});

test('an interrupted recording is finished with the unbroken run of parts the server holds', async () => {
  store.clear(); mark();
  const seen = server({
    [`GET /api/oracle/recordings/${ID}`]: [200, { status: 'recording', received: [0, 1, 3], call_id: 7 }],
    [`POST /api/oracle/recordings/${ID}/finish`]: [200, { call_id: 7, status: 'transcribing' }],
  });
  assert.deepEqual(await ChunkUploader.recover({ userId: 1 }), { call_id: 7, status: 'transcribing' });
  assert.deepEqual(seen.at(-1).body, { chunks: 2, durationMs: 12_000, interrupted: true }); // part 2 never arrived, so part 3 cannot be used
  assert.equal(store.has(MARKER), false);
});

test('when the server cannot be reached, everything is kept for another try', async () => {
  store.clear(); mark();
  server({});
  await assert.rejects(ChunkUploader.recover({ userId: 1 }));
  assert.ok(store.has(MARKER));
});

test('a recording that was already finished, or deleted, is simply forgotten', async () => {
  store.clear(); mark();
  server({ [`GET /api/oracle/recordings/${ID}`]: [200, { status: 'finished', received: [], call_id: 7 }] });
  assert.deepEqual(await ChunkUploader.recover({ userId: 1 }), { call_id: 7, status: 'finished' });
  assert.equal(store.has(MARKER), false);

  mark();
  server({ [`GET /api/oracle/recordings/${ID}`]: [404, { error: 'That recording could not be found.' }] });
  assert.equal(await ChunkUploader.recover({ userId: 1 }), null);
  assert.equal(store.has(MARKER), false);
});

test('a page that closed before anything was recorded leaves nothing behind', async () => {
  store.clear(); mark();
  server({
    [`GET /api/oracle/recordings/${ID}`]: [200, { status: 'recording', received: [], call_id: 7 }],
    [`POST /api/oracle/recordings/${ID}/finish`]: [409, { error: 'Some of the recording has not arrived yet.' }],
  });
  assert.equal(await ChunkUploader.recover({ userId: 1 }), null);
  assert.equal(store.has(MARKER), false);
});

test('parts are sent in order, a part that fails is sent again, and finish says how many there were', async () => {
  store.clear();
  let failures = 1;
  const seen = server({
    'POST /api/oracle/recordings': [201, { id: ID, call_id: 9 }],
    [`PUT /api/oracle/recordings/${ID}/chunks/0`]: () => (failures-- > 0 ? [503, {}] : [200, { seq: 0, bytes: 3 }]),
    [`PUT /api/oracle/recordings/${ID}/chunks/1`]: [200, { seq: 1, bytes: 3 }],
    [`POST /api/oracle/recordings/${ID}/finish`]: [200, { call_id: 9, status: 'uploaded' }],
  });
  const uploader = new ChunkUploader();
  const made = await uploader.create({ mimeType: 'audio/webm;codecs=opus', consent: { confirmed: true, wording: 'Everyone agreed.' }, userId: 1 });
  assert.deepEqual(made, { id: ID, call_id: 9 });
  assert.deepEqual(seen[0].body, { mimeType: 'audio/webm;codecs=opus', consent: { confirmed: true, wording: 'Everyone agreed.' } });
  assert.equal(JSON.parse(store.get(MARKER)).id, ID);
  uploader.add(new Blob(['abc']));
  uploader.add(new Blob(['def']));
  uploader.add(new Blob([])); // an empty part is not a part
  assert.deepEqual(await uploader.finish({ durationMs: 10_000 }), { call_id: 9, status: 'uploaded' });
  assert.deepEqual(seen.slice(1).map((r) => r.key.replace(`/api/oracle/recordings/${ID}`, '')), ['PUT /chunks/0', 'PUT /chunks/0', 'PUT /chunks/1', 'POST /finish']);
  assert.deepEqual(seen.at(-1).body, { chunks: 2, durationMs: 10_000 });
  assert.equal(store.has(MARKER), false);
});

test('a part the server refuses outright stops the upload and keeps the marker for later', async () => {
  store.clear();
  server({
    'POST /api/oracle/recordings': [201, { id: ID, call_id: 9 }],
    [`PUT /api/oracle/recordings/${ID}/chunks/0`]: [401, { error: 'Please sign in.' }],
  });
  const uploader = new ChunkUploader();
  await uploader.create({ mimeType: 'audio/webm', consent: { confirmed: true, wording: 'Everyone agreed.' }, userId: 1 });
  let fatal = null;
  uploader.addEventListener('fatal', (e) => { fatal = e.detail; });
  uploader.add(new Blob(['abc']));
  await assert.rejects(uploader.finish({ durationMs: 1000 }));
  assert.equal(fatal.status, 401);
  assert.ok(store.has(MARKER));
  uploader.letGo();
});

test('the clock reads minutes and seconds, and hours once there are any', () => {
  assert.equal(formatElapsed(0), '00:00');
  assert.equal(formatElapsed(192_400), '03:12');
  assert.equal(formatElapsed(3_792_000), '1:03:12');
});
