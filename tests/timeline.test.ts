import { describe, expect, it } from 'vitest';
import {
  chooseTickStep,
  clipEndFrame,
  fitZoom,
  formatTimecode,
  frameToX,
  parseTimecode,
  showFrameGrid,
  snapFrame,
  sourceFrameAt,
  xToFrame,
  clampZoom,
  MAX_PX_PER_FRAME,
  MIN_PX_PER_FRAME,
} from '../src/engine/timeline/math';
import * as ops from '../src/engine/timeline/ops';
import { createEmptyProject, type MediaAsset, type Project } from '../src/engine/project/types';
import { projectDuration } from '../src/engine/timeline/derive';

function asset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: 'm1',
    name: 'clip.mp4',
    sizeBytes: 1000,
    durationFrames: 300,
    width: 1920,
    height: 1080,
    fps: 30,
    container: 'mp4',
    videoCodec: 'avc1.640028',
    hasAudio: true,
    lastModified: 0,
    addedAt: 0,
    ...overrides,
  };
}

function projectWithClip(): Project {
  const project = createEmptyProject();
  project.media.push(asset());
  ops.addClipFromMedia(project, project.media[0]!);
  return project;
}

describe('timeline maths', () => {
  it('converts frames to x and back', () => {
    const view = { pxPerFrame: 2, startFrame: 100, width: 800 };
    expect(frameToX(100, view)).toBe(0);
    expect(frameToX(150, view)).toBe(100);
    expect(xToFrame(100, view)).toBe(150);
  });

  it('formats and parses timecodes', () => {
    expect(formatTimecode(127, 30)).toBe('00:04.233');
    expect(parseTimecode('00:04', 30)).toBe(120);
    expect(parseTimecode('bad', 30)).toBeNull();
  });

  it('picks a ruler step that keeps labels readable', () => {
    expect(chooseTickStep(0.1, 30)).toBeGreaterThan(0);
    // At the deepest zoom every single frame gets a label.
    expect(chooseTickStep(80, 30)).toBe(1);
    // Zoomed out, labels must stay at least ~74px apart.
    expect(chooseTickStep(4, 30) * 4).toBeGreaterThanOrEqual(74);
    expect(showFrameGrid(8)).toBe(true);
    expect(showFrameGrid(1)).toBe(false);
  });

  it('clamps zoom and fits the whole timeline', () => {
    expect(clampZoom(1e9)).toBe(MAX_PX_PER_FRAME);
    expect(clampZoom(0)).toBe(MIN_PX_PER_FRAME);
    expect(fitZoom(600, 600)).toBeCloseTo(1);
  });

  it('snaps to nearby targets within the pixel threshold', () => {
    const targets = [
      { frame: 0, kind: 'origin' as const },
      { frame: 120, kind: 'effect' as const },
    ];
    // 7px default threshold at 5 px/frame is 1.4 frames of tolerance.
    expect(snapFrame(121, targets, 5).frame).toBe(120);
    expect(snapFrame(150, targets, 5).frame).toBe(150);
  });
});

describe('clip mapping', () => {
  it('maps a timeline frame to a source frame through clip speed', () => {
    const project = projectWithClip();
    const clip = project.clips[0]!;
    expect(sourceFrameAt(clip, 0)).toBe(0);
    expect(sourceFrameAt(clip, 30)).toBe(30);
    ops.setClipSpeed(project, clip.id, 2);
    expect(sourceFrameAt(clip, 30)).toBe(60);
    expect(clipEndFrame(clip)).toBe(150);
  });
});

describe('edit operations', () => {
  it('splits a clip into two adjacent clips', () => {
    const project = projectWithClip();
    const clip = project.clips[0]!;
    const rightId = ops.splitClip(project, clip.id, 120);
    expect(rightId).not.toBeNull();
    expect(project.clips).toHaveLength(2);
    expect(clip.outFrame).toBe(120);
    const right = project.clips.find((c) => c.id === rightId)!;
    expect(right.startFrame).toBe(120);
    expect(right.inFrame).toBe(120);
    expect(right.outFrame).toBe(300);
  });

  it('refuses to split on a clip edge', () => {
    const project = projectWithClip();
    const clip = project.clips[0]!;
    expect(ops.splitClip(project, clip.id, 0)).toBeNull();
    expect(ops.splitClip(project, clip.id, 300)).toBeNull();
  });

  it('trims the left edge while keeping the remaining frames anchored', () => {
    const project = projectWithClip();
    const clip = project.clips[0]!;
    ops.trimClipStart(project, clip.id, 30);
    expect(clip.startFrame).toBe(30);
    expect(clip.inFrame).toBe(30);
    expect(clipEndFrame(clip)).toBe(300);
  });

  it('cannot trim before the first source frame', () => {
    const project = projectWithClip();
    const clip = project.clips[0]!;
    ops.trimClipStart(project, clip.id, -60);
    expect(clip.startFrame).toBe(0);
    expect(clip.inFrame).toBe(0);
  });

  it('clamps the right edge to the source duration', () => {
    const project = projectWithClip();
    const clip = project.clips[0]!;
    ops.trimClipEnd(project, clip.id, 9999);
    expect(clip.outFrame).toBe(300);
    ops.trimClipEnd(project, clip.id, 10);
    expect(clip.outFrame).toBe(10);
    expect(projectDuration(project)).toBe(10);
  });

  it('prevents clips from overlapping when moved', () => {
    const project = projectWithClip();
    const clip = project.clips[0]!;
    ops.trimClipEnd(project, clip.id, 100);
    const secondId = ops.duplicateClip(project, clip.id)!;
    ops.moveClip(project, secondId, 50);
    const second = project.clips.find((c) => c.id === secondId)!;
    expect(second.startFrame).toBeGreaterThanOrEqual(100);
  });
});

describe('effect regions', () => {
  it('creates an effect that matches the requested range exactly', () => {
    const project = projectWithClip();
    const id = ops.addEffect(project, {
      type: 'datamosh',
      startFrame: 120,
      endFrame: 180,
      preset: 'classic',
      parameters: { intensity: 80 },
    });
    const effect = project.effects.find((e) => e.id === id)!;
    // Datamosh region === effect block: the same numbers the UI draws.
    expect(effect.startFrame).toBe(120);
    expect(effect.endFrame).toBe(180);
    expect(effect.endFrame - effect.startFrame).toBe(60);
    expect(effect.track).toBe(0);
  });

  it('resizes each edge independently', () => {
    const project = projectWithClip();
    const id = ops.addEffect(project, { type: 'datamosh', startFrame: 100, endFrame: 200 });
    ops.resizeEffectStart(project, id, 130);
    ops.resizeEffectEnd(project, id, 260);
    const effect = project.effects.find((e) => e.id === id)!;
    expect([effect.startFrame, effect.endFrame]).toEqual([130, 260]);
  });

  it('never lets an effect collapse to zero length', () => {
    const project = projectWithClip();
    const id = ops.addEffect(project, { type: 'datamosh', startFrame: 100, endFrame: 200 });
    ops.resizeEffectEnd(project, id, 100);
    ops.resizeEffectStart(project, id, 500);
    const effect = project.effects.find((e) => e.id === id)!;
    expect(effect.endFrame).toBeGreaterThan(effect.startFrame);
  });

  it('moves a block without changing its duration', () => {
    const project = projectWithClip();
    const id = ops.addEffect(project, { type: 'datamosh', startFrame: 100, endFrame: 160 });
    ops.moveEffectBy(project, id, 45);
    const effect = project.effects.find((e) => e.id === id)!;
    expect(effect.startFrame).toBe(145);
    expect(effect.endFrame - effect.startFrame).toBe(60);
  });

  it('carries its keyframes when the block moves', () => {
    const project = projectWithClip();
    const id = ops.addEffect(project, { type: 'datamosh', startFrame: 100, endFrame: 160 });
    ops.setKeyframe(project, id, 'intensity', 120, 10);
    ops.setKeyframe(project, id, 'intensity', 150, 90);
    ops.moveEffectBy(project, id, 30);
    const effect = project.effects.find((e) => e.id === id)!;
    expect(effect.keyframes.map((k) => k.frame)).toEqual([150, 180]);
  });

  it('is absolute when dragged repeatedly, so a long drag cannot drift', () => {
    const project = projectWithClip();
    const id = ops.addEffect(project, { type: 'datamosh', startFrame: 100, endFrame: 160 });
    const origin = 100;
    // The UI derives every position from the drag origin, never from the
    // previous position, which is what keeps a 200-move drag stable.
    for (const frames of [10, 20, 30, 40]) {
      ops.setEffectRange(project, id, origin + frames, origin + frames + 60);
    }
    const effect = project.effects.find((e) => e.id === id)!;
    expect(effect.startFrame).toBe(140);
    expect(effect.endFrame).toBe(200);
  });

  it('never moves a block before frame zero', () => {
    const project = projectWithClip();
    const id = ops.addEffect(project, { type: 'datamosh', startFrame: 10, endFrame: 40 });
    ops.moveEffectBy(project, id, -999);
    const effect = project.effects.find((e) => e.id === id)!;
    expect(effect.startFrame).toBe(0);
    expect(effect.endFrame).toBe(30);
  });

  it('puts overlapping effects on separate lanes', () => {
    const project = projectWithClip();
    const first = ops.addEffect(project, { type: 'datamosh', startFrame: 60, endFrame: 120 });
    const second = ops.addEffect(project, { type: 'glitch', startFrame: 90, endFrame: 150 });
    const third = ops.addEffect(project, { type: 'blur', startFrame: 150, endFrame: 200 });
    expect(project.effects.find((e) => e.id === first)!.track).toBe(0);
    expect(project.effects.find((e) => e.id === second)!.track).toBe(1);
    expect(project.effects.find((e) => e.id === third)!.track).toBe(0);
  });

  it('keeps three datamosh regions independent', () => {
    const project = projectWithClip();
    const ids = [
      ops.addEffect(project, { type: 'datamosh', startFrame: 30, endFrame: 60, preset: 'classic' }),
      ops.addEffect(project, { type: 'datamosh', startFrame: 120, endFrame: 150, preset: 'extreme' }),
      ops.addEffect(project, { type: 'datamosh', startFrame: 200, endFrame: 260, preset: 'frame-hold' }),
    ];
    expect(project.effects).toHaveLength(3);
    ops.setEffectParam(project, ids[1]!, 'intensity', 5);
    expect(project.effects.find((e) => e.id === ids[0]!)!.parameters.intensity).not.toBe(5);
    expect(project.effects.find((e) => e.id === ids[1]!)!.parameters.intensity).toBe(5);
  });

  it('removes effects that lose their video when the clip is deleted', () => {
    const project = projectWithClip();
    ops.addEffect(project, { type: 'datamosh', startFrame: 30, endFrame: 60 });
    const clip = project.clips[0]!;
    ops.deleteClip(project, clip.id);
    expect(project.clips).toHaveLength(0);
    expect(project.effects).toHaveLength(0);
  });
});
