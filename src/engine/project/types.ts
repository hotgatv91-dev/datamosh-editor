/**
 * Canonical project data model.
 *
 * IMPORTANT DESIGN RULE: every time value is a *timeline frame* (integer).
 * Seconds only exist for display. This is what makes frame-accurate selection,
 * timeline zoom-to-frame and "datamosh region === effect block" work without
 * any two-way synchronisation.
 *
 * `duration` is never stored on an effect: it is always derived as
 * `endFrame - startFrame`, so a block can never disagree with the timeline.
 */

export type Frame = number;
export type Id = string;
export type ParamBag = Record<string, number | string | boolean>;

export type Easing = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut';

export type EffectType =
  | 'datamosh'
  | 'glitch'
  | 'rgbsplit'
  | 'chromatic'
  | 'vhs'
  | 'noise'
  | 'pixelate'
  | 'blur'
  | 'scanline'
  | 'distortion';

export type RenderMode = 'bitstream' | 'preview-quality';

export interface MediaAsset {
  id: Id;
  name: string;
  sizeBytes: number;
  durationFrames: Frame;
  width: number;
  height: number;
  fps: number;
  container: string;
  videoCodec: string;
  hasAudio: boolean;
  lastModified: number;
  addedAt: number;
}

export interface Crop {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface Transform {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  flipH: boolean;
  flipV: boolean;
  crop: Crop;
}

export interface Adjust {
  brightness: number;
  contrast: number;
  saturation: number;
  exposure: number;
  blur: number;
}

export interface Clip {
  id: Id;
  mediaId: Id;
  track: number;
  /** Position on the timeline. */
  startFrame: Frame;
  /** Source range, in source frames. */
  inFrame: Frame;
  outFrame: Frame;
  speed: number;
  transform: Transform;
  adjust: Adjust;
  volume: number;
  muted: boolean;
  fadeInFrames: number;
  fadeOutFrames: number;
}

export interface Keyframe {
  id: Id;
  param: string;
  frame: Frame;
  value: number;
  easing: Easing;
}

/** Normalised position (0..1) inside the effect region -> speed multiplier. */
export interface SpeedPoint {
  at: number;
  value: number;
}

export interface Effect {
  id: Id;
  type: EffectType;
  /** Effect lane index, so several effects can overlap without fighting. */
  track: number;
  startFrame: Frame;
  endFrame: Frame;
  preset: string | null;
  parameters: ParamBag;
  keyframes: Keyframe[];
  speedCurve: SpeedPoint[];
  renderMode: RenderMode;
  enabled: boolean;
}

export interface ExportSettings {
  resolution: 'original' | '720' | '1080';
  fps: 'original' | 24 | 30 | 60;
  format: 'mp4' | 'webm';
  /** Which export path the user chose in the Export modal. */
  pipeline: 'bitstream' | 'render';
}

export interface Project {
  version: number;
  id: Id;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** Timeline frame rate. Taken from the first imported clip. */
  fps: number;
  media: MediaAsset[];
  clips: Clip[];
  effects: Effect[];
  exportSettings: ExportSettings;
}

export const PROJECT_VERSION = 3;

export const DEFAULT_TRANSFORM: Transform = {
  x: 0,
  y: 0,
  scale: 1,
  rotation: 0,
  flipH: false,
  flipV: false,
  crop: { top: 0, right: 0, bottom: 0, left: 0 },
};

export const DEFAULT_ADJUST: Adjust = {
  brightness: 0,
  contrast: 0,
  saturation: 0,
  exposure: 0,
  blur: 0,
};

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  resolution: 'original',
  fps: 'original',
  format: 'mp4',
  pipeline: 'bitstream',
};

export function createEmptyProject(): Project {
  const now = Date.now();
  return {
    version: PROJECT_VERSION,
    id: `p_${now.toString(36)}`,
    name: 'Untitled project',
    createdAt: now,
    updatedAt: now,
    fps: 30,
    media: [],
    clips: [],
    effects: [],
    exportSettings: { ...DEFAULT_EXPORT_SETTINGS },
  };
}

export function clipLength(clip: Clip): Frame {
  return Math.max(1, Math.round((clip.outFrame - clip.inFrame) / Math.max(0.01, clip.speed)));
}

export function effectDuration(effect: Effect): Frame {
  return Math.max(1, effect.endFrame - effect.startFrame);
}
