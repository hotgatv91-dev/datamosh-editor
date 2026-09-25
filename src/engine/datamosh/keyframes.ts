/**
 * Keyframes: the very basic curve support the spec asks for.
 * A keyframe belongs to (effect, param, frame) and is intepreted as an absolute
 * timeline frame, so it stays valid when the effect block is dragged.
 * Keyframes move with the block because the drag operations shift them together.
 */

import type { Easing, Effect, Frame, Keyframe, ParamBag } from '../project/types';
import { PARAM_MAP, defaultParameters, normalizeParams } from './params';

export function easingFn(easing: Easing, t: number): number {
  switch (easing) {
    case 'easeIn':
      return t * t;
    case 'easeOut':
      return 1 - (1 - t) * (1 - t);
    case 'easeInOut':
      return t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);
    case 'linear':
    default:
      return t;
  }
}

export function keyframesForParam(effect: Effect, param: string): Keyframe[] {
  return effect.keyframes.filter((k) => k.param === param).sort((a, b) => a.frame - b.frame);
}

export function isAnimated(effect: Effect, param: string): boolean {
  return effect.keyframes.some((k) => k.param === param);
}

export function hasKeyframeAt(effect: Effect, param: string, frame: Frame): boolean {
  return effect.keyframes.some((k) => k.param === param && k.frame === Math.round(frame));
}

/**
 * Value of `param` at `frame`. Falls back to the effect's parameter bag when the
 * param is not animated, and clamps outside the keyframe range.
 */
export function valueAtFrame(effect: Effect, param: string, frame: Frame): number | null {
  const keys = keyframesForParam(effect, param);
  if (!keys.length) {
    const raw = effect.parameters[param];
    if (typeof raw === 'number') return raw;
    if (typeof raw === 'string' && raw !== '' && Number.isFinite(Number(raw))) return Number(raw);
    const def = PARAM_MAP[param];
    return def && typeof def.default === 'number' ? def.default : null;
  }
  const first = keys[0]!;
  if (frame <= first.frame) return first.value;
  const last = keys[keys.length - 1]!;
  if (frame >= last.frame) return last.value;

  for (let i = 0; i < keys.length - 1; i += 1) {
    const a = keys[i]!;
    const b = keys[i + 1]!;
    if (frame >= a.frame && frame <= b.frame) {
      const span = Math.max(1, b.frame - a.frame);
      const t = (frame - a.frame) / span;
      const eased = easingFn(a.easing, t);
      return a.value + (b.value - a.value) * eased;
    }
  }
  return last.value;
}

/**
 * The full parameter bag for a moment in time, with animated params replaced by
 * their interpolated value. Both backends consume this, so preview and export
 * always agree on what the settings are.
 */
export function resolveParams(effect: Effect, frame: Frame): ParamBag {
  const bag = normalizeParams(effect.parameters as Record<string, unknown>);
  if (!effect.keyframes.length) return bag;
  const params = new Set(effect.keyframes.map((k) => k.param));
  for (const param of params) {
    const value = valueAtFrame(effect, param, frame);
    if (value !== null && Number.isFinite(value)) bag[param] = roundIfNeeded(value);
  }
  return bag;
}

function roundIfNeeded(value: number): number {
  return Math.abs(value - Math.round(value)) < 0.0005 ? Math.round(value) : Number(value.toFixed(4));
}

/** 0 at the region start, 1 at the region end. Drives transition/acceleration. */
export function regionProgress(effect: Effect, frame: Frame): number {
  const length = Math.max(1, effect.endFrame - effect.startFrame);
  return Math.min(1, Math.max(0, (frame - effect.startFrame) / length));
}

/**
 * Fade envelope for the whole effect (used by Transition / fade in-out).
 * Returns 0..1 and is applied to the effect's strength, never to the raw frame.
 */
export function effectEnvelope(effect: Effect, frame: Frame, transitionFrames: number): number {
  if (transitionFrames <= 0) return 1;
  const progress = regionProgress(effect, frame);
  const length = Math.max(1, effect.endFrame - effect.startFrame);
  const ramp = Math.min(1, transitionFrames / length);
  if (progress < ramp) return progress / ramp;
  if (progress > 1 - ramp) return (1 - progress) / ramp;
  return 1;
}

export function defaultParamBag(): ParamBag {
  return defaultParameters();
}
