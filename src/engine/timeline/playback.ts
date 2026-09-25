/**
 * ONE resolver for "what should be on screen at timeline frame N".
 *
 * Both the WebGL preview and the exporter call this, and the frame scheduler is
 * deterministic, so the exported result reproduces the previewed result. Nothing
 * else in the app is allowed to re-implement this mapping.
 */

import type { Effect, Frame, ParamBag, Project } from '../project/types';
import { buildFrameMap, frameMapOptionsFromParams, frameMapSignature, type FrameMap } from '../datamosh/frameMap';
import { resolveParams } from '../datamosh/keyframes';
import { numParam } from '../datamosh/params';
import { clipAtFrame } from './derive';
import { clipEndFrame, sourceFrameAt } from './math';

export interface ResolvedEffect {
  effect: Effect;
  params: ParamBag;
  /** Output index inside the effect region (0-based). */
  frameOffset: number;
  /** Source offset inside the region after hold/repeat/skip/timewarp. */
  sourceOffset: number;
  progress: number;
  /** Transition fade, 0..1. */
  envelope: number;
}

export interface ResolvedFrame {
  clipId: string | null;
  mediaId: string | null;
  /** Source frame from clip mapping only (no datamosh scheduling). */
  clipSourceFrame: Frame;
  /** Final source frame to decode. */
  sourceFrame: Frame;
  datamosh: ResolvedEffect[];
  /** Every enabled effect covering this frame, datamosh included. */
  effects: Effect[];
  /** True when the resolved source frame is outside the clip (empty output). */
  empty: boolean;
}

export class FrameMapCache {
  private maps = new Map<string, { signature: string; map: FrameMap }>();

  get(effect: Effect, params: Record<string, unknown>, length: number): FrameMap {
    const options = frameMapOptionsFromParams(effect, params, length);
    const signature = frameMapSignature(options);
    const cached = this.maps.get(effect.id);
    if (cached && cached.signature === signature && cached.map.length === length) return cached.map;
    const map = buildFrameMap(options);
    this.maps.set(effect.id, { signature, map });
    return map;
  }

  clear(): void {
    this.maps.clear();
  }

  size(): number {
    return this.maps.size;
  }
}

/** Effect strength fade so a block never starts or ends with a hard jump. */
export function envelopeFor(effect: Effect, frame: Frame, params: Record<string, unknown>): number {
  const transition = numParam(params, 'transition', 6);
  if (transition <= 0) return 1;
  const length = Math.max(1, effect.endFrame - effect.startFrame);
  const progress = (frame - effect.startFrame) / length;
  const ramp = Math.min(0.5, transition / length);
  if (ramp <= 0) return 1;
  if (progress < ramp) return Math.max(0, progress / ramp);
  if (progress > 1 - ramp) return Math.max(0, (1 - progress) / ramp);
  return 1;
}

const EMPTY_FRAME: ResolvedFrame = {
  clipId: null,
  mediaId: null,
  clipSourceFrame: 0,
  sourceFrame: 0,
  datamosh: [],
  effects: [],
  empty: true,
};

export function resolveTimelineFrame(
  project: Project,
  frame: Frame,
  cache: FrameMapCache = new FrameMapCache(),
): ResolvedFrame {
  const clip = clipAtFrame(project, frame);
  if (!clip) return EMPTY_FRAME;

  const clipSourceFrame = sourceFrameAt(clip, frame);
  const clipEnd = clipEndFrame(clip);

  const effects = project.effects
    .filter((e) => e.enabled && frame >= e.startFrame && frame < e.endFrame)
    .sort((a, b) => a.track - b.track);

  const datamoshEffects = effects.filter((e) => e.type === 'datamosh');

  if (!datamoshEffects.length) {
    return {
      clipId: clip.id,
      mediaId: clip.mediaId,
      clipSourceFrame,
      sourceFrame: clipSourceFrame,
      datamosh: [],
      effects,
      empty: false,
    };
  }

  // The highest lane controls which frame is decoded; lower lanes still render
  // their own warp pass, so "Datamosh 1 / Datamosh 2 / Datamosh 3" compose.
  const scheduler = datamoshEffects[datamoshEffects.length - 1]!;
  const schedulerParams = resolveParams(scheduler, frame);

  // Region is clamped to the clip so a block can never pull frames that do not
  // exist in the source.
  const regionStart = Math.max(scheduler.startFrame, clip.startFrame);
  const regionEnd = Math.min(scheduler.endFrame, clipEnd);
  const length = Math.max(1, regionEnd - regionStart);
  const offset = Math.min(length - 1, Math.max(0, frame - regionStart));
  const map = cache.get(scheduler, schedulerParams, length);
  const sourceOffset = map[offset] ?? offset;

  const regionSourceStart = sourceFrameAt(clip, regionStart);
  const maxSource = Math.max(0, assetDurationFor(project, clip.mediaId));
  const scheduled = regionSourceStart + sourceOffset;
  const sourceFrame = maxSource > 0 ? Math.min(maxSource - 1, scheduled) : scheduled;

  const datamosh: ResolvedEffect[] = datamoshEffects.map((effect) => {
    const params = effect === scheduler ? schedulerParams : resolveParams(effect, frame);
    const effLength = Math.max(1, effect.endFrame - effect.startFrame);
    const effOffset = Math.min(effLength - 1, Math.max(0, frame - effect.startFrame));
    const effRegionStart = Math.max(effect.startFrame, clip.startFrame);
    const effRegionEnd = Math.min(effect.endFrame, clipEnd);
    const effSpan = Math.max(1, effRegionEnd - effRegionStart);
    const effMap = cache.get(effect, params, effSpan);
    const effMapOffset = Math.min(effSpan - 1, Math.max(0, frame - effRegionStart));
    return {
      effect,
      params,
      frameOffset: effOffset,
      sourceOffset: effMap[effMapOffset] ?? effMapOffset,
      progress: effLength <= 1 ? 0 : effOffset / (effLength - 1),
      envelope: envelopeFor(effect, frame, params),
    };
  });

  return {
    clipId: clip.id,
    mediaId: clip.mediaId,
    clipSourceFrame,
    sourceFrame,
    datamosh,
    effects,
    empty: false,
  };
}

function assetDurationFor(project: Project, mediaId: string): number {
  return project.media.find((m) => m.id === mediaId)?.durationFrames ?? 0;
}

/** Effective playback speed multiplier at a frame (shown by the Speed tool). */
export function effectiveSpeedAt(project: Project, frame: Frame, cache: FrameMapCache): number {
  const resolved = resolveTimelineFrame(project, frame, cache);
  const base = clipSpeed(project, resolved.clipId);
  if (!resolved.datamosh.length) return base;
  const top = resolved.datamosh[resolved.datamosh.length - 1]!;
  return base * numParam(top.params, 'speed', 1);
}

function clipSpeed(project: Project, clipId: string | null): number {
  if (!clipId) return 1;
  return project.clips.find((c) => c.id === clipId)?.speed ?? 1;
}
