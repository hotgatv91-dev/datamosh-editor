/**
 * Datamosh presets. A preset is nothing more than a parameter bundle over
 * params.ts plus a normalised keyframe curve, so a preset can never drift away
 * from the manual controls — "Custom" is simply the same effect with no bundle.
 */

import type { Effect, Keyframe, ParamBag } from '../project/types';
import { defaultParameters, normalizeParams } from './params';

export interface PresetKeyframeSpec {
  param: string;
  /** Normalised position inside the effect region (0..1). */
  at: number;
  value: number;
}

export interface DatamoshPreset {
  id: string;
  label: string;
  description: string;
  /** Only these preset-own controls are shown in Simple mode. */
  relevant: string[];
  params: Partial<ParamBag>;
  keyframes?: PresetKeyframeSpec[];
  /** Renders best with the real bitstream backend. */
  prefersBitstream?: boolean;
}

export const DATAMOSH_PRESETS: DatamoshPreset[] = [
  {
    id: 'classic',
    label: 'Classic',
    description: 'Gỡ I-frame để chuyển động của cảnh trước trôi sang cảnh sau.',
    relevant: ['intensity', 'persistence', 'decay', 'iframeDrop', 'gopSize'],
    params: { intensity: 100, motion: 60, stretch: 25, persistence: 55, decay: 10, smearLength: 30 },
    prefersBitstream: true,
  },
  {
    id: 'motion-stretch',
    label: 'Motion Stretch',
    description: 'Kéo dài hình ảnh theo chuyển động.',
    relevant: ['stretch', 'motion', 'direction', 'persistence', 'decay'],
    params: { intensity: 90, motion: 130, stretch: 150, direction: 0, persistence: 50, decay: 8 },
  },
  {
    id: 'motion-smear',
    label: 'Motion Smear',
    description: 'Hình ảnh bị kéo thành vệt theo chuyển động.',
    relevant: ['smearLength', 'frameInfluence', 'persistence', 'decay', 'motion'],
    params: {
      smearLength: 80,
      frameInfluence: 70,
      persistence: 75,
      decay: 18,
      motion: 110,
      stretch: 60,
    },
  },
  {
    id: 'slow-motion',
    label: 'Slow Motion',
    description: 'Làm chuyển động chậm và kéo dài.',
    relevant: ['speed', 'persistence', 'holdFrames', 'repeatCount', 'stretch', 'decay'],
    params: {
      speed: 0.5,
      holdFrames: 4,
      repeatCount: 2,
      persistence: 65,
      stretch: 60,
      decay: 12,
      motion: 70,
    },
    keyframes: [
      { param: 'speed', at: 0, value: 1 },
      { param: 'speed', at: 0.25, value: 0.5 },
      { param: 'speed', at: 0.6, value: 0.25 },
      { param: 'speed', at: 1, value: 1 },
    ],
  },
  {
    id: 'frame-hold',
    label: 'Frame Hold',
    description: 'Giữ nguyên chuyển động trong một khoảng thời gian.',
    relevant: ['holdFrames', 'persistence', 'decay', 'frameInfluence'],
    params: { holdFrames: 12, persistence: 80, decay: 0, frameInfluence: 60, stretch: 30 },
  },
  {
    id: 'frame-repeat',
    label: 'Frame Repeat',
    description: 'Lặp lại frame hoặc nhóm frame.',
    relevant: ['repeatCount', 'repeatInterval', 'holdFrames', 'persistence'],
    params: { repeatCount: 3, repeatInterval: 1, holdFrames: 2, persistence: 60, decay: 6 },
  },
  {
    id: 'frame-skip',
    label: 'Frame Skip',
    description: 'Bỏ qua frame để chuyển động giật và nhảy.',
    relevant: ['skipAmount', 'skipPattern', 'randomness', 'persistence'],
    params: { skipAmount: 2, skipPattern: 'regular', randomness: 30, persistence: 35 },
  },
  {
    id: 'frame-melt',
    label: 'Frame Melt',
    description: 'Làm hình ảnh trôi và biến dạng theo chuyển động.',
    relevant: ['persistence', 'decay', 'smearLength', 'motion', 'temporalOffset'],
    params: {
      persistence: 88,
      decay: 22,
      smearLength: 70,
      motion: 120,
      temporalOffset: 4,
      stretch: 70,
    },
  },
  {
    id: 'freeze-warp',
    label: 'Freeze Warp',
    description: 'Đóng băng hình ảnh rồi kéo biến dạng theo chuyển động.',
    relevant: ['freezeDuration', 'transition', 'stretch', 'motion'],
    params: { freezeDuration: 18, transition: 12, stretch: 130, motion: 120, persistence: 60 },
  },
  {
    id: 'extreme',
    label: 'Extreme',
    description: 'Đẩy mọi thông số lên mức tối đa.',
    relevant: ['intensity', 'motion', 'stretch', 'persistence', 'randomness', 'corruption'],
    params: {
      intensity: 200,
      motion: 200,
      stretch: 200,
      persistence: 95,
      decay: 40,
      randomness: 35,
      corruption: 25,
      smearLength: 90,
    },
  },
  {
    id: 'vhs-drag',
    label: 'VHS Tape Drag',
    description: 'Mô phỏng băng VHS bị kẹt, kéo giãn hình ảnh và âm thanh theo chiều dọc.',
    relevant: ['stretch', 'direction', 'persistence', 'decay', 'audioAmount', 'speed'],
    params: { 
      intensity: 120, 
      motion: 80, 
      stretch: 180, 
      direction: 180,
      persistence: 70, 
      decay: 8,
      speed: 0.6,
      audioAmount: 100,
    },
  },
  {
    id: 'tape-stutter',
    label: 'Analog Tape Stutter',
    description: 'Mô phỏng băng bị giật cục, âm thanh và hình ảnh lặp lại ngắt quãng.',
    relevant: ['holdFrames', 'repeatCount', 'persistence', 'corruption', 'audioAmount'],
    params: { 
      holdFrames: 6, 
      repeatCount: 4, 
      persistence: 80, 
      decay: 0, 
      corruption: 15,
      intensity: 80,
      stretch: 40,
      audioAmount: 100,
    },
  },
  {
    id: 'analog-melt',
    label: 'Analog Melt',
    description: 'Hình ảnh và âm thanh tan chảy từ từ như nhựa nóng.',
    relevant: ['persistence', 'decay', 'smearLength', 'direction', 'audioAmount', 'speed'],
    params: {
      persistence: 90,
      decay: 10,
      smearLength: 100,
      motion: 100,
      stretch: 120,
      direction: 160,
      speed: 0.4,
      temporalOffset: 8,
      audioAmount: 100,
    },
  },
  {
    id: 'monster-attack',
    label: 'Monster Attack',
    description:
      'Nhân vật lao tới camera: chậm lại, hình ảnh kéo dài, biến dạng mạnh rồi trở lại bình thường.',
    relevant: ['intensity', 'motion', 'stretch', 'persistence', 'holdFrames', 'speed'],
    params: {
      intensity: 140,
      motion: 175,
      stretch: 150,
      persistence: 82,
      holdFrames: 5,
      repeatCount: 2,
      smearLength: 75,
      decay: 20,
      temporalOffset: 5,
      acceleration: 45,
      speed: 0.8,
    },
    keyframes: [
      { param: 'intensity', at: 0, value: 25 },
      { param: 'intensity', at: 0.3, value: 180 },
      { param: 'intensity', at: 0.75, value: 200 },
      { param: 'intensity', at: 1, value: 40 },
      { param: 'stretch', at: 0, value: 30 },
      { param: 'stretch', at: 0.35, value: 190 },
      { param: 'stretch', at: 0.8, value: 160 },
      { param: 'stretch', at: 1, value: 30 },
      { param: 'speed', at: 0, value: 1 },
      { param: 'speed', at: 0.3, value: 0.35 },
      { param: 'speed', at: 0.7, value: 0.3 },
      { param: 'speed', at: 1, value: 1 },
      { param: 'persistence', at: 0, value: 40 },
      { param: 'persistence', at: 0.5, value: 95 },
      { param: 'persistence', at: 1, value: 45 },
    ],
    prefersBitstream: true,
  },
  {
    id: 'face-distortion',
    label: 'Face Distortion',
    description: 'Bóp méo khuôn mặt và chi tiết nhỏ theo chuyển động.',
    relevant: ['motion', 'stretch', 'temporalOffset', 'persistence', 'direction', 'blockSize'],
    params: {
      motion: 160,
      stretch: 120,
      temporalOffset: 6,
      persistence: 72,
      decay: 16,
      blockSize: '4',
      mvPrecision: 4,
      direction: 0,
    },
  },
  {
    id: 'custom',
    label: 'Custom',
    description: 'Tự chỉnh toàn bộ thông số, không dùng preset.',
    relevant: [
      'intensity',
      'motion',
      'stretch',
      'speed',
      'persistence',
      'decay',
      'holdFrames',
      'repeatCount',
      'skipAmount',
      'randomness',
    ],
    params: {},
  },
];

export const PRESET_MAP: Record<string, DatamoshPreset> = Object.fromEntries(
  DATAMOSH_PRESETS.map((p) => [p.id, p]),
);

export function presetById(id: string | null | undefined): DatamoshPreset | null {
  if (!id) return null;
  return PRESET_MAP[id] ?? null;
}

export const DEFAULT_DATAMOSH_PRESET = 'classic';

/**
 * Preset bundles merged over the schema defaults.
 *
 * Takes the bundles directly rather than an id so a user-authored preset —
 * which is not in PRESET_MAP — goes through exactly the same path as a
 * built-in one.
 */
export function parametersFromBundles(...bundles: (Partial<ParamBag> | undefined)[]): ParamBag {
  const base = defaultParameters();
  for (const bundle of bundles) {
    if (bundle) Object.assign(base, bundle);
  }
  return normalizeParams(base);
}

/** Preset bundle merged over the schema defaults. */
export function parametersForPreset(presetId: string): ParamBag {
  return parametersFromBundles(presetById(presetId)?.params);
}

export interface MaterializedPreset {
  parameters: ParamBag;
  keyframes: Keyframe[];
}

/** Turn normalised keyframe specs into real timeline keyframes for an effect. */
export function materializeKeyframes(
  specs: PresetKeyframeSpec[],
  effect: Pick<Effect, 'id' | 'startFrame' | 'endFrame'>,
): Keyframe[] {
  if (!specs.length) return [];
  const length = Math.max(1, effect.endFrame - effect.startFrame);
  return specs
    .map((spec, index) => ({
      id: `${effect.id}_kf${index}`,
      param: spec.param,
      frame: effect.startFrame + Math.round(spec.at * length),
      value: spec.value,
      easing: 'easeInOut' as const,
    }))
    .sort((a, b) => a.frame - b.frame);
}

/** Turn normalised preset keyframes into real timeline keyframes for an effect. */
export function materializePresetKeyframes(
  presetId: string,
  effect: Pick<Effect, 'id' | 'startFrame' | 'endFrame'>,
): Keyframe[] {
  return materializeKeyframes(presetById(presetId)?.keyframes ?? [], effect);
}

/**
 * The inverse of `materializeKeyframes`: absolute timeline keyframes back into
 * region-relative specs, so the bundle can be re-applied to a region of any
 * length.
 */
export function normalizeKeyframeSpecs(
  keyframes: Keyframe[],
  effect: Pick<Effect, 'startFrame' | 'endFrame'>,
): PresetKeyframeSpec[] {
  const length = Math.max(1, effect.endFrame - effect.startFrame);
  return keyframes.map((key) => ({
    param: key.param,
    at: Math.min(1, Math.max(0, (key.frame - effect.startFrame) / length)),
    value: key.value,
  }));
}

/** Used by the inspector's Reset button. */
export function resetToPreset(effect: Effect): { parameters: ParamBag; keyframes: Keyframe[] } {
  const presetId = effect.preset ?? DEFAULT_DATAMOSH_PRESET;
  return {
    parameters: parametersForPreset(presetId),
    keyframes: materializePresetKeyframes(presetId, effect),
  };
}
