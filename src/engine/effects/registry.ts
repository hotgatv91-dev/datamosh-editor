/**
 * Basic effects.
 *
 * These are EXPLICITLY separated from datamosh. They are colour/spatial
 * distortions (RGB split, VHS, noise, ...) and are never described as datamosh
 * anywhere in the UI — the spec is emphatic about that distinction.
 *
 * Each effect is a timeline block with its own parameters. `ffmpegFilter`
 * carries the equivalent filter for the fast export pipeline; `glsl` carries the
 * real-time preview/immediate-mode pass.
 */

import type { EffectType } from '../project/types';

export interface BasicEffectDef {
  type: EffectType;
  label: string;
  description: string;
  /** Short glyph for the timeline block. */
  glyph: string;
  defaults: Record<string, number | string | boolean>;
  controls: {
    id: string;
    label: string;
    min: number;
    max: number;
    step: number;
    unit?: string;
  }[];
  ffmpegFilter?: string;
}

export const BASIC_EFFECTS: BasicEffectDef[] = [
  {
    type: 'glitch',
    label: 'Glitch',
    description: 'Nhảy khối hình ảnh và lệch dòng theo chu kỳ.',
    glyph: 'GL',
    defaults: { amount: 35, speed: 6, blocks: 12, seed: 7 },
    controls: [
      { id: 'amount', label: 'Amount', min: 0, max: 100, step: 1, unit: '%' },
      { id: 'speed', label: 'Rate', min: 1, max: 30, step: 1, unit: '/s' },
      { id: 'blocks', label: 'Bands', min: 1, max: 40, step: 1 },
      { id: 'seed', label: 'Seed', min: 0, max: 999, step: 1 },
    ],
  },
  {
    type: 'rgbsplit',
    label: 'RGB Split',
    description: 'Tách ba kênh màu theo hướng ngẫu nhiên.',
    glyph: 'RGB',
    defaults: { amount: 6, angle: 0, jitter: 20 },
    controls: [
      { id: 'amount', label: 'Offset', min: 0, max: 40, step: 0.5, unit: 'px' },
      { id: 'angle', label: 'Angle', min: 0, max: 360, step: 1, unit: '°' },
      { id: 'jitter', label: 'Jitter', min: 0, max: 100, step: 1, unit: '%' },
    ],
  },
  {
    type: 'chromatic',
    label: 'Chromatic Aberration',
    description: 'Quang sai màu ở rìa hình ảnh.',
    glyph: 'CA',
    defaults: { amount: 1.6, falloff: 60 },
    controls: [
      { id: 'amount', label: 'Amount', min: 0, max: 12, step: 0.1, unit: 'px' },
      { id: 'falloff', label: 'Falloff', min: 0, max: 100, step: 1, unit: '%' },
    ],
  },
  {
    type: 'vhs',
    label: 'VHS',
    description: 'Nhiễu băng từ: lệch dòng, mất màu, hạt thô.',
    glyph: 'VHS',
    defaults: { amount: 45, jitter: 30, desaturate: 25, grain: 30 },
    controls: [
      { id: 'amount', label: 'Amount', min: 0, max: 100, step: 1, unit: '%' },
      { id: 'jitter', label: 'Jitter', min: 0, max: 100, step: 1, unit: '%' },
      { id: 'desaturate', label: 'Desaturate', min: 0, max: 100, step: 1, unit: '%' },
      { id: 'grain', label: 'Grain', min: 0, max: 100, step: 1, unit: '%' },
    ],
  },
  {
    type: 'noise',
    label: 'Noise',
    description: 'Hạt nhiễu tĩnh và nhiễu động.',
    glyph: 'NS',
    defaults: { amount: 30, animated: 1, monochrome: 1 },
    controls: [
      { id: 'amount', label: 'Amount', min: 0, max: 100, step: 1, unit: '%' },
      { id: 'animated', label: 'Animated', min: 0, max: 1, step: 1 },
      { id: 'monochrome', label: 'Monochrome', min: 0, max: 1, step: 1 },
    ],
  },
  {
    type: 'pixelate',
    label: 'Pixelate',
    description: 'Giảm độ phân giải theo khối vuông.',
    glyph: 'PX',
    defaults: { size: 12 },
    controls: [{ id: 'size', label: 'Block', min: 2, max: 80, step: 1, unit: 'px' }],
  },
  {
    type: 'blur',
    label: 'Blur',
    description: 'Làm mờ toàn khung hình.',
    glyph: 'BL',
    defaults: { amount: 4 },
    controls: [{ id: 'amount', label: 'Radius', min: 0, max: 40, step: 0.5, unit: 'px' }],
  },
  {
    type: 'scanline',
    label: 'Scanline',
    description: 'Dòng quét ngang kiểu CRT.',
    glyph: 'SC',
    defaults: { density: 3, opacity: 35, roll: 20 },
    controls: [
      { id: 'density', label: 'Density', min: 1, max: 12, step: 1, unit: 'px' },
      { id: 'opacity', label: 'Opacity', min: 0, max: 100, step: 1, unit: '%' },
      { id: 'roll', label: 'Roll', min: 0, max: 100, step: 1, unit: '%' },
    ],
  },
  {
    type: 'distortion',
    label: 'Distortion',
    description: 'Bóp méo hình học theo sóng.',
    glyph: 'DS',
    defaults: { amount: 20, frequency: 6, phase: 0 },
    controls: [
      { id: 'amount', label: 'Amount', min: 0, max: 100, step: 1, unit: '%' },
      { id: 'frequency', label: 'Frequency', min: 1, max: 24, step: 1 },
      { id: 'phase', label: 'Phase', min: 0, max: 360, step: 1, unit: '°' },
    ],
  },
];

export const BASIC_EFFECT_MAP: Record<string, BasicEffectDef> = Object.fromEntries(
  BASIC_EFFECTS.map((e) => [e.type, e]),
);

export function basicEffectDef(type: EffectType): BasicEffectDef | null {
  return BASIC_EFFECT_MAP[type] ?? null;
}

export function isDatamosh(type: EffectType): boolean {
  return type === 'datamosh';
}

export function effectLabel(type: EffectType): string {
  if (type === 'datamosh') return 'DATAMOSH';
  return BASIC_EFFECT_MAP[type]?.label ?? type;
}

export function effectGlyph(type: EffectType): string {
  if (type === 'datamosh') return '⚡';
  return BASIC_EFFECT_MAP[type]?.glyph ?? 'FX';
}

export function effectColorVar(type: EffectType): string {
  return type === 'datamosh' ? 'var(--mosh)' : 'var(--accent)';
}
