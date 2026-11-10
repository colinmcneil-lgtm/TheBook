// Reading calendar files on a thread of their own.
//
// Reading a large calendar takes real time (about a second for 5,000 events, and a private calendar link carries the
// calendar's whole history, so that size is ordinary). Done on the server's main thread, nobody else's request would
// be answered for that second, and a recording being sent in pieces would stall. So the reading, and the working-out
// of each day from it, happens here, and the main thread only waits for the answer.
//
// The thread keeps the calendars it has read, each under the version of its text and the time zone it was read for,
// so a download is read once and every day asked of it afterwards is quick. What it keeps is capped; the calendars
// not asked for longest are dropped first and simply read again if they are wanted.
//
// If the thread runs out of memory, takes far too long or dies, the server carries on: the requests that were
// waiting are told the calendar could not be read, and a fresh thread is started for the next one.
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { parseFeed, eventsForDay } from './calendar-day.js';

const MAX_KEPT = 40;                       // calendars held in the thread at once
const MAX_KEPT_CHARS = 20 * 1024 * 1024;   // and their text together; a calendar read into memory takes about five times its text
const MAX_MEMORY_MB = 384;                 // the most the thread may use before it is stopped and started afresh
const ANSWER_WITHIN = 45000;               // milliseconds; several large calendars may be waiting in front of one request

// ---------- inside the thread ----------
if (!isMainThread) {
  const kept = new Map();                  // "version:zone" -> { feed, size } or { failed }, oldest first
  let chars = 0;
  parentPort.on('message', ({ id, key, zone, text, ymd, forget }) => {
    try {
      if (forget) {
        for (const old of [...kept.keys()]) if (old.startsWith(`${forget}:`)) { chars -= kept.get(old).size; kept.delete(old); }
        return;
      }
      let entry = kept.get(key);
      if (entry) { kept.delete(key); kept.set(key, entry); }        // asked for just now: last in line to be dropped
      else {
        if (text == null) return parentPort.postMessage({ id, need: true });
        try {
          entry = { feed: parseFeed(text, zone), size: text.length };
        } catch (err) {
          // A text that cannot be read is remembered as such, so it is not read again every time it is asked for.
          entry = { failed: err?.message === 'not a calendar' ? 'not_a_calendar' : 'broken', size: 0 };
        }
        kept.set(key, entry);
        chars += entry.size;
        for (const old of kept.keys()) {
          if (kept.size <= MAX_KEPT && chars <= MAX_KEPT_CHARS) break;
          if (old !== key) { chars -= kept.get(old).size; kept.delete(old); }
        }
      }
      parentPort.postMessage(entry.failed ? { id, failed: entry.failed } : { id, result: eventsForDay(entry.feed, ymd) });
    } catch {
      parentPort.postMessage({ id, failed: 'broken' });
    }
  });
}

// ---------- on the main thread ----------
let worker = null, nextId = 1;
const waiting = new Map();                 // request number -> { resolve, reject, timer }

export class CalendarReadError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function stop(code) {
  const old = worker;
  worker = null;
  for (const { reject, timer } of waiting.values()) { clearTimeout(timer); reject(new CalendarReadError(code)); }
  waiting.clear();
  old?.terminate().catch(() => {});
}

function thread() {
  if (worker) return worker;
  const started = new Worker(new URL(import.meta.url), { resourceLimits: { maxOldGenerationSizeMb: MAX_MEMORY_MB } });
  started.unref();                          // an idle reader must not keep the server from stopping
  started.on('message', ({ id, ...answer }) => {
    const request = waiting.get(id);
    if (!request) return;
    waiting.delete(id);
    clearTimeout(request.timer);
    request.resolve(answer);
  });
  // Out of memory, or anything else that ends the thread: only the thread is lost.
  const ended = () => { if (worker === started) stop('unreadable'); };
  started.on('error', ended);
  started.on('exit', ended);
  worker = started;
  return started;
}

function ask(message) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { if (waiting.has(id)) stop('too_slow'); }, ANSWER_WITHIN);
    timer.unref();
    waiting.set(id, { resolve, reject, timer });
    thread().postMessage({ id, ...message });
  });
}

/**
 * One day's events from a calendar's text. `version` names the text (a hash of it), so the thread can tell whether
 * it has already read this download; the text itself is only sent across when it has not.
 * Resolves to { events, warnings } as eventsForDay gives them. Rejects with CalendarReadError: 'not_a_calendar' (the
 * text is not a calendar), 'broken' (it is one, but could not be understood), 'too_slow', or 'unreadable' (the
 * thread itself failed).
 */
export async function readDay({ version, text, zone, ymd }) {
  const key = `${version}:${zone}`;
  let answer = await ask({ key, zone, ymd });
  if (answer.need) answer = await ask({ key, zone, ymd, text });
  if (answer.failed) throw new CalendarReadError(answer.failed);
  return answer.result;
}

/** Have the thread drop what it read from one download (every time zone it was read for), when its owner removes their calendar. */
export function forgetRead(version) {
  if (worker && version) worker.postMessage({ forget: version });
}

/** Stop the thread (when the server shuts down, or between tests). It starts again by itself when next needed. */
export const stopReader = () => stop('unreadable');
