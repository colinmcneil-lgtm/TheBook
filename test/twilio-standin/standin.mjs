// Local stand-in for the parts of Twilio Programmable Voice that The Book uses. Plain Node, no dependencies.
// The phone tests start it in-process with startStandin(); it can also be run by hand:
//
//   node test/twilio-standin/standin.mjs      listens on 127.0.0.1:4010
//
// Point the app at it with  TWILIO_API_URL=http://127.0.0.1:4010  and the credentials printed at start.
//
// It answers the way Twilio's published API description and SDK say Twilio does. Twilio itself has never been
// called by these tests, so a test passing here shows the app and this stand-in agree, not that Twilio behaves
// this way. Where Twilio's behaviour is not written down anywhere first-hand, the stand-in is a best reading.
//
// REST calls it accepts (HTTP Basic auth: Account SID + Auth Token, or API key SID + secret):
//   POST   /2010-04-01/Accounts/{AC}/Calls.json                      create a call, then play out a scripted scenario
//   GET    /2010-04-01/Accounts/{AC}/Calls/{CA}.json                 fetch a call
//   POST   /2010-04-01/Accounts/{AC}/Calls/{CA}.json                 Status=canceled | completed (hang up)
//   GET    /2010-04-01/Accounts/{AC}/Calls.json?ParentCallSid=CA..   list calls (child legs)
//   GET    /2010-04-01/Accounts/{AC}/Calls/{CA}/Recordings.json      the recordings of a call
//   GET    /2010-04-01/Accounts/{AC}/Recordings/{RE}.json            recording details
//   GET    /2010-04-01/Accounts/{AC}/Recordings/{RE}[.wav|.mp3][?RequestedChannels=1|2]   the audio
//   DELETE /2010-04-01/Accounts/{AC}/Recordings/{RE}.json            delete it (204)
//   GET    /2010-04-01/Accounts/{AC}/IncomingPhoneNumbers.json       the account's numbers
//   POST   /2010-04-01/Accounts/{AC}/IncomingPhoneNumbers/{PN}.json  set VoiceUrl, VoiceMethod, StatusCallback
// Not Twilio (control endpoints for tests):
//   POST   /_standin/inbound   JSON { from, to?, voiceUrl?, voiceMethod?, statusCallback?, digits? }  simulate a call to the number;
//                              digits is what the caller keys in at each <Gather> in turn, e.g. ["4821", "4165550123"]
//   GET    /_standin/idle      answers when no scenario is running
//   GET    /_standin/log       everything logged so far, as JSON
//
// On "create call" it makes the webhook requests Twilio would make, in order, form-encoded and signed with the
// Auth Token (X-Twilio-Signature), to the URLs it was given, and it follows the TwiML the app returns.
// What happens is chosen by phone number (see SCENARIOS below). Time is scripted: a 12-second conversation
// takes a few milliseconds, and the durations reported are the scripted ones.
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { twilioSignature } from '../../server/twilio-signature.js';
import { parseXml, ATTRS, DIAL_RECORD, RECORDING_EVENTS, CALL_EVENTS } from './twiml.mjs';
import { callWav, voicemailWav, toMp3 } from './audio.mjs';

// ---- scenarios, chosen by phone number --------------------------------------------------------------------------
export const SCENARIOS = {
  // "To" of POST /Calls.json: refused by the REST API itself, no call is created
  rest: {
    '+16135550001': { status: 400, code: 21211, message: "The 'To' number +16135550001 is not a valid phone number." },
    '+16135550002': { status: 400, code: 21215, message: 'Account not authorized to call +16135550002. Perhaps you need to enable some international permissions: https://www.twilio.com/console/voice/calls/geo-permissions/low-risk' },
    '+16135550003': { status: 400, code: 21219, message: "The number +16135550003 is unverified. Trial accounts may only make calls to verified numbers." },
    '+16135550005': { status: 401, code: 20005, message: 'Account not active' }, // HTTP status here is a guess
  },
  // "To" of POST /Calls.json: what the first leg (the recruiter's own phone) does. Any other number answers.
  firstLeg: {
    '+16135550101': 'no-answer',
    '+16135550102': 'busy',
    '+16135550103': 'failed',
    '+16135550104': 'voicemail', // answered by a machine: nobody presses a key, a <Gather> times out
    '+16135550105': 'rings-on',  // keeps ringing (for up to three real seconds) until the app hangs up
  },
  // The number inside <Dial><Number>: what the second leg does. Any other number answers and talks for 12 seconds.
  dialed: {
    '+16135550111': 'busy',
    '+16135550112': 'no-answer',
    '+16135550113': 'failed',
    '+16135550114': 'voicemail',        // answered by voicemail: to Twilio this is an answered, completed call
    '+16135550115': 'hangup-in-whisper', // answers, hangs up while the <Number url> notice plays: never joined
    '+16135550116': 'parent-hangs-up',  // answered; the first leg hangs up first
    '+16135550117': 'talks-on',         // answered; they talk (for up to four real seconds) until the app hangs up
  },
};
const SECONDS = { say: 4, ringFirstLeg: 6, ringDialed: 8, whisper: 3, talk: 12, voicemailTalk: 9, voicemailMessage: 6, gather: 5 };
const CANADA = new Set('204 226 236 249 250 263 289 306 343 354 365 367 368 382 403 416 418 428 431 437 438 450 468 474 506 514 519 548 579 581 584 587 604 613 639 647 672 683 705 709 742 753 778 780 782 807 819 825 867 873 879 902 905'.split(' '));

const hex = (n) => crypto.randomBytes(n / 2).toString('hex');
const rfc2822 = (ms) => new Date(ms).toUTCString().replace('GMT', '+0000');
const country = (num) => (/^\+1\d{10}$/.test(num) ? (CANADA.has(num.slice(2, 5)) ? 'CA' : 'US') : '');
const E164 = /^\+[1-9]\d{6,14}$/;

export async function startStandin(options = {}) {
  const cfg = {
    port: Number(options.port ?? process.env.STANDIN_PORT ?? 4010),
    accountSid: options.accountSid ?? process.env.TWILIO_ACCOUNT_SID ?? 'AC' + '0123456789abcdef'.repeat(2),
    authToken: options.authToken ?? process.env.TWILIO_AUTH_TOKEN ?? 'standin_auth_token_0123456789abcd',
    apiKeySid: options.apiKeySid ?? process.env.TWILIO_API_KEY_SID ?? 'SK' + 'fedcba9876543210'.repeat(2),
    apiKeySecret: options.apiKeySecret ?? process.env.TWILIO_API_KEY_SECRET ?? 'standin_api_key_secret',
    numbers: (options.numbers ?? (process.env.STANDIN_NUMBERS || '+16475550100').split(',')).map((n) => n.trim()),
    verified: (options.verified ?? (process.env.STANDIN_VERIFIED || '').split(',')).map((n) => n.trim()).filter(Boolean),
    stepMs: Number(options.stepMs ?? process.env.STANDIN_STEP_MS ?? 15),       // real pause between scripted steps
    logFile: options.logFile ?? process.env.STANDIN_LOG ?? null,
    recordingCallbackFirst: options.recordingCallbackFirst ?? process.env.STANDIN_RECORDING_FIRST === '1', // send the recording callback before the Dial action
    quiet: options.quiet ?? false,
  };
  const baseUrl = `http://127.0.0.1:${cfg.port}`;
  const accountPath = `/2010-04-01/Accounts/${cfg.accountSid}`;
  const numbers = cfg.numbers.map((phoneNumber) => ({ sid: 'PN' + hex(32), phoneNumber, voiceUrl: '', voiceMethod: 'POST', statusCallback: '', statusCallbackMethod: 'POST' }));
  const calls = new Map(), recordings = new Map(), entries = [];
  let running = 0, idleWaiters = [];
  // Ways to misbehave, switched on by a test for as long as it needs them:
  //   drop            names of webhooks that are never delivered, e.g. ['recording:completed'] (matched by how they start)
  //   twice           every webhook is delivered twice
  //   mono            <Dial> recordings are made with one channel, whatever was asked for; asking for two is refused
  //   monoReported    how many channels the recording callback then claims (default 1)
  //   downloadFailures  how many fetches of recording audio answer 404 first, as if it were not ready yet
  //   deleteFailures    how many attempts to delete a recording answer 500 first
  //   firstLegDigits  what the person rung by the REST API keys in at each <Gather>, instead of "1"
  //   absent          <Dial> recordings come to nothing: the callback says "absent" and there is no audio to fetch
  //   keyMs           real milliseconds a person takes to key something in at a <Gather> (0 unless a screen is being watched)
  //   talkMs          real milliseconds an answered call lasts, unless the app hangs it up sooner (0 likewise)
  //   monoRefusal     the status that refuses two channels of a one-channel recording: 400 (one of Twilio's pages) or 404 (another)
  //   stuck           recordings never finish: the list of a call's recordings says "processing" for ever
  //   hangupRefused   changing a call that is already over is refused with 400, as Twilio's error 21220 describes
  const behaviour = { drop: [], twice: false, mono: false, monoReported: 1, monoRefusal: 400, downloadFailures: 0, deleteFailures: 0, firstLegDigits: null, absent: false, stuck: false, hangupRefused: false, keyMs: 0, talkMs: 0 };
  const realPause = (ms) => new Promise((r) => setTimeout(r, ms));

  const audio = { call2: callWav(SECONDS.talk, 2), call1: callWav(SECONDS.talk, 1), voicemail: voicemailWav(SECONDS.voicemailMessage) };
  const mp3Cache = new Map();

  function log(entry) {
    const line = { t: new Date().toISOString(), ...entry };
    entries.push(line);
    if (cfg.logFile) fs.appendFileSync(cfg.logFile, JSON.stringify(line) + '\n');
    options.onLog?.(line);
    return line;
  }
  const note = (call, text, code) => log({ kind: 'note', callSid: call?.sid, ...(code ? { twilioErrorCode: code } : {}), text });
  const pause = () => new Promise((r) => setTimeout(r, cfg.stepMs));

  // ---- calls and recordings ------------------------------------------------------------------------------------
  function createCall({ to, from, direction, parent, statusCallback }) {
    const call = {
      sid: 'CA' + hex(32), parentCallSid: parent?.sid ?? null, to, from, direction, status: direction === 'inbound' ? 'ringing' : 'queued',
      created: Date.now(), clock: parent?.clock ?? Date.now(), startTime: null, endTime: null, duration: null, answeredBy: null,
      seq: 0, live: true, hangupRequested: null, statusCallback: statusCallback ?? null, pendingRecordingCallbacks: [],
    };
    calls.set(call.sid, call);
    return call;
  }
  function finish(call, status) {
    if (call.endTime) return;
    call.status = status; call.live = false; call.endTime = call.clock;
    if (call.startTime && status === 'completed') call.duration = Math.round((call.endTime - call.startTime) / 1000);
  }
  const tick = (call, seconds) => { call.clock += seconds * 1000; };
  function callJson(c) {
    const answered = c.startTime !== null, rate = c.direction === 'inbound' ? 0.0085 : 0.014;
    return {
      sid: c.sid, account_sid: cfg.accountSid, parent_call_sid: c.parentCallSid, api_version: '2010-04-01',
      to: c.to, to_formatted: c.to, from: c.from, from_formatted: c.from, phone_number_sid: numbers.find((n) => n.phoneNumber === c.from || n.phoneNumber === c.to)?.sid ?? null,
      status: c.status, direction: c.direction, answered_by: c.answeredBy, caller_name: null, forwarded_from: null, group_sid: null,
      date_created: rfc2822(c.created), date_updated: rfc2822(c.endTime ?? c.clock),
      start_time: answered ? rfc2822(c.startTime) : null, end_time: c.endTime ? rfc2822(c.endTime) : null,
      duration: c.status === 'completed' ? String(c.duration ?? 0) : null,
      // Illustrative only: whole minutes at a made-up flat rate. Real prices arrive some time after the call ends.
      price: c.status === 'completed' ? (-Math.ceil((c.duration || 1) / 60) * rate).toFixed(5) : null, price_unit: 'USD',
      queue_time: '0', trunk_sid: null, stir_verstat: null,
      uri: `${accountPath}/Calls/${c.sid}.json`,
      subresource_uris: { recordings: `${accountPath}/Calls/${c.sid}/Recordings.json`, notifications: `${accountPath}/Calls/${c.sid}/Notifications.json`, events: `${accountPath}/Calls/${c.sid}/Events.json` },
    };
  }
  // Parameters Twilio sends with every voice webhook about a call.
  function callParams(c) {
    const p = { AccountSid: cfg.accountSid, ApiVersion: '2010-04-01', CallSid: c.sid, CallStatus: c.status, Called: c.to, Caller: c.from, Direction: c.direction, From: c.from, To: c.to };
    for (const [prefix, num] of [['From', c.from], ['Caller', c.from], ['To', c.to], ['Called', c.to]]) if (country(num)) p[prefix + 'Country'] = country(num);
    if (c.parentCallSid) p.ParentCallSid = c.parentCallSid;
    if (c.answeredBy) p.AnsweredBy = c.answeredBy;
    return p;
  }
  function createRecording({ call, channels, source, duration, kind, startedAt }) {
    const rec = { sid: 'RE' + hex(32), callSid: call.sid, channels, source, duration, kind, startedAt, status: 'in-progress', deleted: false, created: Date.now() };
    recordings.set(rec.sid, rec);
    return rec;
  }
  const recordingUrl = (rec) => `${baseUrl}${accountPath}/Recordings/${rec.sid}`;
  function recordingJson(r) {
    return {
      sid: r.sid, account_sid: cfg.accountSid, api_version: '2010-04-01', call_sid: r.callSid, conference_sid: null, channels: r.channels,
      date_created: rfc2822(r.created), date_updated: rfc2822(r.created), start_time: rfc2822(r.startedAt), duration: String(r.duration),
      price: (-Math.ceil(r.duration / 60) * 0.0025).toFixed(5), price_unit: 'USD', source: r.source, status: r.status, error_code: null, encryption_details: null,
      uri: `${accountPath}/Recordings/${r.sid}.json`, media_url: recordingUrl(r),
      subresource_uris: { add_on_results: `${accountPath}/Recordings/${r.sid}/AddOnResults.json`, transcriptions: `${accountPath}/Recordings/${r.sid}/Transcriptions.json` },
    };
  }

  // ---- webhooks --------------------------------------------------------------------------------------------------
  async function sendWebhook(what, call, url, method, params) {
    const m = String(method || 'POST').toUpperCase();
    let target = String(url).split('#')[0]; // a #fragment holds Twilio "connection overrides"; it is neither sent nor signed
    const headers = { 'User-Agent': 'TwilioProxy/1.1', Accept: '*/*', 'I-Twilio-Idempotency-Token': crypto.randomUUID() };
    let body, signed;
    if (m === 'GET') {
      const u = new URL(target);
      for (const [k, v] of Object.entries(params)) u.searchParams.append(k, v);
      target = u.toString(); signed = {};
    } else {
      body = new URLSearchParams(params).toString(); signed = params;
      headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
    }
    headers['X-Twilio-Signature'] = twilioSignature(cfg.authToken, target, signed);
    const entry = { kind: 'webhook', what, callSid: call?.sid, method: m, url: target, params, signature: headers['X-Twilio-Signature'] };
    if (behaviour.drop.some((name) => what.startsWith(name))) {
      log({ ...entry, status: 0, error: 'dropped by the test' });
      return { status: 0, contentType: '', text: '', dropped: true };
    }
    try {
      const request = () => fetch(target, { method: m, headers, body, redirect: 'manual', signal: AbortSignal.timeout(15000) });
      const res = await request();
      const text = await res.text();
      if (behaviour.twice) { const again = await request(); entry.secondStatus = again.status; entry.secondResponse = (await again.text()).slice(0, 4000); }
      Object.assign(entry, { status: res.status, contentType: res.headers.get('content-type'), response: text.slice(0, 4000) });
      log(entry);
      return { status: res.status, contentType: res.headers.get('content-type') || '', text };
    } catch (err) {
      Object.assign(entry, { status: 0, error: String(err.cause?.code || err.message) });
      log(entry);
      return { status: 0, contentType: '', text: '' };
    }
  }
  // Fetches TwiML. Returns { root, base } or null when the app answered badly (Twilio would play
  // "an application error has occurred" and end the call).
  async function fetchTwiml(what, call, url, method, extra = {}) {
    const res = await sendWebhook(what, call, url, method, { ...callParams(call), ...extra });
    if (res.dropped) return null;
    if (res.status < 200 || res.status >= 300) { note(call, `${what}: the app answered HTTP ${res.status || 'nothing'}; Twilio would report an HTTP retrieval failure and end the call`, 11200); return null; }
    if (!res.text.trim()) return { root: { name: 'Response', attrs: {}, children: [], text: '' }, base: url };
    if (!/xml/i.test(res.contentType)) note(call, `${what}: Content-Type was "${res.contentType}", TwiML should be served as text/xml`, 12300);
    let root;
    try { root = parseXml(res.text); } catch (err) { note(call, `${what}: the TwiML is not valid XML (${err.message})`, 12100); return null; }
    if (root.name !== 'Response') { note(call, `${what}: the root element is <${root.name}>, it must be <Response>`, 12100); return null; }
    return { root, base: url };
  }
  async function statusCallback(call, event) {
    const sc = call.statusCallback;
    if (!sc?.url || !sc.events.includes(event)) return;
    const params = { ...callParams(call), CallbackSource: 'call-progress-events', SequenceNumber: String(call.seq++), Timestamp: rfc2822(call.clock) };
    if (event === 'initiated') params.CallStatus = 'initiated';
    if (event === 'completed' && call.status === 'completed') params.CallDuration = String(call.duration ?? 0);
    if (event === 'completed' && call.dialRecording) Object.assign(params, { RecordingUrl: recordingUrl(call.dialRecording), RecordingSid: call.dialRecording.sid, RecordingDuration: String(call.dialRecording.duration) });
    await sendWebhook(`status:${event}`, call, sc.url, sc.method, params);
  }
  async function recordingCallback(rec, status, cb) {
    rec.status = status;
    if (!cb?.url || !cb.events.includes(status)) return;
    const params = {
      AccountSid: cfg.accountSid, CallSid: rec.callSid, RecordingSid: rec.sid, RecordingUrl: recordingUrl(rec), RecordingStatus: status,
      RecordingChannels: String(rec.reportedChannels ?? rec.channels), RecordingSource: rec.source, RecordingTrack: 'both', RecordingStartTime: rfc2822(rec.startedAt), ErrorCode: '0',
    };
    if (status === 'completed') params.RecordingDuration = String(rec.duration);
    await sendWebhook(`recording:${status}`, calls.get(rec.callSid), cb.url, cb.method, params);
  }
  const resolve = (ref, base) => new URL(ref, base).toString();
  const events = (value, allowed, fallback) => {
    const list = String(value ?? '').split(/\s+/).filter(Boolean);
    return list.length ? list.filter((e) => allowed.includes(e)) : fallback;
  };
  function checkAttrs(call, el) {
    const known = ATTRS[el.name];
    if (!known) return;
    for (const name of Object.keys(el.attrs)) if (!known.includes(name)) note(call, `<${el.name}> has no attribute "${name}"; Twilio logs a schema warning and ignores it`, 12200);
  }

  // ---- running TwiML ---------------------------------------------------------------------------------------------
  async function runDocument(call, doc, leg) {
    let verbs = [...doc.root.children], base = doc.base, redirects = 0;
    while (verbs.length && call.live) {
      if (call.hangupRequested) { note(call, `hung up by the REST API (Status=${call.hangupRequested})`); return; }
      const el = verbs.shift();
      checkAttrs(call, el);
      let next = null;
      if (el.name === 'Say' || el.name === 'Play') { tick(call, SECONDS.say); note(call, `<${el.name}> played to ${leg}: ${el.text || '(audio)'}`); }
      else if (el.name === 'Pause') tick(call, Number(el.attrs.length || 1));
      else if (el.name === 'Hangup') return;
      else if (el.name === 'Reject') { call.rejected = el.attrs.reason === 'busy' ? 'busy' : 'no-answer'; return; }
      else if (el.name === 'Redirect') next = await fetchTwiml('redirect', call, resolve(el.text, base), el.attrs.method);
      else if (el.name === 'Gather') next = await runGather(call, el, base, leg);
      else if (el.name === 'Dial') next = await runDial(call, el, base);
      else if (el.name === 'Record') next = await runRecord(call, el, base);
      else note(call, `<${el.name}> is not something this stand-in acts on; skipped`);
      if (next === false) return;                    // the call is over, or the app answered badly
      if (next) {
        if (++redirects > 10) { note(call, 'more than 10 TwiML documents in one call; stopping'); return; }
        verbs = [...next.root.children]; base = next.base;
      }
      await pause();
    }
  }
  async function runGather(call, el, base, leg) {
    for (const child of el.children) if (child.name === 'Say' || child.name === 'Play') note(call, `<Gather><${child.name}> played to ${leg}: ${child.text || '(audio)'}`);
    tick(call, SECONDS.gather);
    // What is keyed in: scripted for this call, or else a person presses 1 and a machine presses nothing.
    const digits = call.digits ? call.digits.shift() : call.machine ? undefined : '1';
    if (digits === undefined) { note(call, 'no key was pressed; <Gather> timed out and the next verb runs'); return null; }
    for (let waited = 0; !call.hangupRequested && waited < behaviour.keyMs; waited += 20) await realPause(20);
    if (call.hangupRequested) { note(call, `hung up by the REST API (Status=${call.hangupRequested}) before a key was pressed`); return false; }
    return (await fetchTwiml('gather-action', call, resolve(el.attrs.action || base, base), el.attrs.method, { Digits: String(digits) })) || false;
  }
  async function runDial(parent, el, base) {
    const a = el.attrs;
    const nouns = el.children;
    const numberEl = nouns.find((c) => c.name === 'Number');
    if (nouns.some((c) => c.name !== 'Number')) note(parent, `<Dial> contains <${nouns.find((c) => c.name !== 'Number').name}>; this stand-in only dials <Number>`);
    if (nouns.filter((c) => c.name === 'Number').length > 1) note(parent, 'several <Number> elements: Twilio would ring them all at once; this stand-in dials the first only');
    if (numberEl) checkAttrs(parent, numberEl);
    const target = String(numberEl ? numberEl.text : el.text).replace(/[\s().-]/g, '');
    if (a.record !== undefined && !DIAL_RECORD.includes(a.record) && a.record !== 'true' && a.record !== 'false') note(parent, `record="${a.record}" is not one of ${DIAL_RECORD.join(', ')}`, 12200);
    const recordMode = a.record === 'true' ? 'record-from-answer' : DIAL_RECORD.includes(a.record) ? a.record : 'do-not-record';
    const recording = recordMode !== 'do-not-record';
    const recCb = a.recordingStatusCallback ? { url: resolve(a.recordingStatusCallback, base), method: a.recordingStatusCallbackMethod, events: events(a.recordingStatusCallbackEvent, RECORDING_EVENTS, ['completed']) } : null;
    if (recording && !recCb) note(parent, 'the call is recorded but <Dial> has no recordingStatusCallback: the app will not be told when the recording is ready');
    if (a.callerId === undefined && parent.direction === 'outbound-api') note(parent, '<Dial> has no callerId. Set it explicitly: what the called person sees by default on an API-made call was not verified');
    const callerId = (a.callerId ?? parent.from).replace(/[\s().-]/g, '');
    const callerIdOk = numbers.some((n) => n.phoneNumber === callerId) || cfg.verified.includes(callerId) || (parent.direction === 'inbound' && callerId === parent.from);
    const actionParams = (extra) => ({ ...callParams(parent), ...extra });
    const afterDial = async (extra) => {
      if (!a.action) return parent.live ? null : false;   // no action: the next verb runs
      const doc = await fetchTwiml('dial-action', parent, resolve(a.action, base), a.method, actionParams(extra));
      return parent.live && doc ? doc : false;          // TwiML from the action replaces the rest of the document
    };

    if (!callerIdOk) {
      note(parent, `<Dial callerId="${callerId}"> is neither a number on this account nor a verified caller ID; Twilio fails the dial`, 13214);
      return afterDial({ DialCallStatus: 'failed', DialBridged: 'false' });
    }
    if (!E164.test(target)) {
      note(parent, `<Dial> target "${target}" is not a valid E.164 number; Twilio fails the dial`, 13224);
      return afterDial({ DialCallStatus: 'failed', DialBridged: 'false' });
    }

    const nAttrs = numberEl?.attrs ?? {};
    const child = createCall({
      to: target, from: callerId, direction: 'outbound-dial', parent,
      statusCallback: nAttrs.statusCallback ? { url: resolve(nAttrs.statusCallback, base), method: nAttrs.statusCallbackMethod, events: events(nAttrs.statusCallbackEvent, CALL_EVENTS, ['completed']) } : null,
    });
    child.clock = parent.clock;
    const outcome = SCENARIOS.dialed[target] ?? 'answered';
    const timeout = Number(a.timeout ?? 30);
    await statusCallback(child, 'initiated');
    child.status = 'ringing';
    await statusCallback(child, 'ringing');
    await pause();

    if (outcome === 'busy' || outcome === 'no-answer' || outcome === 'failed') {
      tick(child, outcome === 'no-answer' ? timeout : 2); parent.clock = child.clock;
      finish(child, outcome);
      await statusCallback(child, 'completed');
      return afterDial({ DialCallStatus: outcome, DialCallSid: child.sid, DialBridged: 'false' });
    }

    // the second leg is answered (by a person or by voicemail: Twilio cannot tell without machine detection)
    tick(child, SECONDS.ringDialed);
    child.status = 'in-progress'; child.startTime = child.clock;
    await statusCallback(child, 'answered');
    let bridged = true;
    if (nAttrs.url) {
      const whisper = await fetchTwiml('number-url', child, resolve(nAttrs.url, base), nAttrs.method);
      for (const w of whisper?.root.children ?? []) {
        if (w.name === 'Say' || w.name === 'Play') note(child, `<${w.name}> played to the called person only, before the two are joined: ${w.text || '(audio)'}`);
        else if (w.name === 'Hangup') bridged = false;
        else if (w.name !== 'Pause' && w.name !== 'Gather') note(child, `<${w.name}> is not allowed in a <Number url> document`, 12200);
      }
      tick(child, SECONDS.whisper);
      if (outcome === 'hangup-in-whisper') bridged = false;
    }
    let rec = null;
    if (bridged) {
      const talk = outcome === 'voicemail' ? SECONDS.voicemailTalk : SECONDS.talk;
      if (recording) {
        rec = createRecording({ call: parent, channels: recordMode.endsWith('-dual') && !behaviour.mono ? 2 : 1, source: 'DialVerb', duration: talk, kind: 'call', startedAt: child.clock });
        if (behaviour.mono) rec.reportedChannels = behaviour.monoReported;
        if (behaviour.absent) rec.absent = true;
        child.dialRecording = rec;
        await recordingCallback(rec, 'in-progress', recCb);
      }
      note(parent, `the two legs are joined; they talk for ${talk} seconds${outcome === 'voicemail' ? ' (the called side is a voicemail greeting)' : ''}`);
      for (let waited = 0; !parent.hangupRequested && waited < (outcome === 'talks-on' ? 4000 : behaviour.talkMs); waited += 20) await realPause(20);
      tick(child, talk);
    }
    parent.clock = child.clock;
    finish(child, 'completed');
    if (outcome === 'parent-hangs-up' || parent.hangupRequested) finish(parent, 'completed');
    await statusCallback(child, 'completed');
    const outcomeOfRecording = rec?.absent ? 'absent' : 'completed';
    if (rec && cfg.recordingCallbackFirst) await recordingCallback(rec, outcomeOfRecording, recCb);
    else if (rec) parent.pendingRecordingCallbacks.push(() => recordingCallback(rec, outcomeOfRecording, recCb));
    const extra = { DialCallStatus: 'completed', DialCallSid: child.sid, DialCallDuration: String(child.duration), DialBridged: String(bridged) };
    if (rec) Object.assign(extra, { RecordingUrl: recordingUrl(rec), RecordingSid: rec.sid, RecordingDuration: String(rec.duration) });
    return afterDial(extra);
  }
  // <Record>: the caller leaves a message and hangs up.
  async function runRecord(call, el, base) {
    const a = el.attrs;
    const recCb = a.recordingStatusCallback ? { url: resolve(a.recordingStatusCallback, base), method: a.recordingStatusCallbackMethod, events: events(a.recordingStatusCallbackEvent, RECORDING_EVENTS, ['completed']) } : null;
    const rec = createRecording({ call, channels: 1, source: 'RecordVerb', duration: SECONDS.voicemailMessage, kind: 'voicemail', startedAt: call.clock });
    await recordingCallback(rec, 'in-progress', recCb);
    tick(call, SECONDS.voicemailMessage);
    note(call, `the caller leaves a ${SECONDS.voicemailMessage}-second message and hangs up`);
    finish(call, 'completed');
    if (!a.action) note(call, '<Record> has no action: Twilio requests the current document URL again, with the recording parameters');
    await sendWebhook('record-action', call, resolve(a.action || base, base), a.method, { ...callParams(call), RecordingUrl: recordingUrl(rec), RecordingSid: rec.sid, RecordingDuration: String(rec.duration), Digits: 'hangup' });
    call.pendingRecordingCallbacks.push(() => recordingCallback(rec, 'completed', recCb));
    return false;
  }

  async function track(fn) {
    running++;
    try { await fn(); } catch (err) { log({ kind: 'note', text: `stand-in error: ${err.stack}` }); } finally {
      if (--running === 0) { for (const w of idleWaiters) w(); idleWaiters = []; }
    }
  }
  async function endOfCall(call) {
    finish(call, call.rejected ?? (call.hangupRequested === 'canceled' && !call.startTime ? 'canceled' : 'completed'));
    await statusCallback(call, 'completed');
    for (const send of call.pendingRecordingCallbacks) { await pause(); await send(); }
  }
  // A call made with the REST API: ring the first leg, fetch TwiML when it answers, follow it.
  async function runOutbound(call, p) {
    await pause();
    await statusCallback(call, 'initiated');
    call.status = 'ringing';
    await statusCallback(call, 'ringing');
    await pause();
    if (call.hangupRequested) return endOfCall(call);
    let outcome = SCENARIOS.firstLeg[call.to] ?? 'answered';
    if (outcome === 'rings-on') {
      for (let waited = 0; !call.hangupRequested && waited < 3000; waited += 20) await realPause(20);
      if (call.hangupRequested) return endOfCall(call);
      outcome = 'no-answer';
    }
    if (outcome === 'no-answer' || outcome === 'busy' || outcome === 'failed') {
      tick(call, outcome === 'no-answer' ? Number(p.Timeout || 60) : 2);
      finish(call, outcome);
      return statusCallback(call, 'completed');
    }
    tick(call, SECONDS.ringFirstLeg);
    call.status = 'in-progress'; call.startTime = call.clock;
    if (outcome === 'voicemail') call.machine = true;
    else if (behaviour.firstLegDigits) call.digits = [...behaviour.firstLegDigits];
    if (p.MachineDetection) call.answeredBy = call.machine ? 'machine_start' : 'human';
    const doc = p.Url
      ? await fetchTwiml('voice-url', call, p.Url, p.Method)
      : (() => { try { return { root: parseXml(p.Twiml), base: baseUrl }; } catch (err) { note(call, `Twiml parameter is not valid XML (${err.message})`, 12100); return null; } })();
    await statusCallback(call, 'answered');
    if (doc) await runDocument(call, doc, 'the first leg');
    await endOfCall(call);
  }
  // A call from outside to one of the account's numbers.
  async function runInbound(call, number, overrides) {
    const voiceUrl = overrides.voiceUrl || number.voiceUrl;
    if (!voiceUrl) { note(call, `the number ${number.phoneNumber} has no VoiceUrl; Twilio would reject the call`); finish(call, 'failed'); return; }
    const doc = await fetchTwiml('voice-url', call, voiceUrl, overrides.voiceMethod || number.voiceMethod);
    call.status = 'in-progress'; call.startTime = call.clock;
    if (doc) await runDocument(call, doc, 'the caller');
    await endOfCall(call);
  }

  // ---- REST API --------------------------------------------------------------------------------------------------
  const send = (res, status, body, headers = {}) => {
    const data = body === undefined ? '' : Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(status, { ...(body === undefined ? {} : { 'Content-Type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json', 'Content-Length': Buffer.byteLength(data) }), ...headers });
    res.end(data);
    return status;
  };
  const apiError = (res, status, code, message) => send(res, status, { code, message, more_info: `https://www.twilio.com/docs/errors/${code}`, status });
  function whoIs(req) {
    const m = /^Basic\s+(.+)$/i.exec(req.headers.authorization || '');
    if (!m) return null;
    const [user, ...rest] = Buffer.from(m[1], 'base64').toString('utf8').split(':');
    const pass = rest.join(':');
    if (user === cfg.accountSid && pass === cfg.authToken) return 'account-sid+auth-token';
    if (user === cfg.apiKeySid && pass === cfg.apiKeySecret) return 'api-key';
    return null;
  }

  function createCallRequest(res, form, logEntry) {
    const p = Object.fromEntries(form), To = (p.To || '').trim(), From = (p.From || '').trim();
    const statusEvents = form.getAll('StatusCallbackEvent').flatMap((v) => v.split(/\s+/)).filter(Boolean);
    if (form.getAll('StatusCallbackEvent').some((v) => /\s/.test(v.trim()))) logEntry.warnings.push('StatusCallbackEvent was sent as one space-separated value; the API reference says to repeat the parameter once per event');
    if (!To) return apiError(res, 400, 21201, "No 'To' number is specified");
    if (!From) return apiError(res, 400, 21213, "No 'From' number is specified");
    if (!p.Url && !p.Twiml && !p.ApplicationSid) return apiError(res, 400, 21205, 'Url parameter is required.');
    if (p.Url && !/^https?:\/\/[^\s/]+/i.test(p.Url)) return apiError(res, 400, 21205, `Url is not a valid URL: ${p.Url}`);
    if (p.Url && p.Twiml) logEntry.warnings.push('Url and Twiml both sent: Twilio ignores Twiml');
    if (p.Twiml && p.Twiml.length > 4000) return apiError(res, 400, 21218, 'Twiml is longer than 4000 characters'); // error code is a placeholder
    for (const key of ['Method', 'StatusCallbackMethod', 'FallbackMethod', 'RecordingStatusCallbackMethod']) if (p[key] && !['GET', 'POST'].includes(p[key].toUpperCase())) return apiError(res, 400, 21206, `${key} must be GET or POST`); // code is a placeholder
    if (p.Timeout && !(/^\d+$/.test(p.Timeout) && Number(p.Timeout) >= 1 && Number(p.Timeout) <= 600)) return apiError(res, 400, 21207, 'Timeout must be between 1 and 600'); // code is a placeholder
    const bad = statusEvents.find((e) => !CALL_EVENTS.includes(e));
    if (bad) return apiError(res, 400, 21626, `Invalid StatusCallbackEvent: ${bad}`); // code is a placeholder
    if (p.StatusCallback && !/^https?:\/\//i.test(p.StatusCallback)) return apiError(res, 400, 21609, `Invalid StatusCallback: ${p.StatusCallback}`); // code is a placeholder
    if (SCENARIOS.rest[To]) { const e = SCENARIOS.rest[To]; return apiError(res, e.status, e.code, e.message); }
    if (!E164.test(To)) return apiError(res, 400, 21211, `The 'To' number ${To} is not a valid phone number.`); // stricter than Twilio, which tolerates some national formats
    if (!numbers.some((n) => n.phoneNumber === From) && !cfg.verified.includes(From)) return apiError(res, 400, 21210, `The source phone number provided, ${From}, is not yet verified for your account. You may only make calls from phone numbers that you've verified or purchased from Twilio.`);
    for (const key of ['Record', 'RecordingChannels', 'RecordingStatusCallback']) if (p[key]) logEntry.warnings.push(`${key} on the REST call is accepted but not acted on by this stand-in (it records through <Dial record>)`);
    const call = createCall({
      to: To, from: From, direction: 'outbound-api',
      statusCallback: p.StatusCallback ? { url: p.StatusCallback, method: p.StatusCallbackMethod, events: statusEvents.length ? statusEvents : ['completed'] } : null,
    });
    track(() => runOutbound(call, p));
    return send(res, 201, callJson(call));
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url, baseUrl), path = url.pathname, raw = Buffer.concat(chunks).toString('utf8');
      const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      // control endpoints
      if (path === '/_standin/log') return send(res, 200, entries);
      if (path === '/_standin/idle') { const done = () => send(res, 200, { idle: true }); return running === 0 ? done() : idleWaiters.push(done); }
      if (path === '/_standin/inbound' && req.method === 'POST') {
        let o; try { o = JSON.parse(raw || '{}'); } catch { return send(res, 400, { error: 'send JSON' }); }
        const number = numbers.find((n) => n.phoneNumber === (o.to || numbers[0].phoneNumber));
        if (!number) return send(res, 404, { error: `${o.to} is not a number on this account`, numbers: numbers.map((n) => n.phoneNumber) });
        if (!E164.test(o.from || '')) return send(res, 400, { error: 'from must be an E.164 number such as +14165550123' });
        const sc = o.statusCallback || number.statusCallback;
        const call = createCall({ to: number.phoneNumber, from: o.from, direction: 'inbound', statusCallback: sc ? { url: sc, method: number.statusCallbackMethod, events: ['completed'] } : null });
        call.digits = Array.isArray(o.digits) ? o.digits.map(String) : []; // a caller keys in only what the test says
        log({ kind: 'control', what: 'inbound call simulated', callSid: call.sid, from: o.from, to: number.phoneNumber });
        track(() => runInbound(call, number, o));
        return send(res, 201, { callSid: call.sid });
      }

      const entry = { kind: 'rest', method: req.method, path: path + url.search, auth: null, contentType: type || null, params: null, warnings: [] };
      const done = (status) => { entry.status = status; if (!entry.warnings.length) delete entry.warnings; log(entry); };
      const who = whoIs(req);
      entry.auth = who ?? (req.headers.authorization ? 'wrong credentials' : 'no Authorization header');
      const form = new URLSearchParams(type === 'application/x-www-form-urlencoded' ? raw : '');
      if (req.method === 'POST') {
        entry.params = Object.fromEntries([...new Set(form.keys())].map((k) => [k, form.getAll(k).length > 1 ? form.getAll(k) : form.get(k)]));
        if (raw && type !== 'application/x-www-form-urlencoded') entry.warnings.push(`the body was sent as "${type || 'no content type'}"; Twilio's API reads application/x-www-form-urlencoded, so every parameter was ignored`);
      }
      if (!who) return done(send(res, 401, { code: 20003, message: 'Authenticate', more_info: 'https://www.twilio.com/docs/errors/20003', status: 401 }, { 'WWW-Authenticate': 'Basic realm="Twilio API"' }));
      const m = /^\/2010-04-01\/Accounts\/([^/]+)\/(.+)$/.exec(path);
      if (!m) return done(apiError(res, 404, 20404, `The requested resource ${path} was not found`));
      if (m[1] !== cfg.accountSid) return done(apiError(res, 401, 20003, 'Authenticate'));
      const rest = m[2];
      let r;

      if (rest === 'Calls.json' && req.method === 'POST') return done(createCallRequest(res, form, entry));
      if (rest === 'Calls.json' && req.method === 'GET') {
        const parent = url.searchParams.get('ParentCallSid');
        const list = [...calls.values()].filter((c) => !parent || c.parentCallSid === parent).map(callJson);
        return done(send(res, 200, { calls: list, page: 0, page_size: 50, start: 0, end: Math.max(0, list.length - 1), next_page_uri: null, previous_page_uri: null, first_page_uri: `${accountPath}/Calls.json?PageSize=50&Page=0`, uri: `${accountPath}/Calls.json${url.search}` }));
      }
      if ((r = /^Calls\/(CA[0-9a-f]{32})\.json$/i.exec(rest))) {
        const call = calls.get(r[1]);
        if (!call) return done(apiError(res, 404, 20404, `The requested resource ${path} was not found`));
        if (req.method === 'GET') return done(send(res, 200, callJson(call)));
        if (req.method === 'POST') {
          const status = form.get('Status');
          if (status && !['canceled', 'completed'].includes(status)) return done(apiError(res, 400, 21220, `Invalid call status: ${status}`)); // code is a placeholder
          if (status && !call.live && behaviour.hangupRefused) return done(apiError(res, 400, 21220, 'Invalid call status: the call is not in-progress and cannot be redirected or ended')); // HTTP status from memory in the research
          if (status && call.live) call.hangupRequested = status;
          return done(send(res, 200, callJson(call)));
        }
      }
      if ((r = /^Calls\/(CA[0-9a-f]{32})\/Recordings\.json$/i.exec(rest)) && req.method === 'GET') {
        if (!calls.has(r[1])) return done(apiError(res, 404, 20404, `The requested resource ${path} was not found`));
        const list = [...recordings.values()].filter((rec) => rec.callSid === r[1] && !rec.deleted).map(recordingJson).map((rec) => (behaviour.stuck ? { ...rec, status: 'processing' } : rec));
        return done(send(res, 200, { recordings: list, page: 0, page_size: 50, start: 0, end: Math.max(0, list.length - 1), next_page_uri: null, previous_page_uri: null, uri: `${accountPath}/Calls/${r[1]}/Recordings.json` }));
      }
      if ((r = /^Recordings\/(RE[0-9a-f]{32})(\.json|\.wav|\.mp3)?$/i.exec(rest))) {
        const rec = recordings.get(r[1]), ext = (r[2] || '').toLowerCase();
        if (!rec || rec.deleted) return done(apiError(res, 404, 20404, `The requested resource ${path} was not found`));
        if (req.method === 'DELETE') {
          if (ext !== '.json') return done(apiError(res, 405, 20004, 'Method not allowed')); // delete the resource (.json), not the media file
          if (behaviour.deleteFailures > 0) { behaviour.deleteFailures--; return done(apiError(res, 500, 20500, 'Internal server error')); }
          rec.deleted = true;
          return done(send(res, 204));
        }
        if (req.method !== 'GET') return done(apiError(res, 405, 20004, 'Method not allowed'));
        if (ext === '.json') return done(send(res, 200, recordingJson(rec)));
        if (rec.status !== 'completed') return done(apiError(res, 404, 20404, 'The recording is not available yet')); // asked for before the "completed" callback
        if (behaviour.downloadFailures > 0) { behaviour.downloadFailures--; return done(apiError(res, 404, 20404, 'The recording is not available yet')); }
        const requested = url.searchParams.get('RequestedChannels');
        if (requested !== null && requested !== '1' && requested !== '2') return done(apiError(res, 400, 20001, 'RequestedChannels must be 1 or 2'));
        if (requested === '2' && rec.channels !== 2) return done(apiError(res, behaviour.monoRefusal, behaviour.monoRefusal === 404 ? 20404 : 16113, 'Cannot download a dual-channel presentation of a mono recording'));
        // Without RequestedChannels this stand-in gives ONE channel, on purpose: Twilio's default was not verified, so always ask.
        if (requested === null && rec.channels === 2) entry.warnings.push('RequestedChannels was not sent: this stand-in returns a mono mix. Send RequestedChannels=2 to get both channels.');
        const key = rec.kind === 'voicemail' ? 'voicemail' : requested === '2' ? 'call2' : 'call1';
        let media = audio[key], mime = ext === '.wav' ? 'audio/x-wav' : 'audio/wav';
        if (ext === '.mp3') {
          if (!mp3Cache.has(key)) mp3Cache.set(key, toMp3(audio[key]));
          media = mp3Cache.get(key); mime = 'audio/mpeg';
          if (!media) return done(apiError(res, 501, 0, 'this stand-in needs ffmpeg to serve .mp3; ask for .wav'));
        }
        entry.served = { bytes: media.length, mime, channels: key === 'call2' ? 2 : 1 };
        return done(send(res, 200, media, { 'Content-Type': mime }));
      }
      if (rest === 'IncomingPhoneNumbers.json' && req.method === 'GET') {
        const want = url.searchParams.get('PhoneNumber');
        const list = numbers.filter((n) => !want || n.phoneNumber === want).map(numberJson);
        return done(send(res, 200, { incoming_phone_numbers: list, page: 0, page_size: 50, uri: `${accountPath}/IncomingPhoneNumbers.json` }));
      }
      if ((r = /^IncomingPhoneNumbers\/(PN[0-9a-f]{32})\.json$/i.exec(rest))) {
        const number = numbers.find((n) => n.sid === r[1]);
        if (!number) return done(apiError(res, 404, 20404, `The requested resource ${path} was not found`));
        if (req.method === 'POST') for (const [param, field] of [['VoiceUrl', 'voiceUrl'], ['VoiceMethod', 'voiceMethod'], ['StatusCallback', 'statusCallback'], ['StatusCallbackMethod', 'statusCallbackMethod']]) if (form.has(param)) number[field] = form.get(param);
        return done(send(res, 200, numberJson(number)));
      }
      return done(apiError(res, 404, 20404, `The requested resource ${path} was not found`));
    });
  });
  function numberJson(n) {
    return {
      sid: n.sid, account_sid: cfg.accountSid, phone_number: n.phoneNumber, friendly_name: n.phoneNumber, api_version: '2010-04-01',
      voice_url: n.voiceUrl, voice_method: n.voiceMethod, voice_fallback_url: null, voice_fallback_method: 'POST', voice_application_sid: '', voice_caller_id_lookup: false,
      status_callback: n.statusCallback, status_callback_method: n.statusCallbackMethod, capabilities: { voice: true, sms: true, mms: true, fax: false },
      status: 'in-use', type: 'local', uri: `${accountPath}/IncomingPhoneNumbers/${n.sid}.json`,
    };
  }

  await new Promise((ok, fail) => { server.once('error', fail); server.listen(cfg.port, '127.0.0.1', ok); });
  if (!cfg.quiet) console.log(`Twilio stand-in on ${baseUrl}\n  TWILIO_API_URL=${baseUrl}\n  TWILIO_ACCOUNT_SID=${cfg.accountSid}\n  TWILIO_AUTH_TOKEN=${cfg.authToken}\n  TWILIO_API_KEY_SID=${cfg.apiKeySid}\n  TWILIO_API_KEY_SECRET=${cfg.apiKeySecret}\n  numbers on the account: ${cfg.numbers.join(', ')}\n  log: ${cfg.logFile}`);
  return {
    baseUrl, config: cfg, numbers, entries, behaviour, calls, recordings,
    idle: () => new Promise((r) => (running === 0 ? r() : idleWaiters.push(r))),
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) await startStandin();
