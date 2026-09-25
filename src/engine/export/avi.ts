/**
 * AVI bitstream surgery — the mechanism behind REAL datamosh.
 *
 * Why this exists: decoding a video normally and then throwing frames away
 * cannot produce datamosh. The decoder has already resolved the reference
 * chain, so all you get is a stutter. The motion smear only happens when a
 * P-frame reaches the decoder WITHOUT its I-frame, because the decoder then
 * applies the motion vectors of the new shot on top of the pixels of the old
 * one. That means the removal has to happen inside the encoded bitstream.
 *
 * So we:
 *   1. prepare the region as MPEG-4 Part 2 in AVI (every frame is an
 *      addressable chunk, and the encoder is built into ffmpeg),
 *   2. read each chunk, detect its VOP coding type from the MPEG-4 start code
 *      (0x000001B6) instead of trusting the index,
 *   3. drop I-frame chunks / duplicate or drop P-frame chunks in the region,
 *   4. rebuild the `movi` list and a consistent `idx1` index.
 *
 * The rebuilt file is then re-encoded by ffmpeg, which is where the decoder
 * drift becomes visible pixels.
 */

export type FrameKind = 'I' | 'P' | 'B' | 'S' | '?';

export interface AviChunk {
  fourcc: string;
  /** Absolute offset of the chunk header in the original buffer. */
  headerOffset: number;
  dataOffset: number;
  size: number;
  /** Chunk data padded to an even byte boundary. */
  paddedSize: number;
  streamId: number;
  kind: FrameKind;
  /** Position among video frames (0-based) in the original file. */
  frameIndex: number;
}

export interface AviFile {
  bytes: Uint8Array;
  /** Everything before the movi list (RIFF header + hdrl). */
  header: Uint8Array;
  /** hdrl bytes including its LIST header, used when rebuilding. */
  hdrl: Uint8Array;
  chunks: AviChunk[];
  videoChunks: AviChunk[];
  /** Bytes after the movi list (JUNK, idx1, ...), excluding movi itself. */
  trailer: Uint8Array;
  frameCount: number;
  keyframeCount: number;
}

const RIFF = 0x52494646; // 'RIFF'
const LIST = 0x4c495354; // 'LIST'
const AVI_ = 0x41564920; // 'AVI '
const MOVI = 0x6d6f7669; // 'movi'
const IDX1 = 0x69647831; // 'idx1'
const AVIIF_KEYFRAME = 0x00000010;

function fourcc(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

function u32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

/**
 * MPEG-4 Part 2 frames start with 00 00 01 B6 and the following byte encodes
 * vop_coding_type in its top two bits. This is the authoritative way to tell an
 * I-frame from a P-frame; container flags are frequently wrong in the wild.
 */
export function detectVopKind(bytes: Uint8Array, start: number, length: number): FrameKind {
  const limit = Math.min(start + length, bytes.length) - 4;
  for (let i = Math.max(0, start); i <= limit; i += 1) {
    if (bytes[i] === 0x00 && bytes[i + 1] === 0x00 && bytes[i + 2] === 0x01 && bytes[i + 3] === 0xb6) {
      const header = bytes[i + 4];
      if (header === undefined) return '?';
      const codingType = (header >> 6) & 0x03;
      if (codingType === 0) return 'I';
      if (codingType === 1) return 'P';
      if (codingType === 2) return 'B';
      return 'S';
    }
    // Only scan the first part of each frame; start codes are at the front.
    if (i - start > 64) break;
  }
  return '?';
}

export function parseAvi(bytes: Uint8Array): AviFile {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 12 || fourcc(view, 0) !== 'RIFF' || fourcc(view, 8) !== 'AVI ') {
    throw new Error('Not an AVI file');
  }
  const riffEnd = Math.min(bytes.byteLength, u32(view, 4) + 8);

  let moviListStart = -1;
  let moviDataStart = -1;
  let moviDataEnd = -1;
  let hdrlStart = -1;
  let hdrlEnd = -1;

  let cursor = 12;
  while (cursor + 8 <= riffEnd) {
    const id = fourcc(view, cursor);
    const size = u32(view, cursor + 4);
    if (id === 'LIST') {
      const type = fourcc(view, cursor + 8);
      if (type === 'hdrl' && hdrlStart < 0) {
        hdrlStart = cursor;
        hdrlEnd = cursor + 8 + size;
      } else if (type === 'movi' && moviListStart < 0) {
        moviListStart = cursor;
        moviDataStart = cursor + 12;
        moviDataEnd = cursor + 8 + size;
      }
    }
    cursor += 8 + size + (size % 2);
  }

  if (moviListStart < 0 || moviDataStart < 0) throw new Error('AVI has no movi list');
  if (hdrlStart < 0) throw new Error('AVI has no hdrl list');

  const header = bytes.slice(0, hdrlStart);
  const hdrl = bytes.slice(hdrlStart, hdrlEnd);
  const trailer = bytes.slice(moviListStart + 8 + (moviDataEnd - moviListStart - 8));
  void trailer;

  const chunks: AviChunk[] = [];
  let frameIndex = 0;
  let c = moviDataStart;
  while (c + 8 <= moviDataEnd) {
    const id = fourcc(view, c);
    const size = u32(view, c + 4);
    const dataOffset = c + 8;
    if (dataOffset + size > bytes.byteLength) break;
    if (id === 'LIST') {
      // Nested lists inside movi (rare); skip them.
      c += 8 + size + (size % 2);
      continue;
    }
    const streamId = Number.parseInt(id.slice(0, 2), 10);
    const isVideo = /^\d{2}(dc|db|dx)$/.test(id);
    const kind: FrameKind = isVideo ? detectVopKind(bytes, dataOffset, size) : '?';
    chunks.push({
      fourcc: id,
      headerOffset: c,
      dataOffset,
      size,
      paddedSize: size + (size % 2),
      streamId: Number.isFinite(streamId) ? streamId : 0,
      kind,
      frameIndex: isVideo ? frameIndex++ : -1,
    });
    c += 8 + size + (size % 2);
  }

  const videoChunks = chunks.filter((chunk) => chunk.frameIndex >= 0);

  // Everything after the movi list (JUNK / idx1 ...), rebuilt from scratch.
  const afterMovi = moviListStart + 8 + (moviDataEnd - moviListStart - 8);
  const leftover = bytes.slice(afterMovi);

  return {
    bytes,
    header,
    hdrl,
    chunks,
    videoChunks,
    trailer: leftover,
    frameCount: videoChunks.length,
    keyframeCount: videoChunks.filter((chunk) => chunk.kind === 'I').length,
  };
}

export interface RegionTransform {
  startFrame: number;
  endFrame: number;
  /** Remove I-frames inside the region: the classic "bloom" mosh. */
  dropKeyframes: boolean;
  /** Emit each frame `repeatCount` times every `repeatInterval` frames. */
  repeatCount: number;
  repeatInterval: number;
  /** Hold: extra copies of the current frame every `holdInterval` frames. */
  holdFrames: number;
  holdInterval: number;
  /** Drop frames: keep `keepEvery` frames then skip `skipAmount`. */
  skipAmount: number;
  skipEvery: number;
  /** Reorder: swap adjacent frames to scramble motion (Swap preset). */
  reorder: boolean;
}

export interface SurgeryStats {
  framesIn: number;
  framesOut: number;
  droppedKeyframes: number;
  duplicatedFrames: number;
  droppedFrames: number;
  reordered: number;
}

export interface SurgeryResult {
  bytes: Uint8Array;
  stats: SurgeryStats;
}

/**
 * Applies per-region transforms and rebuilds the container.
 * Regions are processed in timeline frame order and must not overlap.
 */
export function applySurgery(avi: AviFile, regions: RegionTransform[]): SurgeryResult {
  const stats: SurgeryStats = {
    framesIn: avi.videoChunks.length,
    framesOut: 0,
    droppedKeyframes: 0,
    duplicatedFrames: 0,
    droppedFrames: 0,
    reordered: 0,
  };

  const sorted = [...regions].sort((a, b) => a.startFrame - b.startFrame);
  const emitted: AviChunk[] = [];
  const byFrame = avi.videoChunks;

  let frame = 0;
  const nonVideo = avi.chunks.filter((chunk) => chunk.frameIndex < 0);
  // Audio chunks are interleaved in the original order; for simplicity the
  // rewritten file keeps only video (the export pipeline muxes audio back).
  void nonVideo;

  const regionAt = (index: number): RegionTransform | null =>
    sorted.find((region) => index >= region.startFrame && index < region.endFrame) ?? null;

  while (frame < byFrame.length) {
    const chunk = byFrame[frame]!;
    const region = regionAt(frame);

    if (!region) {
      emitted.push(chunk);
      frame += 1;
      continue;
    }

    if (region.dropKeyframes && chunk.kind === 'I') {
      stats.droppedKeyframes += 1;
      frame += 1;
      continue;
    }

    if (region.skipAmount > 0) {
      const period = region.skipAmount + Math.max(1, region.skipEvery);
      const position = frame - region.startFrame;
      if (position > 0 && position % period < region.skipAmount) {
        stats.droppedFrames += 1;
        frame += 1;
        continue;
      }
    }

    if (region.reorder && chunk.kind === 'P' && frame + 1 < byFrame.length) {
      const next = byFrame[frame + 1]!;
      if (next.kind === 'P' && regionAt(frame + 1)) {
        if (frame % 2 === 0) {
          emitted.push(next, chunk);
        } else {
          emitted.push(chunk, next);
        }
        stats.reordered += 1;
        frame += 2;
        continue;
      }
    }

    emitted.push(chunk);
    const repeat = Math.max(1, Math.round(region.repeatCount));
    const hold = Math.max(0, Math.round(region.holdFrames));
    const repeats =
      repeat + (hold > 0 && (frame - region.startFrame) % Math.max(1, region.holdInterval) === 0 ? hold : 0);
    for (let r = 1; r < repeats; r += 1) {
      emitted.push(chunk);
      stats.duplicatedFrames += 1;
    }
    frame += 1;
  }

  stats.framesOut = emitted.length;
  const bytes = rebuildAvi(avi, emitted);
  return { bytes, stats };
}

function rebuildAvi(avi: AviFile, chunks: AviChunk[]): Uint8Array {
  const moviDataSize = chunks.reduce((sum, chunk) => sum + 8 + chunk.paddedSize, 0);
  const moviListSize = 4 + moviDataSize; // 'movi' + data
  const idx1Size = 16 * chunks.length;
  const headerSize = 12;
  const hdrlSize = 8 + avi.hdrl.byteLength - 8;
  void hdrlSize;
  const total = headerSize + avi.hdrl.byteLength + 8 + moviListSize + (chunks.length ? 8 + idx1Size : 0);

  const out = new Uint8Array(total + 1); // +1 keeps RIFF sizes even
  const view = new DataView(out.buffer);
  let cursor = 0;

  // RIFF header
  writeFourcc(view, cursor, 'RIFF');
  view.setUint32(cursor + 4, total - 8, true);
  writeFourcc(view, cursor + 8, 'AVI ');
  cursor += 12;

  // hdrl (copied verbatim: it holds avih/strh/strf)
  out.set(avi.hdrl, cursor);
  cursor += avi.hdrl.byteLength;

  // movi
  writeFourcc(view, cursor, 'LIST');
  view.setUint32(cursor + 4, moviListSize, true);
  writeFourcc(view, cursor + 8, 'movi');
  const moviDataStart = cursor + 12;
  cursor += 12;

  const indexEntries: { fourcc: string; flags: number; offset: number; size: number }[] = [];
  for (const chunk of chunks) {
    const relative = cursor - moviDataStart;
    writeFourcc(view, cursor, chunk.fourcc);
    view.setUint32(cursor + 4, chunk.size, true);
    out.set(avi.bytes.subarray(chunk.dataOffset, chunk.dataOffset + chunk.size), cursor + 8);
    indexEntries.push({
      fourcc: chunk.fourcc,
      flags: chunk.kind === 'I' ? AVIIF_KEYFRAME : 0,
      offset: relative,
      size: chunk.size,
    });
    cursor += 8 + chunk.paddedSize;
  }

  // idx1: offsets are relative to the start of the movi list data, which is the
  // convention ffmpeg's AVI demuxer uses when it resolves index entries.
  if (chunks.length) {
    writeFourcc(view, cursor, 'idx1');
    view.setUint32(cursor + 4, idx1Size, true);
    let entry = cursor + 8;
    for (const item of indexEntries) {
      writeFourcc(view, entry, item.fourcc);
      view.setUint32(entry + 4, item.flags, true);
      view.setUint32(entry + 8, item.offset, true);
      view.setUint32(entry + 12, item.size, true);
      entry += 16;
    }
    cursor += 8 + idx1Size;
  }

  return out.subarray(0, Math.min(out.length, cursor));
}

function writeFourcc(view: DataView, offset: number, value: string): void {
  for (let i = 0; i < 4; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
}

/** Builds a RegionTransform from resolved datamosh parameters. */
export function regionTransformFromParams(
  startFrame: number,
  endFrame: number,
  params: Record<string, unknown>,
): RegionTransform {
  const num = (key: string, fallback: number): number => {
    const value = params[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && Number(value)) return Number(value);
    return fallback;
  };
  const speed = num('speed', 1);
  const dropKeyframes = params.iframeDrop === false ? false : true;
  // A slow-motion parameter is expressed as frame repetition on the bitstream
  // side, mirroring what the frame scheduler does in the preview.
  const repeatFromSpeed = speed < 1 ? Math.min(6, Math.max(1, Math.round(1 / Math.max(0.05, speed)))) : 1;
  return {
    startFrame,
    endFrame,
    dropKeyframes,
    repeatCount: Math.max(repeatFromSpeed, num('repeatCount', 1)),
    repeatInterval: Math.max(1, num('repeatInterval', 1)),
    holdFrames: num('holdFrames', 0),
    holdInterval: Math.max(1, num('repeatInterval', 1)),
    skipAmount: speed > 1 ? Math.max(num('skipAmount', 0), Math.round(speed) - 1) : num('skipAmount', 0),
    skipEvery: Math.max(1, num('repeatInterval', 1)),
    reorder: num('swapWeight', 0) > 0 || num('corruption', 0) > 40,
  };
}

export const AVI_HELPERS = {
  fourcc,
  LIST,
  MOVI,
  IDX1,
  RIFF,
  AVI_,
};
