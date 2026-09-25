/**
 * Minimal MP4/MOV index reader.
 *
 * We need three things to drive WebCodecs frame-accurately:
 *   - the exact byte offset/size/timestamp of every encoded sample,
 *   - which samples are sync samples (I-frames),
 *   - the codec description box (avcC / hvcC / av1C / vpcC) as a codec string.
 *
 * Both plain (moov/stbl) and fragmented (moof/traf/trun) files are supported.
 * Anything unexpected makes `readMp4Index` return null, and the app then falls
 * back to the video-element frame source instead of failing.
 */

export interface Mp4Sample {
  offset: number;
  size: number;
  dts: number;
  cts: number;
  duration: number;
  isKey: boolean;
}

export interface Mp4Index {
  container: string;
  codec: string;
  /** Codec-specific description box payload (avcC/hvcC/...), if present. */
  description: Uint8Array | null;
  width: number;
  height: number;
  timescale: number;
  durationSec: number;
  sampleCount: number;
  hasAudio: boolean;
  audioCodec: string | null;
  samples: Mp4Sample[];
  /** Byte ranges needed to decode (kept for diagnostics). */
  fragmented: boolean;
}

const VIDEO_FOURCC = ['avc1', 'avc3', 'hev1', 'hvc1', 'av01', 'vp08', 'vp09', 'mp4v', 'dvh1', 'dvhe'];

export function isMp4Family(name: string, mime = ''): boolean {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  if (['mp4', 'm4v', 'mov', 'm4a'].includes(ext)) return true;
  return /mp4|quicktime/i.test(mime);
}

interface Box {
  type: string;
  start: number;
  size: number;
  headerSize: number;
  contentStart: number;
  contentEnd: number;
}

function readBox(view: DataView, start: number, limit: number): Box | null {
  if (start + 8 > limit) return null;
  let size = view.getUint32(start);
  const type = boxType(view, start + 4);
  let headerSize = 8;
  if (size === 1) {
    if (start + 16 > limit) return null;
    const high = view.getUint32(start + 8);
    const low = view.getUint32(start + 12);
    size = high * 4294967296 + low;
    headerSize = 16;
  } else if (size === 0) {
    size = limit - start;
  }
  if (size < headerSize || start + size > limit) return null;
  return { type, start, size, headerSize, contentStart: start + headerSize, contentEnd: start + size };
}

function boxType(view: DataView, at: number): string {
  return String.fromCharCode(
    view.getUint8(at),
    view.getUint8(at + 1),
    view.getUint8(at + 2),
    view.getUint8(at + 3),
  );
}

function findBox(view: DataView, start: number, end: number, type: string): Box | null {
  let cursor = start;
  while (cursor + 8 <= end) {
    const box = readBox(view, cursor, end);
    if (!box) return null;
    if (box.type === type) return box;
    cursor = box.start + box.size;
  }
  return null;
}

function listBoxes(view: DataView, start: number, end: number): Box[] {
  const boxes: Box[] = [];
  let cursor = start;
  while (cursor + 8 <= end) {
    const box = readBox(view, cursor, end);
    if (!box) break;
    boxes.push(box);
    cursor = box.start + box.size;
  }
  return boxes;
}

export async function readMp4Index(file: File): Promise<Mp4Index | null> {
  const buffer = await file.arrayBuffer();
  return parseMp4(new Uint8Array(buffer), file.name);
}

export function parseMp4(bytes: Uint8Array, name = 'video.mp4'): Mp4Index | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const limit = bytes.byteLength;

  const moov = findBox(view, 0, limit, 'moov');
  const tracks = moov ? listBoxes(view, moov.contentStart, moov.contentEnd).filter((b) => b.type === 'trak') : [];

  let videoTrack: VideoTrackInfo | null = null;
  let audioTrack: TrackSummary | null = null;

  for (const trak of tracks) {
    const info = readTrack(view, trak, bytes);
    if (!info) continue;
    if (info.kind === 'video' && !videoTrack) videoTrack = info;
    if (info.kind === 'audio' && !audioTrack) audioTrack = info;
  }

  if (!moov && !videoTrack) {
    // Fragmented files may have no moov at all; try to read the init segment.
    const ftyp = findBox(view, 0, limit, 'ftyp');
    if (!ftyp) return null;
  }

  if (!videoTrack) return null;

  let samples = videoTrack.samples;
  let fragmented = false;

  // Fragmented MP4: moof/traf/trun carry the real sample table. If these exist,
  // they are authoritative and replace whatever stbl said.
  const fragments = collectFragments(view, limit, videoTrack.trackId, bytes);
  if (fragments.length) {
    fragments.sort((a, b) => a.dts - b.dts);
    samples = fragments;
    fragmented = true;
  }

  if (!samples.length) return null;

  const timescale = videoTrack.timescale || 1000;
  const durationSec = fragmented
    ? (samples.reduce((max, s) => Math.max(max, s.dts + s.duration), 0)) / timescale
    : (videoTrack.durationTicks > 0 ? videoTrack.durationTicks : samples.reduce((a, s) => a + s.duration, 0)) /
      timescale;

  return {
    container: name.slice(name.lastIndexOf('.') + 1).toLowerCase() || 'mp4',
    codec: videoTrack.codec,
    description: videoTrack.description,
    width: videoTrack.width,
    height: videoTrack.height,
    timescale,
    durationSec,
    sampleCount: samples.length,
    hasAudio: !!audioTrack,
    audioCodec: audioTrack?.codec ?? null,
    samples,
    fragmented,
  };
}

interface TrackSummary {
  trackId: number;
  kind: 'video' | 'audio' | 'other';
  codec: string;
  timescale: number;
  durationTicks: number;
}

interface VideoTrackInfo extends TrackSummary {
  width: number;
  height: number;
  description: Uint8Array | null;
  samples: Mp4Sample[];
}

function readTrack(view: DataView, trak: Box, bytes: Uint8Array): VideoTrackInfo | null {
  const tkhd = findBox(view, trak.contentStart, trak.contentEnd, 'tkhd');
  const mdia = findBox(view, trak.contentStart, trak.contentEnd, 'mdia');
  if (!mdia) return null;
  const mdhd = findBox(view, mdia.contentStart, mdia.contentEnd, 'mdhd');
  const hdlr = findBox(view, mdia.contentStart, mdia.contentEnd, 'hdlr');
  const minf = findBox(view, mdia.contentStart, mdia.contentEnd, 'minf');
  if (!mdhd || !hdlr || !minf) return null;
  const stbl = findBox(view, minf.contentStart, minf.contentEnd, 'stbl');
  if (!stbl) return null;

  const trackId = tkhd ? view.getUint32(tkhd.contentStart + (version(tkhd, view) === 1 ? 16 : 8)) : 1;
  const handler = boxType(view, hdlr.contentStart + 8);
  const kind: TrackSummary['kind'] = handler === 'vide' ? 'video' : handler === 'soun' ? 'audio' : 'other';

  const versionMdhd = version(mdhd, view);
  const timescale = versionMdhd === 1
    ? view.getUint32(mdhd.contentStart + 20)
    : view.getUint32(mdhd.contentStart + 12);
  const durationTicks = versionMdhd === 1
    ? readUint64(view, mdhd.contentStart + 24)
    : view.getUint32(mdhd.contentStart + 16);

  const stsd = findBox(view, stbl.contentStart, stbl.contentEnd, 'stsd');
  const entry = stsd ? readFirstSampleEntry(view, stsd) : null;
  const fourcc = entry ? boxType(view, entry.start + 4) : '';
  const codec = fourcc ? codecString(fourcc, entry!, view, bytes) : '';
  const description = entry ? codecDescription(fourcc, entry, view, bytes) : null;

  let width = 0;
  let height = 0;
  if (kind === 'video' && entry) {
    width = view.getUint16(entry.start + entry.headerSize + 24);
    height = view.getUint16(entry.start + entry.headerSize + 26);
    if (!width || !height) {
      width = view.getUint16(entry.start + entry.headerSize + 32);
      height = view.getUint16(entry.start + entry.headerSize + 34);
    }
  }

  const samples = kind === 'video' ? buildSampleTable(view, stbl) : [];

  return { trackId, kind, codec, timescale, durationTicks, width, height, description, samples };
}

function version(box: Box, view: DataView): number {
  return view.getUint8(box.contentStart);
}

function readUint64(view: DataView, at: number): number {
  return view.getUint32(at) * 4294967296 + view.getUint32(at + 4);
}

function readFirstSampleEntry(view: DataView, stsd: Box): Box | null {
  // FullBox: 4 bytes version/flags, 4 bytes entry count.
  const first = readBox(view, stsd.contentStart + 8, stsd.contentEnd);
  return first;
}

function codecDescription(
  fourcc: string,
  entry: Box,
  view: DataView,
  bytes: Uint8Array,
): Uint8Array | null {
  const childrenStart = entry.contentStart + (isVideoSampleEntry(fourcc) ? 78 : 28);
  const wanted = ['avcC', 'hvcC', 'av1C', 'vpcC', 'esds', 'dOps'].find((type) =>
    findBox(view, childrenStart, entry.contentEnd, type),
  );
  if (!wanted) return null;
  const box = findBox(view, childrenStart, entry.contentEnd, wanted);
  if (!box) return null;
  if (wanted === 'esds') return null; // audio only
  return bytes.slice(box.contentStart, box.contentEnd);
}

function isVideoSampleEntry(fourcc: string): boolean {
  return VIDEO_FOURCC.includes(fourcc) || fourcc === 'mp4v';
}

function codecString(fourcc: string, entry: Box, view: DataView, bytes: Uint8Array): string {
  if (fourcc === 'avc1' || fourcc === 'avc3') {
    const avcC = findBox(view, entry.contentStart + 78, entry.contentEnd, 'avcC');
    if (avcC) {
      const p = avcC.contentStart;
      return `${fourcc}.${hex2(view.getUint8(p + 1))}${hex2(view.getUint8(p + 2))}${hex2(view.getUint8(p + 3))}`;
    }
    return fourcc;
  }
  if (fourcc === 'hev1' || fourcc === 'hvc1') {
    const hvcC = findBox(view, entry.contentStart + 78, entry.contentEnd, 'hvcC');
    if (hvcC) return hevcCodecString(fourcc, view, hvcC.contentStart);
    return '';
  }
  if (fourcc === 'av01') {
    const av1C = findBox(view, entry.contentStart + 78, entry.contentEnd, 'av1C');
    if (av1C) {
      const p = av1C.contentStart;
      const profile = (view.getUint8(p + 1) >> 5) & 0x07;
      const level = view.getUint8(p + 1) & 0x1f;
      const tier = (view.getUint8(p + 2) >> 7) & 0x01;
      const high = (view.getUint8(p + 2) >> 6) & 0x01;
      const twelve = (view.getUint8(p + 2) >> 5) & 0x01;
      return `av01.${profile}.${String(level).padStart(2, '0')}${tier ? 'H' : 'M'}.${String(
        (high << 1) | twelve,
      ).padStart(2, '0')}`;
    }
    return '';
  }
  if (fourcc === 'vp09' || fourcc === 'vp08') {
    const vpcC = findBox(view, entry.contentStart + 78, entry.contentEnd, 'vpcC');
    if (vpcC) {
      const p = vpcC.contentStart + 4;
      const profile = view.getUint8(p);
      const level = view.getUint8(p + 1);
      const bitDepth = view.getUint8(p + 2) >> 4;
      return `${fourcc}.${String(profile).padStart(2, '0')}.${String(level).padStart(2, '0')}.${String(
        bitDepth,
      ).padStart(2, '0')}`;
    }
    return '';
  }
  void bytes;
  return '';
}

function hex2(value: number): string {
  return value.toString(16).padStart(2, '0');
}

function hevcCodecString(fourcc: string, view: DataView, p: number): string {
  const b1 = view.getUint8(p + 1);
  const profileSpace = ['', 'A', 'B', 'C'][(b1 >> 6) & 0x03] ?? '';
  const tier = (b1 & 0x20) !== 0 ? 'H' : 'L';
  const profileIdc = b1 & 0x1f;
  const compat = view.getUint32(p + 2);
  let reversed = 0;
  for (let i = 0; i < 32; i += 1) reversed = (reversed << 1) | ((compat >>> i) & 1);
  const compatHex = (reversed >>> 0).toString(16);
  const constraints = [
    view.getUint8(p + 6),
    view.getUint8(p + 7),
    view.getUint8(p + 8),
    view.getUint8(p + 9),
    view.getUint8(p + 10),
    view.getUint8(p + 11),
  ];
  let lastNonZero = constraints.length;
  while (lastNonZero > 0 && constraints[lastNonZero - 1] === 0) lastNonZero -= 1;
  const constraintHex = constraints
    .slice(0, Math.max(1, lastNonZero))
    .map(hex2)
    .join('');
  const level = view.getUint8(p + 12);
  return `${fourcc}.${profileSpace}${profileIdc}.${compatHex}.${tier}${level}.${constraintHex}`;
}

/** Expands run-length tables (stts / ctts / stsc) — unit tested. */
export function expandRuns(
  runs: [number, number][],
  totalSamples: number,
): { count: number; values: number[] } {
  const values: number[] = [];
  for (const [count, value] of runs) {
    for (let i = 0; i < count && values.length < totalSamples; i += 1) values.push(value);
  }
  return { count: values.length, values };
}

export interface StscEntry {
  firstChunk: number;
  samplesPerChunk: number;
}

/** Maps every chunk index (1-based) to its samples-per-chunk value — unit tested. */
export function chunkSampleCounts(entries: StscEntry[], chunkCount: number): number[] {
  const out = new Array<number>(Math.max(0, chunkCount)).fill(0);
  if (!entries.length) return out;
  const sorted = [...entries].sort((a, b) => a.firstChunk - b.firstChunk);
  for (let i = 0; i < sorted.length; i += 1) {
    const current = sorted[i]!;
    const next = sorted[i + 1];
    const start = Math.max(1, current.firstChunk);
    const end = next ? next.firstChunk : chunkCount + 1;
    for (let chunk = start; chunk < end && chunk <= chunkCount; chunk += 1) {
      out[chunk - 1] = current.samplesPerChunk;
    }
  }
  return out;
}

function buildSampleTable(view: DataView, stbl: Box): Mp4Sample[] {
  const stts = findBox(view, stbl.contentStart, stbl.contentEnd, 'stts');
  const stsz = findBox(view, stbl.contentStart, stbl.contentEnd, 'stsz');
  const stsc = findBox(view, stbl.contentStart, stbl.contentEnd, 'stsc');
  const stco = findBox(view, stbl.contentStart, stbl.contentEnd, 'stco');
  const co64 = findBox(view, stbl.contentStart, stbl.contentEnd, 'co64');
  const stss = findBox(view, stbl.contentStart, stbl.contentEnd, 'stss');
  const ctts = findBox(view, stbl.contentStart, stbl.contentEnd, 'ctts');
  if (!szBox(view, stsz) || !stsc || (!stco && !co64)) return [];

  // Sizes
  const sizeBox = stsz!;
  const defaultSize = view.getUint32(sizeBox.contentStart + 4);
  const sampleCount = view.getUint32(sizeBox.contentStart + 8);
  const sizes: number[] = new Array(sampleCount);
  if (defaultSize === 0) {
    for (let i = 0; i < sampleCount; i += 1) sizes[i] = view.getUint32(sizeBox.contentStart + 12 + i * 4);
  } else {
    sizes.fill(defaultSize);
  }

  // Durations
  const durations = new Array<number>(sampleCount).fill(0);
  if (stts) {
    const entryCount = view.getUint32(stts.contentStart + 4);
    const runs: [number, number][] = [];
    for (let i = 0; i < entryCount; i += 1) {
      const at = stts.contentStart + 8 + i * 8;
      runs.push([view.getUint32(at), view.getUint32(at + 4)]);
    }
    const { values } = expandRuns(runs, sampleCount);
    for (let i = 0; i < values.length; i += 1) durations[i] = values[i]!;
  }

  // Composition offsets
  const offsets = new Array<number>(sampleCount).fill(0);
  if (ctts) {
    const entryCount = view.getUint32(ctts.contentStart + 4);
    const versionCtts = view.getUint8(ctts.contentStart);
    const runs: [number, number][] = [];
    for (let i = 0; i < entryCount; i += 1) {
      const at = ctts.contentStart + 8 + i * 8;
      const count = view.getUint32(at);
      const value = versionCtts === 1 ? view.getInt32(at + 4) : view.getUint32(at + 4);
      runs.push([count, value]);
    }
    const { values } = expandRuns(runs, sampleCount);
    for (let i = 0; i < values.length; i += 1) offsets[i] = values[i]!;
  }

  // Chunk offsets
  let chunkOffsets: number[] = [];
  if (co64) {
    const entryCount = view.getUint32(co64.contentStart + 4);
    chunkOffsets = new Array(entryCount);
    for (let i = 0; i < entryCount; i += 1) {
      chunkOffsets[i] = readUint64(view, co64.contentStart + 8 + i * 8);
    }
  } else if (stco) {
    const entryCount = view.getUint32(stco.contentStart + 4);
    chunkOffsets = new Array(entryCount);
    for (let i = 0; i < entryCount; i += 1) {
      chunkOffsets[i] = view.getUint32(stco.contentStart + 8 + i * 4);
    }
  }

  // Sample-to-chunk
  const entryCount = view.getUint32(stsc.contentStart + 4);
  const entries: StscEntry[] = [];
  for (let i = 0; i < entryCount; i += 1) {
    const at = stsc.contentStart + 8 + i * 12;
    entries.push({ firstChunk: view.getUint32(at), samplesPerChunk: view.getUint32(at + 4) });
  }
  const perChunk = chunkSampleCounts(entries, chunkOffsets.length);

  // Sync samples
  const syncSet = new Set<number>();
  if (stss) {
    const count = view.getUint32(stss.contentStart + 4);
    for (let i = 0; i < count; i += 1) syncSet.add(view.getUint32(stss.contentStart + 8 + i * 4));
  }

  const samples: Mp4Sample[] = [];
  let sampleIndex = 0;
  let dts = 0;
  for (let chunk = 0; chunk < chunkOffsets.length && sampleIndex < sampleCount; chunk += 1) {
    let offset = chunkOffsets[chunk]!;
    const inChunk = perChunk[chunk] ?? 0;
    for (let s = 0; s < inChunk && sampleIndex < sampleCount; s += 1) {
      const size = sizes[sampleIndex]!;
      const duration = durations[sampleIndex] ?? durations[sampleIndex - 1] ?? 0;
      const cts = dts + (offsets[sampleIndex] ?? 0);
      samples.push({
        offset,
        size,
        dts,
        cts,
        duration,
        // Without an stss box every sample is a sync sample (all-intra).
        isKey: syncSet.size === 0 ? true : syncSet.has(sampleIndex + 1),
      });
      offset += size;
      dts += duration;
      sampleIndex += 1;
    }
  }

  // Order samples by decode time; WebCodecs requires monotonically increasing dts.
  samples.sort((a, b) => a.dts - b.dts);
  return samples;
}

function szBox(view: DataView, box: Box | null): boolean {
  return !!box && view.getUint32(box.contentStart + 4) >= 0;
}

/* ------------------------------------------------------------- fragmented */

function collectFragments(
  view: DataView,
  limit: number,
  trackId: number,
  bytes: Uint8Array,
): Mp4Sample[] {
  void bytes;
  const samples: Mp4Sample[] = [];
  let cursor = 0;
  let sawMoof = false;

  while (cursor + 8 <= limit) {
    const box = readBox(view, cursor, limit);
    if (!box) break;

    if (box.type === 'moof') {
      sawMoof = true;
      for (const traf of listBoxes(view, box.contentStart, box.contentEnd).filter(
        (b) => b.type === 'traf',
      )) {
        readTraf(view, traf, box.start, trackId, samples);
      }
    }
    cursor = box.start + box.size;
  }

  if (!sawMoof) return [];
  samples.sort((a, b) => a.dts - b.dts);
  return samples;
}

function readTraf(
  view: DataView,
  traf: Box,
  moofStart: number,
  trackId: number,
  out: Mp4Sample[],
): void {
  const tfhd = findBox(view, traf.contentStart, traf.contentEnd, 'tfhd');
  if (!tfhd) return;
  const flags = view.getUint32(tfhd.contentStart) & 0x00ffffff;
  let at = tfhd.contentStart + 4;
  const thisTrack = view.getUint32(at);
  at += 4;
  if (thisTrack !== trackId) return;

  let baseDataOffset = moofStart;
  let defaultSampleDuration = 0;
  let defaultSampleSize = 0;
  let defaultSampleFlags = 0;

  if (flags & 0x000001) {
    baseDataOffset = readUint64(view, at);
    at += 8;
  }
  if (flags & 0x000002) at += 4; // sample_description_index
  if (flags & 0x000008) {
    defaultSampleDuration = view.getUint32(at);
    at += 4;
  }
  if (flags & 0x000010) {
    defaultSampleSize = view.getUint32(at);
    at += 4;
  }
  if (flags & 0x000020) {
    defaultSampleFlags = view.getUint32(at);
    at += 4;
  }

  const tfdt = findBox(view, traf.contentStart, traf.contentEnd, 'tfdt');
  let dts = 0;
  if (tfdt) {
    const v = view.getUint8(tfdt.contentStart);
    dts = v === 1 ? readUint64(view, tfdt.contentStart + 4) : view.getUint32(tfdt.contentStart + 4);
  }

  for (const trun of listBoxes(view, traf.contentStart, traf.contentEnd).filter(
    (b) => b.type === 'trun',
  )) {
    const trunVersion = view.getUint8(trun.contentStart);
    const trunFlags = view.getUint32(trun.contentStart) & 0x00ffffff;
    const count = view.getUint32(trun.contentStart + 4);
    let p = trun.contentStart + 8;
    let dataOffset = 0;
    if (trunFlags & 0x000001) {
      dataOffset = view.getInt32(p);
      p += 4;
    }
    if (trunFlags & 0x000004) p += 4; // first_sample_flags
    let sampleOffset = baseDataOffset + dataOffset;

    for (let i = 0; i < count; i += 1) {
      let duration = defaultSampleDuration;
      let size = defaultSampleSize;
      let sampleFlags = defaultSampleFlags;
      let ctsOffset = 0;
      if (trunFlags & 0x000100) {
        duration = view.getUint32(p);
        p += 4;
      }
      if (trunFlags & 0x000200) {
        size = view.getUint32(p);
        p += 4;
      }
      if (trunFlags & 0x000400) {
        sampleFlags = view.getUint32(p);
        p += 4;
      }
      if (trunFlags & 0x000800) {
        ctsOffset = trunVersion === 1 ? view.getInt32(p) : view.getUint32(p);
        p += 4;
      }

      // Bit 16 of the sample flags is "sample_is_non_sync_sample".
      const isKey = (sampleFlags & 0x00010000) === 0;

      out.push({
        offset: sampleOffset,
        size,
        dts,
        cts: dts + ctsOffset,
        duration,
        isKey,
      });
      sampleOffset += size;
      dts += duration;
    }
  }
}
