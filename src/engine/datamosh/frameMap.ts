/**
 * The frame scheduler — real temporal frame manipulation, independent of any
 * renderer. Given an effect region it answers: "for output frame j of this
 * region, which source frame should be fed into the pipeline?"
 *
 * Everything here is deterministic (seeded PRNG, integer output), because the
 * export must reproduce byte-for-byte the frame order the preview showed.
 *
 * Mechanisms implemented:
 *   - time warp / speed curve  (normalised phase integration)
 *   - frame repeat             (each source frame emitted N times)
 *   - frame hold               (extra emissions every `repeatInterval` frames)
 *   - frame skip               (regular / random / burst dropout)
 *   - frame freeze             (frozen head of the region)
 */

import type { Effect, Frame, SpeedPoint } from '../project/types';
import { numParam, strParam } from './params';

export interface FrameMapOptions {
  /** Number of output frames in the region (timeline frames). */
  length: number;
  speedBase: number;
  speedCurve: SpeedPoint[];
  /** Per-output-frame speed coming from speed keyframes, when present. */
  speedByFrame?: Float32Array | null;
  repeatCount: number;
  repeatInterval: number;
  holdFrames: number;
  skipAmount: number;
  skipPattern: string;
  randomness: number;
  freezeDuration: number;
  seed: number;
}

/** Small deterministic PRNG (mulberry32) so preview === export. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Linear interpolation across the normalised speed curve. */
export function speedAtNormalised(curve: SpeedPoint[], at: number, fallback: number): number {
  if (!curve.length) return fallback;
  const clamped = Math.min(1, Math.max(0, at));
  const sorted = [...curve].sort((a, b) => a.at - b.at);
  const first = sorted[0]!;
  if (clamped <= first.at) return first.value;
  const last = sorted[sorted.length - 1]!;
  if (clamped >= last.at) return last.value;
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const a = sorted[i]!;
    const b = sorted[i + 1]!;
    if (clamped >= a.at && clamped <= b.at) {
      const span = Math.max(0.0001, b.at - a.at);
      const t = (clamped - a.at) / span;
      return a.value + (b.value - a.value) * t;
    }
  }
  return last.value;
}

export function buildFrameMap(options: FrameMapOptions): Int32Array {
  const length = Math.max(1, Math.floor(options.length));
  const out = new Int32Array(length);
  const rng = mulberry32(options.seed || 1);

  const repeatCount = clampInt(options.repeatCount, 1, 60);
  const repeatInterval = clampInt(options.repeatInterval, 1, 240);
  const holdFrames = clampInt(options.holdFrames, 0, 120);
  const skipAmount = clampInt(options.skipAmount, 0, 60);
  const freeze = clampInt(options.freezeDuration, 0, length);

  // --- 1. expand the source frames according to repeat / hold -------------
  const emissions: number[] = [];
  const expToSrc: number[] = [];
  for (let s = 0; s < length; s += 1) {
    const reps =
      repeatCount + (holdFrames > 0 && s % repeatInterval === 0 ? holdFrames : 0);
    for (let r = 0; r < reps; r += 1) {
      emissions.push(s);
      expToSrc.push(s);
    }
  }
  // Guard against absurd expansions on very long regions.
  const maxEmitted = 400_000;
  if (emissions.length > maxEmitted) {
    const stride = Math.ceil(emissions.length / maxEmitted);
    emissions.length = 0;
    for (let s = 0; s < length; s += 1) {
      const reps = repeatCount + (holdFrames > 0 && s % repeatInterval === 0 ? holdFrames : 0);
      const total = Math.max(1, Math.round(reps / stride));
      for (let r = 0; r < total; r += 1) emissions.push(s);
    }
  }
  const expandedCount = emissions.length;

  // --- 2. walk the expanded sequence at the speed-curve rate --------------
  let phase = 0;
  const speedByIdx = options.speedByFrame;
  for (let j = 0; j < length; j += 1) {
    const at = length <= 1 ? 0 : j / (length - 1);
    const keyframed = speedByIdx && j < speedByIdx.length ? speedByIdx[j] : undefined;
    const speed =
      keyframed !== undefined && Number.isFinite(keyframed) && keyframed > 0
        ? keyframed
        : speedAtNormalised(options.speedCurve, at, options.speedBase);
    // floor() (not round) is what makes a speed of 0.5 emit 100,100,101,101:
    // the phase is the integral of the speed curve, so each integer step is one
    // emitted source frame.
    const srcIndex = Math.min(expandedCount - 1, Math.max(0, Math.floor(phase)));
    out[j] = emissions[srcIndex] ?? 0;
    phase += Math.max(0.02, speed);
  }

  // --- 3. skip / dropout --------------------------------------------------
  if (skipAmount > 0) {
    const pattern = options.skipPattern || 'regular';
    const period = skipAmount + 1;
    for (let j = 0; j < length; j += 1) {
      let drop = false;
      if (pattern === 'random') {
        const chance = Math.min(0.95, (options.randomness / 100) * (skipAmount / 3));
        drop = rng() < chance;
      } else if (pattern === 'burst') {
        const blockSize = Math.max(2, skipAmount * 4);
        drop = Math.floor(j / blockSize) % 2 === 1 && j % period !== 0;
      } else {
        drop = j > 0 && j % period === 0;
      }
      if (drop) out[j] = out[j - 1] ?? out[j] ?? 0;
    }
  }

  // --- 4. freeze the head of the region ----------------------------------
  if (freeze > 1) {
    const frozen = out[Math.min(length - 1, freeze)] ?? 0;
    for (let j = 0; j < freeze && j < length; j += 1) out[j] = frozen;
  }

  // --- 5. clamp ----------------------------------------------------------
  for (let j = 0; j < length; j += 1) {
    out[j] = Math.min(length - 1, Math.max(0, out[j] ?? 0));
  }
  return out;
}

function clampInt(value: number, min: number, max: number): number {
  const rounded = Math.round(Number.isFinite(value) ? value : min);
  return Math.min(max, Math.max(min, rounded));
}

/** Reads the frame-scheduling parameters out of a resolved parameter bag. */
export function frameMapOptionsFromParams(
  effect: Effect,
  params: Record<string, unknown>,
  length: number,
  seed?: number,
): FrameMapOptions {
  return {
    length,
    speedBase: numParam(params, 'speed', 1),
    speedCurve: effect.speedCurve,
    speedByFrame: null,
    repeatCount: numParam(params, 'repeatCount', 1),
    repeatInterval: numParam(params, 'repeatInterval', 1),
    holdFrames: numParam(params, 'holdFrames', 0),
    skipAmount: numParam(params, 'skipAmount', 0),
    skipPattern: strParam(params, 'skipPattern', 'regular'),
    randomness: numParam(params, 'randomness', 0),
    freezeDuration: numParam(params, 'freezeDuration', 0),
    seed: seed ?? hashString(effect.id),
  };
}

/** Cheap signature used to invalidate cached maps. */
export function frameMapSignature(options: FrameMapOptions): string {
  return [
    options.length,
    options.speedBase,
    options.speedCurve.map((p) => `${p.at.toFixed(3)}:${p.value.toFixed(3)}`).join(','),
    options.repeatCount,
    options.repeatInterval,
    options.holdFrames,
    options.skipAmount,
    options.skipPattern,
    options.randomness,
    options.freezeDuration,
    options.seed,
  ].join('|');
}

export function identityFrameMap(length: number): Int32Array {
  const map = new Int32Array(Math.max(1, length));
  for (let i = 0; i < map.length; i += 1) map[i] = i;
  return map;
}

export type FrameMap = Int32Array;
export type { Frame };
