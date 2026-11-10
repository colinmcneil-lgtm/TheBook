// Phone calls through The Book's own number: placing them, taking them, recording them, and handing the recording
// to the Oracle. The phone service is Twilio.
//
// Three ways a call happens:
//   1. Click to call. The recruiter presses Call in the app. Twilio rings the recruiter's own mobile; they hear who
//      they are about to call and press 1 (so a voicemail that answers their phone is never connected to a
//      candidate); then the candidate is rung, seeing The Book's number.
//   2. The switchboard, for calling with no screen. The recruiter rings The Book's number from their saved mobile,
//      keys in their PIN, then the number to call followed by #.
//   3. Somebody rings The Book's number. They are put through to the recruiter who last called them (else the owner
//      of their most recent application, else the first admin with a mobile saved). If nobody answers they can
//      leave a message.
//
// A recorded call is recorded from the moment the second person answers, each person on a channel of their own, and
// the person who did not place the call hears a short notice first. When the call ends Twilio tells us the
// recording is ready; it is fetched, stored the way the Oracle stores audio, deleted from Twilio, and from there it
// is an Oracle call like any other: written out, notes drafted, and the recruiter e-mailed that the notes are ready.
//
// Twilio talks to us through webhooks, and none of them is promised to arrive, or to arrive once, or in order. So
// every step here can be repeated without harm, and a sweep asks Twilio about calls that went quiet and recordings
// that never turned up. A recording is only deleted from Twilio once it is safely on our disk.
//
// Agency only: client users are refused on every route, and the routes Twilio calls are trusted only by its
// signature. Phone numbers and PINs are never written to the server log.
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { q, now, tx, getSetting, UPLOAD_DIR } from './db.js';
import { appUrl, notify } from './mail.js';
import { validateWebhook } from './twilio-signature.js';
import { toE164, placeOf, displayNumber, spokenNumber, searchDigits, KNOWN_COUNTRIES } from './phone-numbers.js';
import { transcriptionConfigured, startTranscription, onCallReady, lengthWords, UNTITLED, VOICEMAIL } from './oracle.js';
import { tieCallToEvent } from './calendar.js';

// ---------- settings ----------
const env = (name) => (process.env[name] || '').trim();
const ACCOUNT_SID = env('TWILIO_ACCOUNT_SID');
const AUTH_TOKEN = env('TWILIO_AUTH_TOKEN');
const BOOK_NUMBER = toE164(env('TWILIO_NUMBER'));                  // The Book's own number, in the stored form
const API_URL = (env('TWILIO_API_URL') || 'https://api.twilio.com').replace(/\/+$/, '');
// Which countries may be called, as two-letter codes. Canada and the United States unless set.
const COUNTRIES = [...new Set((env('PHONE_COUNTRIES') || 'CA,US').split(',').map((code) => code.trim().toUpperCase()).filter((code) => /^[A-Z]{2}$/.test(code)))];
// The notice the other person hears before a recorded call is connected: on unless switched off, and the words can be replaced.
const NOTICE_SETTING = env('PHONE_NOTICE');
const NOTICE_ON = !/^(off|false|0|no)$/i.test(NOTICE_SETTING);
const NOTICE_WORDS = NOTICE_ON && !/^(|on|true|1|yes)$/i.test(NOTICE_SETTING) ? NOTICE_SETTING.replace(/\s+/g, ' ').slice(0, 300) : null;
// What a recruiter's phone shows when a caller is put through: The Book's number (one contact to save, and ringing
// back from the call log reaches the switchboard, so the call back is recorded too), or the caller's own.
const FORWARD_SHOWS_CALLER = /^caller$/i.test(env('PHONE_FORWARD_SHOWS'));
const VOICE = env('PHONE_VOICE').slice(0, 60);                      // optional: which of Twilio's voices reads the prompts
const CALLS_PER_HOUR = Math.max(1, Number(env('PHONE_CALLS_PER_HOUR')) || 30);

const SECOND = 1000, MINUTE = 60 * SECOND, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const ms = (name, fallback) => (Number(env(name)) > 0 ? Number(env(name)) : fallback);
const SWEEP_EVERY = ms('PHONE_SWEEP_MS', MINUTE);                   // how often calls that went quiet are looked at
const QUIET_AFTER = ms('PHONE_QUIET_MS', 2 * MINUTE);               // a live call with no word for this long is checked with Twilio
const RECORDING_WAIT = ms('PHONE_RECORDING_WAIT_MS', 2 * MINUTE);   // how long after a call ends before Twilio is asked for its recording
const RECORDING_GIVE_UP = ms('PHONE_RECORDING_GIVE_UP_MS', 15 * MINUTE); // Twilio: a recording not ready by now will not come
const RETRY_BASE = ms('PHONE_RETRY_MS', 5 * SECOND);                // the first pause before fetching a recording again
const RING_YOU = 25, RING_THEM = 25, RING_FORWARD = 20;             // seconds; short enough that most voicemail has not picked up
const MAX_CALL_SECONDS = 3 * 3600;                                  // the same three hours a recording in the browser may run
const MAX_AUDIO_BYTES = 800 * 1024 * 1024;                          // three hours on two channels is about 350 MB
const LOCK_MINUTES = 15, MAX_PIN_FAILS = 3, MAX_ASKS = 3;
const INBOUND_PER_NUMBER = 10, INBOUND_PER_HOUR = 60;               // calls put through in an hour, from one number and in all
const KEEP_WEBHOOKS = 14 * DAY;

/** Can calls be placed? Needs the three Twilio settings, and the public address Twilio is to call us back on. */
export const phoneConfigured = () => Boolean(ACCOUNT_SID && AUTH_TOKEN && BOOK_NUMBER && appUrl());

if (ACCOUNT_SID || AUTH_TOKEN || env('TWILIO_NUMBER')) {
  const missing = [!ACCOUNT_SID && 'TWILIO_ACCOUNT_SID', !AUTH_TOKEN && 'TWILIO_AUTH_TOKEN', !env('TWILIO_NUMBER') && 'TWILIO_NUMBER', !appUrl() && 'APP_URL'].filter(Boolean);
  if (missing.length) console.error(`Phone calls are not connected: ${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} not set.`);
  else if (!BOOK_NUMBER) console.error('Phone calls are not connected: TWILIO_NUMBER is not a phone number The Book can read. Write it as +1 and ten digits.');
  const unknown = COUNTRIES.filter((code) => !KNOWN_COUNTRIES.has(code));
  if (unknown.length) console.error(`PHONE_COUNTRIES names ${unknown.join(', ')}, which The Book does not know how to recognise numbers for. Numbers there will be refused.`);
}

// ---------- small helpers ----------
const one = (value) => (Array.isArray(value) ? value[0] : value);   // a form field sent twice arrives as a list
const text = (value, max = 200) => (typeof one(value) === 'string' ? one(value).trim().slice(0, max) : '');
const later = (msFromNow) => new Date(Date.now() + msFromNow).toISOString();
const ago = (msBack) => new Date(Date.now() - msBack).toISOString();
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || null;
const agencyName = () => (getSetting('agency_name', '') || '').trim();
const phoneCall = (id) => (Number.isInteger(id) ? q.get('SELECT * FROM phone_calls WHERE id = ?', id) ?? null : null);
const candidateOf = (id) => (id ? q.get('SELECT id, name FROM candidates WHERE id = ?', id) ?? null : null);
const LIVE = `status NOT IN ('ended', 'failed')`;
const AGENCY_USER = `active = 1 AND pending = 0 AND role != 'client'`;

/**
 * The words the other person hears before a recorded call is connected: when they answer a call that was placed,
 * or as soon as they ring in. Short, so it is over in under ten seconds, and it says three things: that the call
 * is recorded, why, and that they can ask for it not to be.
 */
function noticeWords(inbound = false) {
  const agency = agencyName();
  const rest = `recorded and transcribed for recruitment notes. Tell your recruiter if you'd prefer it wasn't.`;
  if (inbound) return `Thanks for calling${agency ? ` ${agency}` : ''}. ${NOTICE_WORDS || `This call is ${rest}`}`;
  return NOTICE_WORDS || `This call${agency ? ` from ${agency}` : ''} is ${rest}`;
}

// PINs are short, so they are hashed the slow way passwords are, each with its own salt.
const hashPin = (pin, salt = crypto.randomBytes(16).toString('hex')) => `${salt}:${crypto.scryptSync(pin, salt, 32).toString('hex')}`;
function pinMatches(pin, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const given = crypto.scryptSync(String(pin), salt, 32), kept = Buffer.from(hash, 'hex');
  return given.length === kept.length && crypto.timingSafeEqual(given, kept);
}
/** PINs anybody would try first: one digit repeated, or a run up or down ("1234", "654321"). */
function easyPin(pin) {
  const steps = new Set([...pin].slice(1).map((digit, i) => Number(digit) - Number(pin[i])));
  return steps.size === 1 && [0, 1, -1].includes([...steps][0]);
}

/**
 * May this number be rung? Resolves what somebody typed to the stored form, or to a sentence saying why not.
 * `whose` words the sentence for the person's own mobile.
 */
function callable(typed, whose = 'That') {
  const number = toE164(String(typed ?? ''));
  if (!number) return { error: `${whose === 'That' ? 'That phone number' : 'Your mobile number'} could not be understood. Write it with its area code, for example (416) 555-0123.` };
  if (number === BOOK_NUMBER) return { error: `That is The Book's own number.` };
  const place = placeOf(number);
  if (place.special) return { error: 'That is a premium-rate, toll-free or other special number, which The Book does not call.' };
  if (!place.country || !COUNTRIES.includes(place.country)) {
    return { error: `That number is outside the countries this workspace can call (${COUNTRIES.join(', ')}).` };
  }
  return { number };
}

// Candidates' numbers are kept as they were typed, so finding one means comparing digits: first loosely in the
// database, then exactly, in the stored form.
const DIGITS_OF_PHONE = `replace(replace(replace(replace(replace(replace(replace(c.phone, ' ', ''), '-', ''), '(', ''), ')', ''), '.', ''), '+', ''), char(160), '')`;
function candidatesWithNumber(number) {
  if (!number) return [];
  return q.all(`SELECT c.id, c.name, c.phone FROM candidates c WHERE c.phone IS NOT NULL AND ${DIGITS_OF_PHONE} LIKE ?`, `%${searchDigits(number)}%`)
    .filter((candidate) => toE164(candidate.phone) === number);
}
/** The application a call with this person belongs on: the most recent one that is still active, else the most recent. */
const bestApplication = (candidateId) =>
  q.get(`SELECT id FROM applications WHERE candidate_id = ? ORDER BY status = 'active' DESC, applied_at DESC, id DESC LIMIT 1`, candidateId)?.id ?? null;

// ---------- talking to Twilio ----------
class TwilioError extends Error {
  constructor(status, code) { super(`Twilio answered ${status}${code ? ` (code ${code})` : ''}`); this.status = status; this.code = code; }
}
const account = () => `${API_URL}/2010-04-01/Accounts/${ACCOUNT_SID}`;
const authorization = () => `Basic ${Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString('base64')}`;
/**
 * One request to Twilio's API. Bodies are forms, never JSON. Resolves to the answer's JSON (or null when there is
 * none); throws a TwilioError carrying the status and Twilio's error code. Twilio's own message is never kept or
 * logged: it usually has a phone number in it.
 */
async function twilio(method, pathname, form) {
  let res;
  try {
    res = await fetch(`${account()}${pathname}`, {
      method,
      headers: { Authorization: authorization(), ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      body: form ? form.toString() : undefined,
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new TwilioError(0, null); // not reached, or no answer in time
  }
  const body = await res.text().catch(() => '');
  let parsed = null;
  try { parsed = body ? JSON.parse(body) : null; } catch { /* not JSON */ }
  if (!res.ok) throw new TwilioError(res.status, Number(parsed?.code) || null);
  return parsed;
}
// Why Twilio would not start a call, for the recruiter. Anything not listed is "could not be started".
const START_PROBLEMS = {
  20003: 'The phone service rejected our sign-in. Ask whoever hosts The Book to check the Twilio settings.',
  20005: 'The phone service account is not active. It may be out of credit.',
  10001: 'The phone service account is not active. It may be out of credit.',
  21210: `The number calls are made from is not set up on the phone service account. Ask whoever hosts The Book to check TWILIO_NUMBER.`,
  21211: 'The phone service could not ring your mobile. Check the number you saved.',
  21214: 'The phone service could not ring your mobile. Check the number you saved.',
  21217: 'The phone service could not ring your mobile. Check the number you saved.',
  21215: 'Calls to your mobile are switched off on the phone service account (its geographic permissions).',
  21216: 'Calls to your mobile are blocked on the phone service account.',
  21219: 'The phone service is still on a trial, which can only ring numbers that have been verified with it.',
};
const startProblem = (code) => START_PROBLEMS[code] ?? 'The phone service could not start the call. Try again in a minute.';

// ---------- TwiML: what Twilio is told to do next ----------
const esc = (value) => String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch]);
const xml = (inner = '') => `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
const say = (words) => `<Say${VOICE ? ` voice="${esc(VOICE)}"` : ''}>${esc(words)}</Say>`;
const HANGUP = '<Hangup/>';
/** The address of one of our webhooks, as Twilio is given it: always the public address, never taken from a request. */
const hook = (name, id, extra = '') => `${appUrl()}/api/phone/twilio/${name}?c=${id}${extra}`;
const SORRY = xml(`${say('Sorry, something went wrong. Please try again.')}${HANGUP}`);

/** Who the other person on a call is, for sentences read to the recruiter and shown on the screen. */
function otherParty(pc) {
  const candidate = candidateOf(pc.candidate_id);
  return { name: candidate?.name ?? null, first: firstName(candidate?.name), number: pc.to_number };
}
/** For a voice: the person's name, or their number one digit at a time. */
const spokenParty = (who) => who.name || (who.number ? spokenNumber(who.number) : 'a withheld number');

/** Ask the recruiter to press 1 before anybody is rung: a voicemail that answered their phone presses nothing. */
function pressOne(pc, attempt = 1) {
  const who = spokenParty(otherParty(pc));
  const words = `${attempt > 1 ? 'That was not 1. ' : 'This is The Book. '}Press 1 to call ${who}. ${pc.record ? 'The call will be recorded.' : 'The call will not be recorded.'}`;
  // Asked twice, a few seconds apart: finding the keypad on a phone that has just been answered takes a moment.
  const ask = `<Gather numDigits="1" timeout="8" action="${esc(hook('connect', pc.id, `&n=${attempt}`))}" method="POST">${say(words)}</Gather>`;
  return xml(`${ask}${ask}${say('No key was pressed, so nobody was called. Goodbye.')}${HANGUP}`);
}
/**
 * Ring `number` and join it to the call. A recorded call is recorded from the moment they answer, each person on
 * a channel of their own. `url` on <Number> is fetched when they answer, before the two are joined: it is how the
 * notice is played to them alone, and how we know they picked up.
 */
function dial(pc, number, { callerId, timeout }) {
  const recording = pc.record
    ? ` record="record-from-answer-dual" trim="do-not-trim" recordingStatusCallback="${esc(hook('recording', pc.id))}" recordingStatusCallbackMethod="POST" recordingStatusCallbackEvent="in-progress completed absent"`
    : '';
  return `<Dial${callerId ? ` callerId="${esc(callerId)}"` : ''} answerOnBridge="true" timeout="${timeout}" timeLimit="${MAX_CALL_SECONDS}"${recording}` +
    ` action="${esc(hook('dial-done', pc.id))}" method="POST"><Number url="${esc(hook('whisper', pc.id))}" method="POST">${esc(number)}</Number></Dial>`;
}
const dialOther = (pc) => dial(pc, pc.to_number, { callerId: BOOK_NUMBER, timeout: RING_THEM });
const leaveMessage = (pc, words) => xml(`${say(words)}<Record maxLength="120" playBeep="true" timeout="5" action="${esc(hook('voicemail-done', pc.id))}" method="POST"` +
  ` recordingStatusCallback="${esc(hook('recording', pc.id))}" recordingStatusCallbackMethod="POST"/>${HANGUP}`);
const askPin = (pc, lead) => xml(`<Gather finishOnKey="#" timeout="10" action="${esc(hook('pin', pc.id))}" method="POST">${say(`${lead} Enter your PIN, then press hash.`)}</Gather>` +
  `${say('Nothing was entered. Goodbye.')}${HANGUP}`);
const askNumber = (pc, lead = '') => xml(`<Gather finishOnKey="#" timeout="15" action="${esc(hook('number', pc.id))}" method="POST">${say(`${lead}Enter the number to call, area code first, then press hash.`)}</Gather>` +
  `${say('Nothing was entered. Goodbye.')}${HANGUP}`);

// ---------- one sentence for where a call stands ----------
const spell = (seconds) => (seconds > 0 ? ` for ${lengthWords(seconds * 1000).slice(2)}` : '');
function recordingWords(pc) {
  if (!pc.record) return ' The call was not recorded.';
  return {
    stored: ' It is in The Oracle.', waiting: ' The recording is on its way to The Oracle.', pending: ' The recording is on its way to The Oracle.',
    fetching: ' The recording is on its way to The Oracle.', absent: ' It was too short to record.', discarded: ' The recording was deleted.',
    failed: ' The recording could not be fetched from the phone service.',
  }[pc.recording_state] ?? '';
}
const durationOf = (pc) => (pc.outcome === 'completed' || pc.voicemail ? pc.recording_sec ?? pc.talk_sec ?? null : null);
function sentence(pc) {
  const who = otherParty(pc);
  const them = who.first || displayNumber(who.number) || 'a withheld number';
  const Them = who.first || 'That number';
  const inbound = pc.direction === 'inbound';
  if (pc.status !== 'ended' && pc.status !== 'failed') {
    if (pc.hangup_at) return 'Hanging up.';
    if (inbound) return pc.status === 'in_call' ? `You are talking to ${them}.${pc.record ? ' The call is being recorded.' : ''}` : `${who.name || displayNumber(who.number) || 'Somebody'} is calling. Your phone is ringing.`;
    if (pc.status === 'ringing_you') return 'Ringing your phone. Pick up, then press 1.';
    if (pc.status === 'waiting_for_you') return pc.direction === 'switchboard' ? 'You have rung in from your phone.' : `Press 1 on your phone to call ${them}.`;
    if (pc.status === 'calling_them') return `Calling ${them}.`;
    return `You are talking to ${them}. The call is ${pc.record ? 'being recorded' : 'not being recorded'}.`;
  }
  switch (pc.outcome) {
    case 'completed': return `You spoke to ${them}${spell(durationOf(pc))}.${recordingWords(pc)}`;
    case 'busy': return who.first ? `${who.first}'s phone was busy.` : 'That number was busy.';
    case 'no_answer':
      if (pc.reason === 'missed') return pc.voicemail ? `${who.name || displayNumber(who.number) || 'Somebody'} rang and left a message.${recordingWords(pc)}` : `You missed a call from ${them}.`;
      if (pc.reason === 'hung_up_first') return `${Them} answered but hung up before being connected.`;
      if (pc.reason === 'unknown_end') return 'The call ended before anyone was connected.';
      return who.first ? `${who.first} did not answer.` : 'Nobody answered that number.';
    case 'you_did_not_answer':
      if (pc.reason === 'your_phone_busy') return 'Your phone was busy, so nobody was called.';
      if (pc.reason === 'no_key') return 'You did not press 1, so nobody was called.';
      return 'You did not pick up.';
    case 'cancelled':
      if (pc.reason === 'locked') return 'Three wrong PINs were keyed in, so the switchboard is locked for this phone for fifteen minutes.';
      if (pc.reason === 'hung_up_early') return 'You rang in and hung up before calling anyone.';
      return 'The call was cancelled.';
    default:
      if (pc.reason === 'your_phone_failed') return 'Your phone could not be reached. Check the mobile number you saved.';
      if (pc.reason === 'not_started') return 'The call could not be started. Try again in a minute.';
      if (/^start:/.test(pc.reason || '')) return startProblem(Number(pc.reason.slice(6)));
      return 'That number could not be called.';
  }
}
/** A phone call as the screen sees it. */
function publicCall(pc) {
  const who = otherParty(pc);
  const live = pc.status !== 'ended' && pc.status !== 'failed';
  return {
    id: pc.id, status: pc.status, outcome: pc.outcome ?? null, message: sentence(pc),
    to_display: displayNumber(pc.to_number), candidate_name: who.name,
    recorded: Boolean(pc.record && (live ? true : ['waiting', 'pending', 'fetching', 'stored'].includes(pc.recording_state))),
    call_id: pc.call_id ?? null, duration_sec: durationOf(pc),
  };
}

// ---------- the call in the Oracle ----------
let logActivity = () => {};
const SPEAKERS = {
  outbound: { 0: 'recruiter', 1: 'candidate' },   // Twilio puts the person it rang first on the first channel
  switchboard: { 0: 'recruiter', 1: 'candidate' },
  inbound: { 0: 'candidate', 1: 'recruiter' },
};
/** Make the Oracle call a phone call is, or will become. It waits as "recording" until the audio is in. */
function newOracleCall(pc) {
  const name = candidateOf(pc.candidate_id)?.name;
  const t = now();
  const id = q.insert(
    `INSERT INTO calls (recording_id, title, status, source, direction, phone_number, speaker_roles, event_key, application_id, candidate_id, created_by, created_at, updated_at)
     VALUES (?, ?, 'recording', 'phone', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    crypto.randomBytes(16).toString('hex'), name ? `Call with ${name}` : UNTITLED, pc.direction === 'inbound' ? 'inbound' : 'outbound', pc.to_number,
    JSON.stringify(SPEAKERS[pc.direction]), pc.event_key, pc.application_id, pc.candidate_id, pc.user_id ?? firstAdmin()?.id ?? null, t, t);
  q.run('UPDATE phone_calls SET call_id = ?, call_made = 1 WHERE id = ?', id, pc.id);
  // Placed from an event in the recruiter's day: the event then shows this call. If the call reaches nobody the
  // entry is removed again and the event goes back to having no call.
  if (pc.event_key && pc.user_id) tieCallToEvent(pc.user_id, pc.event_key, id);
  return id;
}
/** A call that ended with nothing recorded has no place in the Oracle: remove the entry made for it when it was placed. */
function dropEmptyOracleCall(pc) {
  if (!pc.call_id) return;
  if (!q.run(`DELETE FROM calls WHERE id = ? AND source = 'phone' AND status = 'recording' AND audio_file IS NULL`, pc.call_id).changes) return;
  // Removed by us, not by a person: if a recording turns up after all, it is kept, and gets a new entry.
  q.run('UPDATE phone_calls SET call_made = 0 WHERE id = ? AND call_id IS NULL', pc.id);
}
/** What the call's record says about telling people it was recorded: what was played, to whom and when. */
function consentFor(pc) {
  const name = candidateOf(pc.candidate_id)?.name;
  if (!NOTICE_ON) {
    return { at: pc.started_at, wording: 'The Book played no recorded-call notice on this call (the notice is switched off for this workspace). Telling the other person was up to the recruiter.' };
  }
  if (!pc.notice_at) return { at: pc.started_at, wording: 'The Book was set to play a recorded-call notice before this call was connected, but has no record of it being played.' };
  const quoted = `“${noticeWords(pc.direction === 'inbound')}”`;
  if (pc.direction === 'inbound') return { at: pc.notice_at, wording: `The Book played this notice to ${name || 'the caller'} when they rang, before the call was put through: ${quoted}` };
  return { at: pc.notice_at, wording: `The Book played this notice to ${name || 'the person called'} when they answered, before the call was connected: ${quoted}` };
}

// ---------- when a call ends ----------
const FINAL = new Set(['completed', 'busy', 'no-answer', 'failed', 'canceled']);
/**
 * Settle a call that Twilio says is over (`twilioStatus` is how the first half of it ended). The outcome may
 * already be known, from the answer to "how did ringing the other person go"; if that never reached us, it is
 * worked out here from how far the call had got.
 */
function closeCall(id, twilioStatus, seconds = null) {
  const pc = phoneCall(id);
  if (!pc) return;
  let { outcome, reason, status } = pc;
  if (!outcome) {
    status = 'ended';
    if (pc.answered_at) outcome = 'completed';                                // the two spoke
    else if (pc.direction === 'inbound') { outcome = 'no_answer'; reason = 'missed'; }
    else if (pc.hangup_at || twilioStatus === 'canceled') outcome = 'cancelled';
    else if (pc.status === 'calling_them') { outcome = 'no_answer'; reason = 'unknown_end'; } // we never heard how ringing them went
    else if (pc.direction === 'switchboard') { outcome = 'cancelled'; reason = reason || 'hung_up_early'; }
    else if (twilioStatus === 'no-answer') outcome = 'you_did_not_answer';
    else if (twilioStatus === 'busy') { outcome = 'you_did_not_answer'; reason = 'your_phone_busy'; }
    else if (twilioStatus === 'failed') { outcome = 'failed'; status = 'failed'; reason = 'your_phone_failed'; }
    else { outcome = 'you_did_not_answer'; reason = 'no_key'; }                // answered, but 1 was never pressed
  }
  if (status !== 'failed') status = 'ended';
  // A recorded call that got as far as the other person may have a recording even if we never heard it start.
  const mayBeRecorded = pc.record && !pc.recording_state && (outcome === 'completed' || reason === 'unknown_end');
  q.run(`UPDATE phone_calls SET status = ?, outcome = ?, reason = ?, ended_at = COALESCE(ended_at, ?), talk_sec = COALESCE(talk_sec, ?),
           recording_state = COALESCE(recording_state, ?), updated_at = ? WHERE id = ?`,
    status, outcome, reason ?? null, now(), outcome === 'completed' && seconds > 0 ? seconds : null, mayBeRecorded ? 'waiting' : null, now(), pc.id);
  if (!mayBeRecorded && !pc.recording_state) dropEmptyOracleCall(pc);
}

// ---------- the recording: fetch it, keep it, delete Twilio's copy ----------
const newAudioName = () => `call-${crypto.randomBytes(16).toString('hex')}.wav`;
const audioPath = (file) => path.join(UPLOAD_DIR, path.basename(file));
const RETRY_STEPS = [1, 3, 9, 24, 60, 180, 360]; // times RETRY_BASE: 5 s, 15 s, 45 s, 2 min, 5 min, 15 min, 30 min, then hourly
const retryIn = (tries) => RETRY_BASE * (RETRY_STEPS[Math.min(tries, RETRY_STEPS.length) - 1] ?? 720);

/** What a WAV file says about itself: how many channels, and how long it runs. Throws when it is not one. */
async function wavFacts(file) {
  const handle = await fsp.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const head = Buffer.alloc(Math.min(size, 8192));
    await handle.read(head, 0, head.length, 0);
    if (head.length < 44 || head.toString('latin1', 0, 4) !== 'RIFF' || head.toString('latin1', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
    let format = null;
    for (let at = 12; at + 8 <= head.length;) {
      const id = head.toString('latin1', at, at + 4), length = head.readUInt32LE(at + 4);
      if (id === 'fmt ' && at + 24 <= head.length) format = { channels: head.readUInt16LE(at + 10), rate: head.readUInt32LE(at + 12), bits: head.readUInt16LE(at + 22) };
      if (id === 'data') {
        if (!format || !format.channels || !format.rate || !format.bits) break;
        const bytes = size - (at + 8); // measured from the file, not from what the header claims
        if (bytes <= 0) throw new Error('the WAV file holds no sound');
        return { channels: format.channels, seconds: bytes / (format.channels * (format.bits / 8)) / format.rate, size };
      }
      at += 8 + length + (length % 2);
    }
    throw new Error('the WAV file could not be read');
  } finally {
    await handle.close();
  }
}

/** Fetch one recording to `file`. The address is built from our own settings and the recording's name, never from a webhook. */
async function download(sid, channels, file) {
  let res;
  try {
    res = await fetch(`${account()}/Recordings/${sid}.wav?RequestedChannels=${channels}`, { headers: { Authorization: authorization() }, signal: AbortSignal.timeout(10 * MINUTE) });
  } catch {
    throw new TwilioError(0, null);
  }
  if (!res.ok || !res.body) { await res.body?.cancel().catch(() => {}); throw new TwilioError(res.status, null); }
  let size = 0;
  const counted = async function* (source) {
    for await (const chunk of source) {
      size += chunk.length;
      if (size > MAX_AUDIO_BYTES) throw new Error('the recording is larger than a call can be');
      yield chunk;
    }
  };
  await pipeline(Readable.fromWeb(res.body), counted, fs.createWriteStream(file));
}

/** Delete Twilio's copy of a recording. Gone already counts as deleted. Resolves to whether it is gone. */
async function deleteAtTwilio(sid) {
  try {
    await twilio('DELETE', `/Recordings/${sid}.json`);
    return true;
  } catch (err) {
    if (err.status === 404) return true;
    console.error(`Could not delete a recording from the phone service yet (${err.message}). It will be tried again.`);
    return false;
  }
}
async function removeTwiliosCopy(pc) {
  if (!pc.recording_sid || pc.recording_deleted_at) return;
  if (await deleteAtTwilio(pc.recording_sid)) q.run('UPDATE phone_calls SET recording_deleted_at = ? WHERE id = ?', now(), pc.id);
}

const collecting = new Set();
/** Fetch the recording of a call whose recording is ready. Safe to ask for twice: only one fetch runs. */
function collect(id) {
  if (collecting.has(id)) return Promise.resolve();
  collecting.add(id);
  return collectRecording(id)
    .catch((err) => {
      // Something unforeseen. The recording is still at Twilio, so it is put back in line to be fetched again.
      console.error(`Phone call ${id}: its recording could not be dealt with:`, err?.message ?? err);
      try { q.run(`UPDATE phone_calls SET recording_state = 'pending', recording_next_at = ? WHERE id = ? AND recording_state = 'fetching'`, later(10 * MINUTE), id); } catch { /* the sweep will find it */ }
    })
    .finally(() => collecting.delete(id));
}
async function collectRecording(id) {
  // Claimed first, so a webhook that arrives twice, or the sweep, cannot start a second fetch of the same recording.
  if (!q.run(`UPDATE phone_calls SET recording_state = 'fetching', recording_tries = recording_tries + 1, updated_at = ? WHERE id = ? AND recording_state = 'pending'`, now(), id).changes) return;
  const pc = phoneCall(id);
  const sid = pc.recording_sid;
  // The call was deleted in the Oracle while it was still going: nothing is kept, and Twilio's copy goes too.
  const deleted = (row) => row.call_made && !row.call_id;
  const discard = async () => {
    const gone = await deleteAtTwilio(sid);
    q.run(`UPDATE phone_calls SET recording_state = ?, recording_deleted_at = ?, recording_next_at = ?, updated_at = ? WHERE id = ?`,
      gone ? 'discarded' : 'pending', gone ? now() : null, gone ? null : later(retryIn(pc.recording_tries)), now(), id);
  };
  if (deleted(pc)) return discard();

  const name = newAudioName();
  const partial = `${audioPath(name)}.part`;
  let facts;
  try {
    // A message a caller left has one channel. A call has two, one for each person; if Twilio says it cannot
    // give both (the recording was made as one), the mixed-down file is taken, because that is all there is.
    let channels = pc.voicemail || pc.recording_channels === 1 ? 1 : 2;
    try {
      await download(sid, channels, partial);
    } catch (err) {
      if (!(channels === 2 && err.status === 400)) throw err;
      channels = 1;
      await download(sid, 1, partial);
    }
    facts = await wavFacts(partial);
  } catch (err) {
    await fsp.rm(partial, { force: true }).catch(() => {});
    const since = Date.parse(pc.recording_since || pc.updated_at);
    // Twilio saying "not found" for a whole day means there is nothing to fetch. Anything else is tried for a month.
    const gone = err.status === 404 && Date.now() - since > DAY;
    const lost = Date.now() - since > 30 * DAY;
    if (gone || lost) {
      const problem = 'The recording of this call could not be fetched from the phone service, so there is no audio.';
      tx(() => {
        q.run(`UPDATE phone_calls SET recording_state = 'failed', recording_next_at = NULL, updated_at = ? WHERE id = ?`, now(), id);
        if (pc.call_id) q.run(`UPDATE calls SET status = 'failed', error = ?, updated_at = ? WHERE id = ? AND audio_file IS NULL`, problem, now(), pc.call_id);
      });
      console.error(`Phone call ${id}: gave up fetching its recording (${err.message}).`);
      return;
    }
    const wait = retryIn(pc.recording_tries);
    q.run(`UPDATE phone_calls SET recording_state = 'pending', recording_next_at = ?, updated_at = ? WHERE id = ? AND recording_state = 'fetching'`, later(wait), now(), id);
    // After an hour of trying, the call in the Oracle stops saying it is still being recorded, and says what is going on.
    if (pc.call_id && Date.now() - since > HOUR) {
      q.run(`UPDATE calls SET status = 'failed', error = ?, updated_at = ? WHERE id = ? AND status = 'recording'`,
        'The recording of this call has not arrived from the phone service yet. The Book keeps trying to fetch it.', now(), pc.call_id);
    }
    console.error(`Phone call ${id}: its recording could not be fetched yet (${err.message}). Trying again in ${Math.round(wait / 1000)} seconds.`);
    if (wait < SWEEP_EVERY) setTimeout(() => collect(id), wait).unref();
    return;
  }

  await fsp.rename(partial, audioPath(name)); // either the whole file is there under its name, or nothing is
  const transcribe = transcriptionConfigured();
  const kept = tx(() => {
    const fresh = phoneCall(id);
    if (!fresh) return null;                   // the person was erased while the audio was on its way
    if (deleted(fresh)) {                      // or the call was deleted in the Oracle
      q.run(`UPDATE phone_calls SET recording_state = 'discarded', recording_next_at = NULL, updated_at = ? WHERE id = ?`, now(), id);
      return null;
    }
    const callId = fresh.call_id ?? newOracleCall(fresh);
    const who = candidateOf(fresh.candidate_id);
    // The application may have been removed since the call was placed; the call still belongs with the person.
    const applicationId = fresh.candidate_id ? fresh.application_id ?? bestApplication(fresh.candidate_id) : null;
    const consent = consentFor(fresh);
    const durationMs = Math.round(facts.seconds * 1000);
    q.run(
      `UPDATE calls SET status = ?, error = NULL, audio_file = ?, audio_type = 'audio/wav', audio_size = ?, audio_channels = ?, duration_ms = ?,
         voicemail = ?, title = CASE WHEN ? = 1 AND title IN (?, ?) THEN ? ELSE title END, speaker_roles = ?,
         application_id = ?, candidate_id = ?, consent_by = ?, consent_at = ?, consent_wording = ?, updated_at = ? WHERE id = ?`,
      transcribe ? 'transcribing' : 'uploaded', name, facts.size, facts.channels, durationMs,
      fresh.voicemail, fresh.voicemail, UNTITLED, who ? `Call with ${who.name}` : UNTITLED, who ? `${VOICEMAIL} from ${who.name}` : VOICEMAIL,
      JSON.stringify(fresh.voicemail ? { 0: 'candidate' } : SPEAKERS[fresh.direction]),
      applicationId, fresh.candidate_id, fresh.user_id, consent.at, consent.wording, now(), callId);
    q.run(`UPDATE phone_calls SET recording_state = 'stored', recording_channels = ?, recording_sec = ?, recording_next_at = NULL, application_id = ?, updated_at = ? WHERE id = ?`,
      facts.channels, Math.round(facts.seconds), applicationId, now(), id);
    if (applicationId) {
      // On the candidate's history, where client users never see it (the same as any other call).
      logActivity(applicationId, fresh.user_id, 'call', `${fresh.voicemail ? 'Voicemail left' : 'Phone call'}${lengthWords(durationMs)}`);
      q.run('UPDATE applications SET updated_at = ? WHERE id = ?', now(), applicationId);
    }
    return callId;
  });
  if (!kept) await fsp.rm(audioPath(name), { force: true }).catch(() => {});
  // Only now that the audio is safely ours (or is not wanted) is Twilio's copy deleted.
  await removeTwiliosCopy({ ...pc, recording_deleted_at: null });
  if (kept && transcribe) startTranscription(kept);
}

// ---------- the sweep: nothing is left hanging because a webhook went missing ----------
async function sweep() {
  if (!phoneConfigured()) return;
  // 1. Recordings that are ready and due to be fetched (again). A fetch that has been "under way" for an hour with
  //    nothing in this process doing it was cut off: it starts again.
  for (const row of q.all(`SELECT id FROM phone_calls WHERE recording_state = 'fetching' AND updated_at < ?`, ago(HOUR))) {
    if (!collecting.has(row.id)) q.run(`UPDATE phone_calls SET recording_state = 'pending', recording_next_at = NULL WHERE id = ? AND recording_state = 'fetching'`, row.id);
  }
  for (const row of q.all(`SELECT id FROM phone_calls WHERE recording_state = 'pending' AND (recording_next_at IS NULL OR recording_next_at <= ?)`, now())) await collect(row.id);
  // 2. Recordings we hold whose copy at Twilio is still there.
  for (const pc of q.all(`SELECT * FROM phone_calls WHERE recording_state IN ('stored', 'discarded') AND recording_sid IS NOT NULL AND recording_deleted_at IS NULL`)) {
    if (!collecting.has(pc.id)) await removeTwiliosCopy(pc); // one being fetched right now deletes Twilio's copy itself, a moment later
  }
  // 3. Live calls nothing has been heard about for a while: ask Twilio how they stand.
  for (const pc of q.all(`SELECT * FROM phone_calls WHERE ${LIVE} AND updated_at < ? AND (checked_at IS NULL OR checked_at < ?)`, ago(QUIET_AFTER), ago(QUIET_AFTER))) {
    try {
      if (!pc.call_sid) { // the request to start it never came back
        q.run(`UPDATE phone_calls SET status = 'failed', outcome = 'failed', reason = 'not_started', ended_at = ?, updated_at = ? WHERE id = ? AND ${LIVE}`, now(), now(), pc.id);
        dropEmptyOracleCall(pc);
        continue;
      }
      const call = await twilio('GET', `/Calls/${pc.call_sid}.json`);
      if (FINAL.has(call?.status)) closeCall(pc.id, call.status, Number(call.duration) || null);
      else q.run('UPDATE phone_calls SET checked_at = ? WHERE id = ?', now(), pc.id);
    } catch (err) {
      if (err.status === 404) closeCall(pc.id, 'failed'); // Twilio has never heard of it
      else q.run('UPDATE phone_calls SET checked_at = ? WHERE id = ?', now(), pc.id);
    }
  }
  // 4. Calls that ended and should have a recording, but nobody told us it was ready: look for it.
  for (const pc of q.all(`SELECT * FROM phone_calls WHERE recording_state = 'waiting' AND status IN ('ended', 'failed') AND call_sid IS NOT NULL AND ended_at < ?`, ago(RECORDING_WAIT))) {
    try {
      const list = (await twilio('GET', `/Calls/${pc.call_sid}/Recordings.json`))?.recordings ?? [];
      const ready = list.find((rec) => rec.status === 'completed' && /^RE[0-9a-f]{32}$/i.test(rec.sid));
      if (ready) {
        if (recordingReady(pc.id, { sid: ready.sid, channels: Number(ready.channels) || null, seconds: Number(ready.duration) || null, voicemail: ready.source === 'RecordVerb' })) await collect(pc.id);
      } else if (Date.now() - Date.parse(pc.ended_at) > RECORDING_GIVE_UP && !list.some((rec) => rec.status === 'processing' || rec.status === 'in-progress')) {
        noRecording(pc.id);
      }
    } catch (err) {
      console.error(`Phone call ${pc.id}: could not ask the phone service for its recording (${err.message}).`);
    }
  }
  // 5. Calls in the Oracle left waiting for a phone call that is over and has nothing to give them.
  for (const pc of q.all(`SELECT p.* FROM phone_calls p JOIN calls k ON k.id = p.call_id WHERE p.status IN ('ended', 'failed') AND k.status = 'recording'
                          AND (p.recording_state IS NULL OR p.recording_state = 'absent')`)) dropEmptyOracleCall(pc);
  q.run('DELETE FROM phone_webhooks WHERE received_at < ?', ago(KEEP_WEBHOOKS));
}
let sweeping = false;
function runSweep() {
  if (sweeping) return;
  sweeping = true;
  sweep().catch((err) => console.error('The check on phone calls failed:', err?.message ?? err)).finally(() => { sweeping = false; });
}

/** Twilio says a recording is ready (or the sweep found one). True when this is news, and the fetch should start. */
function recordingReady(id, { sid, channels, seconds, voicemail }) {
  return Boolean(q.run(
    `UPDATE phone_calls SET recording_state = 'pending', recording_sid = ?, recording_channels = ?, recording_sec = ?, voicemail = MAX(voicemail, ?),
       recording_tries = 0, recording_next_at = NULL, recording_since = ?, updated_at = ?
     WHERE id = ? AND (recording_state IS NULL OR recording_state IN ('waiting', 'absent'))`,
    sid, channels, seconds, voicemail ? 1 : 0, now(), now(), id).changes);
}
/** Twilio made no recording of this call (it was too short, or nobody spoke after the tone). */
function noRecording(id) {
  if (!q.run(`UPDATE phone_calls SET recording_state = 'absent', updated_at = ? WHERE id = ? AND (recording_state IS NULL OR recording_state = 'waiting')`, now(), id).changes) return;
  const pc = phoneCall(id);
  if (pc.status === 'ended' || pc.status === 'failed') dropEmptyOracleCall(pc);
}

// ---------- telling the recruiter the notes are ready ----------
async function tellRecruiter(callId) {
  const call = q.get(`SELECT * FROM calls WHERE id = ? AND source = 'phone' AND status = 'ready' AND notified_at IS NULL`, callId);
  if (!call) return;
  const user = call.created_by ? q.get(`SELECT name, email FROM users WHERE id = ? AND ${AGENCY_USER}`, call.created_by) : null;
  if (!user) return;
  // Marked first, so the notes being written again later does not send a second e-mail.
  if (!q.run('UPDATE calls SET notified_at = ? WHERE id = ? AND notified_at IS NULL', now(), callId).changes) return;
  const who = candidateOf(call.candidate_id);
  const other = who?.name || displayNumber(call.phone_number) || 'a withheld number';
  const job = call.application_id ? q.get(
    `SELECT j.title, cl.name AS client FROM applications a JOIN jobs j ON j.id = a.job_id JOIN clients cl ON cl.id = j.client_id WHERE a.id = ?`, call.application_id) : null;
  const length = lengthWords(call.duration_ms).slice(2);
  const what = call.voicemail ? `The message ${other} left on The Book's number` : `Your phone call with ${other}`;
  const lines = [
    `Hi ${firstName(user.name) || 'there'},`, '',
    `${what}${length ? ` (${length})` : ''} has been written out${call.notes ? ', and the notes are ready' : ''}:`,
    `${appUrl()}/oracle/${call.id}`, '',
    who ? `It is on ${who.name}'s profile${job ? ` (${job.title}, ${job.client})` : ''}.` : 'It is not on a candidate yet. Open it to add it to one.',
    '', agencyName() || 'The Book', '',
  ];
  await notify({ to: user.email, subject: call.notes ? `Your call notes for ${other} are ready` : `Your call with ${other} has been written out`, body: lines.join('\n') });
}

// ---------- who takes a call that comes in ----------
const firstAdmin = () => q.get(`SELECT * FROM users WHERE role = 'admin' AND active = 1 AND pending = 0 ORDER BY id LIMIT 1`) ?? null;
function recruiterFor(candidateIds, number) {
  const takesCalls = `u.active = 1 AND u.pending = 0 AND u.role != 'client' AND u.phone IS NOT NULL`;
  const theirs = candidateIds.length ? candidateIds.join(',') : null; // whole numbers from our own tables
  // Whoever last rang them is who they are most likely ringing back.
  const lastCaller = number || theirs ? q.get(
    `SELECT u.* FROM phone_calls p JOIN users u ON u.id = p.user_id WHERE ${takesCalls} AND p.direction != 'inbound'
       AND (${number ? 'p.to_number = ?' : '0'}${theirs ? ` OR p.candidate_id IN (${theirs})` : ''}) ORDER BY p.started_at DESC, p.id DESC LIMIT 1`, ...(number ? [number] : [])) : null;
  if (lastCaller) return lastCaller;
  const owner = theirs ? q.get(
    `SELECT u.* FROM applications a JOIN users u ON u.id = a.owner_id WHERE ${takesCalls} AND a.candidate_id IN (${theirs}) ORDER BY a.applied_at DESC, a.id DESC LIMIT 1`) : null;
  return owner ?? q.get(`SELECT u.* FROM users u WHERE ${takesCalls} AND u.role = 'admin' ORDER BY u.id LIMIT 1`) ?? null;
}

// ---------- the routes Twilio calls ----------
/** What Twilio sent, with numbers and keys pressed masked, so a call that went wrong can be understood later. */
function masked(params) {
  const out = {};
  for (const [name, raw] of Object.entries(params)) {
    const value = String(one(raw) ?? '');
    if (/City$|Zip$|State$|^CallerName$/.test(name)) continue; // where a caller is: not needed, so not kept
    if (name === 'Digits') out[name] = /^\d+$/.test(value) ? `(${value.length} keys)` : value;
    else if (/^\+?\d{7,15}$/.test(value.replace(/[\s()-]/g, ''))) out[name] = `${value.startsWith('+1') ? '+1 ' : ''}(number ending ${value.slice(-2)})`;
    else out[name] = value.slice(0, 300);
  }
  return out;
}

export function registerPhoneWebhooks(api) {
  const hooks = express.Router();
  hooks.use(express.urlencoded({ extended: false, limit: '64kb', parameterLimit: 200 }));
  // Nothing in a request is believed until its signature has been checked. Twilio signs the exact address it was
  // given plus every field it sends, with the account's Auth Token; the address is rebuilt here from APP_URL, never
  // from the request's own headers, which behind a proxy are not what Twilio called.
  hooks.use((req, res, next) => {
    const params = req.method === 'POST' ? req.body || {} : {};
    const signed = phoneConfigured() && validateWebhook({
      authToken: AUTH_TOKEN, signature: req.headers['x-twilio-signature'], publicBase: appUrl(), originalUrl: req.originalUrl, params,
      settingsHeader: req.headers['x-twilio-webhooks-signature-settings'],
    });
    if (!signed) return res.status(403).type('text/plain').send('Forbidden');
    req.twilio = req.method === 'POST' ? params : req.query || {};
    next();
  });

  /** The call a webhook is about: named in the address we gave Twilio, or else found by Twilio's own name for it. */
  function callOf(req) {
    const p = req.twilio;
    const named = /^\d{1,12}$/.test(String(req.query.c ?? '')) ? phoneCall(Number(req.query.c)) : null;
    const sid = text(p.ParentCallSid || p.CallSid, 40);
    return named ?? (sid ? q.get('SELECT * FROM phone_calls WHERE call_sid = ?', sid) ?? null : null);
  }
  const touch = (pc, kind, p) => {
    q.run('UPDATE phone_calls SET updated_at = ? WHERE id = ?', now(), pc.id);
    q.run('INSERT INTO phone_webhooks (phone_call_id, kind, params, received_at) VALUES (?, ?, ?, ?)', pc.id, kind, JSON.stringify(masked(p)), now());
  };
  /** A webhook that wants instructions back. Whatever goes wrong, the caller hears a sentence, never a dead line. */
  const twiml = (kind, handler) => (req, res) => {
    let answer = SORRY;
    try {
      const pc = callOf(req);
      if (pc) touch(pc, kind, req.twilio);
      answer = handler(req.twilio, pc, req) ?? SORRY;
    } catch (err) {
      console.error(`Phone webhook "${kind}" failed:`, err?.message ?? err);
    }
    res.status(200).type('text/xml').send(answer);
  };
  /** A webhook that only brings news. */
  const news = (kind, handler) => (req, res) => {
    try {
      const pc = callOf(req);
      if (pc) { touch(pc, kind, req.twilio); handler(req.twilio, pc); }
      res.status(204).end();
    } catch (err) {
      console.error(`Phone webhook "${kind}" failed:`, err?.message ?? err);
      res.status(500).type('text/plain').send('error'); // the sweep picks up whatever this was about
    }
  };
  const over = (pc) => pc.status === 'ended' || pc.status === 'failed';

  // --- click to call: the recruiter's phone was answered ---
  hooks.post('/voice', twiml('voice', (p, pc) => {
    if (!pc || pc.direction !== 'outbound') return SORRY;
    if (over(pc)) return xml(HANGUP);
    q.run(`UPDATE phone_calls SET status = 'waiting_for_you', call_sid = COALESCE(call_sid, ?) WHERE id = ? AND status = 'ringing_you'`, text(p.CallSid, 40) || null, pc.id);
    return pressOne(pc);
  }));
  hooks.post('/connect', twiml('connect', (p, pc, req) => {
    if (!pc || pc.direction !== 'outbound') return SORRY;
    if (over(pc)) return xml(HANGUP);
    if (text(p.Digits, 10) !== '1') {
      const attempt = Number(req.query.n) || 1;
      return attempt < MAX_ASKS ? pressOne(pc, attempt + 1) : xml(`${say('Goodbye.')}${HANGUP}`);
    }
    q.run(`UPDATE phone_calls SET status = 'calling_them' WHERE id = ? AND status IN ('ringing_you', 'waiting_for_you')`, pc.id);
    return xml(dialOther(pc));
  }));

  // --- the person being rung has answered; this is heard by them alone, before the two are joined ---
  hooks.post('/whisper', twiml('whisper', (p, pc) => {
    if (!pc) return xml(HANGUP);
    const child = text(p.ParentCallSid, 40) ? text(p.CallSid, 40) : null;
    const inbound = pc.direction === 'inbound';
    // On a call that was placed, this is the moment the recorded-call notice is played, so this is when it is noted.
    const noticed = !inbound && pc.record && NOTICE_ON;
    q.run(`UPDATE phone_calls SET status = CASE WHEN ${LIVE} THEN 'in_call' ELSE status END, answered_at = COALESCE(answered_at, ?), child_sid = COALESCE(child_sid, ?),
             notice_at = COALESCE(notice_at, ?), recording_state = COALESCE(recording_state, ?) WHERE id = ?`,
      now(), child, noticed ? now() : null, pc.record ? 'waiting' : null, pc.id);
    if (inbound) {
      const who = otherParty(pc);
      return xml(say(`${who.name ? `Call from ${who.name}, a candidate.` : 'Call from a number The Book does not know.'}${pc.record ? ' This call is recorded.' : ''}`));
    }
    return xml(noticed ? say(noticeWords()) : '');
  }));

  // --- ringing the other person is over: Twilio says how it went, and asks what to do with the first person ---
  hooks.post('/dial-done', twiml('dial-done', (p, pc) => {
    if (!pc) return xml(HANGUP);
    const dialStatus = text(p.DialCallStatus, 20);
    const connected = dialStatus === 'completed' && text(p.DialBridged, 10) !== 'false';
    const inbound = pc.direction === 'inbound';
    if (!pc.outcome) {
      const talk = Number(text(p.DialCallDuration, 10)) || null;
      const [outcome, reason] = connected ? ['completed', null]
        : inbound ? ['no_answer', 'missed']
        : dialStatus === 'busy' ? ['busy', null]
        : dialStatus === 'no-answer' ? ['no_answer', null]
        : dialStatus === 'completed' ? ['no_answer', 'hung_up_first']   // answered, then hung up while the notice played
        : dialStatus === 'canceled' ? ['cancelled', null]
        : ['failed', null];
      // An inbound call nobody took carries on: the caller is asked to leave a message, and that may be recorded.
      const expect = pc.record && (connected || inbound) ? 'waiting' : null;
      q.run(`UPDATE phone_calls SET status = ?, outcome = ?, reason = ?, ended_at = COALESCE(ended_at, ?), talk_sec = ?, child_sid = COALESCE(child_sid, ?),
               answered_at = CASE WHEN ? = 1 THEN COALESCE(answered_at, ?) ELSE answered_at END, recording_state = COALESCE(recording_state, ?) WHERE id = ? AND outcome IS NULL`,
        outcome === 'failed' ? 'failed' : 'ended', outcome, reason, now(), connected ? talk : null, text(p.DialCallSid, 40) || null,
        connected ? 1 : 0, now(), expect, pc.id);
      if (!connected && !inbound) dropEmptyOracleCall(pc);
    }
    const settled = phoneCall(pc.id);
    if (settled.outcome === 'completed') return xml(HANGUP);
    if (inbound) return pc.record ? leaveMessage(pc, 'Sorry, nobody could take your call. Please leave a message after the tone.') : xml(`${say('Sorry, nobody could take your call. Please try again later.')}${HANGUP}`);
    return xml(`${say(sentence(settled))}${HANGUP}`); // the recruiter hears why, since they may have no screen in front of them
  }));
  hooks.post('/voicemail-done', twiml('voicemail-done', (p, pc) => {
    if (pc) q.run(`UPDATE phone_calls SET voicemail = 1, recording_state = COALESCE(recording_state, 'waiting') WHERE id = ?`, pc.id);
    return xml(HANGUP);
  }));

  // --- the recording ---
  const recording = news('recording', (p, pc) => {
    const status = text(p.RecordingStatus, 20), sid = text(p.RecordingSid, 40);
    const named = /^RE[0-9a-f]{32}$/i.test(sid);
    if (status === 'in-progress') {
      if (named) q.run(`UPDATE phone_calls SET recording_sid = COALESCE(recording_sid, ?), recording_state = COALESCE(recording_state, 'waiting') WHERE id = ?`, sid, pc.id);
    } else if (status === 'completed' && named) {
      const fresh = recordingReady(pc.id, {
        sid, channels: Number(text(p.RecordingChannels, 4)) || null, seconds: Number(text(p.RecordingDuration, 10)) || null,
        voicemail: text(p.RecordingSource, 40) === 'RecordVerb',
      });
      if (fresh) collect(pc.id); // answered at once; the fetch happens after
    } else if (status === 'absent' || status === 'failed') {
      noRecording(pc.id);
    }
  });
  hooks.post('/recording', (req, res) => {
    // A recording of a call whose record has since been erased (the person was deleted from The Book while the call
    // was still going) must not be left sitting at Twilio. "Erased" is told from "never existed" by the number in
    // the address: one we have handed out, with no row behind it any more.
    const id = /^\d{1,12}$/.test(String(req.query.c ?? '')) ? Number(req.query.c) : null;
    const sid = text(req.twilio.RecordingSid, 40);
    if (id && !callOf(req) && text(req.twilio.RecordingStatus, 20) === 'completed' && /^RE[0-9a-f]{32}$/i.test(sid)
      && id <= (q.get(`SELECT seq FROM sqlite_sequence WHERE name = 'phone_calls'`)?.seq ?? 0)) {
      deleteAtTwilio(sid).then((gone) => { if (gone) console.log('A recording arrived for a phone call that has been erased, so it was deleted from the phone service.'); });
      return res.status(204).end();
    }
    recording(req, res);
  });

  // --- how the first half of a call is getting on ---
  const status = news('status', (p, pc) => {
    const state = text(p.CallStatus, 20);
    if (text(p.CallSid, 40) && pc.call_sid && text(p.CallSid, 40) !== pc.call_sid) return; // about the other half of the call
    if (state === 'in-progress') q.run(`UPDATE phone_calls SET status = 'waiting_for_you' WHERE id = ? AND status = 'ringing_you' AND direction = 'outbound'`, pc.id);
    if (FINAL.has(state)) closeCall(pc.id, state, Number(text(p.CallDuration, 10)) || null);
  });
  hooks.post('/status', status);
  hooks.get('/status', status);

  // --- somebody rings The Book's number ---
  const inbound = twiml('inbound', (p) => {
    const sid = text(p.CallSid, 40);
    if (!/^CA[0-9a-f]{32}$/i.test(sid)) return SORRY;
    const from = toE164(text(p.From, 40));
    if (from && from === BOOK_NUMBER) return xml('<Reject/>');
    const known = q.get('SELECT * FROM phone_calls WHERE call_sid = ?', sid); // the same request, sent again
    const t = now();

    // One of the team, ringing in from their saved mobile: the switchboard.
    const member = from ? q.get(`SELECT * FROM users WHERE phone = ? AND ${AGENCY_USER}`, from) : null;
    if (member) {
      if (member.phone_locked_until && member.phone_locked_until > t) return xml(`${say('The switchboard is locked for this phone after three wrong PINs. Try again in a quarter of an hour.')}${HANGUP}`);
      if (!member.phone_pin_hash) return xml(`${say('To place calls from this phone, first choose a PIN in The Book, in Settings under Your account. Goodbye.')}${HANGUP}`);
      const id = known?.id ?? q.insert(
        `INSERT INTO phone_calls (user_id, direction, status, user_number, call_sid, started_at, updated_at) VALUES (?, 'switchboard', 'waiting_for_you', ?, ?, ?, ?)`,
        member.id, from, sid, t, t);
      if (!known) touch(phoneCall(id), 'inbound', p);
      return askPin(phoneCall(id), 'This is The Book.');
    }

    // Anybody else: a candidate, or a number nobody knows. Put through to a recruiter, with a limit on how many an hour.
    if (!known) {
      const fromThem = q.get(`SELECT COUNT(*) AS n FROM phone_calls WHERE direction = 'inbound' AND started_at > ? AND to_number IS ?`, ago(HOUR), from).n;
      const inAll = q.get(`SELECT COUNT(*) AS n FROM phone_calls WHERE direction = 'inbound' AND started_at > ?`, ago(HOUR)).n;
      if (fromThem >= INBOUND_PER_NUMBER || inAll >= INBOUND_PER_HOUR) return xml('<Reject reason="busy"/>');
    }
    const matches = candidatesWithNumber(from);
    const candidate = matches.length === 1 ? matches[0] : null; // put on a candidate only when the number is one person's
    const recruiter = recruiterFor(matches.map((match) => match.id), from);
    const greeting = NOTICE_ON ? noticeWords(true) : `Thanks for calling${agencyName() ? ` ${agencyName()}` : ''}.`;
    const record = 1;
    const id = known?.id ?? q.insert(
      `INSERT INTO phone_calls (user_id, direction, status, to_number, user_number, candidate_id, application_id, record, call_sid, notice_at, started_at, updated_at)
       VALUES (?, 'inbound', 'ringing_you', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      recruiter?.id ?? firstAdmin()?.id ?? null, from, recruiter?.phone ?? null, candidate?.id ?? null, candidate ? bestApplication(candidate.id) : null,
      record, sid, NOTICE_ON ? t : null, t, t);
    const pc = phoneCall(id);
    if (!known) touch(pc, 'inbound', p);
    if (!recruiter) {
      // Nobody on the team has a mobile saved: straight to a message, so the call is not lost.
      q.run(`UPDATE phone_calls SET status = 'ended', outcome = 'no_answer', reason = 'missed', ended_at = ?, recording_state = 'waiting' WHERE id = ? AND outcome IS NULL`, t, id);
      return leaveMessage(pc, `${greeting} Nobody can take your call right now. Please leave a message after the tone.`);
    }
    return xml(`${say(greeting)}${dial(pc, recruiter.phone, { callerId: FORWARD_SHOWS_CALLER ? null : BOOK_NUMBER, timeout: RING_FORWARD })}`);
  });
  hooks.post('/inbound', inbound);
  hooks.get('/inbound', inbound);

  // --- the switchboard: PIN, then the number to call ---
  hooks.post('/pin', twiml('pin', (p, pc) => {
    if (!pc || pc.direction !== 'switchboard' || over(pc)) return xml(HANGUP);
    const member = pc.user_id ? q.get(`SELECT * FROM users WHERE id = ? AND ${AGENCY_USER}`, pc.user_id) : null;
    if (!member || member.phone !== pc.user_number || !member.phone_pin_hash) return xml(HANGUP);
    if (member.phone_locked_until && member.phone_locked_until > now()) return xml(`${say('The switchboard is locked for this phone. Try again in a quarter of an hour.')}${HANGUP}`);
    if (pc.pin_ok) return askNumber(pc);
    const keyed = text(p.Digits, 12);
    if (!/^\d+$/.test(keyed)) return askPin(pc, 'No PIN was entered.'); // nothing keyed in is not a wrong guess
    if (pinMatches(keyed, member.phone_pin_hash)) {
      q.run('UPDATE users SET phone_pin_fails = 0 WHERE id = ?', member.id);
      q.run('UPDATE phone_calls SET pin_ok = 1, tries = 0 WHERE id = ?', pc.id);
      return askNumber(pc);
    }
    // Wrong PINs are counted on the person, not the call, so hanging up and ringing again does not start the count over.
    const fails = member.phone_pin_fails + 1;
    if (fails >= MAX_PIN_FAILS) {
      q.run('UPDATE users SET phone_pin_fails = 0, phone_locked_until = ? WHERE id = ?', later(LOCK_MINUTES * MINUTE), member.id);
      q.run(`UPDATE phone_calls SET reason = 'locked' WHERE id = ?`, pc.id);
      notify({
        to: member.email, subject: 'Your phone was locked out of The Book\'s switchboard',
        body: `Hi ${firstName(member.name) || 'there'},\n\nThree wrong PINs were keyed in on a call to The Book's number from your mobile, so calls cannot be placed from it for ${LOCK_MINUTES} minutes.\n\nIf that was not you, choose a new PIN in The Book: Settings, Your account, Your mobile number.\n\n${agencyName() || 'The Book'}\n`,
      }).catch(() => {});
      return xml(`${say('That PIN is not right. The switchboard is now locked for this phone for fifteen minutes. Goodbye.')}${HANGUP}`);
    }
    q.run('UPDATE users SET phone_pin_fails = ? WHERE id = ?', fails, member.id);
    return askPin(pc, 'That PIN is not right.');
  }));
  hooks.post('/number', twiml('number', (p, pc) => {
    if (!pc || pc.direction !== 'switchboard' || !pc.pin_ok || over(pc)) return xml(HANGUP);
    if (pc.to_number) return xml(dialOther(pc)); // the same request, sent again
    const again = (why) => {
      q.run('UPDATE phone_calls SET tries = tries + 1 WHERE id = ?', pc.id);
      return pc.tries + 1 >= MAX_ASKS ? xml(`${say(`${why} Goodbye.`)}${HANGUP}`) : askNumber(pc, `${why} `);
    };
    const check = callable(text(p.Digits, 30));
    if (check.error) return again(check.error);
    const limit = overLimit(pc.user_id);
    if (limit) return xml(`${say(`${limit} Goodbye.`)}${HANGUP}`);
    const matches = candidatesWithNumber(check.number);
    const candidate = matches.length === 1 ? matches[0] : null;
    tx(() => {
      q.run(`UPDATE phone_calls SET to_number = ?, candidate_id = ?, application_id = ?, record = 1, status = 'calling_them' WHERE id = ?`,
        check.number, candidate?.id ?? null, candidate ? bestApplication(candidate.id) : null, pc.id);
      newOracleCall(phoneCall(pc.id));
    });
    const placed = phoneCall(pc.id);
    return xml(`${say(`Calling ${spokenParty(otherParty(placed))}. The call is recorded.`)}${dialOther(placed)}`);
  }));

  hooks.use((req, res) => res.status(404).type('text/plain').send('Not found'));
  api.use('/phone/twilio', hooks);
}

/** A sentence when this person has placed as many calls as they may in an hour, else null. Kept in the database, so a restart does not reset it. */
function overLimit(userId) {
  const placed = q.get(`SELECT COUNT(*) AS n FROM phone_calls WHERE user_id = ? AND direction != 'inbound' AND to_number IS NOT NULL AND started_at > ?`, userId, ago(HOUR)).n;
  return placed >= CALLS_PER_HOUR ? `That is ${CALLS_PER_HOUR} calls in an hour, which is the most one person can place. Try again a little later.` : null;
}

// ---------- the routes the app calls ----------
export function registerPhone(api, { agencyOnly, bad, clean, int, loadApp, ...shared }) {
  logActivity = shared.logActivity;
  onCallReady(tellRecruiter);
  if (phoneConfigured()) {
    // Whatever a restart interrupted: a fetch that was under way starts again, and the sweep looks at the rest.
    q.run(`UPDATE phone_calls SET recording_state = 'pending', recording_next_at = NULL WHERE recording_state = 'fetching'`);
    setTimeout(runSweep, Math.min(SWEEP_EVERY, 3000)).unref();
    setInterval(runSweep, SWEEP_EVERY).unref();
  }

  const NOT_CONNECTED = 'Phone calls are not connected to this workspace yet. Ask whoever hosts The Book to add the Twilio settings.';
  const mine = (req) => {
    const pc = phoneCall(int(req.params.id));
    // Somebody else's call is "not found" to everyone but an admin: the list of who rang whom is each person's own.
    if (!pc || (pc.user_id !== req.user.id && req.user.role !== 'admin')) bad('This phone call was not found.', 404);
    return pc;
  };

  api.get('/phone/status', agencyOnly, (req, res) => {
    const on = phoneConfigured();
    res.json({
      configured: on, number: on ? BOOK_NUMBER : null, number_display: on ? displayNumber(BOOK_NUMBER) : null,
      my_phone: req.user.phone ?? null, my_pin_set: Boolean(req.user.phone_pin_hash), notice: NOTICE_ON, countries: COUNTRIES,
    });
  });

  // The signed-in person's own mobile, and the PIN for ringing in from it.
  api.put('/me/phone', agencyOnly, (req, res) => {
    const b = req.body || {};
    if (typeof b.phone !== 'string') bad('Type your mobile number, or leave it empty to remove it.');
    if (b.pin !== undefined && typeof b.pin !== 'string') bad('A PIN is 4 to 6 digits.');
    let phone = null;
    if (b.phone.trim()) {
      const check = callable(b.phone, 'Your');
      if (check.error) bad(check.error);
      phone = check.number;
      if (q.get('SELECT 1 AS x FROM users WHERE phone = ? AND id != ?', phone, req.user.id)) bad('That number is already saved as somebody else\'s mobile.');
    }
    const set = ['phone = ?'], p = [phone];
    // A different phone starts with a clean slate: a lock belongs to the phone that earned it.
    if (phone !== (req.user.phone ?? null)) set.push('phone_pin_fails = 0', 'phone_locked_until = NULL');
    if (b.pin !== undefined) {
      const pin = b.pin.trim();
      if (pin && !/^\d{4,6}$/.test(pin)) bad('A PIN is 4 to 6 digits.');
      if (pin && easyPin(pin)) bad('Choose a PIN that is harder to guess: not one digit repeated, and not a run like 1234.');
      set.push('phone_pin_hash = ?', 'phone_pin_fails = 0');
      p.push(pin ? hashPin(pin) : null);
    }
    q.run(`UPDATE users SET ${set.join(', ')} WHERE id = ?`, ...p, req.user.id);
    const saved = q.get('SELECT phone, phone_pin_hash FROM users WHERE id = ?', req.user.id);
    res.json({ my_phone: saved.phone ?? null, my_pin_set: Boolean(saved.phone_pin_hash) });
  });

  // Find somebody to call, by name or by the digits of their number.
  api.get('/phone/lookup', agencyOnly, (req, res) => {
    const term = clean(req.query.q, 80);
    if (!term || term.length < 2) return res.json([]);
    const like = (value) => `%${value.replace(/[\\%_]/g, '\\$&')}%`;
    const digits = term.replace(/\D/g, '');
    const rows = q.all(
      `SELECT c.id, c.name, c.phone, substr(c.photo_file, 1, 8) AS photo FROM candidates c
       WHERE c.phone IS NOT NULL AND c.phone != '' AND (c.name LIKE ? ESCAPE '\\'${digits.length >= 3 ? ` OR ${DIGITS_OF_PHONE} LIKE ?` : ''})
       ORDER BY c.name, c.id LIMIT 200`, like(term), ...(digits.length >= 3 ? [`%${digits.replace(/^1(?=\d)/, '')}%`] : []));
    const found = [];
    for (const row of rows) {
      const phone = toE164(row.phone); // a number The Book cannot read cannot be rung, so it is not offered
      if (!phone) continue;
      found.push({
        candidate_id: row.id, name: row.name, photo: row.photo, phone, phone_display: displayNumber(phone),
        applications: q.all(
          `SELECT a.id, j.title AS job_title, cl.name AS client_name, a.status FROM applications a JOIN jobs j ON j.id = a.job_id JOIN clients cl ON cl.id = j.client_id
           WHERE a.candidate_id = ? ORDER BY a.status = 'active' DESC, a.applied_at DESC, a.id DESC`, row.id),
      });
      if (found.length === 20) break;
    }
    res.json(found);
  });

  // Place a call: Twilio rings the recruiter's own mobile first.
  api.post('/phone/calls', agencyOnly, async (req, res) => {
    const b = req.body || {};
    if (!phoneConfigured()) bad(ACCOUNT_SID && AUTH_TOKEN && BOOK_NUMBER ? 'Phone calls need The Book to know its own public address. Ask whoever hosts The Book to set APP_URL.' : NOT_CONNECTED);
    if (b.record !== undefined && typeof b.record !== 'boolean') bad('record must be true or false.');
    const eventKey = b.event_key == null || b.event_key === '' ? null : typeof b.event_key === 'string' && /^[\w.~-]{1,200}$/.test(b.event_key) ? b.event_key : bad('That calendar event could not be read.');
    if (!req.user.phone) bad('Save your own mobile number first, so The Book knows which phone to ring.');

    // Who is being called: a candidate (through one of their applications, or on their own), or a number typed in.
    let candidate = null, applicationId = null, typed;
    if (b.application_id != null && b.application_id !== '') {
      let app;
      try { app = loadApp(b.application_id, req.user); } catch { bad('That candidate was not found. They may have been removed.', 404); }
      candidate = q.get('SELECT id, name, phone FROM candidates WHERE id = ?', app.candidate_id);
      applicationId = app.id;
    } else if (b.candidate_id != null && b.candidate_id !== '') {
      candidate = q.get('SELECT id, name, phone FROM candidates WHERE id = ?', int(b.candidate_id)) ?? bad('That candidate was not found. They may have been removed.', 404);
      applicationId = bestApplication(candidate.id);
    } else if (typeof b.to === 'string' && b.to.trim()) {
      typed = b.to;
    } else bad('Choose somebody to call, or type a number.');
    if (candidate && !String(candidate.phone || '').trim()) bad(`${candidate.name} has no phone number on their profile.`);
    const check = callable(candidate ? candidate.phone : typed);
    if (check.error) bad(candidate ? `${candidate.name}'s number cannot be called. ${check.error}` : check.error);
    if (check.number === req.user.phone) bad('That is your own mobile number.');
    if (!candidate) {
      // A typed number that is exactly one person's goes on that person, as if they had been chosen.
      const matches = candidatesWithNumber(check.number);
      if (matches.length === 1) { candidate = matches[0]; applicationId = bestApplication(candidate.id); }
    }
    // One call at a time each, and a ceiling on calls in an hour, so neither a slip nor a script can run up the bill.
    if (q.get(`SELECT 1 AS x FROM phone_calls WHERE user_id = ? AND direction = 'outbound' AND ${LIVE} AND started_at > ?`, req.user.id, ago(4 * HOUR))) {
      bad('You already have a call under way. Hang up first, or wait for it to end.', 409);
    }
    const limit = overLimit(req.user.id);
    if (limit) bad(limit, 429);

    const record = b.record !== false;
    const t = now();
    const { id, callId } = tx(() => {
      const made = q.insert(
        `INSERT INTO phone_calls (user_id, direction, status, to_number, user_number, candidate_id, application_id, record, event_key, started_at, updated_at)
         VALUES (?, 'outbound', 'ringing_you', ?, ?, ?, ?, ?, ?, ?, ?)`,
        req.user.id, check.number, req.user.phone, candidate?.id ?? null, applicationId, record ? 1 : 0, eventKey, t, t);
      return { id: made, callId: record ? newOracleCall(phoneCall(made)) : null };
    });

    const form = new URLSearchParams({
      To: req.user.phone, From: BOOK_NUMBER, Url: hook('voice', id), Method: 'POST',
      StatusCallback: hook('status', id), StatusCallbackMethod: 'POST',
      Timeout: String(RING_YOU), TimeLimit: String(MAX_CALL_SECONDS + 300),
    });
    for (const event of ['initiated', 'ringing', 'answered', 'completed']) form.append('StatusCallbackEvent', event); // once each, as Twilio asks
    try {
      // Not tried twice: a second try could ring the phone twice.
      const created = await twilio('POST', '/Calls.json', form);
      if (!/^CA[0-9a-f]{32}$/i.test(created?.sid ?? '')) throw new TwilioError(502, null);
      q.run('UPDATE phone_calls SET call_sid = COALESCE(call_sid, ?), updated_at = ? WHERE id = ?', created.sid, now(), id);
    } catch (err) {
      const pc = phoneCall(id);
      q.run(`UPDATE phone_calls SET status = 'failed', outcome = 'failed', reason = ?, ended_at = ?, updated_at = ? WHERE id = ?`, `start:${err.code ?? 0}`, now(), now(), id);
      if (pc) dropEmptyOracleCall(pc);
      console.error(`Phone call ${id} could not be started: ${err.message}`);
      // 21211 and its kin are about the recruiter's own number, which they can put right; the rest is the service's side.
      bad(startProblem(err.code), [21211, 21214, 21217].includes(err.code) ? 400 : 502);
    }
    res.status(201).json({ id, call_id: callId, status: 'ringing_you' });
  });

  api.get('/phone/calls', agencyOnly, (req, res) => {
    const limit = Math.min(Math.max(int(req.query.limit) || 20, 1), 100);
    const rows = q.all('SELECT * FROM phone_calls WHERE user_id = ? ORDER BY started_at DESC, id DESC LIMIT ?', req.user.id, limit);
    res.json(rows.map((pc) => ({ ...publicCall(pc), started_at: pc.started_at, direction: pc.direction })));
  });

  api.get('/phone/calls/:id', agencyOnly, (req, res) => res.json(publicCall(mine(req))));

  api.post('/phone/calls/:id/hangup', agencyOnly, async (req, res) => {
    const pc = mine(req);
    if (pc.status !== 'ended' && pc.status !== 'failed' && pc.call_sid) {
      q.run('UPDATE phone_calls SET hangup_at = COALESCE(hangup_at, ?), updated_at = ? WHERE id = ?', now(), now(), pc.id);
      try {
        // "completed" ends a call whatever state it is in, ringing or talking.
        const ended = await twilio('POST', `/Calls/${pc.call_sid}.json`, new URLSearchParams({ Status: 'completed' }));
        if (FINAL.has(ended?.status)) closeCall(pc.id, ended.status, Number(ended.duration) || null);
      } catch (err) {
        if (err.status === 404) closeCall(pc.id, 'failed');
        else {
          q.run('UPDATE phone_calls SET hangup_at = NULL WHERE id = ?', pc.id);
          console.error(`Phone call ${pc.id} could not be hung up: ${err.message}`);
          bad('The phone service did not hang up the call. Hang up on your phone, or try again.', 502);
        }
      }
    }
    res.json({ ok: true });
  });
}
