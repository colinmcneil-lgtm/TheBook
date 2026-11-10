// Test audio for the stand-in, written by hand as RIFF/WAVE (PCM, 16-bit, 8000 Hz).
//
// Stereo file, laid out the way Twilio lays out a dual-channel <Dial> recording: channel 1 (left) is the parent
// call, channel 2 (right) is the child call. The two sides take turns, two seconds each, so a test can tell the
// channels apart: the parent side is a 440 Hz tone, the child side an 880 Hz tone. It is tones, not speech:
// a speech-to-text service will return an empty transcript for it.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SAMPLE_RATE = 8000;

function wav(channels, frames, sampleAt) {
  const blockAlign = channels * 2, dataBytes = frames * blockAlign;
  const b = Buffer.alloc(44 + dataBytes);
  b.write('RIFF', 0, 'latin1'); b.writeUInt32LE(36 + dataBytes, 4); b.write('WAVE', 8, 'latin1');
  b.write('fmt ', 12, 'latin1'); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);            // PCM
  b.writeUInt16LE(channels, 22); b.writeUInt32LE(SAMPLE_RATE, 24); b.writeUInt32LE(SAMPLE_RATE * blockAlign, 28);
  b.writeUInt16LE(blockAlign, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36, 'latin1'); b.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) b.writeInt16LE(sampleAt(i, c), 44 + i * blockAlign + c * 2);
  return b;
}
const tone = (i, hz) => Math.round(9000 * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE));
// Who is "speaking" during second t: the parent on even two-second blocks, the child on odd ones.
const parentTalks = (i) => Math.floor(i / (2 * SAMPLE_RATE)) % 2 === 0;

/** Two-party call, `seconds` long. channels = 2: parent left, child right. channels = 1: both mixed down. */
export function callWav(seconds, channels = 2) {
  const frames = seconds * SAMPLE_RATE;
  if (channels === 2) return wav(2, frames, (i, c) => (c === 0 ? (parentTalks(i) ? tone(i, 440) : 0) : (parentTalks(i) ? 0 : tone(i, 880))));
  return wav(1, frames, (i) => Math.round((parentTalks(i) ? tone(i, 440) : tone(i, 880)) / 2));
}
/** A voicemail left with <Record>: one channel, the caller only. */
export function voicemailWav(seconds) {
  return wav(1, seconds * SAMPLE_RATE, (i) => tone(i, 660));
}

/** Reads the header of a WAV file: { channels, sampleRate, bitsPerSample, seconds }. Throws if it is not PCM WAV. */
export function wavInfo(buf) {
  if (buf.length < 44 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let off = 12, fmt = null, dataBytes = null, dataAt = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('latin1', off, off + 4), size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { format: buf.readUInt16LE(off + 8), channels: buf.readUInt16LE(off + 10), sampleRate: buf.readUInt32LE(off + 12), bitsPerSample: buf.readUInt16LE(off + 22) };
    if (id === 'data') { dataBytes = size; dataAt = off + 8; break; }
    off += 8 + size + (size % 2);
  }
  if (!fmt || dataBytes === null) throw new Error('WAV file has no fmt or data chunk');
  const frameBytes = fmt.channels * (fmt.bitsPerSample / 8);
  return { ...fmt, seconds: dataBytes / frameBytes / fmt.sampleRate, dataAt, dataBytes };
}
/** Loudness (RMS) of each channel over a window, for checking which side is on which channel. */
export function channelRms(buf, fromSecond, toSecond) {
  const info = wavInfo(buf), sums = new Array(info.channels).fill(0);
  const from = Math.floor(fromSecond * info.sampleRate), to = Math.floor(toSecond * info.sampleRate);
  for (let i = from; i < to; i++) for (let c = 0; c < info.channels; c++) sums[c] += buf.readInt16LE(info.dataAt + (i * info.channels + c) * 2) ** 2;
  return sums.map((s) => Math.round(Math.sqrt(s / Math.max(1, to - from))));
}

/** MP3 version made with ffmpeg at 32 kbit/s, or null when ffmpeg is not installed. */
export function toMp3(wavBuffer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twilio-standin-'));
  try {
    fs.writeFileSync(path.join(dir, 'in.wav'), wavBuffer);
    const r = spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', path.join(dir, 'in.wav'), '-codec:a', 'libmp3lame', '-b:a', '32k', path.join(dir, 'out.mp3')]);
    return r.status === 0 ? fs.readFileSync(path.join(dir, 'out.mp3')) : null;
  } catch { return null; } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
