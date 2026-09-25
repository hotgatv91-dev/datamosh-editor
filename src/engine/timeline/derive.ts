/** Read-only derived queries over a Project. Pure and cheap enough to call per frame. */

import type { Clip, Effect, Frame, Id, MediaAsset, Project } from '../project/types';
import { clipEndFrame } from './math';

export function clipEndFrameSafe(clip: Clip): Frame {
  return clipEndFrame(clip);
}

export function projectDuration(project: Project): Frame {
  return project.clips.reduce((max, clip) => Math.max(max, clipEndFrame(clip)), 0);
}

export function clipById(project: Project, clipId: Id | null | undefined): Clip | null {
  if (!clipId) return null;
  return project.clips.find((c) => c.id === clipId) ?? null;
}

export function effectById(project: Project, effectId: Id | null | undefined): Effect | null {
  if (!effectId) return null;
  return project.effects.find((e) => e.id === effectId) ?? null;
}

export function assetById(project: Project, mediaId: Id | null | undefined): MediaAsset | null {
  if (!mediaId) return null;
  return project.media.find((m) => m.id === mediaId) ?? null;
}

export function assetForClip(project: Project, clip: Clip | null): MediaAsset | null {
  return clip ? assetById(project, clip.mediaId) : null;
}

/** Topmost clip covering a timeline frame (highest track wins). */
export function clipAtFrame(project: Project, frame: Frame): Clip | null {
  const covering = project.clips.filter(
    (c) => frame >= c.startFrame && frame < clipEndFrame(c) && frame >= 0,
  );
  if (!covering.length) return null;
  return covering.reduce((best, clip) => (clip.track >= best.track ? clip : best));
}

export function clipsSorted(project: Project): Clip[] {
  return [...project.clips].sort((a, b) => a.track - b.track || a.startFrame - b.startFrame);
}

export function effectsSorted(project: Project): Effect[] {
  return [...project.effects].sort((a, b) => a.track - b.track || a.startFrame - b.startFrame);
}

export function effectsAtFrame(project: Project, frame: Frame): Effect[] {
  return effectsSorted(project).filter(
    (e) => e.enabled && frame >= e.startFrame && frame < e.endFrame,
  );
}

export function hasEffectType(project: Project, type: Effect['type']): boolean {
  return project.effects.some((e) => e.type === type && e.enabled);
}

export function datamoshEffects(project: Project): Effect[] {
  return effectsSorted(project).filter((e) => e.type === 'datamosh' && e.enabled);
}

export function effectLaneCount(project: Project): number {
  return project.effects.reduce((max, e) => Math.max(max, e.track + 1), 0);
}

/** Aspect ratio of the primary clip's source, used to size the preview. */
export function projectAspect(project: Project): number {
  const clip = clipsSorted(project)[0];
  if (!clip) return 16 / 9;
  const asset = assetForClip(project, clip);
  if (!asset || !asset.height) return 16 / 9;
  return asset.width / asset.height;
}

export function primaryAsset(project: Project): MediaAsset | null {
  const clip = clipsSorted(project)[0];
  return assetForClip(project, clip);
}

export function isEmptyProject(project: Project): boolean {
  return project.clips.length === 0;
}

export function mediaIsUsed(project: Project, mediaId: Id): boolean {
  return project.clips.some((c) => c.mediaId === mediaId);
}
