/**
 * Timeline edit operations. These mutate a *draft* Project (the history layer
 * clones before/after) and are the single source of truth used by drag, keyboard
 * shortcuts and the inspector alike — which is why undo/redo needs no extra code.
 */

import type {
  Clip,
  Effect,
  EffectType,
  Frame,
  Id,
  MediaAsset,
  Project,
  RenderMode,
} from '../project/types';
import { DEFAULT_ADJUST, DEFAULT_TRANSFORM } from '../project/types';
import { clipEndFrame, sourceFrameAt } from './math';

let counter = 0;
export function uid(prefix = 'x'): Id {
  counter += 1;
  const rand = Math.random().toString(36).slice(2, 7);
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${rand}`;
}

function assetOf(project: Project, mediaId: Id): MediaAsset | undefined {
  return project.media.find((m) => m.id === mediaId);
}

function findClip(project: Project, clipId: Id): Clip | undefined {
  return project.clips.find((c) => c.id === clipId);
}

/* ------------------------------------------------------------------ clips */

export function addClipFromMedia(project: Project, asset: MediaAsset, track = 0, atFrame?: Frame): Id {
  const sameTrack = project.clips.filter((c) => c.track === track);
  const start = atFrame ?? sameTrack.reduce((max, clip) => Math.max(max, clipEndFrame(clip)), 0);
  const clipId = uid('clip');
  project.clips.push({
    id: clipId,
    mediaId: asset.id,
    track,
    startFrame: Math.max(0, Math.round(start)),
    inFrame: 0,
    outFrame: asset.durationFrames,
    speed: 1,
    transform: structuredClone(DEFAULT_TRANSFORM),
    adjust: structuredClone(DEFAULT_ADJUST),
    volume: 1,
    muted: false,
    fadeInFrames: 0,
    fadeOutFrames: 0,
  });
  return clipId;
}

/**
 * Non-overlapping move.
 *
 * If the requested position collides with another clip we look for the nearest
 * free slot on both sides and prefer the side the user was dragging towards, so
 * a drag never silently jumps across the whole timeline.
 */
export function moveClip(project: Project, clipId: Id, startFrame: Frame, track?: number): void {
  const clip = findClip(project, clipId);
  if (!clip) return;
  const targetTrack = track ?? clip.track;
  const originalStart = clip.startFrame;
  const length = clipEndFrame(clip) - clip.startFrame;
  const desired = Math.max(0, Math.round(startFrame));

  const blockers = project.clips.filter((c) => c.id !== clipId && c.track === targetTrack);
  const overlaps = (start: number): boolean =>
    blockers.some((b) => start < clipEndFrame(b) && start + length > b.startFrame);

  let start = desired;
  if (overlaps(start)) {
    let right = desired;
    for (let guard = 0; guard < 64; guard += 1) {
      const hit = blockers.find((b) => right < clipEndFrame(b) && right + length > b.startFrame);
      if (!hit) break;
      right = clipEndFrame(hit);
    }
    let left = desired;
    for (let guard = 0; guard < 64; guard += 1) {
      const hit = blockers.find((b) => left < clipEndFrame(b) && left + length > b.startFrame);
      if (!hit) break;
      left = hit.startFrame - length;
    }
    left = Math.max(0, left);

    const movingRight = desired >= originalStart;
    const rightFits = !overlaps(right);
    const leftFits = !overlaps(left);
    if (movingRight) start = rightFits ? right : leftFits ? left : desired;
    else start = leftFits ? left : rightFits ? right : desired;
  }

  clip.startFrame = Math.max(0, start);
  clip.track = targetTrack;
}

/**
 * Anchored trim: dragging the left edge inward advances the source in-point but
 * the remaining frames keep their timeline position, so effects never need to
 * move. Dragging outward (before source frame 0) is limited by the source head.
 */
export function trimClipStart(project: Project, clipId: Id, newStartFrame: Frame): void {
  const clip = findClip(project, clipId);
  if (!clip) return;
  const deltaTimeline = Math.round(newStartFrame) - clip.startFrame;
  const wantedIn = clip.inFrame + deltaTimeline * clip.speed;
  const clampedIn = Math.min(Math.max(0, Math.round(wantedIn)), Math.max(0, clip.outFrame - 1));
  const actualDelta = Math.round((clampedIn - clip.inFrame) / Math.max(0.01, clip.speed));
  clip.inFrame = clampedIn;
  clip.startFrame = Math.max(0, clip.startFrame + actualDelta);
}

export function trimClipEnd(project: Project, clipId: Id, newEndFrame: Frame): void {
  const clip = findClip(project, clipId);
  if (!clip) return;
  const asset = assetOf(project, clip.mediaId);
  const maxSource = asset ? asset.durationFrames : clip.outFrame;
  const wantedOut = Math.round(clip.inFrame + (Math.round(newEndFrame) - clip.startFrame) * clip.speed);
  clip.outFrame = Math.min(Math.max(clip.inFrame + 1, wantedOut), maxSource);
}

export function trimClipToSource(project: Project, clipId: Id, inFrame: Frame, outFrame: Frame): void {
  const clip = findClip(project, clipId);
  if (!clip) return;
  const asset = assetOf(project, clip.mediaId);
  const maxSource = asset ? asset.durationFrames : outFrame;
  const lo = Math.max(0, Math.round(inFrame));
  const hi = Math.min(maxSource, Math.round(outFrame));
  clip.inFrame = lo;
  clip.outFrame = Math.max(lo + 1, hi);
}

export function setClipSpeed(project: Project, clipId: Id, speed: number): void {
  const clip = findClip(project, clipId);
  if (!clip) return;
  clip.speed = Math.min(8, Math.max(0.05, Number(speed.toFixed(4))));
}

export function splitClip(project: Project, clipId: Id, atFrame: Frame): Id | null {
  const clip = findClip(project, clipId);
  if (!clip) return null;
  const end = clipEndFrame(clip);
  if (atFrame <= clip.startFrame || atFrame >= end) return null;
  const sourceSplit = sourceFrameAt(clip, atFrame);
  if (sourceSplit <= clip.inFrame || sourceSplit >= clip.outFrame) return null;
  const right: Clip = {
    ...structuredClone(clip),
    id: uid('clip'),
    startFrame: atFrame,
    inFrame: sourceSplit,
    fadeInFrames: 0,
  };
  clip.outFrame = sourceSplit;
  clip.fadeOutFrames = 0;
  project.clips.push(right);
  return right.id;
}

/** Effects that live inside the removed span lose their video, so they go too. */
export function deleteClip(project: Project, clipId: Id): void {
  const clip = findClip(project, clipId);
  if (!clip) return;
  const start = clip.startFrame;
  const end = clipEndFrame(clip);
  project.clips = project.clips.filter((c) => c.id !== clipId);
  project.effects = project.effects.filter((e) => e.startFrame < start || e.startFrame >= end);
}

export function duplicateClip(project: Project, clipId: Id): Id | null {
  const clip = findClip(project, clipId);
  if (!clip) return null;
  const copy: Clip = { ...structuredClone(clip), id: uid('clip'), startFrame: clipEndFrame(clip) };
  project.clips.push(copy);
  return copy.id;
}

export function setClipPatch(project: Project, clipId: Id, patch: Partial<Clip>): void {
  const clip = findClip(project, clipId);
  if (!clip) return;
  Object.assign(clip, structuredClone(patch));
}

export function setClipAdjust(project: Project, clipId: Id, patch: Partial<Clip['adjust']>): void {
  const clip = findClip(project, clipId);
  if (!clip) return;
  clip.adjust = { ...clip.adjust, ...patch };
}

export function setClipTransform(project: Project, clipId: Id, patch: Partial<Clip['transform']>): void {
  const clip = findClip(project, clipId);
  if (!clip) return;
  clip.transform = { ...clip.transform, ...patch };
}

/* ---------------------------------------------------------------- effects */

export interface NewEffectInput {
  type: EffectType;
  startFrame: Frame;
  endFrame: Frame;
  preset?: string | null;
  parameters?: Record<string, number | string | boolean>;
  renderMode?: RenderMode;
  track?: number;
}

/** Effects may overlap in time, but each lane holds at most one block at a time. */
export function nextFreeEffectTrack(project: Project, startFrame: Frame, endFrame: Frame): number {
  for (let track = 0; track < 64; track += 1) {
    const clash = project.effects.some(
      (e) => e.track === track && e.startFrame < endFrame && e.endFrame > startFrame,
    );
    if (!clash) return track;
  }
  return 0;
}

export function addEffect(project: Project, input: NewEffectInput): Id {
  const start = Math.max(0, Math.round(input.startFrame));
  const end = Math.max(start + 1, Math.round(input.endFrame));
  const effect: Effect = {
    id: uid('fx'),
    type: input.type,
    track: input.track ?? nextFreeEffectTrack(project, start, end),
    startFrame: start,
    endFrame: end,
    preset: input.preset ?? null,
    parameters: { ...(input.parameters ?? {}) },
    keyframes: [],
    speedCurve: [],
    renderMode: input.renderMode ?? 'bitstream',
    enabled: true,
  };
  project.effects.push(effect);
  return effect.id;
}

/**
 * Absolute range setter. Drag handlers must always call this with the position
 * derived from the drag origin, never with a delta: deltas applied to a live
 * position accumulate and the block runs away from the cursor.
 *
 * Keyframes are absolute timeline frames, so they ride along with the block —
 * otherwise dragging a mosh region would leave its animation behind.
 */
export function setEffectRange(project: Project, effectId: Id, startFrame: Frame, endFrame: Frame): void {
  const effect = project.effects.find((e) => e.id === effectId);
  if (!effect) return;
  const start = Math.max(0, Math.round(startFrame));
  const end = Math.max(start + 1, Math.round(endFrame));
  shiftKeyframes(effect, start - effect.startFrame);
  effect.startFrame = start;
  effect.endFrame = end;
}

export function moveEffectBy(project: Project, effectId: Id, delta: Frame): void {
  const effect = project.effects.find((e) => e.id === effectId);
  if (!effect) return;
  const length = effect.endFrame - effect.startFrame;
  const start = Math.max(0, Math.round(effect.startFrame + delta));
  shiftKeyframes(effect, start - effect.startFrame);
  effect.startFrame = start;
  effect.endFrame = start + length;
}

function shiftKeyframes(effect: Effect, delta: number): void {
  if (!delta) return;
  for (const key of effect.keyframes) key.frame = Math.max(0, key.frame + delta);
}

export function deleteEffect(project: Project, effectId: Id): void {
  project.effects = project.effects.filter((e) => e.id !== effectId);
}

export function duplicateEffect(project: Project, effectId: Id): Id | null {
  const effect = project.effects.find((e) => e.id === effectId);
  if (!effect) return null;
  const length = effect.endFrame - effect.startFrame;
  const copy: Effect = {
    ...structuredClone(effect),
    id: uid('fx'),
    startFrame: effect.endFrame,
    endFrame: effect.endFrame + length,
    track: nextFreeEffectTrack(project, effect.endFrame, effect.endFrame + length),
  };
  project.effects.push(copy);
  return copy.id;
}

export function setEffectParam(
  project: Project,
  effectId: Id,
  param: string,
  value: number | string | boolean,
): void {
  const effect = project.effects.find((e) => e.id === effectId);
  if (!effect) return;
  effect.parameters = { ...effect.parameters, [param]: value };
}

export function setEffectPreset(
  project: Project,
  effectId: Id,
  preset: string | null,
  parameters: Record<string, number | string | boolean>,
): void {
  const effect = project.effects.find((e) => e.id === effectId);
  if (!effect) return;
  effect.preset = preset;
  effect.parameters = { ...parameters };
}

export function setEffectRenderMode(project: Project, effectId: Id, mode: RenderMode): void {
  const effect = project.effects.find((e) => e.id === effectId);
  if (!effect) return;
  effect.renderMode = mode;
}

export function setKeyframe(
  project: Project,
  effectId: Id,
  param: string,
  frame: Frame,
  value: number,
  easing: Effect['keyframes'][number]['easing'] = 'linear',
): void {
  const effect = project.effects.find((e) => e.id === effectId);
  if (!effect) return;
  const at = Math.max(0, Math.round(frame));
  const existing = effect.keyframes.find((k) => k.param === param && k.frame === at);
  if (existing) {
    existing.value = value;
    existing.easing = easing;
    return;
  }
  effect.keyframes.push({ id: uid('kf'), param, frame: at, value, easing });
  effect.keyframes.sort((a, b) => a.frame - b.frame);
}

export function removeKeyframe(project: Project, effectId: Id, keyframeId: Id): void {
  const effect = project.effects.find((e) => e.id === effectId);
  if (!effect) return;
  effect.keyframes = effect.keyframes.filter((k) => k.id !== keyframeId);
}

export function removeKeyframeAt(project: Project, effectId: Id, param: string, frame: Frame): void {
  const effect = project.effects.find((e) => e.id === effectId);
  if (!effect) return;
  effect.keyframes = effect.keyframes.filter((k) => !(k.param === param && k.frame === frame));
}

export function clearEffectKeyframes(project: Project, effectId: Id): void {
  const effect = project.effects.find((e) => e.id === effectId);
  if (!effect) return;
  effect.keyframes = [];
}

export function setEffectSpeedCurve(project: Project, effectId: Id, points: Effect['speedCurve']): void {
  const effect = project.effects.find((e) => e.id === effectId);
  if (!effect) return;
  effect.speedCurve = points
    .map((p) => ({
      at: Math.min(1, Math.max(0, p.at)),
      value: Math.min(8, Math.max(0.05, p.value)),
    }))
    .sort((a, b) => a.at - b.at);
}

export function toggleEffectEnabled(project: Project, effectId: Id): void {
  const effect = project.effects.find((e) => e.id === effectId);
  if (!effect) return;
  effect.enabled = !effect.enabled;
}

/** Dragging an effect by its head only moves that edge. */
export function resizeEffectStart(project: Project, effectId: Id, frame: Frame): void {
  const effect = project.effects.find((e) => e.id === effectId);
  if (!effect) return;
  const start = Math.min(Math.max(0, Math.round(frame)), effect.endFrame - 1);
  shiftKeyframes(effect, start - effect.startFrame);
  effect.startFrame = start;
}

export function resizeEffectEnd(project: Project, effectId: Id, frame: Frame): void {
  const effect = project.effects.find((e) => e.id === effectId);
  if (!effect) return;
  const end = Math.round(frame);
  effect.endFrame = Math.max(end, effect.startFrame + 1);
}
