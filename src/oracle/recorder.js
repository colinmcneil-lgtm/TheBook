// The Oracle's call recorder. No React in here: CallRecorder owns the microphone and the audio mix, ChunkUploader gets
// the recording to the server a few seconds at a time and keeps whatever has not arrived yet in this browser.
import { api } from '../lib.js';

// ---- format ----------------------------------------------------------------------------------------------------------
// First supported wins. Chrome, Edge and Firefox take the first; Safari before 18.4 only records audio/mp4 (AAC).
const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'];
export function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return null; // no recording in this browser at all
  return MIME_CANDIDATES.find((t) => MediaRecorder.isTypeSupported(t)) ?? ''; // '' = let the browser choose
}

const SPEECH_BITRATE = 32_000; // bits per second: about 14 MB an hour, clear speech in Opus
const TIMESLICE_MS = 5_000; // a part every 5 s: a crash loses at most the last few seconds
const STALL_MS = 20_000; // no part for this long while recording means the browser's recorder has stopped working

// ---- one recording at a time, across every tab of this browser ---------------------------------------------------------
const DB_NAME = 'oracle-recorder';
const STORE = 'chunks';
// localStorage: the recording a person was in the middle of in this browser. Each person has their own marker
// (the key ends in their user number), so on a shared computer one recruiter's recording never wipes the only
// pointer to a colleague's interrupted one.
const ACTIVE_KEY = 'oracle:active-recording';
const LOCK = 'oracle-recording';
const BEAT_STALE_MS = 20_000;

const markerKey = (userId) => `${ACTIVE_KEY}:${userId}`;
const readMarker = (userId) => { try { return JSON.parse(localStorage.getItem(markerKey(userId)) || 'null'); } catch { return null; } };
const writeMarker = (userId, marker) => {
  try { marker ? localStorage.setItem(markerKey(userId), JSON.stringify(marker)) : localStorage.removeItem(markerKey(userId)); } catch { /* storage unavailable */ }
};
/** The recordings that somebody's marker points at, whoever they are. */
function markedRecordings() {
  const ids = new Set();
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(`${ACTIVE_KEY}:`)) ids.add(JSON.parse(localStorage.getItem(key) || 'null')?.id);
    }
  } catch { /* storage unavailable */ }
  return ids;
}

/**
 * The tab that is recording holds a lock for as long as it records, and the browser lets go of it when that tab is
 * closed or crashes. A second tab can then tell "a call is being recorded over there" from "a recording was cut off",
 * and never finishes a recording that is still going. Resolves with a function that lets go, or null when another tab
 * holds the lock.
 */
function holdLock() {
  if (!navigator.locks) return Promise.resolve(() => {});
  return new Promise((resolve) => {
    navigator.locks.request(LOCK, { ifAvailable: true }, (lock) => {
      if (!lock) { resolve(null); return undefined; }
      return new Promise((release) => resolve(release));
    }).catch(() => resolve(() => {}));
  });
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: ['recordingId', 'seq'] });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
const idb = (db, mode, fn) => new Promise((resolve, reject) => {
  const tx = db.transaction(STORE, mode);
  const req = fn(tx.objectStore(STORE));
  tx.oncomplete = () => resolve(req?.result);
  tx.onerror = tx.onabort = () => reject(tx.error);
});
const rowsOf = (id) => IDBKeyRange.bound([id, 0], [id, Infinity]);

/** Send one part. Parts are raw audio, so this goes around the JSON helper; the sign-in cookie still travels with it. */
const putChunk = (base, id, seq, data, signal) => fetch(`/api${base}/${id}/chunks/${seq}`, {
  method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: data, credentials: 'same-origin', signal,
});
/** The server will never take this part (signed out, the recording was finished or deleted elsewhere). Anything else is worth retrying. */
const refused = (status) => status >= 400 && status < 500 && status !== 408 && status !== 429;

/**
 * Send what this browser still holds of one recording, then close it on the server with everything that arrived.
 * Used for a recording that was cut off, and for one the server closed by itself in the meantime (it keeps taking
 * the rest for some days). Resolves to { gone: true } when there is no such call any more or nothing was ever
 * recorded, otherwise to { call_id, status, lost, whole }: `lost` says some of what this browser held could not be
 * added, because the server will not take it now; `whole` that Stop had been pressed and every part is now there.
 * Throws when the server cannot be reached or the person is signed out, and then nothing has been given up: the
 * caller keeps every part for another try.
 */
async function deliver(db, base, id, { elapsedMs, chunks } = {}) {
  let status;
  try {
    status = await api.get(`${base}/${id}`);
  } catch (err) {
    if (err.status === 404) return { gone: true }; // the call was deleted in the meantime
    throw err;
  }
  const rows = db ? await idb(db, 'readonly', (s) => s.getAll(rowsOf(id))) : [];
  const have = new Set(status.received);
  let lost = false;
  if (!status.open) {
    // Closed for good. Parts the audio was made from are only copies; anything past them never made it.
    lost = rows.some((row) => row.seq >= (status.joined ?? Infinity));
    return { call_id: status.call_id, status: status.status, lost, whole: status.interrupted === false && !lost };
  }
  for (const row of rows) {
    if (have.has(row.seq)) continue;
    const res = await putChunk(base, id, row.seq, row.data);
    if (res.ok) have.add(row.seq);
    else if (res.status === 401 || !refused(res.status)) throw Object.assign(new Error('The rest of the interrupted recording could not be sent.'), { status: res.status });
    else lost = true; // the server will never take this part (the call reached its limit)
  }
  // Keep the unbroken run from part 0: the file is only valid as part 0, 1, 2 ... with no gap.
  let n = 0;
  while (have.has(n)) n++;
  if (!n && status.status !== 'recording') return { call_id: status.call_id, status: status.status, lost };
  // When the recorder stopped cleanly it left the number of parts behind. If all of them arrived, this is the whole
  // call, and it is not marked as cut off.
  const whole = Boolean(chunks) && n === chunks;
  try {
    const result = await api.post(`${base}/${id}/finish`, { chunks: n, durationMs: elapsedMs || undefined, ...(whole ? {} : { interrupted: true }) });
    return { call_id: result.call_id ?? status.call_id, status: result.status, lost, whole };
  } catch (err) {
    if (n > 0 || err.status === 401 || !refused(err.status || 0)) throw err;
    return { gone: true }; // nothing was recorded before the page closed, so there is nothing to keep
  }
}

// ---- upload: parts during the call, kept in IndexedDB until the server has them ------------------------------------------
export class ChunkUploader extends EventTarget {
  #queue = []; // { seq, data: ArrayBuffer } in order; an item leaves only after the server has acknowledged it
  #pumping = false;
  #db = null;
  #nextSeq = 0;
  #retryTimer = null;
  #beatTimer = null;
  #idle = [];
  #release = null;
  #stuck = false; // the server refused a part: stop sending, keep storing
  #sealed = 0; // the number of parts in the whole call, once the recruiter has stopped it
  uploaded = 0;
  failures = 0;
  id = null;
  callId = null;
  elapsed = () => 0; // set by the recorder, so the marker knows roughly how long the call was if it is cut off

  constructor({ base = '/oracle/recordings' } = {}) {
    super();
    this.base = base;
    this._online = () => this.#pump();
  }

  /** Claim the one-recording-at-a-time lock before the microphone is asked for. False when another tab is recording. */
  async reserve() {
    this.#release = await holdLock();
    return Boolean(this.#release);
  }
  letGo() {
    clearInterval(this.#beatTimer);
    clearTimeout(this.#retryTimer);
    window.removeEventListener('online', this._online);
    this.#release?.();
    this.#release = null;
  }

  async create({ mimeType, consent, title, application_id, event_key, userId }) {
    // event_key: the calendar event this call is being recorded for, so the event can show that its call was recorded.
    const made = await api.post(this.base, { mimeType, consent, title: title || undefined, application_id: application_id || undefined, event_key: event_key || undefined });
    this.id = made.id;
    this.callId = made.call_id;
    this.userId = userId;
    try { this.#db = await openDb(); } catch { this.#db = null; } // private windows may refuse: upload still works, only the safety net is lost
    this.startedAt = Date.now();
    this.#beat();
    this.#beatTimer = setInterval(() => this.#beat(), 4_000);
    window.addEventListener('online', this._online);
    return made;
  }
  #beat() {
    writeMarker(this.userId, {
      id: this.id, call_id: this.callId, userId: this.userId, startedAt: this.startedAt, beat: Date.now(), elapsedMs: Math.round(this.elapsed()),
      ...(this.#sealed ? { chunks: this.#sealed } : {}),
    });
  }
  /**
   * The recruiter pressed Stop and every part is in this browser's store. Leave the number of parts with the marker:
   * if the page closes before they have all been sent, whoever finishes the job knows when it has the whole call.
   */
  seal() {
    if (!this.#db) return; // nothing is stored in this browser, so nobody could finish the job from it
    this.#sealed = this.#nextSeq;
    this.#beat();
  }

  /** Called from MediaRecorder.ondataavailable. Order is fixed here, synchronously, before any await. */
  add(blob) {
    if (!blob || blob.size === 0) return;
    const seq = this.#nextSeq++;
    const item = { seq, data: null };
    this.#queue.push(item);
    item.ready = blob.arrayBuffer().then(async (data) => {
      item.data = data;
      if (this.#db) await idb(this.#db, 'readwrite', (s) => s.put({ recordingId: this.id, seq, data })).catch(() => {});
    });
    this.#beat();
    this.#pump();
  }

  get pending() { return this.#queue.length; }
  get chunks() { return this.#nextSeq; }
  /** Resolves when every part added so far is in this browser's store, sent or not. */
  stored() { return Promise.all(this.#queue.map((item) => item.ready)); }

  async #pump() {
    if (this.#pumping || this.#stuck) return;
    this.#pumping = true;
    clearTimeout(this.#retryTimer);
    try {
      while (this.#queue.length) {
        const item = this.#queue[0];
        await item.ready;
        let ok = false;
        try {
          const res = await putChunk(this.base, this.id, item.seq, item.data, AbortSignal.timeout(30_000));
          if (res.ok) ok = true;
          else if (refused(res.status)) {
            this.#stuck = true;
            const message = (await res.json().catch(() => null))?.error || null; // the server's own words, such as the length limit
            this.dispatchEvent(new CustomEvent('fatal', { detail: { status: res.status, seq: item.seq, message } }));
            return;
          }
        } catch { /* offline, timeout, server restarting: retry below */ }
        if (!ok) {
          this.failures++;
          const wait = Math.min(15_000, 1_000 * 2 ** Math.min(this.failures - 1, 4));
          this.dispatchEvent(new CustomEvent('retry', { detail: { seq: item.seq, wait, pending: this.#queue.length } }));
          this.#retryTimer = setTimeout(() => this.#pump(), wait);
          return;
        }
        this.failures = 0;
        this.#queue.shift();
        this.uploaded++;
        if (this.#db) idb(this.#db, 'readwrite', (s) => s.delete([this.id, item.seq])).catch(() => {});
        this.dispatchEvent(new CustomEvent('progress', { detail: { uploaded: this.uploaded, pending: this.#queue.length } }));
      }
      this.#idle.splice(0).forEach((done) => done.resolve());
    } finally {
      this.#pumping = false;
      if (this.#stuck) this.#idle.splice(0).forEach((done) => done.reject(new Error('The last part of the recording could not be sent.')));
    }
  }

  /** Resolves when every part so far is on the server. Waits through a dropped connection; fails only if the server refuses. */
  drained() {
    if (!this.#queue.length) return Promise.resolve();
    if (this.#stuck) return Promise.reject(new Error('The last part of the recording could not be sent.'));
    return new Promise((resolve, reject) => { this.#idle.push({ resolve, reject }); this.#pump(); });
  }

  /** Close the recording on the server. Until this succeeds the marker stays, so a reload can pick up where this left off. */
  async finish(extra = {}) {
    await this.drained();
    const result = await api.post(`${this.base}/${this.id}/finish`, { chunks: this.#nextSeq, ...extra });
    this.letGo();
    writeMarker(this.userId, null);
    return result;
  }

  /** Is a recording by this person waiting to be recovered (or going on in another tab)? */
  static interrupted(userId) {
    return Boolean(readMarker(userId)?.id);
  }

  /**
   * After a crash, an accidental reload or a lost connection at the end of a call: send what this browser still holds
   * for the interrupted recording, then finish it with what the server has. Nothing held here is thrown away until
   * the server has it, or has said it can never take it.
   * Returns null when there is nothing to recover, { busy: true } when the recording is still going in another tab,
   * otherwise the finished call { call_id, status, lost, whole } (see deliver). Throws when the server cannot be reached,
   * leaving everything in place for another try.
   */
  static async recover({ base = '/oracle/recordings', userId } = {}) {
    const marker = readMarker(userId);
    const release = await holdLock();
    if (!release) return marker?.id ? { busy: true } : null;
    try {
      if (marker?.id && !navigator.locks && Date.now() - (marker.beat || 0) < BEAT_STALE_MS) return { busy: true };
      let db = null;
      try { db = await openDb(); } catch { /* no safety net in this browser */ }
      const forget = (id) => (db ? idb(db, 'readwrite', (s) => s.delete(rowsOf(id))).catch(() => {}) : null);
      let result = null;
      if (marker?.id) {
        const done = await deliver(db, base, marker.id, marker);
        await forget(marker.id);
        writeMarker(userId, null);
        if (!done.gone) result = { call_id: done.call_id ?? marker.call_id, status: done.status, lost: done.lost, whole: Boolean(done.whole) };
      }
      // Parts in this browser that no marker points at any more (a marker lost to cleared site data, say). If they
      // are this person's, they are sent and the call saved like any other; if the call is gone, they are removed.
      // Somebody else's are refused by the server and left for them.
      const keys = db ? await idb(db, 'readonly', (s) => s.getAllKeys()).catch(() => []) : [];
      const marked = markedRecordings();
      for (const id of new Set(keys.map(([recordingId]) => recordingId))) {
        if (marked.has(id)) continue;
        try {
          const done = await deliver(db, base, id);
          await forget(id);
          if (!done.gone) result ??= { call_id: done.call_id, status: done.status, lost: done.lost, whole: false };
        } catch { /* not this person's, or the server cannot be reached: left for another time */ }
      }
      return result;
    } finally {
      release();
    }
  }
}

// ---- the recorder ------------------------------------------------------------------------------------------------------
export class CallRecorder extends EventTarget {
  state = 'idle'; // idle | recording | paused | stopping | stopped
  mimeType = '';
  #ctx = null; #bus = null; #dest = null; #recorder = null;
  #mic = null; #display = null; #nodes = [];
  #analysers = {}; #buffers = {};
  #startedAt = 0; #pausedAt = 0; #pausedTotal = 0; #endedAt = null;
  #lastPart = 0; #watch = null;
  uploader = null;

  /**
   * Must be called from a click (the audio mixer and both permission prompts need one).
   * consent: { confirmed: true, wording } is sent with the request that creates the recording.
   * Resolves with { id, call_id } once the call exists on the server and recording has begun.
   */
  async start({ consent, title, application_id, event_key, userId, bitsPerSecond = SPEECH_BITRATE, timeslice = TIMESLICE_MS, uploader = new ChunkUploader() } = {}) {
    if (this.state !== 'idle') throw new Error('A call is already being recorded.');
    const mimeType = pickMimeType();
    if (mimeType === null) throw Object.assign(new Error('This browser cannot record audio.'), { name: 'NotSupportedError' });
    if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('Recording needs a secure (https) page.'), { name: 'InsecureError' });
    if (!(await uploader.reserve())) throw Object.assign(new Error('A call is already being recorded in another tab.'), { name: 'BusyError' });
    this.uploader = uploader;
    let made;
    try {
      // The microphone. These three are the defaults in Chrome; stating them keeps other browsers the same.
      this.#mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });

      // Everything is mixed into one mono bus, and the recorder records the bus, so tab audio can join (or leave) mid-call.
      this.#ctx = new AudioContext({ latencyHint: 'interactive' });
      if (this.#ctx.state === 'suspended') await this.#ctx.resume();
      this.#bus = new GainNode(this.#ctx, { gain: 1, channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
      this.#dest = new MediaStreamAudioDestinationNode(this.#ctx, { channelCount: 1, channelCountMode: 'explicit' });
      this.#bus.connect(this.#dest);
      this.#connect('mic', this.#mic);

      this.#recorder = new MediaRecorder(this.#dest.stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: bitsPerSecond });
      this.mimeType = this.#recorder.mimeType || mimeType;
      made = await uploader.create({ mimeType: this.mimeType, consent, title, application_id, event_key, userId });
    } catch (err) {
      this.#release();
      uploader.letGo();
      throw err;
    }

    uploader.elapsed = () => this.elapsedMs;
    this.#recorder.ondataavailable = (e) => { this.#lastPart = performance.now(); uploader.add(e.data); };
    // The browser's recorder can give up on its own: an error, or it simply stops. Nothing more is being recorded
    // then, whatever the clock on the page says, so say so ('broken') and let the page save what there is.
    const broken = (reason) => {
      if (this.state === 'recording' || this.state === 'paused') this.dispatchEvent(new CustomEvent('broken', { detail: { reason } }));
    };
    this.#recorder.onerror = () => broken('error');
    this.#recorder.addEventListener('stop', () => broken('stopped'));
    // And it can go quiet without saying anything: no part for a long while, when one is due every few seconds.
    this.#watch = setInterval(() => {
      if (this.state === 'recording' && performance.now() - this.#lastPart > Math.max(STALL_MS, timeslice * 4)) broken('stalled');
    }, 5_000);
    this.#mic.getAudioTracks()[0].addEventListener('ended', () => {
      // The microphone was unplugged or permission was withdrawn: keep what we have.
      if (this.state === 'recording' || this.state === 'paused') this.dispatchEvent(new CustomEvent('micended'));
    });
    this.#recorder.start(timeslice);
    this.#startedAt = this.#lastPart = performance.now();
    this.#setState('recording');
    return made;
  }

  #setState(state) {
    this.state = state;
    this.dispatchEvent(new Event('statechange'));
  }

  /** Can this browser share a tab's sound at all? (Phones and tablets cannot.) */
  static canShareCallAudio() { return Boolean(navigator.mediaDevices?.getDisplayMedia); }

  /**
   * Add the other side of a call that is playing in a browser tab (or, on Windows and ChromeOS, the whole computer).
   * Must be called from a click. Resolves { ok: false, reason } when the person shared something without sound.
   */
  async addCallAudio() {
    if (this.state !== 'recording' && this.state !== 'paused') return { ok: false, reason: 'not-recording' };
    if (!CallRecorder.canShareCallAudio()) return { ok: false, reason: 'unsupported' };
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: true, // required: the browser will not show the picker for audio alone
        audio: {
          echoCancellation: false, noiseSuppression: false, autoGainControl: false, // it is already clean, processed audio
          suppressLocalAudioPlayback: false, // the recruiter must still hear the call
        },
        systemAudio: 'include', // offer "Also share system audio" on the Entire screen tab (Windows, ChromeOS)
        selfBrowserSurface: 'exclude', // do not offer The Book's own tab
        surfaceSwitching: 'include', // allow "Share this tab instead" without stopping
      });
    } catch (err) {
      return { ok: false, reason: err.name === 'NotAllowedError' ? 'cancelled' : err.name };
    }
    const [audio] = stream.getAudioTracks();
    if (!audio || !this.#ctx || this.#ctx.state === 'closed') {
      stream.getTracks().forEach((t) => t.stop());
      return { ok: false, reason: audio ? 'not-recording' : 'no-audio' }; // "Also share tab audio" was not ticked, or a window was chosen
    }
    this.#disconnect('call'); // sharing a second time replaces the first share
    this.#display?.getTracks().forEach((t) => t.stop());
    this.#display = stream;
    this.#connect('call', new MediaStream([audio]));
    const surface = stream.getVideoTracks()[0]?.getSettings().displaySurface; // 'browser' | 'window' | 'monitor'
    // The picture is not recorded. Keep the video track alive (stopping it can end the share) but make it cheap.
    stream.getVideoTracks().forEach((t) => t.applyConstraints({ frameRate: 1, width: 320 }).catch(() => {}));
    audio.addEventListener('ended', () => { // "Stop sharing", or the shared tab was closed: the microphone carries on
      if (this.#display !== stream) return;
      this.#disconnect('call');
      this.#display = null;
      this.dispatchEvent(new CustomEvent('callaudioended'));
    });
    return { ok: true, surface };
  }

  #connect(name, stream) {
    const source = new MediaStreamAudioSourceNode(this.#ctx, { mediaStream: stream });
    const gain = new GainNode(this.#ctx, { gain: 1 });
    source.connect(gain).connect(this.#bus);
    const analyser = new AnalyserNode(this.#ctx, { fftSize: 1024, smoothingTimeConstant: 0 });
    gain.connect(analyser); // a dead end: an analyser does not need to reach the destination
    this.#analysers[name] = analyser;
    this.#nodes.push({ name, source, gain });
  }
  #disconnect(name) {
    this.#nodes.filter((n) => n.name === name).forEach((n) => { n.source.disconnect(); n.gain.disconnect(); });
    this.#nodes = this.#nodes.filter((n) => n.name !== name);
    delete this.#analysers[name];
  }

  /** Input level 0..1 for 'mic' or 'call' (loudness mapped from -60 dB to 0 dB). Call it from requestAnimationFrame. */
  level(name = 'mic') {
    const a = this.#analysers[name];
    if (!a || this.state !== 'recording') return 0;
    const buf = (this.#buffers[name] ??= new Float32Array(a.fftSize));
    a.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const db = 20 * Math.log10(Math.sqrt(sum / buf.length) || 1e-6);
    return Math.max(0, Math.min(1, (db + 60) / 60));
  }

  /** Milliseconds recorded, not counting pauses. */
  get elapsedMs() {
    if (!this.#startedAt) return 0;
    const end = this.state === 'paused' ? this.#pausedAt : (this.#endedAt ?? performance.now());
    return Math.max(0, end - this.#startedAt - this.#pausedTotal);
  }

  pause() {
    if (this.state !== 'recording') return;
    this.#recorder.pause(); // the microphone stays open (the browser's indicator stays on); nothing is written
    this.#pausedAt = performance.now();
    this.#setState('paused');
  }
  resume() {
    if (this.state !== 'paused') return;
    this.#recorder.resume();
    this.#lastPart = performance.now(); // nothing was due while paused
    this.#pausedTotal += performance.now() - this.#pausedAt;
    this.#setState('recording');
  }

  /** Stop the encoder and let go of the microphone and the shared tab. Every part is with the uploader when this resolves. */
  async #end() {
    if (this.state === 'paused') this.#pausedTotal += performance.now() - this.#pausedAt;
    this.#endedAt = performance.now();
    clearInterval(this.#watch);
    this.#setState('stopping');
    // 'stop' fires after the last 'dataavailable', so the uploader has every part when this resolves.
    // (A recorder that has stopped working may never say it has stopped, so this does not wait for it for ever.)
    if (this.#recorder.state !== 'inactive') {
      await new Promise((resolve) => {
        this.#recorder.addEventListener('stop', resolve, { once: true });
        setTimeout(resolve, 3_000);
        try { this.#recorder.stop(); } catch { resolve(); }
      });
    }
    this.#release();
  }

  /**
   * Stop, upload what is left, and return the server's record of the call: { call_id, status }.
   * `interrupted` marks the call as cut off, for a recording that ended before the recruiter stopped it.
   */
  async stop({ interrupted = false } = {}) {
    if (this.state !== 'recording' && this.state !== 'paused') return null;
    await this.#end();
    // The connection may be down, and the recruiter may close the page before it is back: say now that this is the whole call.
    await this.uploader.stored().then(() => { if (!interrupted) this.uploader.seal(); }, () => {});
    try {
      return await this.uploader.finish({ durationMs: Math.round(this.elapsedMs), ...(interrupted ? { interrupted: true } : {}) });
    } catch (err) {
      // The parts not yet sent stay in this browser with the marker, so ChunkUploader.recover() can finish the job later.
      this.uploader.letGo();
      throw err;
    } finally {
      this.#setState('stopped');
    }
  }

  /**
   * Stop without finishing, for when the page can no longer talk to the server (signed out mid-call). What was
   * recorded stays in this browser and is sent by ChunkUploader.recover() the next time The Book is open here.
   */
  async abandon() {
    if (this.state !== 'recording' && this.state !== 'paused') return;
    await this.#end();
    await this.uploader.stored().catch(() => {});
    this.uploader.letGo();
    this.#setState('stopped');
  }

  #release() {
    clearInterval(this.#watch);
    this.#mic?.getTracks().forEach((t) => t.stop()); // this is what turns the browser's recording indicator off
    this.#display?.getTracks().forEach((t) => t.stop()); // and this ends "Sharing this tab"
    this.#display = null;
    this.#nodes.forEach((n) => { n.source.disconnect(); n.gain.disconnect(); });
    this.#nodes = []; this.#analysers = {};
    this.#ctx?.close().catch(() => {});
  }
}

/** "03:12", or "1:03:12" past the hour. */
export const formatElapsed = (ms) => {
  const s = Math.floor((ms || 0) / 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return (s >= 3600 ? Math.floor(s / 3600) + ':' : '') + pad(Math.floor(s / 60) % 60) + ':' + pad(s % 60);
};
