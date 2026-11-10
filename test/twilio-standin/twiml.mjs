// A small XML reader, enough for TwiML: elements, attributes, text, self-closing tags, comments, the five
// standard entities and numeric ones. No CDATA, no namespaces, no DTD.
const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decode = (t) => t.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return e in ENT ? ENT[e] : m;
});

/** Returns the root element as { name, attrs, children, text }. Throws Error('...') when the XML is not well formed. */
export function parseXml(xml) {
  const s = String(xml).replace(/^﻿/, '').replace(/<\?xml[\s\S]*?\?>/, '').replace(/<!--[\s\S]*?-->/g, '').trim();
  let i = 0;
  const fail = (why) => { throw new Error(`${why} at character ${i}`); };
  function element() {
    const open = /^<([A-Za-z_][\w.-]*)/.exec(s.slice(i));
    if (!open) fail('expected an element');
    i += open[0].length;
    const el = { name: open[1], attrs: {}, children: [], text: '' };
    for (;;) {
      i += /^\s*/.exec(s.slice(i))[0].length;
      if (s.startsWith('/>', i)) { i += 2; return el; }
      if (s[i] === '>') { i += 1; break; }
      const attr = /^([A-Za-z_][\w.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(s.slice(i));
      if (!attr) fail(`bad attribute in <${el.name}>`);
      el.attrs[attr[1]] = decode(attr[2] ?? attr[3]);
      i += attr[0].length;
    }
    for (;;) {
      const lt = s.indexOf('<', i);
      if (lt < 0) fail(`<${el.name}> is not closed`);
      el.text += decode(s.slice(i, lt));
      i = lt;
      if (s.startsWith('</', i)) {
        const close = /^<\/([A-Za-z_][\w.-]*)\s*>/.exec(s.slice(i));
        if (!close || close[1] !== el.name) fail(`</${el.name}> expected`);
        i += close[0].length;
        el.text = el.text.trim();
        return el;
      }
      el.children.push(element());
    }
  }
  const root = element();
  if (s.slice(i).trim()) fail('content after the root element');
  return root;
}

// Attribute names accepted on each verb, from twilio-node's TwiML builders (src/twiml/VoiceResponse.ts, commit 8cae578).
export const ATTRS = {
  Dial: ['action', 'answerOnBridge', 'callerId', 'events', 'hangupOnStar', 'method', 'passports', 'record', 'recordingConfigurationId',
    'recordingStatusCallback', 'recordingStatusCallbackEvent', 'recordingStatusCallbackMethod', 'recordingTrack', 'referMethod', 'referUrl',
    'ringTone', 'sequential', 'timeLimit', 'timeout', 'trim'],
  Number: ['amdStatusCallback', 'amdStatusCallbackMethod', 'byoc', 'machineDetection', 'machineDetectionSilenceTimeout',
    'machineDetectionSpeechEndThreshold', 'machineDetectionSpeechThreshold', 'machineDetectionTimeout', 'method', 'sendDigits',
    'statusCallback', 'statusCallbackEvent', 'statusCallbackMethod', 'url'],
  Record: ['action', 'finishOnKey', 'maxLength', 'method', 'playBeep', 'recordingConfigurationId', 'recordingStatusCallback',
    'recordingStatusCallbackEvent', 'recordingStatusCallbackMethod', 'timeout', 'transcribe', 'transcribeCallback', 'trim'],
  Gather: ['action', 'actionOnEmptyResult', 'bargeIn', 'debug', 'enhanced', 'finishOnKey', 'hints', 'input', 'language', 'maxSpeechTime',
    'method', 'numDigits', 'partialResultCallback', 'partialResultCallbackMethod', 'profanityFilter', 'speechModel', 'speechTimeout', 'timeout'],
  Say: ['language', 'loop', 'voice'],
  Play: ['digits', 'loop'],
  Pause: ['length'],
  Redirect: ['method'],
  Reject: ['reason'],
  Hangup: [],
};
export const DIAL_RECORD = ['do-not-record', 'record-from-answer', 'record-from-ringing', 'record-from-answer-dual', 'record-from-ringing-dual'];
export const RECORDING_EVENTS = ['in-progress', 'completed', 'absent'];
export const CALL_EVENTS = ['initiated', 'ringing', 'answered', 'completed'];
