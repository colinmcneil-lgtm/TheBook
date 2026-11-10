// The small parts of the phone feature, on their own: reading a phone number as people type it, deciding which
// numbers may be rung, checking that a webhook really came from Twilio, and turning a two-channel transcript into
// turns.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { toE164, placeOf, displayNumber, spokenNumber, searchDigits, mayRing } from '../server/phone-numbers.js';
import { twilioSignature, validateTwilioSignature, validateWebhook, signatureAlgorithm } from '../server/twilio-signature.js';
import { PHONE_CANNED, CANNED, tempDir } from './oracle-helpers.mjs';

// The Oracle's module opens the database when it loads, so it is pointed at a folder of its own first.
process.env.DATA_DIR = tempDir('phone-units');
const { turnsFrom } = await import('../server/oracle.js');
test.after(() => fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }));

test('a number typed any usual way is read into one stored form', () => {
  for (const [typed, stored] of [
    ['(647) 555-0199', '+16475550199'], ['647.555.0199', '+16475550199'], ['647 555 0199', '+16475550199'], ['6475550199', '+16475550199'],
    ['1-416-555-0123', '+14165550123'], ['+1 (212) 555 0100', '+12125550100'], ['  +1 212 555 0100  ', '+12125550100'],
    ['647.555.0199 x12', '+16475550199'], ['(647) 555-0199 ext. 5', '+16475550199'], ['647-555-0199, ext 77', '+16475550199'], ['6475550199#4', '+16475550199'],
    ['011 44 7700 900123', '+447700900123'], ['+44 (0)7700 900123', '+447700900123'], ['+44 7700 900123', '+447700900123'],
  ]) assert.equal(toE164(typed), stored, typed);
});

test('a number that cannot be read is refused, never guessed at', () => {
  for (const typed of [
    '', '   ', '555-0199', '07700 900123', '(123) 555-0199', '(647) 155-0199', '647555019', '64755501999', '2-416-555-0123',
    '1 (800) FLOWERS', '6475550199x', '6475550199 or 6475550198', '+1 647 555 0199 +1', '+0 123456789', '+1 647 555', '+123', '６４７５５５０１９９',
    'call me', '6475550199;ext=12', '6475550199,,123', '1'.repeat(41),
  ]) assert.equal(toE164(typed), null, JSON.stringify(typed));
  for (const notText of [6475550199, null, undefined, {}, ['6475550199']]) assert.equal(toE164(notText), null);
});

test('+1 is not only Canada and the United States: premium, toll-free and Caribbean numbers are told apart', () => {
  assert.deepEqual(placeOf('+14165550123'), { country: 'CA' });
  assert.deepEqual(placeOf('+18675550123'), { country: 'CA' });       // Yukon, the Northwest Territories and Nunavut
  assert.deepEqual(placeOf('+12125550100'), { country: 'US' });
  assert.deepEqual(placeOf('+19075550100'), { country: 'US' });       // Alaska
  for (const [number, country] of [['+18765550199', 'JM'], ['+18095550199', 'DO'], ['+17875550199', 'PR'], ['+12425550199', 'BS'], ['+14415550199', 'BM'], ['+16715550199', 'GU'], ['+18685550199', 'TT']]) {
    assert.deepEqual(placeOf(number), { country }, number);
  }
  for (const number of ['+19005550199', '+18005550199', '+18885550199', '+18335550199', '+15005550006', '+15225550199', '+17005550199', '+17105550199', '+16005550199', '+14169765555', '+14565550199']) {
    assert.deepEqual(placeOf(number), { special: true }, number);
  }
  assert.deepEqual(placeOf('+447700900123'), { country: 'GB' });
  assert.deepEqual(placeOf('+353851234567'), { country: 'IE' });
  assert.deepEqual(placeOf('+8613800138000'), { country: null }, 'a country The Book does not know is never allowed by accident');
});

test('numbers are shown, read aloud and searched for in forms that suit each', () => {
  assert.equal(displayNumber('+16475550199'), '(647) 555-0199');
  assert.equal(displayNumber('+447700900123'), '+447700900123');
  assert.equal(displayNumber(null), null);
  assert.equal(spokenNumber('+14165550123'), '4 1 6, 5 5 5, 0 1 2 3');
  assert.equal(searchDigits('+14165550123'), '4165550123');
  assert.equal(searchDigits('+447700900123'), '447700900123');
});

// The fixed examples from Twilio's own library (twilio-node, spec/validation.spec.js): a token, an address, the
// fields sent and the signature Twilio would put on them.
test('webhook signatures match the worked examples in Twilio\'s own library', () => {
  const token = '12345', url = 'https://mycompany.com/myapp.php?foo=1&bar=2';
  const params = { CallSid: 'CA1234567890ABCDE', Caller: '+14158675309', Digits: '1234', From: '+14158675309', To: '+18005551212' };
  assert.equal(twilioSignature(token, url, params), 'RSOYDt4T1cUTdK1PDd93/VVr8B8=');
  assert.equal(validateTwilioSignature(token, 'RSOYDt4T1cUTdK1PDd93/VVr8B8=', url, params), true);
  assert.equal(validateTwilioSignature(token, 'WRONG_SIGNATURE', url, params), false);
  assert.equal(validateTwilioSignature(token, undefined, url, params), false);
  // Twilio has signed with and without the port at different times: both are accepted.
  assert.equal(validateTwilioSignature(token, 'RSOYDt4T1cUTdK1PDd93/VVr8B8=', url.replace('.com', '.com:1234'), params), true);
  assert.equal(validateTwilioSignature(token, 'Zmvh+3yNM1Phv2jhDCwEM3q5ebU=', url.replace('.com', '.com:1234').replace('https', 'http'), params), true);
  assert.equal(validateTwilioSignature(token, 'kvajT1Ptam85bY51eRf/AJRuM3w=', url, params), true);
  assert.equal(validateTwilioSignature(token, '0ZXoZLH/DfblKGATFgpif+LLRf4=', url.replace('https', 'http'), params), true);
  assert.equal(validateTwilioSignature(token, 'TfZzewPq8wqrGlMfyAud8+/IvJ0=', `${url}&Body=It's+amazing`, params), true);
  // A field sent more than once counts each different value once, in order.
  assert.equal(validateTwilioSignature(token, '83O6e2vORAoJHUNzJjDWN1jz+BA=', url, { 'MessagingBinding.Address': ['+1415xxxxxxx', '+1325xxxxxxx'] }), true);
  assert.equal(validateTwilioSignature(token, 'IK+Dwps556ElfBT0I3Rgjkr1wJU=', url, { Sid: 'CA123', SidAccount: 'AC123', Digits: ['5678', '1234', '1234'] }), true);
});

test('a webhook is checked against the public address it was sent to, with every field it carries', () => {
  const base = 'https://thebook.example.com', path = '/api/phone/twilio/status?c=42', params = { CallSid: 'CA1', CallStatus: 'completed' };
  const good = twilioSignature('tok', base + path, params);
  const check = (over) => validateWebhook({ authToken: 'tok', signature: good, publicBase: base, originalUrl: path, params, ...over });
  assert.equal(check({}), true);
  assert.equal(check({ publicBase: `${base}/` }), true, 'a trailing slash on APP_URL does not matter');
  assert.equal(check({ publicBase: 'http://thebook.example.com' }), false, 'http is not https');
  assert.equal(check({ publicBase: 'https://thebook.up.railway.app' }), false, 'another name for the same server is not the address Twilio was given');
  assert.equal(check({ originalUrl: '/api/phone/twilio/status' }), false, 'the query string is part of what is signed');
  assert.equal(check({ originalUrl: '/api/phone/twilio/status?c=43' }), false);
  assert.equal(check({ params: { ...params, Extra: '1' } }), false);
  assert.equal(check({ params: { ...params, CallStatus: 'failed' } }), false);
  assert.equal(check({ authToken: 'other' }), false);
  assert.equal(check({ signature: '' }), false);
  assert.equal(check({ signature: undefined }), false);
  assert.equal(check({ authToken: '' }), false, 'with no secret set, nothing is accepted');
  // A request that says it was signed some other way is refused unless that way has been set up.
  assert.equal(check({ settingsHeader: 'key=webhooks_sharedkey_1,algorithm=HMAC_SHA256' }), false);
  assert.equal(signatureAlgorithm('key=x,algorithm=HMAC_SHA256'), 'HMAC_SHA256');
  // The signature is an HMAC-SHA1 of the address followed by each field's name and value, in order of name.
  assert.equal(good, crypto.createHmac('sha1', 'tok').update(`${base}${path}CallSidCA1CallStatuscompleted`).digest('base64'));
});

test('a two-channel transcript becomes turns in order of time, with the channel as the speaker', () => {
  const { turns, durationMs, channels } = turnsFrom(PHONE_CANNED);
  assert.equal(channels, 2);
  assert.equal(durationMs, 27360);
  assert.deepEqual(turns, [
    { speaker: 0, start: 0.6, end: 3.9, text: 'Hi Dana, it\'s Maya from Kestrel Recruitment. Is now still a good time?' },
    { speaker: 1, start: 4.4, end: 5.6, text: 'Yes, now is fine.' },
    { speaker: 0, start: 6.1, end: 12.9, text: 'Great. Can you tell me about your current role? And how big is the team?' },
    { speaker: 1, start: 12.4, end: 17.8, text: 'Sure. I lead six account executives at Varsity Freight.' },   // begins before the turn above has ended: they overlapped
    { speaker: 0, start: 15, end: 15.4, text: 'Mhmm.' },
    { speaker: 1, start: 18.6, end: 21, text: 'We closed 2.4 million last year.' },
    { speaker: 0, start: 21.9, end: 24.1, text: 'And what are you looking for on salary?' },
    { speaker: 1, start: 24.9, end: 26.3, text: 'Around 90,000 base.' },
  ]);
});

test('a two-channel answer with parts missing is still read', () => {
  // No list of utterances: each channel's sentences are used, and the result is the same eight turns.
  const { utterances, ...rest } = PHONE_CANNED.results;
  const fromSentences = turnsFrom({ metadata: PHONE_CANNED.metadata, results: rest }).turns;
  assert.deepEqual(fromSentences.map((t) => [t.speaker, t.start]), turnsFrom(PHONE_CANNED).turns.map((t) => [t.speaker, t.start]));
  // Times sent as text.
  const texty = { metadata: { channels: 2 }, results: { channels: [{}, {}], utterances: [{ channel: 1, start: '2.5', end: '3', transcript: 'Second.' }, { channel: 0, start: '0.5', end: '2', transcript: 'First.' }] } };
  assert.deepEqual(turnsFrom(texty).turns, [{ speaker: 0, start: 0.5, end: 2, text: 'First.' }, { speaker: 1, start: 2.5, end: 3, text: 'Second.' }]);
  // Nobody spoke on either channel.
  const quiet = { alternatives: [{ transcript: '', words: [] }] };
  assert.deepEqual(turnsFrom({ metadata: { channels: 2, duration: 12 }, results: { channels: [quiet, quiet], utterances: [] } }), { turns: [], durationMs: 12000, channels: 2 });
  // Only one person spoke.
  const oneSided = turnsFrom({ ...PHONE_CANNED, results: { channels: [PHONE_CANNED.results.channels[0], quiet], utterances: utterances.filter((u) => u.channel === 0) } }).turns;
  assert.equal(oneSided.length, 1);
  assert.equal(oneSided[0].speaker, 0);
  // The number of channels is taken from the answer, or failing that from how many it holds.
  assert.equal(turnsFrom({ results: { channels: [{}, {}], utterances } }).channels, 2);
  // An ordinary one-channel answer is read exactly as before.
  assert.equal(turnsFrom(CANNED).turns.length, 4);
  assert.equal(turnsFrom(CANNED).channels, undefined);
});

test('a transcript is read channel by channel only when that was asked for', () => {
  // An uploaded stereo file is not sent with multichannel, so its speakers are the ones told apart by voice, even
  // if the answer mentions two channels. Read channel by channel it would be one long turn by one speaker.
  const stereo = { ...CANNED, metadata: { ...CANNED.metadata, channels: 2 } };
  const told = turnsFrom(stereo, false);
  assert.equal(told.turns.length, 4);
  assert.deepEqual([...new Set(told.turns.map((t) => t.speaker))].sort(), [0, 1]);
  assert.equal(told.channels, undefined);
  // A phone call was asked for by channel, and is read that way.
  assert.equal(turnsFrom(PHONE_CANNED, true).channels, 2);
  assert.deepEqual(turnsFrom(PHONE_CANNED, true).turns, turnsFrom(PHONE_CANNED).turns);
});

test('which numbers The Book would ring', () => {
  assert.equal(mayRing('+14165550142'), true);
  assert.equal(mayRing('+12125550188'), true);
  assert.equal(mayRing('+19005550199'), false, 'premium rate');
  assert.equal(mayRing('+18005550199'), false, 'toll-free');
  assert.equal(mayRing('+18765550199'), false, 'Jamaica shares +1 but is not allowed unless the workspace says so');
  assert.equal(mayRing('+18765550199', ['CA', 'US', 'JM']), true);
  assert.equal(mayRing('+442079460958'), false);
  assert.equal(mayRing('+8823421000111'), false, 'a satellite number');
  assert.equal(mayRing(null), false);
});
