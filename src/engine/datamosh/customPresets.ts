/**
 * User-authored datamosh presets.
 *
 * A custom preset is the same shape as a built-in one (see presets.ts), so the
 * whole preset machinery — merging over the schema defaults, materialising
 * normalised keyframes — keeps working without a second code path. The only
 * difference is where it is stored: the user's browser, not the source tree.
 *
 * Keyframes are stored region-relative (`at` in 0..1) exactly like a built-in
 * preset, so a preset saved on a 40-frame region applies correctly to a
 * 200-frame one.
 */

import type { Effect, ParamBag } from '../project/types';
import type { PresetKeyframeSpec } from './presets';
import { normalizeKeyframeSpecs } from './presets';

export interface CustomPreset {
  id: string;
  label: string;
  description: string;
  /** Preset-own controls worth surfacing first, mirroring DatamoshPreset. */
  relevant: string[];
  params: ParamBag;
  keyframes: PresetKeyframeSpec[];
  speedCurve?: Effect['speedCurve'];
  createdAt: number;
}

const STORAGE_KEY = 'datamosh.customPresets.v1';
export const MAX_PRESETS = 40;

/** Params that belong to the preset's identity, not to a preset bundle. */
const NON_PRESET_KEYS = new Set(['preset']);

function isCustomPreset(value: unknown): value is CustomPreset {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<CustomPreset>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.label === 'string' &&
    !!candidate.params &&
    typeof candidate.params === 'object'
  );
}

/**
 * localStorage is the right home for these: presets are tiny, must survive a
 * reload, and must never end up in the project file that gets saved/shared.
 */
export function loadCustomPresets(): CustomPreset[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isCustomPreset).map((preset) => ({
      ...preset,
      relevant: Array.isArray(preset.relevant) ? preset.relevant : [],
      keyframes: Array.isArray(preset.keyframes) ? preset.keyframes : [],
    }));
  } catch {
    // Private mode, a quota error, or hand-edited JSON: presets are a
    // convenience, never a reason to fail startup.
    return [];
  }
}

export function persistCustomPresets(presets: CustomPreset[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(presets.slice(0, MAX_PRESETS)));
  } catch {
    /* storage unavailable — the presets still work for this session */
  }
}

export function customPresetId(): string {
  return `user_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Captures an effect as a re-usable preset. Keyframes are converted from
 * absolute timeline frames to region-relative positions so the preset is not
 * tied to the region it was created from.
 */
export function snapshotEffectAsPreset(effect: Effect, label: string): CustomPreset {
  const anchored = effect.keyframes.filter((key) => {
    const param = key.param;
    return !NON_PRESET_KEYS.has(param);
  });
  return {
    id: customPresetId(),
    label: label.trim().slice(0, 40) || 'Preset của tôi',
    description: `Preset tự lưu từ vùng ${effect.endFrame - effect.startFrame} frame.`,
    relevant: [...new Set(anchored.map((key) => key.param))],
    params: { ...effect.parameters },
    keyframes: normalizeKeyframeSpecs(anchored, effect),
    speedCurve: effect.speedCurve.length ? effect.speedCurve.map((point) => ({ ...point })) : undefined,
    createdAt: Date.now(),
  };
}
