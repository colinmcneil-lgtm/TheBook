// Gives a browser recording its length.
//
// A browser writes a recording as a "live" WebM file: the header does not say how long the audio is, because the
// browser did not know when it started writing. A player then shows no length and cannot jump around until it has
// read to the end. This module works out the real length from the timestamps inside the file and writes it into the
// header, so the player can seek straight away. Nothing else in the file is changed.
//
// Adding to the header moves everything after it along by a few bytes. That is safe in a browser recording, which
// has no index pointing at positions in the file. A file that does have one (written by other software) is left
// exactly as it is: such files normally state their length already.

const ID = {
  Segment: 0x18538067, Info: 0x1549a966, TimecodeScale: 0x2ad7b1, Duration: 0x4489,
  Tracks: 0x1654ae6b, Cluster: 0x1f43b675, Timecode: 0xe7, SimpleBlock: 0xa3, BlockGroup: 0xa0, Block: 0xa1,
  Cues: 0x1c53bb6b, SeekHead: 0x114d9b74, Tags: 0x1254c367,
};
const TOP_LEVEL = new Set([ID.Info, ID.Tracks, ID.Cluster, ID.Cues, ID.SeekHead, ID.Tags]); // what a Segment holds

/** An element id: 1 to 4 bytes, read with its marker bits. */
function readId(buf, pos) {
  const first = buf[pos];
  if (first === undefined) return null;
  let len = 1;
  for (let mask = 0x80; len <= 4 && !(first & mask); mask >>= 1) len++;
  if (len > 4 || pos + len > buf.length) return null;
  let id = 0;
  for (let i = 0; i < len; i++) id = id * 256 + buf[pos + i];
  return { id, len };
}

/** An element size: 1 to 8 bytes with the marker bit removed. `unknown` is the all-ones value a live file uses for "not known yet". */
function readSize(buf, pos) {
  const first = buf[pos];
  if (first === undefined) return null;
  let len = 1;
  for (let mask = 0x80; len <= 8 && !(first & mask); mask >>= 1) len++;
  if (len > 8 || pos + len > buf.length) return null;
  let value = first & (0xff >> len);
  let allOnes = value === (0xff >> len);
  for (let i = 1; i < len; i++) {
    value = value * 256 + buf[pos + i];
    if (buf[pos + i] !== 0xff) allOnes = false;
  }
  return { value, len, unknown: allOnes };
}

function encodeSize(value, len) {
  const out = Buffer.alloc(len);
  let v = value;
  for (let i = len - 1; i >= 0; i--) { out[i] = v % 256; v = Math.floor(v / 256); }
  out[0] |= 0x80 >> (len - 1);
  return out;
}

/**
 * Walk the file and report where its Info header is and how long the audio runs. The length is the timestamp of the
 * last block of audio plus one block's worth (the gap between the last two), so the final block is counted.
 */
export function measureWebm(buf) {
  let pos = 0;
  const out = { info: null, hasDuration: false, hasIndex: false, timecodeScale: 1_000_000, blocks: 0, lastMs: 0, prevMs: 0, durationMs: 0 };
  let clusterTime = 0;
  const walk = (end, depth) => {
    while (pos < end) {
      const start = pos;
      const id = readId(buf, pos);
      if (!id) return;
      const size = readSize(buf, pos + id.len);
      if (!size) return;
      // A live Cluster has no stated size: the next Segment-level element is what ends it, so hand that back to the caller.
      if (depth >= 2 && TOP_LEVEL.has(id.id)) return;
      const dataStart = pos + id.len + size.len;
      const dataEnd = size.unknown ? end : Math.min(dataStart + size.value, buf.length);
      switch (id.id) {
        case ID.Segment:
        case ID.Cluster:
        case ID.BlockGroup:
          pos = dataStart; walk(dataEnd, depth + 1); break;
        case ID.Info:
          out.info = { sizePos: start + id.len, sizeLen: size.len, dataStart, dataEnd };
          pos = dataStart; walk(dataEnd, depth + 1); break;
        case ID.TimecodeScale:
          out.timecodeScale = buf.readUIntBE(dataStart, size.value); pos = dataEnd; break;
        case ID.Duration:
          out.hasDuration = true; pos = dataEnd; break;
        case ID.SeekHead:
        case ID.Cues:
          out.hasIndex = true; // a list of positions in the file, which must then not move
          if (size.unknown) return;
          pos = dataEnd; break;
        case ID.Timecode:
          clusterTime = size.value <= 6 ? buf.readUIntBE(dataStart, size.value) : Number(buf.readBigUInt64BE(dataStart)); pos = dataEnd; break;
        case ID.SimpleBlock:
        case ID.Block: {
          const track = readSize(buf, dataStart); // the track number comes first, then the time relative to the cluster
          out.prevMs = out.lastMs;
          out.lastMs = (clusterTime + buf.readInt16BE(dataStart + track.len)) * out.timecodeScale / 1_000_000;
          out.blocks++;
          pos = dataEnd; break;
        }
        default:
          if (size.unknown) return; // not something this reader understands
          pos = dataEnd;
      }
    }
  };
  walk(buf.length, 0);
  const lastBlockMs = out.blocks > 1 ? Math.max(0, Math.min(120, out.lastMs - out.prevMs)) : 0;
  out.durationMs = out.blocks ? out.lastMs + lastBlockMs : 0;
  return out;
}

/**
 * The same recording with its length written into the header, as a list of pieces to write one after another (so a
 * long recording is never held in memory twice). A file that already states its length, that has an index of
 * positions, or that cannot be read as WebM, comes back as it was. `durationMs` is the measured length, or 0 when it could not be measured.
 */
export function webmWithDuration(buf) {
  let meta;
  try { meta = measureWebm(buf); } catch { return { pieces: [buf], durationMs: 0 }; } // cut short or damaged: keep it as it arrived
  if (!meta.info || meta.hasDuration || meta.hasIndex || !meta.durationMs) return { pieces: [buf], durationMs: meta.durationMs };
  const duration = Buffer.alloc(11);
  duration.writeUInt16BE(ID.Duration, 0);
  duration[2] = 0x88; // an 8-byte number follows
  duration.writeDoubleBE(meta.durationMs * 1_000_000 / meta.timecodeScale, 3); // counted in the file's own time unit (a millisecond in browser recordings)
  const { info } = meta;
  const newInfoSize = info.dataEnd - info.dataStart + duration.length;
  // The size field keeps its width when the new size fits; otherwise it is widened to 8 bytes.
  const fits = newInfoSize <= 2 ** (7 * info.sizeLen) - 2;
  return {
    pieces: [buf.subarray(0, info.sizePos), encodeSize(newInfoSize, fits ? info.sizeLen : 8), buf.subarray(info.dataStart, info.dataEnd), duration, buf.subarray(info.dataEnd)],
    durationMs: meta.durationMs,
  };
}
