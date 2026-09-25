import { describe, expect, it } from 'vitest';
import { buildFrameMap, speedAtNormalised, hashString } from '../src/engine/datamosh/frameMap';
import { materializePresetKeyframes, parametersForPreset, DATAMOSH_PRESETS } from '../src/engine/datamosh/presets';
import { resolveParams, valueAtFrame } from '../src/engine/datamosh/keyframes';
import { defaultParameters, normalizeParams } from '../src/engine/datamosh/params';
import { FrameMapCache, resolveTimelineFrame } from '../src/engine/timeline/playback';
import { createEmptyProject, type Effect, type MediaAsset } from '../src/engine/project/types';
import * as ops from '../src/engine/timeline/ops';
import { detectVopKind } from '../src/engine/export/avi';

const baseOptions = {
  length: 10,
  speedBase: 1,
  speedCurve: [],
  repeatCount: 1,
  repeatInterval: 1,
  holdFrames: 0,
  skipAmount: 0,
  skipPattern: 'regular',
  randomness: 0,
  freezeDuration: 0,
  seed: 1,
};

describe('frame scheduler', () => {
  it('is an identity map at normal speed with no repeats', () => {
    const map = buildFrameMap(baseOptions);
    expect([...map]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('holds each frame on a slower speed, like the slow-motion example', () => {
    const map = buildFrameMap({ ...baseOptions, length: 8, speedBase: 0.5 });
    // Frame 100, 100, 101, 101, 102, 102, 103, 103 from the spec.
    expect([...map]).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
  });

  it('repeats every frame N times', () => {
    const map = buildFrameMap({ ...baseOptions, length: 6, repeatCount: 2 });
    expect([...map]).toEqual([0, 0, 1, 1, 2, 2]);
  });

  it('holds extra frames on the repeat interval', () => {
    const map = buildFrameMap({ ...baseOptions, length: 8, repeatInterval: 2, holdFrames: 2 });
    // frames 0 and 2 are emitted three times, the others once
    expect(map[0]).toBe(0);
    expect(map[1]).toBe(0);
    expect(map[2]).toBe(0);
    expect(map[3]).toBe(1);
  });

  it('skips frames on a regular pattern by repeating the previous frame', () => {
    const map = buildFrameMap({ ...baseOptions, length: 8, skipAmount: 1 });
    expect([...map]).toEqual([0, 1, 1, 3, 3, 5, 5, 7]);
  });

  it('is deterministic for random skipping (export must match preview)', () => {
    const a = buildFrameMap({ ...baseOptions, length: 40, skipAmount: 2, skipPattern: 'random', randomness: 60 });
    const b = buildFrameMap({ ...baseOptions, length: 40, skipAmount: 2, skipPattern: 'random', randomness: 60 });
    expect([...a]).toEqual([...b]);
    const c = buildFrameMap({ ...baseOptions, length: 40, skipAmount: 2, skipPattern: 'random', randomness: 60, seed: 99 });
    expect([...a]).not.toEqual([...c]);
  });

  it('freezes the head of the region', () => {
    const map = buildFrameMap({ ...baseOptions, length: 10, freezeDuration: 4 });
    expect(map[0]).toBe(map[4]);
    expect(map[3]).toBe(map[4]);
    expect(map[5]).toBe(5);
  });

  it('walks a speed curve: normal -> slow -> normal', () => {
    const curve = [
      { at: 0, value: 1 },
      { at: 0.5, value: 0.25 },
      { at: 1, value: 1 },
    ];
    expect(speedAtNormalised(curve, 0, 1)).toBe(1);
    expect(speedAtNormalised(curve, 0.5, 1)).toBeCloseTo(0.25);
    const map = buildFrameMap({ ...baseOptions, length: 20, speedBase: 1, speedCurve: curve });
    // The middle of the region advances far slower than the ends.
    expect(map[19]).toBeLessThan(19);
    expect(map[1] - map[0]).toBeLessThan(3);
  });

  it('never returns an index outside the region', () => {
    const map = buildFrameMap({
      ...baseOptions,
      length: 12,
      speedBase: 3,
      repeatCount: 4,
      holdFrames: 8,
      skipAmount: 3,
      randomness: 90,
      skipPattern: 'burst',
    });
    for (const value of map) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(12);
    }
  });
});

describe('presets and keyframes', () => {
  it('ships the presets the spec asks for', () => {
    const expected = [
      'classic',
      'motion-stretch',
      'motion-smear',
      'slow-motion',
      'frame-hold',
      'frame-repeat',
      'frame-skip',
      'frame-melt',
      'freeze-warp',
      'extreme',
      'monster-attack',
      'face-distortion',
      'custom',
    ];
    expect(DATAMOSH_PRESETS.map((p) => p.id)).toEqual(expected);
    for (const preset of DATAMOSH_PRESETS) {
      expect(preset.description.length).toBeGreaterThan(3);
    }
  });

  it('resolves preset parameters over the schema defaults', () => {
    const params = parametersForPreset('motion-stretch');
    expect(params.stretch).toBe(150);
    expect(params.threshold).toBe(0); // untouched defaults are still present
  });

  it('materialises preset keyframes inside the effect range', () => {
    const keys = materializePresetKeyframes('monster-attack', {
      id: 'fx1',
      startFrame: 100,
      endFrame: 200,
    });
    expect(keys.length).toBeGreaterThan(3);
    for (const key of keys) {
      expect(key.frame).toBeGreaterThanOrEqual(100);
      expect(key.frame).toBeLessThanOrEqual(200);
    }
  });

  it('interpolates between keyframes', () => {
    const effect: Effect = {
      id: 'e',
      type: 'datamosh',
      track: 0,
      startFrame: 0,
      endFrame: 100,
      preset: 'custom',
      parameters: defaultParameters(),
      keyframes: [
        { id: 'k1', param: 'intensity', frame: 0, value: 10, easing: 'linear' },
        { id: 'k2', param: 'intensity', frame: 50, value: 100, easing: 'linear' },
      ],
      speedCurve: [],
      renderMode: 'bitstream',
      enabled: true,
    };
    expect(valueAtFrame(effect, 'intensity', 0)).toBe(10);
    expect(valueAtFrame(effect, 'intensity', 25)).toBeCloseTo(55);
    expect(valueAtFrame(effect, 'intensity', 50)).toBe(100);
    expect(valueAtFrame(effect, 'intensity', 500)).toBe(100);
    expect(resolveParams(effect, 25).intensity).toBeCloseTo(55);
    expect(resolveParams(effect, 25).motion).toBe(defaultParameters().motion);
  });

  it('clamps parameters into their declared range', () => {
    const params = normalizeParams({ intensity: 99999, motion: -50, bogus: 3 });
    expect(params.intensity).toBe(200);
    expect(params.motion).toBe(0);
    expect('bogus' in params).toBe(false);
  });
});

describe('frame resolution (preview and export share this)', () => {
  function setup(): { project: ReturnType<typeof createEmptyProject>; effectId: string } {
    const asset: MediaAsset = {
      id: 'm1',
      name: 'a.mp4',
      sizeBytes: 1,
      durationFrames: 300,
      width: 1920,
      height: 1080,
      fps: 30,
      container: 'mp4',
      videoCodec: 'avc1',
      hasAudio: true,
      lastModified: 0,
      addedAt: 0,
    };
    const project = createEmptyProject();
    project.media.push(asset);
    ops.addClipFromMedia(project, asset);
    const effectId = ops.addEffect(project, {
      type: 'datamosh',
      startFrame: 120,
      endFrame: 180,
      preset: 'slow-motion',
      parameters: { ...defaultParameters(), speed: 0.5, repeatCount: 2 },
    });
    return { project, effectId };
  }

  it('leaves frames outside the region untouched', () => {
    const { project } = setup();
    const cache = new FrameMapCache();
    const resolved = resolveTimelineFrame(project, 60, cache);
    expect(resolved.datamosh).toHaveLength(0);
    expect(resolved.sourceFrame).toBe(60);
    expect(resolved.empty).toBe(false);
  });

  it('rewrites the source frame inside a slow-motion region', () => {
    const { project } = setup();
    const cache = new FrameMapCache();
    const first = resolveTimelineFrame(project, 120, cache);
    const tenth = resolveTimelineFrame(project, 129, cache);
    expect(first.datamosh).toHaveLength(1);
    // Slower than real time: the source advances much less than 9 frames.
    expect(tenth.sourceFrame - first.sourceFrame).toBeLessThan(4);
  });

  it('reports the same frame for the same input (determinism)', () => {
    const { project } = setup();
    const a = resolveTimelineFrame(project, 150, new FrameMapCache()).sourceFrame;
    const b = resolveTimelineFrame(project, 150, new FrameMapCache()).sourceFrame;
    expect(a).toBe(b);
  });

  it('returns an empty frame past the end of the timeline', () => {
    const { project } = setup();
    const resolved = resolveTimelineFrame(project, 5000, new FrameMapCache());
    expect(resolved.empty).toBe(true);
  });

  it('hashes effect ids stably so the seed does not change between runs', () => {
    expect(hashString('fx_abc')).toBe(hashString('fx_abc'));
    expect(hashString('fx_abc')).not.toBe(hashString('fx_abd'));
  });
});

describe('avi frame type detection', () => {
  it('reads the MPEG-4 VOP coding type from the start code', () => {
    const iFrame = new Uint8Array([0x00, 0x00, 0x01, 0xb6, 0x00, 0x11]);
    const pFrame = new Uint8Array([0x00, 0x00, 0x01, 0xb6, 0x40, 0x11]);
    const bFrame = new Uint8Array([0x00, 0x00, 0x01, 0xb6, 0x80, 0x11]);
    expect(detectVopKind(iFrame, 0, iFrame.length)).toBe('I');
    expect(detectVopKind(pFrame, 0, pFrame.length)).toBe('P');
    expect(detectVopKind(bFrame, 0, bFrame.length)).toBe('B');
  });

  it('returns unknown when there is no start code', () => {
    const junk = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(detectVopKind(junk, 0, junk.length)).toBe('?');
  });
});
