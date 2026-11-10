// The Oracle's uploader: what happens to a recording that was cut off. Run with `npm test`.
// The browser pieces it leans on (fetch, localStorage, window events) are stood in for here; the recorder itself
// (microphone, audio mix) only exists in a browser and was checked there.
import test from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k),
  get length() { return store.size; }, key: (i) => [...store.keys()][i] ?? null,
};
globalThis.window = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };

// A stand-in for the browser's own store (IndexedDB), where parts wait until the server has them. Only what the
// uploader uses: rows keyed by [recording id, part number], put, delete, and reading a recording's rows back.
const held = new Map();
const keyOf = (recordingId, seq) => JSON.stringify([recordingId, seq]);
const within = (key, range) => { const [id, seq] = JSON.parse(key); return id === range.lower[0] && seq >= range.lower[1] && seq <= range.upper[1]; };
globalThis.IDBKeyRange = { bound: (lower, upper) => ({ lower, upper }) };
globalThis.indexedDB = {
  open() {
    const opening = {};
    const transaction = () => {
      const tx = {};
      const request = (work) => { const req = {}; queueMicrotask(() => { req.result = work(); queueMicrotask(() => tx.oncomplete?.()); }); return req; };
      tx.objectStore = () => ({
        put: (row) => request(() => { held.set(keyOf(row.recordingId, row.seq), row); }),
        delete: (key) => request(() => { for (const k of [...held.keys()]) if (key.lower ? within(k, key) : k === JSON.stringify(key)) held.delete(k); }),
        getAll: (range) => request(() => [...held.keys()].filter((k) => within(k, range)).sort((a, b) => JSON.parse(a)[1] - JSON.parse(b)[1]).map((k) => held.get(k))),
        getAllKeys: () => request(() => [...held.keys()].map((k) => JSON.parse(k))),
      });
      return tx;
    };
    queueMicrotask(() => { opening.result = { createObjectStore() {}, transaction }; opening.onsuccess?.(); });
    return opening;
  },
};
const hold = (id, ...seqs) => seqs.forEach((seq) => held.set(keyOf(id, seq), { recordingId: id, seq, data: new Uint8Array([seq]).buffer }));
const heldFor = (id) => [...held.keys()].map((k) => JSON.parse(k)).filter(([recordingId]) => recordingId === id).map(([, seq]) => seq).sort((a, b) => a - b);

const { ChunkUploader, formatElapsed } = await import('../src/oracle/recorder.js');

const MARKER = 'oracle:active-recording:1'; // each person has their own marker: this is user 1's
const ID = 'a'.repeat(32);
const longAgo = Date.now() - 60_000;
const mark = ({ userId = 1, ...extra } = {}) => store.set(`oracle:active-recording:${userId}`, JSON.stringify({ id: ID, call_id: 7, userId, startedAt: longAgo, beat: longAgo, elapsedMs: 12_000, ...extra }));
const fresh = () => { store.clear(); held.clear(); };

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
  fresh();
  const seen = server({});
  assert.equal(await ChunkUploader.recover({ userId: 1 }), null);
  assert.equal(seen.length, 0);
});

test('someone else’s interrupted recording on a shared computer is left for them', async () => {
  fresh(); mark({ userId: 2 });
  const seen = server({});
  assert.equal(await ChunkUploader.recover({ userId: 1 }), null);
  assert.equal(seen.length, 0);
  assert.ok(store.has('oracle:active-recording:2'));
  assert.equal(ChunkUploader.interrupted(1), false);
  assert.equal(ChunkUploader.interrupted(2), true);
});

test('on a shared computer a colleague\'s recording does not strand the first person\'s unsent parts', async () => {
  fresh();
  const OTHER = 'b'.repeat(32);
  // Priya (user 2) was recording; her last three parts never reached the server, and she signed out.
  mark({ userId: 2, id: OTHER, call_id: 3 });
  hold(OTHER, 1, 2, 3);
  // Alex (user 1) signs in on the same browser, records a call and stops.
  let seen = server({
    'POST /api/oracle/recordings': [201, { id: ID, call_id: 9 }],
    [`PUT /api/oracle/recordings/${ID}/chunks/0`]: [200, { seq: 0, bytes: 3 }],
    [`POST /api/oracle/recordings/${ID}/finish`]: [200, { call_id: 9, status: 'uploaded' }],
    [`GET /api/oracle/recordings/${OTHER}`]: [403, { error: 'Only the person who started this recording can add to it.' }],
  });
  assert.equal(await ChunkUploader.recover({ userId: 1 }), null, 'nothing of his own to recover');
  const uploader = new ChunkUploader();
  await uploader.create({ mimeType: 'audio/webm', consent: { confirmed: true, wording: 'Everyone agreed.' }, userId: 1 });
  uploader.add(new Blob(['abc']));
  await uploader.finish({ durationMs: 1000 });
  assert.equal(ChunkUploader.interrupted(1), false);
  assert.equal(ChunkUploader.interrupted(2), true, 'her marker is still there');
  assert.deepEqual(heldFor(OTHER), [1, 2, 3], 'and so are her parts');
  // Priya signs in again: her parts are sent and her call is saved.
  seen = server({
    [`GET /api/oracle/recordings/${OTHER}`]: [200, { status: 'recording', received: [0], call_id: 3, open: true, joined: null }],
    [`PUT /api/oracle/recordings/${OTHER}/chunks/1`]: [200, {}], [`PUT /api/oracle/recordings/${OTHER}/chunks/2`]: [200, {}], [`PUT /api/oracle/recordings/${OTHER}/chunks/3`]: [200, {}],
    [`POST /api/oracle/recordings/${OTHER}/finish`]: [200, { call_id: 3, status: 'transcribing' }],
  });
  assert.deepEqual(await ChunkUploader.recover({ userId: 2 }), { call_id: 3, status: 'transcribing', lost: false, whole: false });
  assert.deepEqual(seen.at(-1).body, { chunks: 4, durationMs: 12_000, interrupted: true });
  assert.deepEqual(heldFor(OTHER), []);
  assert.equal(ChunkUploader.interrupted(2), false);
});

test('parts still held when the server has already closed the recording are sent, not thrown away', async () => {
  // The server saved the call from parts 0 and 1 by itself (nobody had added to it for a day) and still takes the rest.
  fresh(); mark({ chunks: 5 }); hold(ID, 2, 3, 4);
  let seen = server({
    [`GET /api/oracle/recordings/${ID}`]: [200, { status: 'ready', received: [0, 1], call_id: 7, open: true, joined: 2 }],
    [`PUT /api/oracle/recordings/${ID}/chunks/2`]: [200, {}], [`PUT /api/oracle/recordings/${ID}/chunks/3`]: [200, {}], [`PUT /api/oracle/recordings/${ID}/chunks/4`]: [200, {}],
    [`POST /api/oracle/recordings/${ID}/finish`]: [200, { call_id: 7, status: 'transcribing' }],
  });
  assert.deepEqual(await ChunkUploader.recover({ userId: 1 }), { call_id: 7, status: 'transcribing', lost: false, whole: true });
  assert.deepEqual(seen.map((r) => r.key.replace(`/api/oracle/recordings/${ID}`, '')), ['GET ', 'PUT /chunks/2', 'PUT /chunks/3', 'PUT /chunks/4', 'POST /finish']);
  // Stop had been pressed and all five parts are now there, so this is the whole call: not marked as cut off.
  assert.deepEqual(seen.at(-1).body, { chunks: 5, durationMs: 12_000 });
  assert.deepEqual(heldFor(ID), []);
  assert.equal(store.has(MARKER), false);

  // The server cannot be reached part-way: every part is still held for the next try.
  fresh(); mark(); hold(ID, 2, 3);
  server({
    [`GET /api/oracle/recordings/${ID}`]: [200, { status: 'ready', received: [0, 1], call_id: 7, open: true, joined: 2 }],
    [`PUT /api/oracle/recordings/${ID}/chunks/2`]: [200, {}],
  });
  await assert.rejects(ChunkUploader.recover({ userId: 1 }));
  assert.deepEqual(heldFor(ID), [2, 3]);
  assert.ok(store.has(MARKER));

  // The server will never take the rest (it kept the parts for a week, and that has passed): the recruiter is told
  // the end is missing, and only then are the parts let go.
  fresh(); mark(); hold(ID, 1, 2, 3);
  seen = server({ [`GET /api/oracle/recordings/${ID}`]: [200, { status: 'ready', received: [], call_id: 7, open: false, joined: 2, interrupted: true }] });
  assert.deepEqual(await ChunkUploader.recover({ userId: 1 }), { call_id: 7, status: 'ready', lost: true, whole: false });
  assert.deepEqual(heldFor(ID), []);
  // Parts that the saved audio already includes are only copies: nothing was lost.
  fresh(); mark(); hold(ID, 1);
  server({ [`GET /api/oracle/recordings/${ID}`]: [200, { status: 'ready', received: [], call_id: 7, open: false, joined: 2, interrupted: true }] });
  assert.deepEqual(await ChunkUploader.recover({ userId: 1 }), { call_id: 7, status: 'ready', lost: false, whole: false });
});

test('parts left in the browser with no marker are sent if they are this person\'s, and removed if the call is gone', async () => {
  fresh();
  const MINE = 'c'.repeat(32), GONE = 'd'.repeat(32), THEIRS = 'e'.repeat(32);
  hold(MINE, 1, 2); hold(GONE, 0, 1); hold(THEIRS, 4);
  const seen = server({
    [`GET /api/oracle/recordings/${MINE}`]: [200, { status: 'recording', received: [0], call_id: 11, open: true, joined: null }],
    [`PUT /api/oracle/recordings/${MINE}/chunks/1`]: [200, {}], [`PUT /api/oracle/recordings/${MINE}/chunks/2`]: [200, {}],
    [`POST /api/oracle/recordings/${MINE}/finish`]: [200, { call_id: 11, status: 'uploaded' }],
    [`GET /api/oracle/recordings/${GONE}`]: [404, { error: 'This recording was not found. It may have been deleted.' }],
    [`GET /api/oracle/recordings/${THEIRS}`]: [403, { error: 'Only the person who started this recording can add to it.' }],
  });
  assert.deepEqual(await ChunkUploader.recover({ userId: 1 }), { call_id: 11, status: 'uploaded', lost: false, whole: false });
  assert.deepEqual(seen.find((r) => r.key.endsWith(`${MINE}/finish`)).body, { chunks: 3, interrupted: true });
  assert.deepEqual(heldFor(MINE), []);
  assert.deepEqual(heldFor(GONE), [], 'audio of a call that no longer exists is not left in the browser');
  assert.deepEqual(heldFor(THEIRS), [4], 'somebody else\'s is left for them');
});

test('a recording still going in another tab is not finished from this one', async () => {
  fresh(); mark({ beat: Date.now() });
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
  fresh(); mark();
  const seen = server({
    [`GET /api/oracle/recordings/${ID}`]: [200, { status: 'recording', received: [0, 1, 3], call_id: 7, open: true, joined: null }],
    [`POST /api/oracle/recordings/${ID}/finish`]: [200, { call_id: 7, status: 'transcribing' }],
  });
  assert.deepEqual(await ChunkUploader.recover({ userId: 1 }), { call_id: 7, status: 'transcribing', lost: false, whole: false });
  assert.deepEqual(seen.at(-1).body, { chunks: 2, durationMs: 12_000, interrupted: true }); // part 2 never arrived, so part 3 cannot be used
  assert.equal(store.has(MARKER), false);
});

test('when the server cannot be reached, everything is kept for another try', async () => {
  fresh(); mark();
  server({});
  await assert.rejects(ChunkUploader.recover({ userId: 1 }));
  assert.ok(store.has(MARKER));
});

test('a recording that was already finished, or deleted, is simply forgotten', async () => {
  fresh(); mark();
  // (It was finished properly: only the answer never reached the page. So it is the whole call, not one that was cut off.)
  server({ [`GET /api/oracle/recordings/${ID}`]: [200, { status: 'ready', received: [], call_id: 7, open: false, joined: 4, interrupted: false }] });
  assert.deepEqual(await ChunkUploader.recover({ userId: 1 }), { call_id: 7, status: 'ready', lost: false, whole: true });
  assert.equal(store.has(MARKER), false);

  mark();
  server({ [`GET /api/oracle/recordings/${ID}`]: [404, { error: 'That recording could not be found.' }] });
  assert.equal(await ChunkUploader.recover({ userId: 1 }), null);
  assert.equal(store.has(MARKER), false);
});

test('a page that closed before anything was recorded leaves nothing behind', async () => {
  fresh(); mark();
  server({
    [`GET /api/oracle/recordings/${ID}`]: [200, { status: 'recording', received: [], call_id: 7, open: true, joined: null }],
    [`POST /api/oracle/recordings/${ID}/finish`]: [409, { error: 'Some of the recording has not arrived yet.' }],
  });
  assert.equal(await ChunkUploader.recover({ userId: 1 }), null);
  assert.equal(store.has(MARKER), false);
});

test('parts are sent in order, a part that fails is sent again, and finish says how many there were', async () => {
  fresh();
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
  fresh();
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
