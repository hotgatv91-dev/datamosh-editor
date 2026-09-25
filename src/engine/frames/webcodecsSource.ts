/**
 * Frame-accurate frame source built on WebCodecs + our MP4 index.
 *
 * Decoding is GOP-aware: a request for frame N decodes forward from the nearest
 * preceding keyframe, and decoded frames are kept in a small LRU so that
 * motion estimation and frame persistence can look back a few frames cheaply.
 *
 * Ownership: the cache holds the decoded frames and closes them on eviction.
 * Callers receive a cheap `clone()` which THEY own and must close (the preview
 * renderer closes it right after uploading to a texture).
 */

import type { FrameImage, FrameSource, MediaInfo } from './types';
import type { Mp4Index, Mp4Sample } from './mp4Index';
import { readMp4Index } from './mp4Index';
import { normalizeFps } from './probe';
import { log } from '../log';

/**
 * Cache budget, not a frame count.
 *
 * A hardware H.264 decoder has a fixed output surface pool (~10-16 frames) and
 * stops emitting the moment the consumer holds them all — which is why this used
 * to be a flat four. We decode in software now (see config()), so the only
 * limit that matters is memory: hold too few frames and every request past the
 * window has to reset the decoder and re-decode from the keyframe, which costs
 * ~250 ms a time and is what made playback stutter. Hold too many and a 1080p
 * clip eats gigabytes.
 */
const MAX_CACHE_BYTES = 24 * 1024 * 1024;
const MIN_CACHED_FRAMES = 4;
const MAX_CACHED_FRAMES = 16;
const MAX_QUEUE = 8;
/**
 * How many extra samples to feed past the requested one. H.264 reorders frames
 * (B-frames), so the decoder needs samples that sit *after* the requested
 * presentation time before it can emit it.
 */
const LOOKAHEAD = 6;

interface Waiter {
  resolve: (frame: VideoFrame | null) => void;
  reject: (error: unknown) => void;
}

export interface WebCodecsSourceOptions {
  onFatal?: (error: Error) => void;
}

/**
 * A frame handed to a caller. It is always a real clone, because the caller
 * owns it and will close it — sharing the cache's frame here would let one
 * caller close a frame another one is still rendering. If cloning fails the
 * frame is unusable, so `null` is the honest answer.
 */
function cloneFrame(frame: VideoFrame): VideoFrame | null {
  try {
    return frame.clone();
  } catch {
    return null;
  }
}

export class WebCodecsFrameSource implements FrameSource {
  readonly kind = 'webcodecs' as const;
  readonly frameAccurate = true;
  readonly info: MediaInfo;

  private index: Mp4Index;
  private bytes: Uint8Array;
  private decoder: VideoDecoder | null = null;
  private configured = false;
  /**
   * True when the decoder will not accept a delta until a key frame arrives:
   * right after configure() and, in Chromium, right after flush() as well.
   */
  private needsKeyframe = false;
  private failed = false;

  private readonly presentationIndex: number[] = [];
  private readonly samplePresentationIndex: Int32Array;
  private readonly tsToPresentation = new Map<number, number>();
  private readonly tsToSampleIndex = new Map<number, number>();
  private readonly ctsUs: Float64Array;

  private cache = new Map<number, VideoFrame>();
  /** How many decoded frames this source may hold, from the cache budget. */
  private cacheLimit = MIN_CACHED_FRAMES;
  private waiters = new Map<number, Waiter[]>();

  /** Next sample (decode order) to hand to the decoder. */
  private nextDecodeIndex = 0;
  /** Decode index the current run restarted from. */
  private runStartDecodeIndex = -1;
  /**
   * Frontier of what the decoder has actually handed us.
   *
   * Two different things are easy to confuse here, and confusing them costs a
   * full seek (~250 ms) on most frames:
   *   - `lastOutputSampleIndex` is a DECODE-order index, used to spot progress;
   *   - `lastOutputPresentation` is a PRESENTATION index, and it is the only one
   *     that can answer "has frame N already been emitted?" — H.264 reorders
   *     frames, so the decoder emitting sample 161 says nothing about whether
   *     presentation frame 160 was emitted yet.
   */
  private lastOutputSampleIndex = -1;
  private lastOutputPresentation = -1;
  private activeTarget: number | null = null;
  private lock: Promise<void> = Promise.resolve();
  private onFatal?: (error: Error) => void;

  private constructor(index: Mp4Index, bytes: Uint8Array, info: MediaInfo, options: WebCodecsSourceOptions) {
    this.index = index;
    this.bytes = bytes;
    this.info = info;
    this.onFatal = options.onFatal;

    // Decoded frames are RGBA-ish buffers, so budget by resolution rather than
    // by count: a 720p clip can afford many more than a 4K one.
    const bytesPerFrame = Math.max(1, (index.width || 1280) * (index.height || 720) * 4);
    this.cacheLimit = Math.max(
      MIN_CACHED_FRAMES,
      Math.min(MAX_CACHED_FRAMES, Math.floor(MAX_CACHE_BYTES / bytesPerFrame)),
    );

    const order = index.samples.map((_, i) => i);
    order.sort((a, b) => (index.samples[a]!.cts - index.samples[b]!.cts) || (a - b));
    this.samplePresentationIndex = new Int32Array(index.samples.length).fill(-1);
    order.forEach((sampleIndex, presentation) => {
      this.presentationIndex[presentation] = sampleIndex;
      this.samplePresentationIndex[sampleIndex] = presentation;
    });

    this.ctsUs = new Float64Array(index.samples.length);
    for (let i = 0; i < index.samples.length; i += 1) {
      const us = Math.round((index.samples[i]!.cts * 1_000_000) / index.timescale);
      this.ctsUs[i] = us;
      this.tsToPresentation.set(us, this.samplePresentationIndex[i]!);
      this.tsToSampleIndex.set(us, i);
    }
  }

  static async open(
    file: File,
    options: WebCodecsSourceOptions = {},
  ): Promise<WebCodecsFrameSource | null> {
    if (typeof VideoDecoder === 'undefined') return null;
    const index = await readMp4Index(file);
    if (!index || !index.codec) return null;
    if (!index.samples.length) return null;
    if (!index.samples.some((s) => s.isKey)) return null;

    const bytes = new Uint8Array(await file.arrayBuffer());
    const info: MediaInfo = {
      name: file.name,
      sizeBytes: file.size,
      durationSec: index.durationSec,
      width: index.width,
      height: index.height,
      fps: normalizeFps(index.sampleCount / Math.max(0.001, index.durationSec)),
      container: index.container,
      videoCodec: index.codec,
      hasAudio: index.hasAudio,
      lastModified: file.lastModified,
    };
    const source = new WebCodecsFrameSource(index, bytes, info, options);

    const supported = await source.checkSupport();
    if (!supported) {
      log.warn('frames', `Codec not supported by WebCodecs: ${index.codec}`);
      return null;
    }
    return source;
  }

  private config(): VideoDecoderConfig {
    const description = this.index.description
      ? this.index.description.slice()
      : undefined;
    return {
      codec: this.index.codec,
      codedWidth: this.info.width || undefined,
      codedHeight: this.info.height || undefined,
      description,
      // Software decoding is used by default because it has no surface pool to
      // exhaust, which makes frame stepping deterministic on every machine.
      hardwareAcceleration: 'prefer-software',
      optimizeForLatency: true,
    };
  }

  private async checkSupport(): Promise<boolean> {
    try {
      const result = await VideoDecoder.isConfigSupported(this.config());
      return !!result.supported;
    } catch (error) {
      log.warn('frames', 'isConfigSupported failed', error);
      return false;
    }
  }

  get frameCount(): number {
    return this.index.samples.length;
  }

  async getFrame(frameIndex: number): Promise<FrameImage | null> {
    if (this.failed) return null;
    const total = this.presentationIndex.length;
    if (!total) return null;
    const target = Math.max(0, Math.min(total - 1, Math.round(frameIndex)));

    const cached = this.cache.get(target);
    if (cached) {
      this.cache.delete(target);
      this.cache.set(target, cached);
      return cloneFrame(cached);
    }

    return new Promise<VideoFrame | null>((resolve, reject) => {
      const list = this.waiters.get(target) ?? [];
      list.push({ resolve, reject });
      this.waiters.set(target, list);
      this.lock = this.lock.then(
        () => this.serve(target),
        () => this.serve(target),
      );
    });
  }

  prefetch(fromFrame: number, count: number): void {
    if (this.failed) return;
    const total = this.presentationIndex.length;
    const start = Math.max(0, Math.min(total - 1, Math.round(fromFrame)));
    const end = Math.min(total - 1, start + count - 1);
    for (let i = start; i <= end; i += 1) {
      if (this.cache.has(i) || this.waiters.has(i)) continue;
      // One at a time; serve() is serialised and keeps the window moving. The
      // frame is decoded for the cache's benefit only, so the clone that comes
      // back here is closed immediately: an unclosed VideoFrame pins a decoder
      // surface, and enough of those stall decoding altogether.
      void this.getFrame(i).then(
        (frame) => {
          if (frame instanceof VideoFrame || frame instanceof ImageBitmap) frame.close();
        },
        () => undefined,
      );
      break;
    }
  }

  private async serve(target: number): Promise<void> {
    if (this.failed) {
      this.flushWaiters(target, null);
      return;
    }
    if (this.cache.has(target)) {
      this.flushWaiters(target, this.cache.get(target)!);
      return;
    }

    try {
      if (!this.decoder) this.createDecoder();

      // Seek only when the requested frame cannot be produced by continuing the
      // current run: it sits before the run started, or the decoder has already
      // emitted it and it has since been evicted from the cache.
      const targetSample = this.presentationIndex[target] ?? 0;
      const needsSeek =
        !this.configured ||
        this.needsKeyframe ||
        targetSample < this.runStartDecodeIndex ||
        // Only a presentation-order comparison is valid here; see the field docs.
        target <= this.lastOutputPresentation;

      if (needsSeek) {
        await this.seekTo(target);
      }

      this.activeTarget = target;
      this.feedUntil(target, LOOKAHEAD);

      const frame = await this.waitForTarget(target);
      this.flushWaiters(target, frame);
    } catch (error) {
      log.error('frames', `decode failed at frame ${target}`, error);
      this.fail(error instanceof Error ? error : new Error(String(error)));
      this.flushWaiters(target, null);
    } finally {
      // A target that timed out must not stay pinned: `evictIfNeeded` skips the
      // active target, so a stale one would permanently hold a cache slot.
      if (this.activeTarget === target) this.activeTarget = null;
    }
  }

  private createDecoder(): void {
    this.decoder = new VideoDecoder({
      output: (frame) => this.onDecoded(frame),
      error: (error) => {
        log.error('frames', 'decoder error', error);
        this.fail(error instanceof Error ? error : new Error(String(error)));
      },
    });
  }

  private onDecoded(frame: VideoFrame): void {
    const presentation = this.tsToPresentation.get(frame.timestamp);
    const sampleIndex = this.tsToSampleIndex.get(frame.timestamp);
    if (presentation === undefined || sampleIndex === undefined) {
      frame.close();
      return;
    }
    this.lastOutputSampleIndex = Math.max(this.lastOutputSampleIndex, sampleIndex);
    this.lastOutputPresentation = Math.max(this.lastOutputPresentation, presentation);
    const existing = this.cache.get(presentation);
    if (existing && existing !== frame) existing.close();
    this.cache.set(presentation, frame);
    this.evictIfNeeded();

    const waiters = this.waiters.get(presentation);
    if (waiters?.length) {
      this.waiters.delete(presentation);
      waiters.forEach((w) => w.resolve(cloneFrame(frame)));
    }

    if (this.activeTarget !== null && presentation === this.activeTarget) {
      this.activeTarget = null;
    }
  }

  private evictIfNeeded(): void {
    if (this.cache.size <= this.cacheLimit) return;
    for (const key of [...this.cache.keys()]) {
      if (this.cache.size <= this.cacheLimit) break;
      // Never evict the frame the current request is waiting for.
      if (key === this.activeTarget || this.waiters.has(key)) continue;
      const frame = this.cache.get(key)!;
      this.cache.delete(key);
      frame.close();
    }
  }

  private async waitForTarget(target: number, attempt = 0): Promise<VideoFrame | null> {
    const deadline = performance.now() + 5000;
    let extra = LOOKAHEAD;
    let lastOutput = this.lastOutputSampleIndex;
    let stalledSince = performance.now();

    while (performance.now() < deadline) {
      // Return the cache's own frame; `flushWaiters` clones it per waiter. That
      // keeps the number of live VideoFrames exactly equal to the number of
      // callers that will close one.
      const frame = this.cache.get(target);
      if (frame) return frame;
      if (this.failed) return null;
      await new Promise((resolve) => setTimeout(resolve, 4));
      if (!this.decoder) return null;

      if (this.lastOutputSampleIndex !== lastOutput) {
        lastOutput = this.lastOutputSampleIndex;
        stalledSince = performance.now();
      }

      if (this.decoder.decodeQueueSize === 0 && !this.cache.has(target)) {
        // The queue drained without producing the frame (deep reordering or a
        // short GOP): widen the window and feed again before giving up.
        extra = Math.min(160, extra * 2);
        this.feedUntil(target, extra);
      } else if (this.decoder.decodeQueueSize > 0 && performance.now() - stalledSince > 260) {
        // The decoder accepted chunks but stopped emitting. Flushing completes
        // the pending work (and releases any held surfaces) without resetting
        // the stream, so we can keep decoding afterwards.
        stalledSince = performance.now();
        const flushed = await this.flushWithTimeout(400);
        try {
          if (flushed) {
            // The flush emptied the queue, but it also left the decoder needing
            // a key frame; carrying on with deltas is exactly what wedged this
            // source. Anchor the run at a sync sample and keep decoding.
            this.rewindToKeyframe(target);
          } else if (attempt < 2) {
            // flush() itself is now wedged, which is what an exhausted decoder
            // surface pool looks like from the outside. Waiting again would
            // hang this request (and everything queued behind it) forever, so
            // reset the decoder — that drops every surface it holds — and
            // restart from the nearest keyframe.
            log.warn('frames', `decoder stalled on frame ${target}; restarting from the keyframe`);
            await this.seekTo(target);
          } else {
            break;
          }
        } catch (error) {
          log.error('frames', 'restart after stall failed', error);
          break;
        }
        this.feedUntil(target, Math.min(160, LOOKAHEAD * (attempt + 2)));
        if (flushed) return this.waitForTarget(target, attempt + 1);
      }
    }
    log.warn('frames', `decode timeout waiting for frame ${target}`);
    return this.cache.get(target) ?? null;
  }

  /**
   * `flush()` never resolving is a real failure mode, not a theoretical one, so
   * the stall detector must not await it without a bound.
   */
  private async flushWithTimeout(ms: number): Promise<boolean> {
    const decoder = this.decoder;
    if (!decoder) return true;
    let timer = 0;
    const timeout = new Promise<boolean>((resolve) => {
      timer = window.setTimeout(() => resolve(false), ms);
    });
    try {
      const flushed = decoder.flush().then(
        () => true,
        () => false,
      );
      return await Promise.race([flushed, timeout]);
    } finally {
      window.clearTimeout(timer);
    }
  }

  private flushWaiters(target: number, frame: VideoFrame | null): void {
    const waiters = this.waiters.get(target);
    // No waiters means the frame is already where it belongs: in the cache.
    if (!waiters) return;
    this.waiters.delete(target);
    waiters.forEach((w) => w.resolve(frame ? cloneFrame(frame) : null));
  }

  private fail(error: Error): void {
    this.failed = true;
    for (const [, waiters] of this.waiters) waiters.forEach((w) => w.reject(error));
    this.waiters.clear();
    this.onFatal?.(error);
  }

  /**
   * Decode index of the last sync sample whose presentation order is <= target.
   *
   * A decoder only accepts a delta after a key frame, both cold and right after
   * flush(), so every stream restart has to be anchored to one of these.
   */
  private keySampleFor(target: number): number {
    let keySample = -1;
    for (let i = 0; i < this.index.samples.length; i += 1) {
      const sample = this.index.samples[i]!;
      if (!sample.isKey) continue;
      const presentation = this.samplePresentationIndex[i]!;
      if (presentation <= target) keySample = i;
      else break;
    }
    if (keySample < 0) keySample = this.index.samples.findIndex((s) => s.isKey);
    return keySample;
  }

  /**
   * Restarts the decode run at a sync sample without reconfiguring.
   *
   * Chromium's VideoDecoder refuses a delta after `flush()` — "A key frame is
   * required after configure() or flush()" — and an enqueue rejected that way
   * used to leave `nextDecodeIndex` pointing at a delta for good, so every
   * later request timed out on the same 5s deadline. Rewinding to the keyframe
   * is what makes a flushed decoder usable again.
   */
  private rewindToKeyframe(target: number): void {
    const keySample = this.keySampleFor(target);
    if (keySample < 0) return;
    this.nextDecodeIndex = keySample;
    this.runStartDecodeIndex = keySample;
    this.needsKeyframe = false;
  }

  private async seekTo(target: number): Promise<void> {
    const decoder = this.decoder!;
    const keySample = this.keySampleFor(target);
    if (keySample < 0) throw new Error('no keyframe available');

    if (this.configured) {
      try {
        decoder.reset();
      } catch {
        /* reset throws when the decoder was already closed */
      }
    }
    decoder.configure(this.config());
    this.configured = true;
    this.nextDecodeIndex = keySample;
    this.runStartDecodeIndex = keySample;
    this.lastOutputSampleIndex = -1;
    this.lastOutputPresentation = -1;
    this.needsKeyframe = false;
    // Decoded frames are kept: they are still valid pixels and they make
    // look-back (persistence, motion estimation) cheap.
  }

  /**
   * Feeds samples in DECODE order up to the requested presentation frame plus
   * `lookahead`. Presentation order is not monotonic here (B-frames), so the
   * loop is driven by decode index — that is the only ordering the decoder
   * accepts and the only one that guarantees the requested frame is emitted.
   */
  private feedUntil(target: number, lookahead: number): void {
    const decoder = this.decoder;
    if (!decoder) return;
    if (this.needsKeyframe) this.rewindToKeyframe(target);
    const samples = this.index.samples;
    const targetSample = this.presentationIndex[target] ?? 0;
    const lastToFeed = Math.min(samples.length - 1, targetSample + lookahead);
    while (this.nextDecodeIndex <= lastToFeed) {
      if (decoder.decodeQueueSize > MAX_QUEUE) break;
      const sampleIndex = this.nextDecodeIndex;
      const sample: Mp4Sample = samples[sampleIndex]!;
      const data = this.bytes.subarray(sample.offset, sample.offset + sample.size);
      try {
        decoder.decode(
          new EncodedVideoChunk({
            type: sample.isKey ? 'key' : 'delta',
            timestamp: this.ctsUs[sampleIndex]!,
            duration: Math.round((sample.duration * 1_000_000) / this.index.timescale),
            data,
          }),
        );
      } catch (error) {
        log.error('frames', `decode enqueue failed at sample ${sampleIndex}`, error);
        // A rejected delta means the stream is cold: the next attempt must
        // start at a sync sample rather than repeat this failure forever.
        this.needsKeyframe = true;
        break;
      }
      this.nextDecodeIndex += 1;
    }
  }

  dispose(): void {
    for (const [, frame] of this.cache) frame.close();
    this.cache.clear();
    this.waiters.clear();
    try {
      this.decoder?.close();
    } catch {
      /* already closed */
    }
    this.decoder = null;
    this.configured = false;
    this.bytes = new Uint8Array(0);
  }

  /** Frame timestamps in seconds, used by the export pipeline. */
  presentationTime(frameIndex: number): number {
    const sampleIndex = this.presentationIndex[frameIndex];
    if (sampleIndex === undefined) return 0;
    return this.index.samples[sampleIndex]!.cts / this.index.timescale;
  }
}
