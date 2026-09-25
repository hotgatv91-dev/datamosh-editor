import { beforeEach, describe, expect, it } from 'vitest';
import {
  DATAMOSH_PRESETS,
  materializeKeyframes,
  parametersFromBundles,
} from '../src/engine/datamosh/presets';
import { snapshotEffectAsPreset } from '../src/engine/datamosh/customPresets';
import { defaultParameters } from '../src/engine/datamosh/params';
import type { DatamoshPreset } from '../src/engine/datamosh/presets';
import type { Effect } from '../src/engine/project/types';
import { useEditor } from '../src/state/store';

function effect(over: Partial<Effect> = {}): Effect {
  return {
    id: 'fx1',
    type: 'datamosh',
    track: 0,
    startFrame: 100,
    endFrame: 140,
    enabled: true,
    preset: 'custom',
    renderMode: 'bitstream',
    parameters: { ...defaultParameters(), intensity: 175, motion: 20 },
    keyframes: [
      { id: 'k0', param: 'intensity', frame: 100, value: 10, easing: 'easeInOut' },
      { id: 'k1', param: 'intensity', frame: 120, value: 90, easing: 'easeInOut' },
    ],
    speedCurve: [],
    ...over,
  };
}

describe('preset parameter bundles', () => {
  it('merges a bundle over the schema defaults', () => {
    const bag = parametersFromBundles({ intensity: 123 });
    expect(bag.intensity).toBe(123);
    expect(bag.motion).toBe(defaultParameters().motion);
  });

  it('clamps out-of-range values from a bundle', () => {
    expect(parametersFromBundles({ intensity: 9999 }).intensity).toBe(200);
  });
});

describe('saving an effect as a preset', () => {
  it('stores keyframes relative to the region, not as absolute frames', () => {
    // Region 100–140 with keyframes at 100 and 120 becomes 0 and 0.5.
    const preset = snapshotEffectAsPreset(effect(), 'Boom');
    expect(preset.label).toBe('Boom');
    expect(preset.keyframes.map((k) => k.at)).toEqual([0, 0.5]);
    expect(preset.params.intensity).toBe(175);
  });

  it('re-applies to a region of a different length without distortion', () => {
    const preset = snapshotEffectAsPreset(effect(), 'Boom');
    // Same curve on a region twice as long: the keyframes must stretch with it.
    const applied = materializeKeyframes(preset.keyframes, {
      id: 'fx2',
      startFrame: 300,
      endFrame: 380,
    });
    expect(applied.map((k) => k.frame)).toEqual([300, 340]);
    expect(applied.map((k) => k.value)).toEqual([10, 90]);
  });

  it('falls back to a name when the input is blank', () => {
    expect(snapshotEffectAsPreset(effect(), '   ').label).toBe('Preset của tôi');
  });
});

describe('creating a region from a user preset', () => {
  beforeEach(() => {
    useEditor.getState().newProject();
  });

  it('uses the saved params and keyframes, not the schema defaults', () => {
    // A user preset is not in PRESET_MAP, so anything that looks a preset up by
    // id would silently build the effect from defaults instead.
    const userPreset: DatamoshPreset = {
      id: 'user_boom',
      label: 'Boom',
      description: 'tự lưu',
      relevant: ['intensity'],
      params: { intensity: 199, motion: 7 },
      keyframes: [
        { param: 'intensity', at: 0, value: 5 },
        { param: 'intensity', at: 1, value: 95 },
      ],
    };
    expect(DATAMOSH_PRESETS.some((p) => p.id === userPreset.id)).toBe(false);

    const id = useEditor.getState().createDatamoshRegion(userPreset, { start: 10, end: 60 });
    expect(id).toBeTruthy();

    const created = useEditor.getState().project.effects[0]!;
    expect(created.parameters.intensity).toBe(199);
    expect(created.parameters.motion).toBe(7);
    expect(created.keyframes.map((k) => k.frame)).toEqual([10, 60]);
    expect(created.preset).toBe('user_boom');
  });
});
