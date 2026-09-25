import { beforeEach, describe, expect, it } from 'vitest';
import { useEditor } from '../src/state/store';
import { DATAMOSH_PRESETS } from '../src/engine/datamosh/presets';
import { BASIC_EFFECTS } from '../src/engine/effects/registry';
import type { Clip, MediaAsset } from '../src/engine/project/types';

const FPS = 30;
const CLIP_FRAMES = 300;

function seed(clipFrames = CLIP_FRAMES): void {
  const store = useEditor.getState();
  store.newProject();
  useEditor.getState().mutate('seed', (draft) => {
    const asset: MediaAsset = {
      id: 'asset1',
      name: 'clip.mp4',
      sizeBytes: 1,
      durationFrames: clipFrames,
      fps: FPS,
      width: 1280,
      height: 720,
      container: 'mp4',
      videoCodec: 'avc1.64001e',
      hasAudio: false,
      lastModified: 1,
      addedAt: 1,
    };
    const clip: Clip = {
      id: 'clip1',
      mediaId: 'asset1',
      track: 0,
      startFrame: 0,
      inFrame: 0,
      outFrame: clipFrames,
      speed: 1,
      volume: 1,
      muted: false,
      fadeInFrames: 0,
      fadeOutFrames: 0,
      adjust: { brightness: 0, contrast: 0, saturation: 0, exposure: 0, blur: 0 },
      transform: {
        scale: 1,
        x: 0,
        y: 0,
        rotation: 0,
        flipH: false,
        flipV: false,
        crop: { top: 0, right: 0, bottom: 0, left: 0 },
      },
    };
    draft.media.push(asset);
    draft.clips.push(clip);
    draft.fps = FPS;
  });
}

const moshPreset = DATAMOSH_PRESETS.find((p) => p.id === 'classic')!;

/** The block the user would grab on the timeline. */
function firstEffect() {
  return useEditor.getState().project.effects[0]!;
}

describe('adding an effect with no region marked', () => {
  beforeEach(() => seed());

  it('makes one second centred on the playhead', () => {
    useEditor.getState().setPlayhead(100);
    const id = useEditor.getState().createDatamoshRegion(moshPreset);
    expect(id).toBeTruthy();
    const effect = firstEffect();
    expect([effect.startFrame, effect.endFrame]).toEqual([85, 115]);
    expect(effect.endFrame - effect.startFrame).toBe(FPS);
  });

  it('is selected immediately so its edges can be dragged into place', () => {
    useEditor.getState().setPlayhead(100);
    const id = useEditor.getState().createDatamoshRegion(moshPreset);
    expect(useEditor.getState().selection.effectId).toBe(id);
  });

  it('clamps to the start instead of going negative', () => {
    useEditor.getState().setPlayhead(3);
    useEditor.getState().createDatamoshRegion(moshPreset);
    expect(firstEffect().startFrame).toBe(0);
  });

  it('clamps to the end of the timeline', () => {
    useEditor.getState().setPlayhead(CLIP_FRAMES - 1);
    useEditor.getState().createDatamoshRegion(moshPreset);
    const effect = firstEffect();
    expect(effect.endFrame).toBe(CLIP_FRAMES);
    expect(effect.startFrame).toBe(CLIP_FRAMES - FPS);
  });

  it('shrinks with a clip shorter than one second', () => {
    seed(12);
    useEditor.getState().setPlayhead(6);
    useEditor.getState().createDatamoshRegion(moshPreset);
    const effect = firstEffect();
    expect([effect.startFrame, effect.endFrame]).toEqual([0, 12]);
  });

  it('puts each new block in its own lane when the times overlap', () => {
    useEditor.getState().setPlayhead(100);
    useEditor.getState().createDatamoshRegion(moshPreset);
    useEditor.getState().setPlayhead(110);
    useEditor.getState().createDatamoshRegion(moshPreset);
    const [a, b] = useEditor.getState().project.effects;
    expect(a!.track).toBe(0);
    // Overlapping in time, so the second block goes below the first.
    expect(b!.track).toBe(1);
  });

  it('still honours a region the user did mark', () => {
    useEditor.getState().setPlayhead(0);
    useEditor.getState().createDatamoshRegion(moshPreset, { start: 200, end: 240 });
    expect([firstEffect().startFrame, firstEffect().endFrame]).toEqual([200, 240]);
  });

  it('does the same for a basic effect', () => {
    useEditor.getState().setPlayhead(60);
    useEditor.getState().createEffectRegion(BASIC_EFFECTS[0]!.type);
    const effect = firstEffect();
    expect(effect.type).toBe(BASIC_EFFECTS[0]!.type);
    expect([effect.startFrame, effect.endFrame]).toEqual([45, 75]);
  });
});

describe('adding an effect with no video at all', () => {
  beforeEach(() => {
    useEditor.getState().newProject();
  });

  it('refuses and says why instead of making an orphan block', () => {
    expect(useEditor.getState().createDatamoshRegion(moshPreset)).toBeNull();
    expect(useEditor.getState().project.effects).toHaveLength(0);
    expect(useEditor.getState().ui.status?.message).toContain('nhập video');
  });
});
