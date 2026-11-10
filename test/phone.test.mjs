// Phone calls, end to end: the real server on a throwaway data folder, with stand-ins for Twilio (the phone
// service), Deepgram (transcription), Anthropic (notes) and the mail provider. Run with `npm test`.
// Nothing here reaches the real services: see test/twilio-standin/standin.mjs for what that leaves unproven.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer, deepgramStandIn, anthropicStandIn, session, until, tempDir, sleep } from './oracle-helpers.mjs';
import { PHONE_PORTS, BOOK_NUMBER, mailSink, putJson, ringIn, webhooks, restCalls, complaints } from './phone-helpers.mjs';
import { startStandin } from './twilio-standin/standin.mjs';
import { twilioSignature } from '../server/twilio-signature.js';

// The numbers the stand-in gives a behaviour to (test/twilio-standin/standin.mjs). Anything else answers.
const N = {
  priya: '+16475550142', sam: '+16475550143', alex: '+16475550144',
  dana: '+14165550123', jonas: '+14165550124',
  busy: '+16135550111', noAnswer: '+16135550112', failed: '+16135550113', hangsUpInNotice: '+16135550115', talksOn: '+16135550117',
  youNoAnswer: '+16135550101', youBusy: '+16135550102', youFailed: '+16135550103', yourVoicemail: '+16135550104', youRingOn: '+16135550105',
  stranger: '+12125550188',
};
const PIN = '4821';

let twilio, deepgram, anthropic, mail, server, dataDir, base;
let admin, priya, sam, maya;       // the owner, two recruiters and a client's hiring manager
let appDana, appJonas, appKevin;   // three candidates; Kevin's phone is always busy

/** Settings for a server with everything connected to the stand-ins. The pauses are shortened so the tests do not wait minutes. */
const connected = (port, extra = {}) => ({
  TWILIO_ACCOUNT_SID: twilio.config.accountSid, TWILIO_AUTH_TOKEN: twilio.config.authToken, TWILIO_NUMBER: '(647) 555-0100', TWILIO_API_URL: twilio.baseUrl,
  APP_URL: `http://127.0.0.1:${port}`,
  PHONE_SWEEP_MS: '150', PHONE_QUIET_MS: '500', PHONE_RECORDING_WAIT_MS: '350', PHONE_RECORDING_GIVE_UP_MS: '900', PHONE_RETRY_MS: '50',
  PHONE_CALLS_PER_HOUR: '500', // these tests place far more calls in a minute than a person does in an hour
  PHONE_STRANGERS_PER_HOUR: '500', PHONE_STRANGERS_PER_DAY: '500', PHONE_RING_INS_PER_HOUR: '500', // and ring in far more often
  ORACLE_PHONE_RETRY_MS: '60', PHONE_NOTIFY_RETRY_MS: '80',
  DEEPGRAM_API_KEY: 'good', DEEPGRAM_API_URL: deepgram.url, DEEPGRAM_RETRY_MS: '30', DEEPGRAM_TIMEOUT_MS: '1500',
  ANTHROPIC_API_KEY: 'good', ANTHROPIC_BASE_URL: anthropic.url,
  ...mail.env(), ...extra,
});

/** The owner, a client with a job, two recruiters, a client user and three candidates with phone numbers. */
async function workspace(at) {
  const owner = session(at);
  assert.equal((await owner.post('/setup', { agencyName: 'Harbour Talent', name: 'Alex Morgan', email: 'alex@agency.example', password: 'demo1234' })).status, 200);
  const clientId = (await owner.post('/clients', { name: 'Kestrel Logistics', engagement_model: 'per_hire', fee_percent: 20 })).body.id;
  const join = async (role, name, email, extra = {}) => {
    const { token } = (await owner.post('/invites', { role, email, ...extra })).body;
    const person = session(at);
    assert.equal((await person.post(`/invites/${token}/accept`, { name, password: 'demo1234' })).status, 200);
    return person;
  };
  const jobId = (await owner.post('/jobs', { client_id: clientId, title: 'Head of Sales', status: 'open', location: 'Toronto', description: 'Lead and grow our sales team.' })).body.id;
  const candidate = async (name, email, phone) => (await owner.upload('/applications', { job_id: jobId, name, email, phone })).body.id;
  return {
    owner, clientId, jobId, candidate,
    recruiter: await join('recruiter', 'Priya Nair', 'priya@agency.example'),
    colleague: await join('recruiter', 'Sam Okoro', 'sam@agency.example'),
    hiringManager: await join('client', 'Maya Okonkwo', 'maya@kestrel.example', { client_id: clientId }),
    dana: await candidate('Dana Whitlock', 'dana@mail.example', '(416) 555-0123'),
    jonas: await candidate('Jonas Brandt', 'jonas@mail.example', '1-416-555-0124 ext. 9'),
    kevin: await candidate('Kevin Asante', 'kevin@mail.example', '613.555.0111'),
  };
}

const savePhone = (who, phone, pin, at = base) => putJson(who, at, '/me/phone', pin === undefined ? { phone } : { phone, pin });
const phoneCallOf = async (who, id) => (await who.get(`/phone/calls/${id}`)).body;
/** Place a call and wait until it is over. Resolves to { placed, call }: what placing it answered, and how it ended. */
async function callAndWait(who, body) {
  const placed = await who.post('/phone/calls', body);
  assert.equal(placed.status, 201, JSON.stringify(placed.body));
  await twilio.idle();
  const call = await until(() => phoneCallOf(who, placed.body.id), (c) => c.status === 'ended' || c.status === 'failed');
  return { placed: placed.body, call };
}
const oracleCall = async (who, id) => (await who.get(`/oracle/calls/${id}`)).body;
/** Wait until a call in the Oracle has been written out (and, when asked, until its notes are there). */
const writtenOut = (who, id, alsoNotes = true) => until(() => oracleCall(who, id), (d) => d.call && d.call.status === 'ready' && (!alsoNotes || d.call.notes));
const audioFiles = () => fs.readdirSync(path.join(dataDir, 'uploads')).filter((name) => name.startsWith('call-'));
const activities = async (who, appId) => (await who.get(`/applications/${appId}`)).body.activities.filter((a) => a.type === 'call').map((a) => a.detail);
/** Read the server's database directly, for things no route shows. */
function db(query, ...params) {
  const database = new DatabaseSync(path.join(dataDir, 'app.db'), { readOnly: true });
  try { return database.prepare(query).all(...params); } finally { database.close(); }
}
/** A webhook as Twilio would send it, signed with `token` (the real one unless a test forges it). */
async function webhook(pathAndQuery, params, { token = twilio.config.authToken, signature, method = 'POST' } = {}) {
  const url = `${base}/api/phone/twilio/${pathAndQuery}`;
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  const sig = signature === undefined ? twilioSignature(token, url, method === 'POST' ? params : {}) : signature;
  if (sig !== null) headers['X-Twilio-Signature'] = sig;
  const res = await fetch(url, { method, headers: method === 'POST' ? headers : { 'X-Twilio-Signature': sig ?? '' }, body: method === 'POST' ? new URLSearchParams(params).toString() : undefined });
  return { status: res.status, text: await res.text(), type: res.headers.get('content-type') || '' };
}

before(async () => {
  twilio = await startStandin({ port: PHONE_PORTS.twilio, numbers: [BOOK_NUMBER], quiet: true, stepMs: 5 });
  deepgram = await deepgramStandIn(PHONE_PORTS.deepgram);
  anthropic = await anthropicStandIn(PHONE_PORTS.anthropic);
  mail = await mailSink();
  dataDir = tempDir('phone');
  server = await startServer({ port: PHONE_PORTS.main, dataDir, env: connected(PHONE_PORTS.main) });
  base = server.base;
  const w = await workspace(base);
  ({ owner: admin, recruiter: priya, colleague: sam, hiringManager: maya, dana: appDana, jonas: appJonas, kevin: appKevin } = w);
  assert.equal((await savePhone(priya, '647-555-0142', PIN)).status, 200);
});
after(async () => {
  if (process.env.PHONE_TEST_LOG) fs.writeFileSync(process.env.PHONE_TEST_LOG, server?.output() ?? ''); // to read what the server said during a run
  await server?.stop();
  await twilio?.close();
  await deepgram?.stop();
  await anthropic?.stop();
  await mail?.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('status says what is connected, and whose phone and PIN are saved', async () => {
  const mine = await priya.get('/phone/status');
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.body, {
    configured: true, number: BOOK_NUMBER, number_display: '(647) 555-0100', my_phone: N.priya, my_pin_set: true, notice: true, countries: ['CA', 'US'],
    // Nothing is missing, and the two addresses to enter on the number at Twilio are given in full.
    missing: [], problem: null, webhooks: { inbound: `${base}/api/phone/twilio/inbound`, status: `${base}/api/phone/twilio/status` },
  });
  const theirs = (await sam.get('/phone/status')).body;
  assert.equal(theirs.my_phone, null);
  assert.equal(theirs.my_pin_set, false);
});

test('click to call, answered: recorded on two channels, fetched, deleted at Twilio, written out with the right names, on the candidate, and the recruiter is e-mailed', async () => {
  const mark = twilio.entries.length, mailed = mail.sent.length, heard = deepgram.requests.length;
  const { placed, call } = await callAndWait(priya, { application_id: appDana });
  assert.equal(placed.status, 'ringing_you');
  assert.ok(Number.isInteger(placed.call_id), 'a recorded call says which Oracle call it will become');
  assert.equal(call.outcome, 'completed');
  assert.equal(call.candidate_name, 'Dana Whitlock');
  assert.equal(call.to_display, '(416) 555-0123');
  assert.equal(call.recorded, true);
  assert.equal(call.call_id, placed.call_id);

  // What Twilio was asked to do.
  const [start] = restCalls(twilio, mark, /^POST .*\/Calls\.json$/);
  assert.equal(start.params.To, N.priya, 'the recruiter\'s own phone is rung first');
  assert.equal(start.params.From, BOOK_NUMBER);
  assert.deepEqual(start.params.StatusCallbackEvent, ['initiated', 'ringing', 'answered', 'completed']);
  assert.equal(start.auth, 'account-sid+auth-token');
  const voice = webhooks(twilio, mark, 'voice-url')[0].response;
  assert.match(voice, /<Gather numDigits="1"/);
  assert.match(voice, /Press 1 to call Dana Whitlock\. The call will be recorded\./);
  const connect = webhooks(twilio, mark, 'gather-action')[0].response;
  assert.match(connect, /<Dial callerId="\+16475550100"/, 'the candidate sees The Book\'s number');
  assert.match(connect, /record="record-from-answer-dual"/);
  assert.match(connect, /trim="do-not-trim"/);
  assert.match(connect, /recordingStatusCallbackEvent="in-progress completed absent"/);
  assert.match(connect, /<Number url="[^"]+\/api\/phone\/twilio\/whisper\?c=\d+" method="POST">\+14165550123<\/Number>/);
  const notice = webhooks(twilio, mark, 'number-url')[0].response;
  assert.match(notice, /<Say>This call from Harbour Talent is recorded and transcribed for recruitment notes\. Tell your recruiter if you&apos;d prefer it wasn&apos;t\.<\/Say>/);
  assert.deepEqual(complaints(twilio, mark), [], 'Twilio would have nothing to complain about in what it was told');

  // The call in the Oracle.
  const { call: written } = await writtenOut(priya, placed.call_id);
  assert.equal(written.source, 'phone');
  assert.equal(written.direction, 'outbound');
  assert.equal(written.phone_display, '(416) 555-0123');
  assert.equal(written.title, 'Call with Dana Whitlock');
  assert.equal(written.application_id, appDana);
  assert.equal(written.has_audio, true);
  assert.equal(written.audio_type, 'audio/wav');
  assert.equal(written.duration_ms, 12000);
  assert.equal(written.created_by_name, 'Priya Nair');
  assert.equal(written.transcript.length, 8, 'the two channels are woven into turns in order of time');
  assert.deepEqual(written.transcript.map((turn) => turn.speaker), [0, 1, 0, 1, 0, 1, 0, 1]);
  assert.deepEqual(written.speakers, { 0: 'Priya Nair', 1: 'Dana Whitlock' }, 'the recruiter is on the first channel of a call they placed');
  assert.match(written.notes, /Varsity Freight/);
  assert.match(written.consent_wording, /The Book played this notice to Dana Whitlock when they answered, before the call was connected: “This call from Harbour Talent is recorded/);
  assert.equal(written.consent_by_name, 'Priya Nair');
  assert.ok(written.consent_at);

  // The recording: fetched with both channels, kept, and then deleted from Twilio.
  const fetched = restCalls(twilio, mark, /^GET .*\/Recordings\/RE\w+\.wav/);
  assert.equal(fetched.length, 1);
  assert.match(fetched[0].path, /RequestedChannels=2$/);
  assert.equal(fetched[0].served.channels, 2);
  const audio = await priya.get(`/oracle/calls/${placed.call_id}/audio`);
  assert.equal(audio.body.length, 384044);
  assert.equal(audio.body.readUInt16LE(22), 2, 'the audio kept has two channels');
  await until(async () => restCalls(twilio, mark, /^DELETE .*\/Recordings\/RE\w+\.json$/), (list) => list.length === 1 && list[0].status === 204);
  assert.equal([...twilio.recordings.values()].filter((rec) => rec.status === 'completed' && !rec.deleted).length, 0, 'nothing is left at Twilio');

  // Transcription: asked for channel by channel, and never for speakers to be told apart as well.
  const [asked] = deepgram.requests.slice(heard);
  assert.equal(asked.query.multichannel, 'true');
  assert.ok(!('diarize_model' in asked.query) && !('diarize' in asked.query));
  assert.equal(asked.query.tag, 'oracle-phone');
  assert.equal(asked.query.mip_opt_out, 'true');
  assert.equal(asked.channels, 2);
  assert.equal(asked.contentType, 'audio/wav');
  assert.deepEqual(asked.problems, []);

  // On the candidate, for the agency only.
  assert.deepEqual(await activities(priya, appDana), ['Phone call, 12 sec']);
  assert.deepEqual(await activities(maya, appDana), []);
  // The recruiter is told, once, with a link to the call.
  const [message] = await until(async () => mail.sent.slice(mailed), (list) => list.length >= 1);
  assert.deepEqual(message.to, ['priya@agency.example']);
  assert.equal(message.subject, 'Your call notes for Dana Whitlock are ready');
  assert.ok(message.text.includes(`${base}/oracle/${placed.call_id}`));
  assert.ok(message.text.includes('It is on Dana Whitlock\'s profile (Head of Sales, Kestrel Logistics).'));
  // And the call shows in their list of phone calls, saying where it ended up.
  const after = await until(() => phoneCallOf(priya, placed.id), (c) => /in The Oracle/.test(c.message));
  assert.equal(after.message, 'You spoke to Dana for 12 sec. It is in The Oracle.');
  assert.equal(after.duration_sec, 12);
  const [latest] = (await priya.get('/phone/calls?limit=5')).body;
  assert.equal(latest.id, placed.id);
  assert.equal(latest.direction, 'outbound');
  assert.ok(latest.started_at);
});

test('the other person is busy, does not answer, cannot be reached, or hangs up during the notice: one plain sentence each, and nothing is left in the Oracle', async () => {
  const before = (await priya.get('/oracle/calls')).body.length, files = audioFiles().length;
  const mark = twilio.entries.length;

  const busy = await callAndWait(priya, { application_id: appKevin });
  assert.equal(busy.call.status, 'ended');
  assert.equal(busy.call.outcome, 'busy');
  assert.equal(busy.call.message, 'Kevin\'s phone was busy.');
  assert.equal(busy.call.candidate_name, 'Kevin Asante');
  assert.equal(busy.call.recorded, false);
  assert.equal(busy.call.call_id, null, 'the Oracle call it would have become is gone');
  assert.equal((await priya.get(`/oracle/calls/${busy.placed.call_id}`)).status, 404);
  // The recruiter hears why on their phone too, since they may not be looking at a screen.
  assert.match(webhooks(twilio, mark, 'dial-action')[0].response, /<Say>Kevin&apos;s phone was busy\.<\/Say><Hangup\/>/);

  const silent = await callAndWait(priya, { to: '613 555 0112' });
  assert.equal(silent.call.outcome, 'no_answer');
  assert.equal(silent.call.message, 'Nobody answered that number.');
  assert.equal(silent.call.candidate_name, null);
  assert.equal(silent.call.to_display, '(613) 555-0112');
  assert.equal(silent.call.duration_sec, null);

  const dead = await callAndWait(priya, { to: N.failed });
  assert.equal(dead.call.status, 'failed');
  assert.equal(dead.call.outcome, 'failed');
  assert.equal(dead.call.message, 'That number could not be called.');

  const shy = await callAndWait(priya, { to: N.hangsUpInNotice });
  assert.equal(shy.call.outcome, 'no_answer');
  assert.equal(shy.call.message, 'That number answered but hung up before being connected.');
  assert.equal(shy.call.call_id, null);

  assert.equal((await priya.get('/oracle/calls')).body.length, before);
  assert.equal(audioFiles().length, files);
  assert.equal(restCalls(twilio, mark, /Recordings/).length, 0, 'no recording was asked for');
  assert.deepEqual(complaints(twilio, mark), []);
  assert.deepEqual(await activities(priya, appKevin), [], 'a call that never connected is not on the candidate\'s history');
});

test('the recruiter does not pick up, is busy or cannot be reached: nobody else is rung', async () => {
  const mark = twilio.entries.length, rung = () => [...twilio.calls.values()].filter((c) => c.direction === 'outbound-dial').length;
  const before = rung();
  const outcomes = [];
  for (const [mobile, status, outcome, message] of [
    [N.youNoAnswer, 'ended', 'you_did_not_answer', 'You did not pick up.'],
    [N.youBusy, 'ended', 'you_did_not_answer', 'Your phone was busy, so nobody was called.'],
    [N.youFailed, 'failed', 'failed', 'Your phone could not be reached. Check the mobile number you saved.'],
  ]) {
    assert.equal((await savePhone(priya, mobile)).status, 200);
    const { call } = await callAndWait(priya, { application_id: appDana });
    outcomes.push([call.status, call.outcome, call.message, call.call_id]);
    assert.deepEqual(outcomes.at(-1), [status, outcome, message, null]);
  }
  assert.equal(webhooks(twilio, mark, 'voice-url').length, 0, 'the first phone was never answered, so nothing was asked of us');
  assert.equal(rung(), before, 'Twilio rang nobody else');
  assert.equal((await savePhone(priya, N.priya)).status, 200);
});

test('the recruiter\'s own voicemail answers: nobody presses 1, so the candidate is never rung', async () => {
  assert.equal((await savePhone(priya, N.yourVoicemail)).status, 200);
  const mark = twilio.entries.length, dials = [...twilio.calls.values()].filter((c) => c.direction === 'outbound-dial').length;
  const { call } = await callAndWait(priya, { application_id: appDana });
  assert.equal(call.outcome, 'you_did_not_answer');
  assert.equal(call.message, 'You did not press 1, so nobody was called.');
  assert.equal(call.call_id, null);
  assert.equal(webhooks(twilio, mark, 'voice-url').length, 1);
  assert.ok(!webhooks(twilio, mark).some((hook) => /<Dial/.test(hook.response || '')), 'no instruction to ring anyone was ever given');
  assert.equal([...twilio.calls.values()].filter((c) => c.direction === 'outbound-dial').length, dials, 'Twilio rang nobody else');
  assert.equal((await savePhone(priya, N.priya)).status, 200);

  // A person who presses the wrong key is asked again, and is connected once they press 1.
  twilio.behaviour.firstLegDigits = ['7', '1'];
  try {
    const again = twilio.entries.length;
    const { call: second } = await callAndWait(priya, { to: N.noAnswer });
    assert.equal(second.outcome, 'no_answer');
    const asked = webhooks(twilio, again, 'gather-action');
    assert.equal(asked.length, 2);
    assert.match(asked[0].response, /That was not 1\. Press 1 to call 6 1 3, 5 5 5, 0 1 1 2\./, 'a number with no name is read out digit by digit');
    assert.match(asked[1].response, /<Dial /);
  } finally {
    twilio.behaviour.firstLegDigits = null;
  }
});

test('a call can be placed without recording: no recording, no notice, and nothing in the Oracle', async () => {
  const before = (await priya.get('/oracle/calls')).body.length, mark = twilio.entries.length;
  const { placed, call } = await callAndWait(priya, { application_id: appJonas, record: false });
  assert.equal(placed.call_id, null);
  assert.equal(call.outcome, 'completed');
  assert.equal(call.recorded, false);
  assert.equal(call.to_display, '(416) 555-0124', 'a number typed with an extension is rung without it');
  assert.equal(call.message, 'You spoke to Jonas for 15 sec. The call was not recorded.');
  assert.match(webhooks(twilio, mark, 'voice-url')[0].response, /The call will not be recorded\./);
  const connect = webhooks(twilio, mark, 'gather-action')[0].response;
  assert.ok(!/record=|recordingStatusCallback/.test(connect), 'Twilio is not asked to record');
  assert.match(webhooks(twilio, mark, 'number-url')[0].response, /<Response><\/Response>/, 'the person called hears no notice');
  assert.equal(twilio.recordings.size, [...twilio.recordings.values()].filter((rec) => rec.deleted).length, 'no recording exists at Twilio');
  assert.equal((await priya.get('/oracle/calls')).body.length, before);
  assert.deepEqual(await activities(priya, appJonas), []);
  assert.deepEqual(complaints(twilio, mark), []);
});

test('hanging up from the app ends a call that is ringing or under way, and only the person on it (or an admin) can', async () => {
  // While their own phone is still ringing.
  assert.equal((await savePhone(priya, N.youRingOn)).status, 200);
  let placed = (await priya.post('/phone/calls', { application_id: appDana })).body;
  assert.equal((await phoneCallOf(priya, placed.id)).message, 'Ringing your phone. Pick up, then press 1.');
  assert.equal((await sam.post(`/phone/calls/${placed.id}/hangup`)).status, 404, 'somebody else\'s call is not theirs to end');
  assert.equal((await sam.get(`/phone/calls/${placed.id}`)).status, 404);
  assert.deepEqual((await priya.post(`/phone/calls/${placed.id}/hangup`)).body, { ok: true });
  let call = await until(() => phoneCallOf(priya, placed.id), (c) => c.status === 'ended');
  assert.equal(call.outcome, 'cancelled');
  assert.equal(call.message, 'The call was cancelled.');
  assert.equal(call.call_id, null);
  assert.equal((await savePhone(priya, N.priya)).status, 200);

  // While the two are talking: the call ends, and what was said up to then is kept.
  placed = (await priya.post('/phone/calls', { to: N.talksOn })).body;
  call = await until(() => phoneCallOf(priya, placed.id), (c) => c.status === 'in_call');
  assert.equal(call.message, 'You are talking to (613) 555-0117. The call is being recorded.');
  // One call at a time each.
  const second = await priya.post('/phone/calls', { application_id: appDana });
  assert.equal(second.status, 409);
  assert.equal(second.body.error, 'You already have a call under way. Hang up first, or wait for it to end.');
  assert.deepEqual((await admin.post(`/phone/calls/${placed.id}/hangup`)).body, { ok: true }, 'an admin can end anyone\'s call');
  call = await until(() => phoneCallOf(priya, placed.id), (c) => c.status === 'ended');
  assert.equal(call.outcome, 'completed');
  const { call: written } = await writtenOut(priya, placed.call_id);
  assert.equal(written.title, 'Untitled call');
  assert.equal(written.application_id, null, 'a number that is nobody\'s is left for the recruiter to add to a candidate');
  assert.deepEqual(written.speakers, { 0: 'Priya Nair', 1: 'Candidate' });
  // Hanging up a call that is already over is not an error.
  assert.deepEqual((await priya.post(`/phone/calls/${placed.id}/hangup`)).body, { ok: true });
  await twilio.idle();
});

test('the switchboard: ring in from your saved mobile, key in your PIN and a number, and the call is placed and recorded the same way', async () => {
  const mark = twilio.entries.length, mailed = mail.sent.length;
  await ringIn(twilio, base, N.priya, [PIN, '4165550123']);
  const steps = webhooks(twilio, mark);
  assert.match(steps.find((s) => s.what === 'voice-url').response, /<Gather finishOnKey="#"[^>]*>.*Enter your PIN, then press hash\./);
  const [pinStep, numberStep] = steps.filter((s) => s.what === 'gather-action');
  assert.equal(pinStep.params.Digits, PIN);
  assert.match(pinStep.response, /Enter the number to call, area code first, then press hash\./);
  assert.match(numberStep.response, /<Say>Calling Dana Whitlock\. The call is recorded\.<\/Say><Dial callerId="\+16475550100"[^>]*record="record-from-answer-dual"/);
  assert.match(steps.find((s) => s.what === 'number-url').response, /This call from Harbour Talent is recorded/);
  assert.deepEqual(complaints(twilio, mark), []);

  const [latest] = (await priya.get('/phone/calls?limit=1')).body;
  assert.equal(latest.direction, 'switchboard');
  assert.equal(latest.outcome, 'completed');
  assert.equal(latest.candidate_name, 'Dana Whitlock');
  const { call: written } = await writtenOut(priya, latest.call_id);
  assert.equal(written.direction, 'outbound');
  assert.equal(written.application_id, appDana, 'a number that is exactly one candidate\'s goes on that candidate');
  assert.deepEqual(written.speakers, { 0: 'Priya Nair', 1: 'Dana Whitlock' });
  assert.equal(written.created_by_name, 'Priya Nair');
  assert.deepEqual(await activities(priya, appDana), ['Phone call, 12 sec', 'Phone call, 12 sec']);
  const [message] = await until(async () => mail.sent.slice(mailed), (list) => list.length >= 1);
  assert.equal(message.subject, 'Your call notes for Dana Whitlock are ready');
});

test('the switchboard refuses a number it may not call, a phone with no PIN, and locks a phone out after three wrong PINs', async () => {
  // A number outside the countries allowed: said aloud, asked again, and nobody is rung.
  let mark = twilio.entries.length;
  await ringIn(twilio, base, N.priya, [PIN, '8765550199']);
  let asked = webhooks(twilio, mark, 'gather-action');
  assert.match(asked[1].response, /That number is outside the countries this workspace can call \(CA, US\)\. Enter the number to call/);
  assert.ok(!webhooks(twilio, mark).some((hook) => /<Dial/.test(hook.response || '')));
  const [abandoned] = await until(async () => (await priya.get('/phone/calls?limit=1')).body, (list) => list[0].status === 'ended');
  assert.equal(abandoned.direction, 'switchboard');
  assert.equal(abandoned.message, 'You rang in and hung up before calling anyone.');
  assert.equal(abandoned.call_id, null);

  // A saved mobile with no PIN cannot place calls by ringing in.
  assert.equal((await savePhone(sam, N.sam)).status, 200);
  mark = twilio.entries.length;
  await ringIn(twilio, base, N.sam, ['1', '4165550123']);
  assert.match(webhooks(twilio, mark, 'voice-url')[0].response, /first choose a PIN in The Book/);
  assert.equal(webhooks(twilio, mark, 'gather-action').length, 0);

  // A wrong PIN is asked for again; wrong PINs add up across calls; the third locks the phone for fifteen minutes.
  const mailed = mail.sent.length;
  mark = twilio.entries.length;
  await ringIn(twilio, base, N.priya, ['1111']);
  assert.match(webhooks(twilio, mark, 'gather-action')[0].response, /That PIN is not right\. Enter your PIN, then press hash\./);
  await ringIn(twilio, base, N.priya, ['2222']);
  mark = twilio.entries.length;
  await ringIn(twilio, base, N.priya, ['3333', PIN, '4165550123']);
  asked = webhooks(twilio, mark, 'gather-action');
  assert.equal(asked.length, 1, 'after the third wrong PIN the call is ended: the right one is never asked for');
  assert.match(asked[0].response, /The switchboard is now locked for this phone for a quarter of an hour\. Goodbye\.<\/Say><Hangup\/>/);
  // Even the right PIN does nothing now.
  mark = twilio.entries.length;
  await ringIn(twilio, base, N.priya, [PIN, '4165550123']);
  assert.match(webhooks(twilio, mark, 'voice-url')[0].response, /The switchboard is locked for this phone after wrong PINs/);
  assert.equal(webhooks(twilio, mark, 'gather-action').length, 0);
  assert.ok(!webhooks(twilio, mark).some((hook) => /<Dial/.test(hook.response || '')));
  const [lockedOut] = db(`SELECT phone_locked_until FROM users WHERE email = 'priya@agency.example'`);
  const minutes = (Date.parse(lockedOut.phone_locked_until) - Date.now()) / 60000;
  assert.ok(minutes > 14 && minutes <= 15, `locked for fifteen minutes (${minutes})`);
  const [warning] = await until(async () => mail.sent.slice(mailed), (list) => list.length >= 1);
  assert.deepEqual(warning.to, ['priya@agency.example']);
  assert.match(warning.subject, /locked out of The Book's switchboard/);
  // Click to call from the app is not affected: it needs a signed-in person, not a PIN.
  assert.equal((await callAndWait(priya, { to: N.busy })).call.outcome, 'busy');
  // Saving a different phone starts afresh; the PIN itself is never stored as typed.
  assert.equal((await savePhone(priya, N.youBusy)).status, 200);
  assert.equal((await savePhone(priya, N.priya)).status, 200);
  const [saved] = db(`SELECT phone_pin_hash, phone_locked_until FROM users WHERE email = 'priya@agency.example'`);
  assert.equal(saved.phone_locked_until, null);
  assert.ok(saved.phone_pin_hash && !saved.phone_pin_hash.includes(PIN));
  await twilio.idle();
});

test('a candidate rings The Book\'s number: put through to the recruiter who last called them, announced by name, recorded with a notice to the caller', async () => {
  const mark = twilio.entries.length, mailed = mail.sent.length;
  await ringIn(twilio, base, N.dana);
  const steps = webhooks(twilio, mark);
  const first = steps.find((s) => s.what === 'voice-url').response;
  assert.match(first, /<Say>Thanks for calling Harbour Talent\. This call is recorded and transcribed for recruitment notes\. Tell your recruiter if you&apos;d prefer it wasn&apos;t\.<\/Say>/);
  assert.match(first, /<Dial callerId="\+16475550100" answerOnBridge="true" timeout="20"[^>]*record="record-from-answer-dual"[^>]*>.*>\+16475550142<\/Number>/, 'Priya called Dana last, so Priya\'s phone rings, showing The Book\'s number');
  assert.match(steps.find((s) => s.what === 'number-url').response, /<Say>Call from Dana Whitlock, a candidate\. This call is recorded\.<\/Say>/);
  assert.deepEqual(complaints(twilio, mark), []);

  const [latest] = await until(async () => (await priya.get('/phone/calls?limit=1')).body, (list) => list[0].direction === 'inbound' && list[0].call_id);
  assert.equal(latest.outcome, 'completed');
  assert.equal(latest.candidate_name, 'Dana Whitlock');
  assert.equal(latest.to_display, '(416) 555-0123');
  const { call: written } = await writtenOut(priya, latest.call_id);
  assert.equal(written.direction, 'inbound');
  assert.equal(written.application_id, appDana);
  assert.equal(written.title, 'Call with Dana Whitlock');
  assert.deepEqual(written.speakers, { 0: 'Dana Whitlock', 1: 'Priya Nair' }, 'on a call that came in, the caller is on the first channel');
  assert.match(written.consent_wording, /The Book played this notice to Dana Whitlock when they rang, before the call was put through: “Thanks for calling Harbour Talent\. This call is recorded/);
  assert.equal((await activities(priya, appDana)).length, 3);
  const [message] = await until(async () => mail.sent.slice(mailed), (list) => list.length >= 1);
  assert.deepEqual(message.to, ['priya@agency.example']);
});

test('a number nobody knows rings: put through the same way, and the call waits in the Oracle to be added to a candidate', async () => {
  // Nobody has called this number and it is no candidate's, so it goes to the first admin with a mobile saved.
  // Before any admin has one, the caller is asked to leave a message rather than being lost.
  let mark = twilio.entries.length;
  await ringIn(twilio, base, N.stranger);
  let first = webhooks(twilio, mark, 'voice-url')[0].response;
  assert.match(first, /Nobody can take your call right now\. Please leave a message after the tone\.<\/Say><Record /);
  const [left] = await until(async () => (await admin.get('/phone/calls?limit=1')).body, (list) => list.length && list[0].call_id);
  assert.equal(left.message, '(212) 555-0188 rang and left a message. It is in The Oracle.');

  assert.equal((await savePhone(admin, N.alex)).status, 200);
  mark = twilio.entries.length;
  await ringIn(twilio, base, N.stranger);
  first = webhooks(twilio, mark, 'voice-url')[0].response;
  assert.match(first, />\+16475550144<\/Number>/);
  assert.match(webhooks(twilio, mark, 'number-url')[0].response, /<Say>Call from a number The Book does not know\. This call is recorded\.<\/Say>/);
  const [latest] = await until(async () => (await admin.get('/phone/calls?limit=1')).body, (list) => list[0].outcome === 'completed' && list[0].call_id);
  assert.equal(latest.candidate_name, null);
  const { call: written } = await writtenOut(admin, latest.call_id);
  assert.equal(written.application_id, null);
  assert.equal(written.candidate_id, null);
  assert.equal(written.title, 'Untitled call');
  assert.equal(written.phone_display, '(212) 555-0188');
  assert.deepEqual(written.speakers, { 0: 'Caller', 1: 'Alex Morgan' });
  const listed = (await admin.get('/oracle/calls')).body.find((row) => row.id === latest.call_id);
  assert.equal(listed.source, 'phone');
  assert.equal(listed.direction, 'inbound');
  assert.equal(listed.phone_display, '(212) 555-0188');

  // Added to a candidate afterwards, the caller takes that person's name, and the phone call is tied to them too.
  const moved = await admin.patch(`/oracle/calls/${latest.call_id}`, { application_id: appJonas });
  assert.equal(moved.body.call.title, 'Call with Jonas Brandt');
  assert.deepEqual(moved.body.call.speakers, { 0: 'Jonas Brandt', 1: 'Alex Morgan' });
  const [tied] = db('SELECT candidate_id, application_id FROM phone_calls WHERE call_id = ?', latest.call_id);
  assert.equal(tied.application_id, appJonas);
  assert.ok(tied.candidate_id);
});

test('nobody answers a caller: they leave a message, which becomes a call in the Oracle on the candidate, and the recruiter is told', async () => {
  // Sam owns this candidate, and Sam's phone is one that rings out.
  assert.equal((await savePhone(sam, N.noAnswer)).status, 200);
  const appErin = (await sam.upload('/applications', { job_id: (await admin.get(`/applications/${appDana}`)).body.job.id, name: 'Erin Vasquez', email: 'erin@mail.example', phone: '+1 (905) 555-0177' })).body.id;
  const mark = twilio.entries.length, mailed = mail.sent.length, heard = deepgram.requests.length;
  deepgram.mode = 'nodiarize'; // one voice: the service tells no speakers apart
  try {
    await ringIn(twilio, base, '+19055550177');
    const steps = webhooks(twilio, mark);
    assert.match(steps.find((s) => s.what === 'voice-url').response, />\+16135550112<\/Number>/, 'the owner of their application is rung');
    const afterRinging = steps.find((s) => s.what === 'dial-action');
    assert.equal(afterRinging.params.DialCallStatus, 'no-answer');
    assert.match(afterRinging.response, /<Say>Sorry, nobody could take your call\. Please leave a message after the tone\.<\/Say><Record maxLength="120" playBeep="true" timeout="5" action="[^"]+voicemail-done\?c=\d+"/);
    assert.deepEqual(complaints(twilio, mark), []);

    const [latest] = await until(async () => (await sam.get('/phone/calls?limit=1')).body, (list) => list.length && list[0].call_id);
    assert.equal(latest.direction, 'inbound');
    assert.equal(latest.outcome, 'no_answer');
    assert.equal(latest.message, 'Erin Vasquez rang and left a message. It is in The Oracle.');
    assert.equal(latest.duration_sec, 6);
    const { call: written } = await writtenOut(sam, latest.call_id);
    assert.equal(written.voicemail, true);
    assert.equal(written.title, 'Voicemail from Erin Vasquez');
    assert.equal(written.application_id, appErin);
    assert.equal(written.duration_ms, 6000);
    assert.deepEqual(written.speakers, { 0: 'Erin Vasquez' });
    assert.deepEqual(await activities(sam, appErin), ['Voicemail left, 6 sec']);
    // One channel, so it is transcribed the ordinary way.
    const [asked] = deepgram.requests.slice(heard);
    assert.equal(asked.channels, 1);
    assert.ok(!('multichannel' in asked.query));
    assert.deepEqual(asked.problems, []);
    const fetched = restCalls(twilio, mark, /^GET .*\/Recordings\/RE\w+\.wav/);
    assert.match(fetched[0].path, /RequestedChannels=1$/);
    await until(async () => restCalls(twilio, mark, /^DELETE .*\/Recordings\//), (list) => list.some((r) => r.status === 204));
    const [message] = await until(async () => mail.sent.slice(mailed), (list) => list.length >= 1);
    assert.deepEqual(message.to, ['sam@agency.example']);
    assert.equal(message.subject, 'Your call notes for Erin Vasquez are ready');
    assert.match(message.text, /The message Erin Vasquez left on The Book's number \(6 sec\) has been written out/);
  } finally {
    deepgram.mode = null;
    assert.equal((await savePhone(sam, N.sam)).status, 200);
  }
});

test('forged and unsigned webhooks are refused, and change nothing', async () => {
  const { placed } = await callAndWait(priya, { to: N.busy });
  const before = await phoneCallOf(priya, placed.id);
  const params = { CallSid: 'CA00000000000000000000000000000000', CallStatus: 'completed', From: N.stranger, To: BOOK_NUMBER };
  const route = `status?c=${placed.id}`;
  assert.equal((await webhook(route, params, { signature: null })).status, 403, 'no signature at all');
  assert.equal((await webhook(route, params, { signature: 'bm90IGEgc2lnbmF0dXJl' })).status, 403, 'a made-up signature');
  assert.equal((await webhook(route, params, { token: 'not-the-auth-token' })).status, 403, 'signed with the wrong secret');
  const forOther = twilioSignature(twilio.config.authToken, `${base}/api/phone/twilio/status?c=${placed.id + 1}`, params);
  assert.equal((await webhook(route, params, { signature: forOther })).status, 403, 'a real signature, for a different address');
  const real = twilioSignature(twilio.config.authToken, `${base}/api/phone/twilio/${route}`, params);
  assert.equal((await webhook(route, { ...params, CallStatus: 'failed' }, { signature: real })).status, 403, 'a real signature, with the contents changed');
  // The routes that answer with instructions are no different: an unsigned caller gets no instructions.
  for (const name of ['inbound', 'voice?c=1', 'connect?c=1', 'whisper?c=1', 'dial-done?c=1', 'recording?c=1', 'voicemail-done?c=1', 'pin?c=1', 'number?c=1']) {
    const refused = await webhook(name, { ...params, Digits: '1', RecordingSid: 'RE00000000000000000000000000000000', RecordingStatus: 'completed' }, { signature: null });
    assert.equal(refused.status, 403, name);
    assert.ok(!/<Response/.test(refused.text));
  }
  assert.deepEqual(await phoneCallOf(priya, placed.id), before);
  assert.equal(db(`SELECT COUNT(*) AS n FROM phone_calls WHERE call_sid = ?`, params.CallSid)[0].n, 0, 'an unsigned call to the number created nothing');
  // The same request with its real signature is accepted (and, the call being over, changes nothing either).
  assert.equal((await webhook(route, params)).status, 204);
  assert.equal((await webhook('nothing-here', params)).status, 404);
  // Signed-in people have no way in to these routes that skips the signature.
  const viaSession = await fetch(`${base}/api/phone/twilio/${route}`, { method: 'POST', headers: { Cookie: priya.cookie(), 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() });
  assert.equal(viaSession.status, 403);
});

test('every webhook arriving twice makes one call, one recording fetched once, one line on the candidate and one e-mail', async () => {
  twilio.behaviour.twice = true;
  try {
    const mark = twilio.entries.length, mailed = mail.sent.length;
    const oracleBefore = (await priya.get('/oracle/calls')).body.length, rows = db('SELECT COUNT(*) AS n FROM phone_calls')[0].n, lines = (await activities(priya, appDana)).length;
    const { placed, call } = await callAndWait(priya, { application_id: appDana });
    assert.equal(call.outcome, 'completed');
    await writtenOut(priya, placed.call_id);
    await until(async () => mail.sent.slice(mailed), (list) => list.length >= 1);
    await ringIn(twilio, base, N.priya, [PIN, '4165550124']);   // the switchboard, to Jonas
    await ringIn(twilio, base, N.dana);                          // and a call coming in
    const mineNow = await until(async () => (await priya.get('/phone/calls?limit=3')).body, (list) => list.slice(0, 2).every((c) => c.status === 'ended' && c.call_id && /in The Oracle/.test(c.message)));
    assert.deepEqual(mineNow.slice(0, 2).map((c) => c.direction), ['inbound', 'switchboard']);
    for (const c of mineNow.slice(0, 2)) await writtenOut(priya, c.call_id);
    await sleep(300); // long enough for anything that was going to happen twice to have happened
    assert.ok(webhooks(twilio, mark).every((hook) => hook.secondStatus === hook.status), 'the second delivery of each webhook was answered like the first');
    assert.equal(db('SELECT COUNT(*) AS n FROM phone_calls')[0].n, rows + 3);
    assert.equal((await priya.get('/oracle/calls')).body.length, oracleBefore + 3);
    assert.equal(restCalls(twilio, mark, /^GET .*\/Recordings\/RE\w+\.wav/).length, 3, 'each recording was fetched once');
    assert.equal(restCalls(twilio, mark, /^POST .*\/Calls\.json$/).length, 1);
    assert.equal((await activities(priya, appDana)).length, lines + 2);
    assert.equal(mail.sent.length, mailed + 3);
    assert.deepEqual(complaints(twilio, mark), []);
  } finally {
    twilio.behaviour.twice = false;
  }
});

test('the recording webhook never arrives: the sweep asks Twilio for the recording, and the call is not lost', async () => {
  twilio.behaviour.drop = ['recording:'];
  try {
    const mark = twilio.entries.length;
    const { placed, call } = await callAndWait(priya, { application_id: appDana });
    assert.equal(call.outcome, 'completed');
    assert.equal(call.message, 'You spoke to Dana for 15 sec. The recording is on its way to The Oracle.');
    const { call: written } = await writtenOut(priya, placed.call_id);
    assert.equal(written.has_audio, true);
    assert.equal(written.transcript.length, 8);
    assert.ok(restCalls(twilio, mark, /^GET .*\/Calls\/CA\w+\/Recordings\.json$/).length >= 1, 'Twilio was asked what recordings the call has');
    await until(async () => restCalls(twilio, mark, /^DELETE .*\/Recordings\//), (list) => list.some((r) => r.status === 204));
  } finally {
    twilio.behaviour.drop = [];
  }
});

test('every webhook after the call is connected goes missing: the sweep asks Twilio how the call ended and fetches the recording', async () => {
  twilio.behaviour.drop = ['dial-action', 'status:completed', 'recording:'];
  try {
    const mark = twilio.entries.length;
    const placed = (await priya.post('/phone/calls', { application_id: appDana })).body;
    await twilio.idle();
    const call = await until(() => phoneCallOf(priya, placed.id), (c) => c.status === 'ended');
    assert.equal(call.outcome, 'completed');
    assert.ok(restCalls(twilio, mark, /^GET .*\/Calls\/CA\w+\.json$/).length >= 1, 'Twilio was asked how the call stands');
    const { call: written } = await writtenOut(priya, placed.call_id);
    assert.equal(written.has_audio, true);
    assert.deepEqual(written.speakers, { 0: 'Priya Nair', 1: 'Dana Whitlock' });
  } finally {
    twilio.behaviour.drop = [];
  }
});

test('a recording that is not ready yet is fetched again, and a delete that fails is tried again', async () => {
  twilio.behaviour.downloadFailures = 2;
  twilio.behaviour.deleteFailures = 1;
  const mark = twilio.entries.length;
  const { placed } = await callAndWait(priya, { application_id: appDana });
  const { call: written } = await writtenOut(priya, placed.call_id);
  assert.equal(written.has_audio, true);
  const fetches = restCalls(twilio, mark, /^GET .*\/Recordings\/RE\w+\.wav/);
  assert.deepEqual(fetches.map((r) => r.status), [404, 404, 200]);
  const deletes = await until(async () => restCalls(twilio, mark, /^DELETE .*\/Recordings\//), (list) => list.some((r) => r.status === 204));
  assert.deepEqual(deletes.map((r) => r.status), [500, 204], 'the recording was kept at Twilio until it was safely here, and removed once it could be');
  const [row] = db('SELECT recording_state, recording_deleted_at FROM phone_calls WHERE id = ?', placed.id);
  assert.equal(row.recording_state, 'stored');
  assert.ok(row.recording_deleted_at);
});

test('a recording Twilio made with one channel is still kept, and transcribed the ordinary way', async () => {
  twilio.behaviour.mono = true;
  twilio.behaviour.monoReported = 2; // the webhook claims two channels; the download says otherwise
  try {
    const mark = twilio.entries.length, heard = deepgram.requests.length;
    const { placed } = await callAndWait(priya, { application_id: appDana });
    const { call: written } = await writtenOut(priya, placed.call_id);
    const fetches = restCalls(twilio, mark, /^GET .*\/Recordings\/RE\w+\.wav/);
    assert.deepEqual(fetches.map((r) => [r.status, /RequestedChannels=(\d)/.exec(r.path)[1]]), [[400, '2'], [200, '1']]);
    assert.equal((await priya.get(`/oracle/calls/${placed.call_id}/audio`)).body.readUInt16LE(22), 1);
    assert.equal(db('SELECT audio_channels FROM calls WHERE id = ?', placed.call_id)[0].audio_channels, 1);
    const [asked] = deepgram.requests.slice(heard);
    assert.ok(!('multichannel' in asked.query), 'one channel holds both people, so they are told apart by voice');
    assert.equal(asked.query.diarize_model, 'latest');
    assert.deepEqual(asked.problems, []);
    assert.equal(written.transcript.length, 4);
    await until(async () => restCalls(twilio, mark, /^DELETE .*\/Recordings\//), (list) => list.some((r) => r.status === 204));
  } finally {
    twilio.behaviour.mono = false;
    twilio.behaviour.monoReported = 1;
  }
});

test('a call Twilio made no recording of says so, whether or not Twilio tells us, and leaves nothing in the Oracle', async () => {
  twilio.behaviour.absent = true;
  try {
    const before = (await priya.get('/oracle/calls')).body.length;
    const told = await callAndWait(priya, { application_id: appDana });
    const settled = await until(() => phoneCallOf(priya, told.placed.id), (c) => /too short/.test(c.message));
    assert.equal(settled.message, 'You spoke to Dana for 15 sec. It was too short to record.');
    assert.equal(settled.recorded, false);
    assert.equal(settled.call_id, null);
    // The same when the word that there is no recording never arrives: Twilio is asked, and after a while the wait ends.
    twilio.behaviour.drop = ['recording:'];
    const untold = await callAndWait(priya, { application_id: appDana });
    assert.match(untold.call.message, /The recording is on its way to The Oracle\./);
    const gaveUp = await until(() => phoneCallOf(priya, untold.placed.id), (c) => /too short/.test(c.message));
    assert.equal(gaveUp.call_id, null);
    assert.equal((await priya.get(`/oracle/calls/${untold.placed.call_id}`)).status, 404);
    assert.equal((await priya.get('/oracle/calls')).body.length, before);
  } finally {
    twilio.behaviour.absent = false;
    twilio.behaviour.drop = [];
  }
});

test('the transcription service answering for one channel of a two-channel call: the words are kept, nobody is named by guesswork, and the recruiter is still told', async () => {
  deepgram.mode = 'mixed';
  anthropic.mode = 'busy'; // so that no notes are written, and with them no names
  const mailed = mail.sent.length;
  try {
    const { placed } = await callAndWait(priya, { application_id: appDana });
    const { call: written } = await writtenOut(priya, placed.call_id, false);
    assert.ok(written.transcript.length > 0);
    assert.deepEqual(written.speakers, {});
    assert.equal(written.notes, null);
    await until(async () => server.output(), (log) => log.includes(`Call ${placed.call_id}: its audio has two channels but the transcription service answered for 1`));
    const [message] = await until(async () => mail.sent.slice(mailed), (list) => list.length >= 1);
    assert.equal(message.subject, 'Your call with Dana Whitlock has been written out');
    assert.ok(message.text.includes(`${base}/oracle/${placed.call_id}`));
  } finally {
    deepgram.mode = null;
    anthropic.mode = null;
  }
});

test('a call deleted in the Oracle while it is still going: its recording is deleted from Twilio and never kept', async () => {
  const files = audioFiles().length, mark = twilio.entries.length;
  const placed = (await priya.post('/phone/calls', { to: N.talksOn })).body;
  await until(() => phoneCallOf(priya, placed.id), (c) => c.status === 'in_call');
  assert.equal((await priya.del(`/oracle/calls/${placed.call_id}`)).status, 200);
  await priya.post(`/phone/calls/${placed.id}/hangup`);
  const call = await until(() => phoneCallOf(priya, placed.id), (c) => c.status === 'ended' && /deleted/.test(c.message));
  assert.equal(call.message, 'You spoke to (613) 555-0117 for 12 sec. The recording was deleted.');
  assert.equal(call.recorded, false);
  assert.equal(call.call_id, null);
  await until(async () => restCalls(twilio, mark, /^DELETE .*\/Recordings\//), (list) => list.some((r) => r.status === 204));
  assert.equal(restCalls(twilio, mark, /^GET .*\/Recordings\/RE\w+\.wav/).length, 0, 'the audio was never fetched');
  assert.equal(audioFiles().length, files);
  await twilio.idle();
});

test('numbers that may not be called are refused before Twilio is asked for anything', async () => {
  const mark = twilio.entries.length;
  const refused = async (body, pattern) => {
    const res = await priya.post('/phone/calls', body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match(res.body.error, pattern);
  };
  await refused({ to: '+1 876 555 0199' }, /outside the countries this workspace can call \(CA, US\)/);       // Jamaica shares +1
  await refused({ to: '1-900-555-0199' }, /premium-rate, toll-free or other special number/);
  await refused({ to: '(800) 555-0199' }, /premium-rate, toll-free or other special number/);
  await refused({ to: '+1 787 555 0199' }, /outside the countries/);                                         // Puerto Rico
  await refused({ to: '+44 20 7946 0000' }, /outside the countries/);
  await refused({ to: '07700 900123' }, /could not be understood/);
  await refused({ to: '555-0199' }, /could not be understood/);
  await refused({ to: '1 (416) FLOWERS' }, /could not be understood/);
  await refused({ to: '(647) 555-0100' }, /The Book's own number/);
  await refused({ to: N.priya }, /your own mobile number/);
  await refused({}, /Choose somebody to call, or type a number/);
  await refused({ application_id: appDana, record: 'no' }, /record must be true or false/);
  await refused({ application_id: appDana, event_key: 'not a key!' }, /calendar event/);
  assert.equal((await priya.post('/phone/calls', { application_id: 999999 })).status, 404);
  const noPhone = (await admin.upload('/applications', { job_id: (await admin.get(`/applications/${appDana}`)).body.job.id, name: 'Noor Haddad', email: 'noor@mail.example' })).body.id;
  await refused({ application_id: noPhone }, /^Noor Haddad has no phone number on their profile\.$/);
  // Somebody with no mobile saved has no phone for The Book to ring.
  assert.equal((await savePhone(sam, '')).status, 200);
  const noMobile = await sam.post('/phone/calls', { application_id: appDana });
  assert.equal(noMobile.status, 400);
  assert.match(noMobile.body.error, /Save your own mobile number first/);
  assert.equal(restCalls(twilio, mark).length, 0, 'Twilio heard nothing about any of these');

  // The same rules guard the mobile a person saves, since that is a phone The Book rings too.
  for (const [phone, pattern] of [['+1 876 555 0199', /outside the countries/], ['1-900-555-0199', /special number/], ['12345', /Your mobile number could not be understood/], [N.priya, /already saved as somebody else's mobile/], [BOOK_NUMBER, /The Book's own number/]]) {
    const res = await savePhone(sam, phone);
    assert.equal(res.status, 400, phone);
    assert.match(res.body.error, pattern);
  }
  for (const pin of ['12', '1234567', 'abcd', '1111', '1234', '654321']) assert.equal((await savePhone(sam, N.sam, pin)).status, 400, `PIN ${pin}`);
  assert.deepEqual((await savePhone(sam, '1 (647) 555-0143', '7305')).body, { my_phone: N.sam, my_pin_set: true });
  assert.deepEqual((await savePhone(sam, N.sam, '')).body, { my_phone: N.sam, my_pin_set: false });
  assert.deepEqual((await savePhone(sam, '')).body, { my_phone: null, my_pin_set: false });
});

test('Twilio refusing to start a call is said plainly, and leaves nothing behind', async () => {
  const before = (await priya.get('/oracle/calls')).body.length;
  for (const [mobile, status, pattern] of [
    ['613 555 0002', 502, /switched off on the phone service account/],
    ['613 555 0001', 400, /could not ring your mobile\. Check the number you saved/],
    ['613 555 0003', 502, /still on a trial/],
    ['613 555 0005', 502, /account is not active/],
  ]) {
    assert.equal((await savePhone(priya, mobile)).status, 200);
    const res = await priya.post('/phone/calls', { application_id: appDana });
    assert.equal(res.status, status, mobile);
    assert.match(res.body.error, pattern);
  }
  assert.equal((await savePhone(priya, N.priya)).status, 200);
  assert.equal((await priya.get('/oracle/calls')).body.length, before);
  const [last] = (await priya.get('/phone/calls?limit=1')).body;
  assert.equal(last.status, 'failed');
  assert.match(last.message, /account is not active/);
  // A failed start does not count as a call under way.
  assert.equal((await callAndWait(priya, { to: N.busy })).call.outcome, 'busy');
});

test('finding somebody to call, by name or by the digits of their number', async () => {
  const byName = (await priya.get('/phone/lookup?q=dana')).body;
  assert.deepEqual(byName, [{
    candidate_id: byName[0].candidate_id, name: 'Dana Whitlock', photo: null, phone: N.dana, phone_display: '(416) 555-0123',
    applications: [{ id: appDana, job_title: 'Head of Sales', client_name: 'Kestrel Logistics', status: 'active' }],
  }]);
  assert.deepEqual((await priya.get(`/phone/lookup?q=${encodeURIComponent('555-0124')}`)).body.map((c) => c.name), ['Jonas Brandt']);
  assert.deepEqual((await priya.get(`/phone/lookup?q=${encodeURIComponent('(416) 555')}`)).body.map((c) => c.name), ['Dana Whitlock', 'Jonas Brandt']);
  assert.deepEqual((await priya.get(`/phone/lookup?q=${encodeURIComponent('1 416 555 0123')}`)).body.map((c) => c.name), ['Dana Whitlock']);
  assert.deepEqual((await priya.get('/phone/lookup?q=d')).body, [], 'one letter is not enough to search on');
  assert.deepEqual((await priya.get('/phone/lookup?q=noor')).body, [], 'somebody with no number cannot be called');
  assert.deepEqual((await priya.get(`/phone/lookup?q=${encodeURIComponent('%')}`)).body, []);
});

test('a call made from a calendar event carries the event\'s key into the Oracle', async () => {
  const { placed } = await callAndWait(priya, { application_id: appDana, event_key: 'evt_2026-11-10.abc~1' });
  await writtenOut(priya, placed.call_id);
  assert.equal(db('SELECT event_key FROM calls WHERE id = ?', placed.call_id)[0].event_key, 'evt_2026-11-10.abc~1');
});

test('a phone call placed from an event in the day is shown on that event, and comes off it again if nobody is reached', async () => {
  // One of The Book's own interviews, an hour from now: it is in Priya's day whether or not she has a calendar connected.
  const soon = new Date(Date.now() + 3600000);
  const tz = 'America/Toronto';
  const dayOf = soon.toLocaleDateString('en-CA', { timeZone: tz });
  for (const application_id of [appDana, appKevin]) {
    assert.equal((await priya.post('/interviews', { application_id, title: 'Recruiter screen', kind: 'phone', starts_at: soon.toISOString(), duration_min: 30 })).status, 200);
  }
  const eventFor = async (name) => (await priya.get(`/calendar/day?date=${dayOf}&tz=${encodeURIComponent(tz)}`)).body.events.find((e) => e.source === 'interview' && e.match.name === name);
  const dana = await eventFor('Dana Whitlock');
  assert.equal(dana.call_id, null);

  const { placed } = await callAndWait(priya, { application_id: appDana, event_key: dana.key });
  assert.equal((await eventFor('Dana Whitlock')).call_id, placed.call_id, 'the event reports the call made for it');
  await writtenOut(priya, placed.call_id);
  assert.equal((await eventFor('Dana Whitlock')).call_id, placed.call_id);

  // Kevin's phone is always busy: the call made for his event leaves nothing in the Oracle, and nothing on the event.
  const kevin = await eventFor('Kevin Asante');
  const { placed: tried, call } = await callAndWait(priya, { application_id: appKevin, event_key: kevin.key });
  assert.equal(call.outcome, 'busy');
  assert.equal((await priya.get(`/oracle/calls/${tried.call_id}`)).status, 404);
  assert.equal((await eventFor('Kevin Asante')).call_id, null);

  // Somebody else's key ties nothing: the call is still placed, and Priya's event is untouched.
  assert.equal((await savePhone(sam, N.sam)).status, 200);
  const { placed: other } = await callAndWait(sam, { application_id: appJonas, event_key: dana.key });
  await writtenOut(sam, other.call_id);
  assert.equal((await eventFor('Dana Whitlock')).call_id, placed.call_id);
});

test('a client user is refused on every phone route, a visitor is asked to sign in, and nothing about calls shows to a client', async () => {
  const { placed } = await callAndWait(priya, { application_id: appDana });
  await writtenOut(priya, placed.call_id);
  const visitor = session(base);
  const mark = twilio.entries.length;
  for (const [method, route, payload] of [
    ['get', '/phone/status'], ['get', '/phone/lookup?q=dana'], ['get', '/phone/calls'], ['get', `/phone/calls/${placed.id}`],
    ['post', '/phone/calls', { application_id: appDana }], ['post', '/phone/calls', { to: N.dana }], ['post', `/phone/calls/${placed.id}/hangup`],
  ]) {
    const refused = await maya[method](route, payload);
    assert.equal(refused.status, 403, `${method} ${route} as a client user`);
    assert.equal(refused.body.error, 'Only the agency team can do this.');
    assert.equal((await visitor[method](route, payload)).status, 401, `${method} ${route} signed out`);
  }
  const saving = await putJson(maya, base, '/me/phone', { phone: '416 555 0199', pin: '7305' });
  assert.equal(saving.status, 403);
  assert.equal(db(`SELECT phone FROM users WHERE email = 'maya@kestrel.example'`)[0].phone, null);
  assert.equal(restCalls(twilio, mark).length, 0);
  // The candidate as the client sees them: no call on their history, no number of ours, no transcript.
  const seen = JSON.stringify((await maya.get(`/applications/${appDana}`)).body);
  assert.ok((await activities(priya, appDana)).length >= 1);
  assert.deepEqual(await activities(maya, appDana), []);
  assert.ok(!/Phone call|Voicemail|Varsity Freight/.test(seen));
  assert.ok(!/Phone call|Voicemail/.test(JSON.stringify((await maya.get('/dashboard')).body)));
  assert.ok((await priya.get('/dashboard')).body.recent.some((a) => a.type === 'call'));
  assert.equal((await maya.get(`/oracle/calls/${placed.call_id}`)).status, 403);
});

test('deleting a candidate deletes their phone calls, the audio and what Twilio told us about them', async () => {
  const jobId = (await admin.get(`/applications/${appDana}`)).body.job.id;
  const appId = (await admin.upload('/applications', { job_id: jobId, name: 'Tara Quigley', email: 'tara@mail.example', phone: '289 555 0166' })).body.id;
  const candidateId = (await admin.get(`/applications/${appId}`)).body.candidate.id;
  const recorded = await callAndWait(priya, { application_id: appId });
  await writtenOut(priya, recorded.placed.call_id);
  const unrecorded = await callAndWait(priya, { candidate_id: candidateId, record: false });
  assert.equal(unrecorded.call.candidate_name, 'Tara Quigley');
  await ringIn(twilio, base, '+12895550166');
  const [incoming] = await until(async () => (await priya.get('/phone/calls?limit=1')).body, (list) => list[0].direction === 'inbound' && list[0].call_id && /in The Oracle/.test(list[0].message));
  await writtenOut(priya, incoming.call_id);
  const file = db('SELECT audio_file FROM calls WHERE id = ?', recorded.placed.call_id)[0].audio_file;
  assert.ok(fs.existsSync(path.join(dataDir, 'uploads', file)));
  assert.equal(db('SELECT COUNT(*) AS n FROM phone_calls WHERE candidate_id = ?', candidateId)[0].n, 3);
  assert.ok(db('SELECT COUNT(*) AS n FROM phone_webhooks w JOIN phone_calls p ON p.id = w.phone_call_id WHERE p.candidate_id = ?', candidateId)[0].n > 5);
  const files = audioFiles().length;

  assert.equal((await admin.del(`/candidates/${candidateId}`)).status, 200);
  for (const id of [recorded.placed.id, unrecorded.placed.id, incoming.id]) assert.equal((await priya.get(`/phone/calls/${id}`)).status, 404);
  assert.equal((await priya.get(`/oracle/calls/${recorded.placed.call_id}`)).status, 404);
  assert.equal((await priya.get(`/oracle/calls/${incoming.call_id}`)).status, 404);
  assert.equal(db(`SELECT COUNT(*) AS n FROM phone_calls WHERE to_number = '+12895550166'`)[0].n, 0, 'their number is nowhere in the list of phone calls');
  assert.equal(db('SELECT COUNT(*) AS n FROM phone_webhooks WHERE phone_call_id IN (?, ?, ?)', recorded.placed.id, unrecorded.placed.id, incoming.id)[0].n, 0);
  await until(async () => audioFiles().length, (n) => n === files - 2);
  assert.ok(!fs.existsSync(path.join(dataDir, 'uploads', file)));
});

test('a candidate erased while a call with them is still going: the recording is deleted from Twilio when it arrives, and nothing is kept', async () => {
  const jobId = (await admin.get(`/applications/${appDana}`)).body.job.id;
  const appId = (await admin.upload('/applications', { job_id: jobId, name: 'Uma Thackeray', email: 'uma@mail.example', phone: '613 555 0117' })).body.id;
  const candidateId = (await admin.get(`/applications/${appId}`)).body.candidate.id;
  const files = audioFiles().length, mark = twilio.entries.length;
  const placed = (await priya.post('/phone/calls', { application_id: appId })).body;
  await until(() => phoneCallOf(priya, placed.id), (c) => c.status === 'in_call');
  assert.equal((await admin.del(`/candidates/${candidateId}`)).status, 200);
  assert.equal((await priya.get(`/phone/calls/${placed.id}`)).status, 404);
  // The call is still going at Twilio, which knows nothing of this. End it the way the other person hanging up would.
  const [live] = [...twilio.calls.values()].filter((c) => c.live && c.direction === 'outbound-api');
  await fetch(`${twilio.baseUrl}/2010-04-01/Accounts/${twilio.config.accountSid}/Calls/${live.sid}.json`, {
    method: 'POST', body: new URLSearchParams({ Status: 'completed' }),
    headers: { Authorization: `Basic ${Buffer.from(`${twilio.config.accountSid}:${twilio.config.authToken}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  await twilio.idle();
  await until(async () => restCalls(twilio, mark, /^DELETE .*\/Recordings\//), (list) => list.some((r) => r.status === 204));
  assert.equal(restCalls(twilio, mark, /^GET .*\/Recordings\/RE\w+\.wav/).length, 0, 'the audio was never fetched');
  assert.equal(audioFiles().length, files);
  assert.equal((await priya.get(`/oracle/calls/${placed.call_id}`)).status, 404);
  assert.equal(db(`SELECT COUNT(*) AS n FROM phone_calls WHERE to_number = '+16135550117' AND candidate_id IS NOT NULL`)[0].n, 0);
});

test('two records merged into one person keep their phone calls, and somebody deactivated can no longer ring in', async () => {
  const jobId = (await admin.get(`/applications/${appDana}`)).body.job.id;
  const otherJob = (await admin.post('/jobs', { client_id: (await admin.get(`/applications/${appDana}`)).body.client.id, title: 'Sales Manager', status: 'open' })).body.id;
  const first = (await admin.upload('/applications', { job_id: jobId, name: 'Wren Okafor', email: 'wren@mail.example', phone: '437 555 0155' })).body.id;
  const second = (await admin.upload('/applications', { job_id: otherJob, name: 'Wren Okafor', email: 'wren.okafor@mail.example' })).body.id;
  const fromId = (await admin.get(`/applications/${first}`)).body.candidate.id, intoId = (await admin.get(`/applications/${second}`)).body.candidate.id;
  assert.notEqual(fromId, intoId);
  const { placed } = await callAndWait(priya, { application_id: first, record: false });
  assert.equal((await admin.post(`/candidates/${fromId}/merge`, { into: intoId })).status, 200);
  assert.equal(db('SELECT candidate_id FROM phone_calls WHERE id = ?', placed.id)[0].candidate_id, intoId);
  assert.equal((await phoneCallOf(priya, placed.id)).candidate_name, 'Wren Okafor');

  // Sam has a mobile and a PIN saved, then is deactivated: their phone is just a caller now, not a way in.
  assert.equal((await savePhone(sam, N.sam, '7305')).status, 200);
  const samId = (await admin.get('/users')).body.find((u) => u.email === 'sam@agency.example').id;
  assert.equal((await admin.patch(`/users/${samId}`, { active: false })).status, 200);
  const mark = twilio.entries.length;
  await ringIn(twilio, base, N.sam, ['7305', '4165550123']);
  const answer = webhooks(twilio, mark, 'voice-url')[0].response;
  assert.ok(!/PIN/.test(answer), 'no PIN is asked for');
  assert.match(answer, /Thanks for calling Harbour Talent\./, 'they are greeted like any caller');
  assert.equal(webhooks(twilio, mark, 'gather-action').length, 0);
  await twilio.idle();
});

test('what Twilio told us is kept with numbers and keys masked', async () => {
  const kept = db('SELECT kind, params FROM phone_webhooks').map((row) => `${row.kind} ${row.params}`).join('\n');
  assert.ok(kept.length > 1000);
  assert.match(kept, /"DialCallStatus":"completed"/);
  for (const secret of [PIN, ...Object.values(N), BOOK_NUMBER]) assert.ok(!kept.includes(secret), `${secret} is not kept`);
  assert.match(kept, /"Digits":"\(4 keys\)"/);
  assert.match(kept, /"From":"\+1 \(number ending \d\d\)"/);
});

test('with phone calls not connected, everything says so and nothing else breaks', async () => {
  const dir = tempDir('phone-bare');
  const bare = await startServer({ port: PHONE_PORTS.bare, dataDir: dir });
  try {
    const owner = session(bare.base);
    assert.equal((await owner.post('/setup', { agencyName: 'Bare', name: 'Alex Morgan', email: 'alex@agency.example', password: 'demo1234' })).status, 200);
    assert.deepEqual((await owner.get('/phone/status')).body, {
      configured: false, number: null, number_display: null, my_phone: null, my_pin_set: false, notice: true, countries: ['CA', 'US'],
      missing: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_NUMBER', 'APP_URL'],
      problem: 'TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_NUMBER are not set, and neither is APP_URL, the public address of The Book.', webhooks: null,
    });
    // A mobile can be saved ahead of time.
    assert.deepEqual((await savePhone(owner, '416 555 0199', '7305', bare.base)).body, { my_phone: '+14165550199', my_pin_set: true });
    const refused = await owner.post('/phone/calls', { to: N.dana });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.error, 'Phone calls are not connected to this workspace yet. Ask whoever hosts The Book to add the Twilio settings.');
    assert.deepEqual((await owner.get('/phone/calls')).body, []);
    // Nobody can talk to the webhook routes of a workspace with no phone service: there is no secret to sign with.
    const res = await fetch(`${bare.base}/api/phone/twilio/inbound`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': twilioSignature('', `${bare.base}/api/phone/twilio/inbound`, {}) }, body: '' });
    assert.equal(res.status, 403);
    assert.deepEqual((await owner.get('/oracle/calls')).body, []);
  } finally {
    await bare.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('calls placed in an hour are limited for each person, from the app and from the switchboard, and a restart does not lose a recording', async () => {
  const dir = tempDir('phone-limits');
  // ORACLE_STREAM_BYTES: audio above this size is sent to be transcribed straight from the disk, as an hour-long call is.
  const env = connected(PHONE_PORTS.limits, { PHONE_CALLS_PER_HOUR: '3', PHONE_NOTICE: 'off', ORACLE_STREAM_BYTES: '1000', PHONE_FORWARD_SHOWS: 'caller' });
  let limited = await startServer({ port: PHONE_PORTS.limits, dataDir: dir, env });
  try {
    const owner = session(limited.base);
    assert.equal((await owner.post('/setup', { agencyName: 'Limits', name: 'Alex Morgan', email: 'alex@agency.example', password: 'demo1234' })).status, 200);
    assert.equal((await savePhone(owner, N.alex, PIN, limited.base)).status, 200);
    const place = async (body) => {
      const placed = await owner.post('/phone/calls', body);
      if (placed.status !== 201) return placed;
      await twilio.idle();
      await until(async () => (await owner.get(`/phone/calls/${placed.body.id}`)).body, (c) => c.status === 'ended' || c.status === 'failed');
      return placed;
    };
    assert.equal((await owner.get('/phone/status')).body.notice, false);

    // With the notice switched off, the person called hears nothing first, and the call's record says so.
    let mark = twilio.entries.length;
    const heard = deepgram.requests.length;
    const first = await place({ to: N.dana });
    assert.equal(first.status, 201);
    assert.match(webhooks(twilio, mark, 'number-url')[0].response, /<Response><\/Response>/);
    const written = await until(async () => (await owner.get(`/oracle/calls/${first.body.call_id}`)).body, (d) => d.call?.status === 'ready');
    assert.match(written.call.consent_wording, /The Book played no recorded-call notice on this call/);
    const [asked1] = deepgram.requests.slice(heard);
    assert.equal(asked1.bytes, 384044, 'the whole file arrived although it was sent from the disk');
    assert.equal(asked1.contentLength, 384044);
    assert.deepEqual(asked1.problems, []);

    assert.equal((await place({ to: N.busy })).status, 201);
    // The third is placed, and its recording cannot be fetched before the server is stopped.
    twilio.behaviour.downloadFailures = 1000;
    const third = await place({ to: N.jonas });
    assert.equal(third.status, 201);
    await until(async () => restCalls(twilio, mark, /^GET .*\/Recordings\/RE\w+\.wav/), (list) => list.length >= 2);

    const fourth = await owner.post('/phone/calls', { to: N.dana });
    assert.equal(fourth.status, 429);
    assert.equal(fourth.body.error, 'That is 3 calls in an hour, which is the most one person can place. Try again a little later.');
    mark = twilio.entries.length;
    await ringIn(twilio, limited.base, N.alex, [PIN, '4165550123']);
    const asked = webhooks(twilio, mark, 'gather-action');
    assert.match(asked[1].response, /That is 3 calls in an hour, which is the most one person can place\. Try again a little later\. Goodbye\./);
    assert.ok(!webhooks(twilio, mark).some((hook) => /<Dial/.test(hook.response || '')));

    // This workspace is set to show a caller's own number when they are put through, and plays them no notice.
    mark = twilio.entries.length;
    await ringIn(twilio, limited.base, N.stranger);
    const forwarded = webhooks(twilio, mark, 'voice-url')[0].response;
    assert.match(forwarded, /<Say>Thanks for calling Limits\.<\/Say><Dial answerOnBridge="true"/, 'no callerId, so Twilio passes the caller\'s number on');
    assert.ok(!/callerId|recorded and transcribed/.test(forwarded));
    assert.deepEqual(complaints(twilio, mark), []);

    // Pull the plug, let the recording become fetchable, and start again: the count of calls and the recording both survive.
    await limited.stop('SIGKILL');
    twilio.behaviour.downloadFailures = 0;
    limited = await startServer({ port: PHONE_PORTS.limits, dataDir: dir, env });
    assert.equal((await owner.post('/phone/calls', { to: N.dana })).status, 429, 'the hourly count is kept in the database');
    const recovered = await until(async () => (await owner.get(`/oracle/calls/${third.body.call_id}`)).body, (d) => d.call?.status === 'ready');
    assert.equal(recovered.call.has_audio, true);
    assert.equal(recovered.call.phone_display, '(416) 555-0124');
    // Calls coming in from one number are put through ten times in an hour; after that the caller gets a busy tone
    // without the call being answered, so nobody can keep a recruiter's phone ringing or run up the bill that way.
    for (let n = 1; n < 10; n++) await ringIn(twilio, limited.base, N.stranger);
    mark = twilio.entries.length;
    await ringIn(twilio, limited.base, N.stranger);
    assert.match(webhooks(twilio, mark, 'voice-url')[0].response, /<Response><Reject reason="busy"\/><\/Response>/);
    assert.equal(webhooks(twilio, mark).length, 2, 'the request for instructions and the news that the call ended: nobody was rung');
    await until(async () => [...twilio.recordings.values()].filter((rec) => rec.status === 'completed' && !rec.deleted).length, (n) => n === 0);
  } finally {
    twilio.behaviour.downloadFailures = 0;
    await limited.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- what the reviews of the first version found ----------
/** Change the server's database directly, for states no route leads to quickly (a lock that has run out, an old message). */
function dbRun(query, ...params) {
  const database = new DatabaseSync(path.join(dataDir, 'app.db'), { timeout: 5000 });
  try { return database.prepare(query).run(...params); } finally { database.close(); }
}
/** Finished recordings the stand-in still holds: what would be sitting at Twilio. */
const recordingsLeft = () => [...twilio.recordings.values()].filter((rec) => rec.status === 'completed' && !rec.deleted).length;
const newCandidate = async (name, email, phone) => {
  const jobId = (await admin.get(`/applications/${appDana}`)).body.job.id;
  const appId = (await admin.upload('/applications', { job_id: jobId, name, email, phone })).body.id;
  return { appId, candidateId: (await admin.get(`/applications/${appId}`)).body.candidate.id };
};

test('a candidate erased while their recording is still waiting to be fetched, or while Twilio still holds a copy: the recording is deleted from Twilio all the same', async () => {
  await twilio.idle();
  await until(async () => recordingsLeft(), (n) => n === 0);
  // 1. The recording is ready, but the phone service keeps answering "not found" for the audio when the person is erased.
  const first = await newCandidate('Vera Lindqvist', 'vera@mail.example', '289 555 0171');
  twilio.behaviour.downloadFailures = 1000;
  try {
    const { placed } = await callAndWait(priya, { application_id: first.appId });
    await until(async () => db('SELECT recording_state, recording_tries FROM phone_calls WHERE id = ?', placed.id)[0], (row) => row.recording_tries >= 1);
    assert.equal(recordingsLeft(), 1);
    assert.equal((await admin.del(`/candidates/${first.candidateId}`)).status, 200);
    assert.equal(db('SELECT COUNT(*) AS n FROM phone_calls WHERE id = ?', placed.id)[0].n, 0);
    await until(async () => recordingsLeft(), (n) => n === 0);
  } finally {
    twilio.behaviour.downloadFailures = 0;
  }
  // 2. The audio is on our disk, but deleting Twilio's copy keeps failing when the person is erased.
  const second = await newCandidate('Wim Achterberg', 'wim@mail.example', '289 555 0172');
  twilio.behaviour.deleteFailures = 1000;
  try {
    const { placed } = await callAndWait(priya, { application_id: second.appId });
    await writtenOut(priya, placed.call_id);
    assert.equal(recordingsLeft(), 1, 'Twilio still has its copy');
    assert.equal((await admin.del(`/candidates/${second.candidateId}`)).status, 200);
    await sleep(400);
    assert.equal(recordingsLeft(), 1);
    assert.equal(db('SELECT COUNT(*) AS n FROM phone_recordings_owed')[0].n, 1, 'what is still owed is remembered without the call');
    twilio.behaviour.deleteFailures = 0;
    await until(async () => recordingsLeft(), (n) => n === 0);
    await until(async () => db('SELECT COUNT(*) AS n FROM phone_recordings_owed')[0].n, (n) => n === 0);
  } finally {
    twilio.behaviour.deleteFailures = 0;
  }
  // 3. Erased with the recording still to come, and the news that it is ready never arrives.
  const third = await newCandidate('Xavier Oyelaran', 'xavier@mail.example', '289 555 0173');
  twilio.behaviour.drop = ['recording:'];
  try {
    const placed = (await priya.post('/phone/calls', { application_id: third.appId })).body;
    await twilio.idle();
    await until(() => phoneCallOf(priya, placed.id), (c) => c.status === 'ended');
    assert.equal(recordingsLeft(), 1);
    assert.equal((await admin.del(`/candidates/${third.candidateId}`)).status, 200);
    await until(async () => recordingsLeft(), (n) => n === 0);
    await until(async () => db('SELECT COUNT(*) AS n FROM phone_calls_erased')[0].n, (n) => n === 0);
  } finally {
    twilio.behaviour.drop = [];
  }
  assert.ok(!/RE[0-9a-f]{32}|CA[0-9a-f]{32}/.test(server.output()), 'the phone service\'s names for calls and recordings are not logged either');
});

test('the transcription service being busy does not lose a phone call\'s transcript: it is tried again by itself, and the recruiter is told when it cannot be written out at all', async () => {
  const mailed = mail.sent.length, heard = deepgram.requests.length;
  deepgram.mode = 'busy';
  try {
    const { placed, call } = await callAndWait(priya, { application_id: appDana });
    assert.equal(call.outcome, 'completed');
    // Three requests a few moments apart all answer "busy". The call is not failed: it waits and goes again.
    await until(async () => deepgram.requests.slice(heard), (list) => list.length >= 4);
    assert.equal((await oracleCall(priya, placed.call_id)).call.status, 'transcribing');
    assert.equal(mail.sent.length, mailed);
    deepgram.mode = null;
    const { call: written } = await writtenOut(priya, placed.call_id);
    assert.equal(written.error, null);
    const [message] = await until(async () => mail.sent.slice(mailed), (list) => list.length >= 1);
    assert.equal(message.subject, 'Your call notes for Dana Whitlock are ready');
    assert.deepEqual({ ...db('SELECT transcribe_tries, transcribe_next_at FROM calls WHERE id = ?', placed.call_id)[0] }, { transcribe_tries: 0, transcribe_next_at: null });
  } finally {
    deepgram.mode = null;
  }
  // Audio the service cannot read at all is not worth trying again: the recruiter is told once, with the reason.
  const before = mail.sent.length;
  deepgram.mode = 'corrupt';
  try {
    const { placed } = await callAndWait(priya, { application_id: appDana });
    const failed = await until(() => oracleCall(priya, placed.call_id), (d) => d.call?.status === 'failed');
    assert.equal(failed.call.has_audio, true);
    const [message] = await until(async () => mail.sent.slice(before), (list) => list.length >= 1);
    assert.deepEqual(message.to, ['priya@agency.example']);
    assert.equal(message.subject, 'Your call with Dana Whitlock could not be written out');
    assert.match(message.text, /was recorded, but it could not be written out:/);
    assert.match(message.text, /The recording is safe\./);
    assert.ok(message.text.includes(`${base}/oracle/${placed.call_id}`));
    await sleep(400);
    assert.equal(mail.sent.length, before + 1, 'told once');
  } finally {
    deepgram.mode = null;
  }
});

test('the "notes are ready" e-mail is sent again when the mail provider fails, and only marked as sent once it is', async () => {
  const mailed = mail.sent.length;
  mail.failures = 2;
  mail.refused = 0;
  try {
    const { placed } = await callAndWait(priya, { application_id: appJonas });
    await writtenOut(priya, placed.call_id);
    const [message] = await until(async () => mail.sent.slice(mailed), (list) => list.length >= 1);
    assert.equal(mail.refused, 2, 'two tries were refused first');
    assert.equal(message.subject, 'Your call notes for Jonas Brandt are ready');
    await until(async () => db('SELECT notified_at FROM calls WHERE id = ?', placed.call_id)[0], (row) => row.notified_at);
    await sleep(400);
    assert.equal(mail.sent.length, mailed + 1, 'and it is not sent twice');
  } finally {
    mail.failures = 0;
  }
});

test('news that a call ended overtaking how ringing the other person went: the call says what happened, is not shown as recorded, and leaves nothing in the Oracle', async () => {
  await twilio.idle();
  const sidOf = (id) => db('SELECT call_sid FROM phone_calls WHERE id = ?', id)[0].call_sid;
  // The stand-in is silenced, and Twilio's messages are sent by hand in the order that went wrong.
  twilio.behaviour.drop = [''];
  try {
    for (const variant of ['late', 'never']) {
      const placed = (await priya.post('/phone/calls', { application_id: appKevin })).body;
      assert.ok(placed.call_id);
      await twilio.idle();
      const c = `c=${placed.id}`, CallSid = sidOf(placed.id);
      assert.equal((await webhook(`voice?${c}`, { CallSid, CallStatus: 'in-progress' })).status, 200);
      assert.match((await webhook(`connect?${c}&n=1`, { CallSid, Digits: '1' })).text, /<Dial /);
      assert.equal((await phoneCallOf(priya, placed.id)).status, 'calling_them');
      assert.equal((await webhook(`status?${c}`, { CallSid, CallStatus: 'completed', CallDuration: '9' })).status, 204);
      if (variant === 'late') {
        // The answer to "how did ringing them go" arrives after all.
        const said = await webhook(`dial-done?${c}`, { CallSid, DialCallStatus: 'busy' });
        assert.match(said.text, /Kevin&apos;s phone was busy\./);
        const call = await phoneCallOf(priya, placed.id);
        assert.deepEqual([call.status, call.outcome, call.message, call.recorded], ['ended', 'busy', 'Kevin\'s phone was busy.', false]);
      } else {
        // It never arrives: Twilio is asked, and says the other phone was never reached.
        const call = await until(() => phoneCallOf(priya, placed.id), (c2) => c2.outcome && c2.outcome !== 'no_answer');
        assert.deepEqual([call.status, call.outcome, call.message, call.recorded], ['ended', 'cancelled', 'The call was cancelled.', false]);
      }
      assert.equal((await priya.get(`/oracle/calls/${placed.call_id}`)).status, 404, 'no entry is left waiting for a recording');
      assert.equal(db('SELECT recording_state FROM phone_calls WHERE id = ?', placed.id)[0].recording_state, null);
    }
  } finally {
    twilio.behaviour.drop = [];
  }
});

test('hanging up a call Twilio has already ended closes it, and does not say the phone service failed', async () => {
  twilio.behaviour.drop = ['status:completed', 'dial-action', 'recording:'];
  twilio.behaviour.hangupRefused = true;
  try {
    const placed = (await priya.post('/phone/calls', { to: N.dana, record: false })).body;
    await twilio.idle(); // over at Twilio; nothing told us
    assert.equal((await phoneCallOf(priya, placed.id)).status, 'in_call');
    const hung = await priya.post(`/phone/calls/${placed.id}/hangup`);
    assert.equal(hung.status, 200, JSON.stringify(hung.body));
    const call = await phoneCallOf(priya, placed.id);
    assert.deepEqual([call.status, call.outcome], ['ended', 'completed']);
  } finally {
    twilio.behaviour.drop = [];
    twilio.behaviour.hangupRefused = false;
  }
});

test('Twilio answering "not found" instead of "bad request" for two channels of a one-channel recording: the one channel is fetched', async () => {
  const mark = twilio.entries.length;
  Object.assign(twilio.behaviour, { mono: true, monoReported: 0, monoRefusal: 404 }); // the news that it is ready does not say how many channels
  try {
    const { placed } = await callAndWait(priya, { application_id: appDana });
    const { call: written } = await writtenOut(priya, placed.call_id, false);
    assert.equal(written.has_audio, true);
    const asked = restCalls(twilio, mark, /^GET .*\/Recordings\/RE\w+\.wav/).map((r) => `${/RequestedChannels=(\d)/.exec(r.path)[1]}:${r.status}`);
    assert.deepEqual(asked, ['2:404', '2:404', '2:404', '1:200'], 'two channels a few times, in case it was only not ready yet, then one');
    await until(async () => recordingsLeft(), (n) => n === 0);
  } finally {
    Object.assign(twilio.behaviour, { mono: false, monoReported: 1, monoRefusal: 400 });
  }
});

test('the switchboard: a mistyped number is answered in words for a keypad, a second call at once is refused, and keys that are not a PIN end the call after three asks', async () => {
  let mark = twilio.entries.length;
  await ringIn(twilio, base, N.priya, [PIN, '5550159', '5550159', '5550159']);
  let asked = webhooks(twilio, mark, 'gather-action');
  assert.match(asked[1].response, /<Say>That number was not understood\. Key in the area code and the number, ten digits, then press hash\. Enter the number to call/);
  assert.ok(!/Write it|\(416\)/.test(asked.map((a) => a.response).join(' ')), 'nothing written for a screen is read out');
  assert.match(asked[3].response, /Goodbye\.<\/Say><Hangup\/>/);

  // "*" then "#" is not a wrong PIN, but it is an ask: three and the call is over.
  mark = twilio.entries.length;
  await ringIn(twilio, base, N.priya, ['*', '*', '*', '*', '*']);
  asked = webhooks(twilio, mark, 'gather-action');
  assert.equal(asked.length, 3);
  assert.match(asked[2].response, /<Say>No PIN was entered\. Goodbye\.<\/Say><Hangup\/>/);
  assert.equal(db(`SELECT phone_pin_fails FROM users WHERE email = 'priya@agency.example'`)[0].phone_pin_fails, 0, 'none of that counted as a wrong PIN');

  // With a call placed from the app still under way, ringing in gets as far as the number and is then refused.
  const placed = (await priya.post('/phone/calls', { to: N.talksOn, record: false })).body;
  await until(() => phoneCallOf(priya, placed.id), (c) => c.status === 'in_call');
  mark = twilio.entries.length;
  const rang = fetch(`${twilio.baseUrl}/_standin/inbound`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: N.priya, digits: [PIN, '4165550124'], voiceUrl: `${base}/api/phone/twilio/inbound`, statusCallback: `${base}/api/phone/twilio/status` }) });
  assert.equal((await rang).status, 201);
  asked = await until(async () => webhooks(twilio, mark, 'gather-action'), (list) => list.length >= 2);
  assert.match(asked[1].response, /<Say>You already have a call under way\. Hang up first, or wait for it to end\. Goodbye\.<\/Say><Hangup\/>/);
  assert.ok(!webhooks(twilio, mark).some((hook) => /<Dial/.test(hook.response || '')));
  assert.equal((await priya.post(`/phone/calls/${placed.id}/hangup`)).status, 200);
  await twilio.idle();
});

test('wrong PINs: each lock is longer than the last, and ten in a day switch the PIN off until a new one is chosen', async () => {
  const lockedFor = () => (Date.parse(db(`SELECT phone_locked_until FROM users WHERE email = 'priya@agency.example'`)[0].phone_locked_until) - Date.now()) / 60000;
  const unlock = () => dbRun(`UPDATE users SET phone_locked_until = NULL WHERE email = 'priya@agency.example'`); // as if the lock had run out
  const mailed = mail.sent.length;
  const wrong = async (n) => { for (let i = 0; i < n; i++) await ringIn(twilio, base, N.priya, ['9090']); };
  await wrong(3);
  assert.ok(lockedFor() > 14 && lockedFor() <= 15, 'a quarter of an hour');
  unlock();
  await wrong(3);
  assert.ok(lockedFor() > 59 && lockedFor() <= 60, 'then an hour');
  unlock();
  let mark = twilio.entries.length;
  await wrong(3);
  assert.ok(lockedFor() > 1439 && lockedFor() <= 1440, 'then a day');
  assert.match(webhooks(twilio, mark, 'gather-action').at(-1).response, /locked for this phone for a day/);
  unlock();
  mark = twilio.entries.length;
  await wrong(1); // the tenth wrong PIN inside a day
  assert.match(webhooks(twilio, mark, 'gather-action')[0].response, /the PIN for this phone has been switched off\. Choose a new one in The Book/);
  assert.equal(db(`SELECT phone_pin_hash FROM users WHERE email = 'priya@agency.example'`)[0].phone_pin_hash, null);
  // Even the right PIN is no use now: there is none.
  mark = twilio.entries.length;
  await ringIn(twilio, base, N.priya, [PIN, '4165550123']);
  assert.match(webhooks(twilio, mark, 'voice-url')[0].response, /first choose a PIN in The Book/);
  assert.ok(!webhooks(twilio, mark).some((hook) => /<Dial/.test(hook.response || '')));
  assert.equal((await priya.get('/phone/status')).body.my_pin_set, false);
  const subjects = (await until(async () => mail.sent.slice(mailed), (list) => list.length >= 4)).map((m) => m.subject);
  assert.equal(subjects.filter((subject) => /locked out of The Book's switchboard/.test(subject)).length, 3);
  assert.equal(subjects.filter((subject) => /has been switched off/.test(subject)).length, 1);
  // PINs anybody would try are refused; a new one puts everything back.
  for (const easy of ['2580', '1212', '1122', '1987', '7007']) {
    const refused = await savePhone(priya, N.priya, easy);
    assert.equal(refused.status, 400, easy);
    assert.match(refused.body.error, /harder to guess/);
  }
  assert.deepEqual((await savePhone(priya, N.priya, PIN)).body, { my_phone: N.priya, my_pin_set: true });
  mark = twilio.entries.length;
  await ringIn(twilio, base, N.priya, [PIN, '6135550111']);
  assert.ok(webhooks(twilio, mark).some((hook) => /<Dial/.test(hook.response || '')), 'the switchboard works again');
  await twilio.idle();
});

test('a call placed from a calendar event with nobody on file is named after the event', async () => {
  const { placed } = await callAndWait(priya, { to: '905-555-0142', title: 'Call Kevin about the Hamilton role', event_key: 'kevin_event_key_000000' });
  const { call } = await writtenOut(priya, placed.call_id, false);
  assert.equal(call.title, 'Call Kevin about the Hamilton role');
  assert.equal((await priya.post('/phone/calls', { to: '905-555-0142', title: 7 })).status, 400);
  // With a candidate, the call is named after them, as every other call is.
  const withDana = await callAndWait(priya, { application_id: appDana, title: 'Intro call' });
  assert.equal((await writtenOut(priya, withDana.placed.call_id, false)).call.title, 'Call with Dana Whitlock');
});

test('somebody who is deactivated gives their mobile number back, so the next person can save it', async () => {
  const { token } = (await admin.post('/invites', { role: 'recruiter', email: 'tess@agency.example' })).body;
  const tess = session(base);
  assert.equal((await tess.post(`/invites/${token}/accept`, { name: 'Tess Marlow', password: 'demo1234' })).status, 200);
  assert.equal((await savePhone(tess, '416 555 0190', '7305')).status, 200);
  assert.equal((await savePhone(admin, '416 555 0190')).status, 400, 'taken while she is on the team');
  const id = db(`SELECT id FROM users WHERE email = 'tess@agency.example'`)[0].id;
  assert.equal((await admin.patch(`/users/${id}`, { active: false })).status, 200);
  assert.deepEqual({ ...db('SELECT phone, phone_pin_hash FROM users WHERE id = ?', id)[0] }, { phone: null, phone_pin_hash: null });
  const own = (await admin.get('/phone/status')).body.my_phone;
  assert.equal((await savePhone(admin, '416 555 0190')).status, 200);
  assert.equal((await savePhone(admin, own ?? '')).status, 200);
});

test('a restart between the transcript and the notes: the notes are still written and the recruiter is still told', async () => {
  const dir = tempDir('phone-restart');
  const env = connected(PHONE_PORTS.limits);
  let again = await startServer({ port: PHONE_PORTS.limits, dataDir: dir, env });
  try {
    const owner = session(again.base);
    assert.equal((await owner.post('/setup', { agencyName: 'Restart', name: 'Alex Morgan', email: 'alex@agency.example', password: 'demo1234' })).status, 200);
    assert.equal((await savePhone(owner, N.alex, PIN, again.base)).status, 200);
    const mailed = mail.sent.length, asked = anthropic.requests.length;
    anthropic.mode = 'hang'; // the notes are being written when the plug is pulled
    const placed = (await owner.post('/phone/calls', { to: N.dana })).body;
    await twilio.idle();
    await until(async () => (await owner.get(`/oracle/calls/${placed.call_id}`)).body, (d) => d.call?.status === 'ready');
    await until(async () => anthropic.requests.slice(asked), (list) => list.length >= 1);
    await again.stop('SIGKILL');
    anthropic.mode = null;
    assert.equal(mail.sent.length, mailed);
    again = await startServer({ port: PHONE_PORTS.limits, dataDir: dir, env });
    const { call } = await until(async () => (await owner.get(`/oracle/calls/${placed.call_id}`)).body, (d) => d.call?.notes);
    assert.ok(call.notes.length > 20);
    const [message] = await until(async () => mail.sent.slice(mailed), (list) => list.length >= 1);
    assert.deepEqual(message.to, ['alex@agency.example']);
    assert.match(message.subject, /^Your call notes for .* are ready$/);
  } finally {
    anthropic.mode = null;
    await again.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a recording Twilio never finishes: the call stops saying it is waiting, and in the end says there is no audio', async () => {
  const dir = tempDir('phone-stuck');
  const env = connected(PHONE_PORTS.limits, { PHONE_RECORDING_STUCK_MS: '1200', PHONE_RECORDING_LOST_MS: '2600' });
  const stuck = await startServer({ port: PHONE_PORTS.limits, dataDir: dir, env });
  twilio.behaviour.drop = ['recording:'];
  twilio.behaviour.stuck = true;
  try {
    const owner = session(stuck.base);
    assert.equal((await owner.post('/setup', { agencyName: 'Stuck', name: 'Alex Morgan', email: 'alex@agency.example', password: 'demo1234' })).status, 200);
    assert.equal((await savePhone(owner, N.alex, PIN, stuck.base)).status, 200);
    const placed = (await owner.post('/phone/calls', { to: N.dana })).body;
    await twilio.idle();
    const oracle = async () => (await owner.get(`/oracle/calls/${placed.call_id}`)).body;
    assert.equal((await oracle()).call.status, 'recording');
    const waiting = await until(oracle, (d) => d.call?.status === 'failed');
    assert.equal(waiting.call.error, 'The phone service has not finished the recording of this call yet. The Book checks again every hour.');
    const mark = twilio.entries.length;
    const given = await until(oracle, (d) => /never finished/.test(d.call?.error || ''), 8000);
    assert.equal(given.call.error, 'The phone service never finished the recording of this call, so there is no audio.');
    const phoneCall = (await owner.get(`/phone/calls/${placed.id}`)).body;
    assert.equal(phoneCall.recorded, false);
    await sleep(500);
    const asks = restCalls(twilio, mark, /Recordings\.json/).length;
    await sleep(500);
    assert.equal(restCalls(twilio, mark, /Recordings\.json/).length, asks, 'and Twilio is no longer asked about it');
    // If the recording turns up after all, it is still taken.
    twilio.behaviour.stuck = false;
    const [rec] = [...twilio.recordings.values()].filter((r) => !r.deleted && r.status === 'completed');
    assert.ok(rec, 'the recording exists at the stand-in');
    const url = `${stuck.base}/api/phone/twilio/recording?c=${placed.id}`;
    const params = { RecordingSid: rec.sid, RecordingStatus: 'completed', RecordingChannels: '2', RecordingDuration: '12', RecordingSource: 'DialVerb' };
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': twilioSignature(twilio.config.authToken, url, params) }, body: new URLSearchParams(params).toString() });
    assert.equal(res.status, 204);
    const late = await until(oracle, (d) => d.call?.status === 'ready');
    assert.equal(late.call.has_audio, true);
  } finally {
    twilio.behaviour.drop = [];
    twilio.behaviour.stuck = false;
    await stuck.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('calls from numbers nobody knows are limited far below the rest, cost nothing unasked, are not taken when the disk is nearly full, and are deleted when nobody claims them', async () => {
  const dir = tempDir('phone-strangers');
  const env = connected(PHONE_PORTS.limits, { PHONE_STRANGERS_PER_HOUR: '2', PHONE_STRANGERS_PER_DAY: '50', PHONE_KEEP_UNKNOWN_MESSAGES_MS: '2500' });
  let quiet = await startServer({ port: PHONE_PORTS.limits, dataDir: dir, env });
  const dirOf = () => fs.readdirSync(path.join(dir, 'uploads')).filter((name) => name.startsWith('call-'));
  try {
    const owner = session(quiet.base);
    assert.equal((await owner.post('/setup', { agencyName: 'Quiet', name: 'Alex Morgan', email: 'alex@agency.example', password: 'demo1234' })).status, 200);
    const clientId = (await owner.post('/clients', { name: 'Kestrel Logistics', engagement_model: 'per_hire', fee_percent: 20 })).body.id;
    const jobId = (await owner.post('/jobs', { client_id: clientId, title: 'Head of Sales', status: 'open', location: 'Toronto', description: 'Lead and grow our sales team.' })).body.id;
    assert.equal((await owner.upload('/applications', { job_id: jobId, name: 'Dana Whitlock', email: 'dana@mail.example', phone: '(416) 555-0123' })).status, 200);
    // Nobody has a mobile saved, so every caller goes straight to leaving a message.
    const mailed = mail.sent.length, noted = anthropic.requests.length;
    let mark = twilio.entries.length;
    await ringIn(twilio, quiet.base, '+12125550101');
    assert.match(webhooks(twilio, mark, 'voice-url')[0].response, /Please leave a message after the tone\.<\/Say><Record /);
    const [left] = await until(async () => (await owner.get('/oracle/calls')).body, (list) => list.length === 1 && list[0].status === 'ready');
    assert.equal(left.title, 'Voicemail');
    const [message] = await until(async () => mail.sent.slice(mailed), (list) => list.length >= 1);
    assert.match(message.subject, /has been written out$/, 'written out, and the owner is told');
    assert.equal(anthropic.requests.length, noted, 'but no notes are written for a message from nobody\'s number until somebody asks');
    assert.equal((await owner.get(`/oracle/calls/${left.id}`)).body.call.notes, null);
    assert.equal(dirOf().length, 1);

    await ringIn(twilio, quiet.base, '+12125550102');
    // The third unknown number in the hour gets a busy tone and costs nothing...
    mark = twilio.entries.length;
    await ringIn(twilio, quiet.base, '+12125550103');
    assert.match(webhooks(twilio, mark, 'voice-url')[0].response, /<Response><Reject reason="busy"\/><\/Response>/);
    // ...while a candidate ringing from the number on their profile is still answered.
    mark = twilio.entries.length;
    await ringIn(twilio, quiet.base, N.dana);
    assert.match(webhooks(twilio, mark, 'voice-url')[0].response, /Please leave a message after the tone\.<\/Say><Record /);
    await until(async () => (await owner.get('/oracle/calls')).body, (list) => list.some((c) => c.title === 'Voicemail from Dana Whitlock' && c.status === 'ready'));

    // A message from nobody's number that nobody put on a candidate is deleted, with its audio, once it is old enough.
    const kept = await until(async () => (await owner.get('/oracle/calls')).body, (list) => !list.some((c) => c.title === 'Voicemail'), 10000);
    assert.deepEqual(kept.map((c) => c.title), ['Voicemail from Dana Whitlock']);
    await until(async () => dirOf().length, (n) => n === 1);
    assert.match(quiet.output(), /left by unknown numbers more than \d+ days ago w(as|ere) deleted/);

    // With next to no room left on the disk, callers are not asked to leave a message.
    await quiet.stop();
    quiet = await startServer({ port: PHONE_PORTS.limits, dataDir: dir, env: { ...env, PHONE_MIN_FREE_MB: '99999999999' } });
    mark = twilio.entries.length;
    await ringIn(twilio, quiet.base, N.dana);
    const told = webhooks(twilio, mark, 'voice-url')[0].response;
    assert.match(told, /Nobody can take your call right now\. Please try again later\.<\/Say><Hangup\/>/);
    assert.ok(!/<Record/.test(told));
    assert.match(quiet.output(), /nearly full/);
  } finally {
    await quiet.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('no phone number or PIN is ever written to the server log', async () => {
  await twilio.idle();
  const log = server.output();
  for (const secret of [PIN, ...Object.values(N), BOOK_NUMBER, '5550123', '555-0123', '5550142']) assert.ok(!log.includes(secret), `the log does not contain ${secret}`);
});
