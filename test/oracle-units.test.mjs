// The Oracle's small readers and writers, on their own: what comes back from the transcription service, a pasted
// transcript, the first bytes of an audio file, a recording's length, and the layout of the notes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { measureWebm, webmWithDuration } from '../server/webm.js';
import { RECORDING, CANNED, tempDir, pieces } from './oracle-helpers.mjs';

// The module opens the database when it loads, so it is pointed at a folder of its own first.
process.env.DATA_DIR = tempDir('oracle-units');
const { turnsFrom, deepgramError, parsePastedTranscript, audioKind, notesText, transcriptText } = await import('../server/oracle.js');
test.after(() => fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }));

test('a transcription answer becomes turns: one per speaker change, with only speaker, times and text', () => {
  const { turns, durationMs } = turnsFrom(CANNED);
  assert.equal(durationMs, 21400);
  assert.equal(turns.length, 4);
  assert.deepEqual(turns.map((t) => t.speaker), [0, 1, 0, 1]);
  assert.deepEqual(turns[1], { speaker: 1, start: 5.8, end: 13.2, text: 'Sure. I lead six account executives at Varsity Freight. We closed 2.4 million last year.' });
  for (const turn of turns) assert.deepEqual(Object.keys(turn), ['speaker', 'start', 'end', 'text']);
});

test('an answer with parts missing is still read', () => {
  // Times sent as text, which the published description allows.
  const texty = { results: { utterances: [{ speaker: '1', start: '1.50', end: '2.75', transcript: ' Hello  there. ' }] } };
  assert.deepEqual(turnsFrom(texty), { turns: [{ speaker: 1, start: 1.5, end: 2.75, text: 'Hello there.' }], durationMs: null });
  // No utterances: the paragraphs are used, which carry speakers too.
  const { utterances, ...rest } = CANNED.results;
  assert.deepEqual(turnsFrom({ metadata: CANNED.metadata, results: rest }).turns.map((t) => [t.speaker, t.start, t.end]), [[0, 0.5, 4.9], [1, 5.8, 13.2], [0, 14.1, 16.4], [1, 17.3, 19]]);
  // Neither: the plain text, as one turn.
  const plain = turnsFrom({ metadata: { duration: 12 }, results: { channels: [{ alternatives: [{ transcript: 'Just the words.' }] }] } });
  assert.deepEqual(plain.turns, [{ speaker: 0, start: 0, end: 12, text: 'Just the words.' }]);
  // Nothing was said, or the answer is not what was expected at all.
  for (const empty of [{}, null, 'text', { results: { utterances: [] } }, { results: { utterances: [{ speaker: 0, transcript: '  ' }] } }, { results: { channels: [{ alternatives: [{ transcript: '' }] }] } }]) {
    assert.deepEqual(turnsFrom(empty).turns, []);
  }
});

test('the three shapes an error answer can take', () => {
  const legacy = deepgramError(401, '{"err_code":"INVALID_AUTH","err_msg":"Invalid credentials.","request_id":"req_1"}');
  assert.deepEqual([legacy.kind, legacy.code, legacy.detail, legacy.requestId, legacy.retryable], ['key', 'INVALID_AUTH', 'Invalid credentials.', 'req_1', false]);
  const newer = deepgramError(400, '{"category":"INVALID_REQUEST","message":"The audio could not be decoded.","details":"corrupt","request_id":"req_2"}');
  assert.deepEqual([newer.kind, newer.code, newer.detail, newer.requestId], ['audio', 'INVALID_REQUEST', 'The audio could not be decoded.', 'req_2']);
  const page = deepgramError(504, '<html>504 Gateway Time-out</html>');
  assert.deepEqual([page.kind, page.code, page.detail, page.retryable], ['too_slow', null, '<html>504 Gateway Time-out</html>', true]);
  assert.ok(!page.message.includes('<'), 'the recruiter is shown a sentence, never the raw answer');

  const kinds = { 401: 'key', 402: 'credit', 408: 'busy', 413: 'too_large', 429: 'busy', 500: 'server', 503: 'server', 504: 'too_slow', 400: 'audio', 422: 'audio' };
  for (const [status, kind] of Object.entries(kinds)) assert.equal(deepgramError(Number(status), '').kind, kind, status);
  assert.equal(deepgramError(403, '{"err_code":"INSUFFICIENT_PERMISSIONS","err_msg":"no"}').kind, 'access');
  assert.equal(deepgramError(400, '{"err_code":"INVALID_QUERY_PARAMETER","err_msg":"diarize and diarize_model"}').kind, 'request');
  // Tried again only when trying again could help.
  assert.deepEqual(Object.keys(kinds).filter((s) => deepgramError(Number(s), '').retryable).map(Number), [408, 429, 500, 503, 504]);
  assert.equal(deepgramError(429, '', '7').retryAfter, 7000);
  assert.equal(deepgramError(429, '', null).retryAfter, null);
});

test('a pasted transcript: named lines become turns', () => {
  const { turns, speakers } = parsePastedTranscript(`Priya Nair: Thanks for joining.
Can you hear me all right?

Sam (candidate): Yes. My salary: about 85,000.
PRIYA NAIR: And your notice period?
Sam (candidate): Three months, but it could be less.`);
  assert.deepEqual(turns.map((t) => [t.speaker, t.text]), [
    [0, 'Thanks for joining. Can you hear me all right?'],
    [1, 'Yes. My salary: about 85,000.'],
    [0, 'And your notice period?'],
    [1, 'Three months, but it could be less.'],
  ]);
  assert.deepEqual(speakers, { 0: 'Priya Nair', 1: 'Sam (candidate)' });
  assert.ok(turns.every((t) => t.start === 0 && t.end === 0), 'nobody knows the times, so none are made up');
});

test('a pasted transcript: times at the start of a line are read; numbered speakers are left for a person to name', () => {
  const { turns, speakers } = parsePastedTranscript('[00:05] Speaker 1: Hello.\n[00:12] Speaker 2: Hi, thanks for calling.\n01:02:03 - Speaker 1: Shall we start?');
  assert.deepEqual(turns, [
    { speaker: 0, start: 5, end: 12, text: 'Hello.' },
    { speaker: 1, start: 12, end: 3723, text: 'Hi, thanks for calling.' },
    { speaker: 0, start: 3723, end: 3723, text: 'Shall we start?' },
  ]);
  assert.deepEqual(speakers, {});
});

test('a pasted transcript: text with no names, a heading before the first name, and things that only look like names', () => {
  // No names at all: one turn a paragraph, all from one speaker.
  const plain = parsePastedTranscript('We talked about the role.\nShe is keen.\n\n\nNotice is one month.');
  assert.deepEqual(plain.turns.map((t) => [t.speaker, t.text]), [[0, 'We talked about the role. She is keen.'], [0, 'Notice is one month.']]);
  assert.deepEqual(plain.speakers, {});
  // A line before the first speaker is kept, under a speaker number of its own.
  const headed = parsePastedTranscript('Call on Monday morning\nDana: Hello.\nPriya: Hi Dana.');
  assert.deepEqual(headed.turns.map((t) => [t.speaker, t.text]), [[0, 'Call on Monday morning'], [1, 'Hello.'], [2, 'Hi Dana.']]);
  assert.deepEqual(headed.speakers, { 1: 'Dana', 2: 'Priya' });
  // Ordinary sentences with a colon, a clock time and a web address do not start a new speaker.
  const tricky = parsePastedTranscript('Dana: I have two offers.\nthe thing is: I would rather work here.\nWe could meet at 10:30 tomorrow.\nSee https://example.com for the pack.');
  assert.equal(tricky.turns.length, 1);
  assert.deepEqual(tricky.speakers, { 0: 'Dana' });
  assert.match(tricky.turns[0].text, /the thing is: I would rather work here\. We could meet at 10:30 tomorrow\. See https:\/\/example\.com/);
  assert.deepEqual(parsePastedTranscript('   \n\n').turns, []);
});

test('the first bytes of a file say what kind of audio it is', () => {
  const kinds = {
    webm: RECORDING.subarray(0, 16),
    mp4: Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from('ftypM4A \0\0\0\0')]),
    ogg: Buffer.from('OggS\0\x02\0\0\0\0\0\0\0\0\0\0', 'latin1'),
    wav: Buffer.from('RIFF\x24\0\0\0WAVEfmt ', 'latin1'),
    mp3: Buffer.from('ID3\x04\0\0\0\0\0\0\0\0\0\0\0\0', 'latin1'),
  };
  for (const [kind, head] of Object.entries(kinds)) assert.equal(audioKind(head), kind);
  assert.equal(audioKind(Buffer.from([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])), 'mp3'); // an MP3 with no tag in front
  for (const not of ['<html><body>hello</body></html>', '%PDF-1.7 something', 'PK\x03\x04 a zip file...', 'RIFF\x24\0\0\0AVI LIST', '', '\xff\xff\xff\xff\xff\xff\xff\xff']) {
    assert.equal(audioKind(Buffer.from(not, 'latin1')), null, JSON.stringify(not));
  }
});

test('a browser recording is given its length without changing anything else', () => {
  const before = measureWebm(RECORDING);
  assert.equal(before.hasDuration, false);
  assert.ok(Math.abs(before.durationMs - 9362) < 60, `measured ${before.durationMs} ms`);
  const { pieces: out, durationMs } = webmWithDuration(RECORDING);
  const fixed = Buffer.concat(out);
  assert.equal(durationMs, before.durationMs);
  assert.equal(fixed.length, RECORDING.length + 11);
  const after = measureWebm(fixed);
  assert.equal(after.hasDuration, true);
  assert.equal(after.blocks, before.blocks);
  assert.equal(after.durationMs, before.durationMs);
  // Everything after the header is the same audio, byte for byte.
  assert.ok(fixed.subarray(fixed.length - 30000).equals(RECORDING.subarray(RECORDING.length - 30000)));
  // Done twice, nothing more is added; and bytes that are not a recording are handed back as they came.
  assert.equal(Buffer.concat(webmWithDuration(fixed).pieces).length, fixed.length);
  const junk = Buffer.from('not a recording at all');
  assert.deepEqual(webmWithDuration(junk), { pieces: [junk], durationMs: 0 });
  // A file with an index of positions in it (other software writes one; browsers do not) is measured but not altered,
  // because adding to the header would leave the index pointing at the wrong places.
  const indexed = Buffer.concat([RECORDING.subarray(0, 48), Buffer.from([0x11, 0x4d, 0x9b, 0x74, 0x80]), RECORDING.subarray(48)]);
  assert.equal(measureWebm(indexed).hasIndex, true);
  assert.deepEqual(webmWithDuration(indexed), { pieces: [indexed], durationMs: before.durationMs });
  // A recording cut off part-way through still measures, up to where it stops.
  const half = Buffer.concat(pieces(RECORDING, 5).slice(0, 2));
  const partial = webmWithDuration(half);
  assert.ok(partial.durationMs > 2500 && partial.durationMs < 5000, `kept ${partial.durationMs} ms`);
  assert.equal(measureWebm(Buffer.concat(partial.pieces)).hasDuration, true);
});

test('notes are laid out as an overview, then headings each followed by "- " lines', () => {
  const text = notesText({
    overview: '  A strong\ncandidate.  ',
    sections: [
      { heading: 'Why they are looking:', points: ['Wants a bigger team.', '• Passed over for promotion.', '   '] },
      { heading: 'Concerns to probe', points: [] },             // nothing under it: left out
      { heading: '', points: ['No heading'] },                  // no heading: left out
      { heading: 'Next steps', points: ['- Send the job description.'] },
    ],
  });
  assert.equal(text, 'A strong candidate.\n\nWhy they are looking\n- Wants a bigger team.\n- Passed over for promotion.\n\nNext steps\n- Send the job description.');
  assert.equal(notesText({ overview: 'Only this.' }), 'Only this.');
  assert.equal(notesText({}), '');
  assert.match(notesText({ overview: 'Start.', sections: [] }, true), /^Start\.\n\nThis call was too long to read in one go, so this covers the first part of it only\.$/);
});

test('a transcript too long to send in one go is cut at the end of a turn, and says so', () => {
  const turns = [
    { speaker: 0, start: 0, end: 4, text: 'First turn.' },
    { speaker: 1, start: 65, end: 70, text: 'Second turn.' },
    { speaker: 0, start: 3725, end: 3730, text: 'Third turn, an hour in.' },
  ];
  const all = transcriptText(turns, { 1: 'Dana' });
  assert.equal(all.text, '[0:00] Speaker 0: First turn.\n[1:05] Speaker 1 (Dana): Second turn.\n[1:02:05] Speaker 0: Third turn, an hour in.\n');
  assert.equal(all.cut, false);
  const some = transcriptText(turns, {}, 70);
  assert.equal(some.text, '[0:00] Speaker 0: First turn.\n[1:05] Speaker 1: Second turn.\n');
  assert.equal(some.cut, true);
  // One turn longer than the limit: its beginning is sent, never nothing.
  const one = transcriptText([{ speaker: 0, start: 0, end: 9, text: 'x'.repeat(500) }], {}, 100);
  assert.equal(one.text.length, 100);
  assert.equal(one.cut, true);
});
