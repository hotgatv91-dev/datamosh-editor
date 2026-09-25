/**
 * Pure timeline maths. No React, no project knowledge, no datamosh knowledge.
 * Everything here is unit-tested in tests/timeline.test.ts.
 */

import type { Clip, Frame } from '../project/types';
import { clipLength } from '../project/types';

export interface Viewport {
  /** Pixels per timeline frame. */
  pxPerFrame: number;
  /** First visible frame. */
  startFrame: number;
  /** Visible width in CSS pixels. */
  width: number;
}

/** ~1 frame per 40px (deep frame level) .. ~1 frame per pixel/120 (whole video). */
export const MIN_PX_PER_FRAME = 0.025;
export const MAX_PX_PER_FRAME = 40;

export function clampZoom(pxPerFrame: number): number {
  return Math.min(MAX_PX_PER_FRAME, Math.max(MIN_PX_PER_FRAME, pxPerFrame));
}

export function frameToX(frame: Frame, view: Viewport): number {
  return (frame - view.startFrame) * view.pxPerFrame;
}

export function xToFrame(x: number, view: Viewport): Frame {
  return view.startFrame + x / view.pxPerFrame;
}

export function xToFrameRounded(x: number, view: Viewport): Frame {
  return Math.round(xToFrame(x, view));
}

export function startFrameForScroll(scrollLeft: number, pxPerFrame: number): Frame {
  return Math.floor(scrollLeft / pxPerFrame);
}

/** Zoom keeping `anchorFrame` pinned at `anchorX` (both in the same space). */
export function zoomAround(
  view: Viewport,
  nextPxPerFrame: number,
  anchorX: number,
): { pxPerFrame: number; scrollLeft: number } {
  const pxPerFrame = clampZoom(nextPxPerFrame);
  const anchorFrame = xToFrame(anchorX, view);
  const scrollLeft = Math.max(0, (anchorFrame - 0) * pxPerFrame - anchorX);
  return { pxPerFrame, scrollLeft };
}

const TICK_STEPS_FRAMES = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 9000, 18000];

export interface Tick {
  frame: Frame;
  major: boolean;
}

/** Pick a tick step so major labels stay >= `minLabelPx` apart. */
export function chooseTickStep(pxPerFrame: number, fps: number, minLabelPx = 74): number {
  const steps = TICK_STEPS_FRAMES.map((f) => Math.max(1, Math.round((f * fps) / 30)));
  for (const step of steps) {
    if (step * pxPerFrame >= minLabelPx) return step;
  }
  const last = steps[steps.length - 1] ?? 18000;
  return Math.max(last, Math.ceil(minLabelPx / pxPerFrame));
}

export function rulerTicks(view: Viewport, fps: number): Tick[] {
  const step = chooseTickStep(view.pxPerFrame, fps);
  const first = Math.floor(view.startFrame / step) * step;
  const last = view.startFrame + view.width / view.pxPerFrame;
  const ticks: Tick[] = [];
  // Guard against pathological loops if zoom/viewport are inconsistent.
  const maxTicks = 2000;
  for (let f = first; f <= last + step && ticks.length < maxTicks; f += step) {
    if (f < 0) continue;
    ticks.push({ frame: f, major: f % (step * 2) === 0 || step >= 10 });
  }
  return ticks;
}

/** Minor per-frame ticks are only drawn when they are actually readable. */
export function showFrameGrid(pxPerFrame: number): boolean {
  return pxPerFrame >= 6;
}

export function formatTimecode(frame: Frame, fps: number): string {
  const safeFps = fps > 0 ? fps : 30;
  const totalSeconds = Math.max(0, frame) / safeFps;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const millis = Math.round((totalSeconds - Math.floor(totalSeconds)) * 1000);
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  const mmm = String(millis).padStart(3, '0');
  return `${mm}:${ss}.${mmm}`;
}

export function formatShortTime(frame: Frame, fps: number): string {
  const safeFps = fps > 0 ? fps : 30;
  const totalSeconds = Math.max(0, frame) / safeFps;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function parseTimecode(input: string, fps: number): Frame | null {
  const m = input.trim().match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const minutes = m[1] ? Number(m[1]) : 0;
  const seconds = Number(m[2]);
  if (!Number.isFinite(seconds)) return null;
  return Math.round((minutes * 60 + seconds) * fps);
}

export function clipEndFrame(clip: Clip): Frame {
  return clip.startFrame + clipLength(clip);
}

/** Source frame that should be shown for a given timeline frame inside a clip. */
export function sourceFrameAt(clip: Clip, timelineFrame: Frame): Frame {
  const local = timelineFrame - clip.startFrame;
  return Math.round(clip.inFrame + local * clip.speed);
}

export interface SnapTarget {
  frame: Frame;
  kind: 'clip' | 'effect' | 'playhead' | 'origin';
}

export function collectSnapTargets(
  clips: Clip[],
  extra: Frame[] = [],
  effects: { startFrame: Frame; endFrame: Frame }[] = [],
): SnapTarget[] {
  const targets: SnapTarget[] = [{ frame: 0, kind: 'origin' }];
  for (const clip of clips) {
    targets.push({ frame: clip.startFrame, kind: 'clip' });
    targets.push({ frame: clipEndFrame(clip), kind: 'clip' });
  }
  for (const effect of effects) {
    targets.push({ frame: effect.startFrame, kind: 'effect' });
    targets.push({ frame: effect.endFrame, kind: 'effect' });
  }
  for (const frame of extra) targets.push({ frame, kind: 'playhead' });
  return targets;
}

export interface SnapResult {
  frame: Frame;
  snappedTo: SnapTarget | null;
}

export function snapFrame(
  frame: Frame,
  targets: SnapTarget[],
  pxPerFrame: number,
  thresholdPx = 7,
): SnapResult {
  const raw = Math.round(frame);
  let best: SnapTarget | null = null;
  let bestDistance = thresholdPx / Math.max(0.0001, pxPerFrame);
  for (const target of targets) {
    const distance = Math.abs(target.frame - raw);
    if (distance <= bestDistance) {
      best = target;
      bestDistance = distance;
    }
  }
  return best ? { frame: best.frame, snappedTo: best } : { frame: raw, snappedTo: null };
}

export function clampFrame(frame: Frame, min: Frame, max: Frame): Frame {
  return Math.min(max, Math.max(min, Math.round(frame)));
}

/** Nicer zoom steps for the zoom buttons. */
export function nextZoom(pxPerFrame: number, factor: number): number {
  return clampZoom(pxPerFrame * factor);
}

export function fitZoom(durationFrames: Frame, width: number): number {
  if (durationFrames <= 0 || width <= 0) return 1;
  return clampZoom(width / durationFrames);
}
