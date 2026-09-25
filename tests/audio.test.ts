import { describe, expect, it } from 'vitest';
import {
  buildAudioFilterGraph,
  buildAudioSpans,
  mangleFilter,
  type ExportSegmentPlan,
} from '../src/engine/export/audioPlan';
import { buildExportPlan } from '../src/engine/export/pipeline';
import { defaultParameters } from '../src/engine/datamosh/params';
import { DATAMOSH_PRESETS } from '../src/engine/datamosh/presets';
import { createEmptyProject, type MediaAsset, type Project } from '../src/engine/project/types';

const FPS = 30;

function projectWithRegion(
  startFrame: number,
  endFrame: number,
  params: Record<string, number | string | boolean>,
  hasAudio = true,
): Project {
  const project = createEmptyProject();
  const asset: MediaAsset = {
    id: 'asset1',
    name: 'clip.mp4',
    sizeBytes: 1000,
    durationFrames: 300,
    fps: FPS,
    width: 1280,
    height: 720,
    container: 'mp4',
    videoCodec: 'avc1.64001e',
    hasAudio,
    lastModified: 1,
    addedAt: 1,
  };
  project.media.push(asset);
  project.fps = FPS;
  project.clips.push({
    id: 'clip1',
    mediaId: 'asset1',
    track: 0,
    startFrame: 0,
    inFrame: 0,
    outFrame: 300,
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
  });
  project.effects.push({
    id: 'fx1',
    type: 'datamosh',
    track: 0,
    startFrame,
    endFrame,
    enabled: true,
    preset: 'classic',
    renderMode: 'bitstream',
    parameters: { ...defaultParameters(), ...params },
    keyframes: [],
    speedCurve: [],
  });
  return project;
}

describe('export plan segments', () => {
  it('cuts the timeline into copy spans around a mosh span with pre-roll', () => {
    const plan = buildExportPlan(projectWithRegion(100, 160, {}));
    // Pre-roll is 0.5s = 15 frames at 30fps.
    expect(plan.segments.map((s) => [s.startFrame, s.endFrame, s.mosh])).toEqual([
      [0, 85, false],
      [85, 160, true],
      [160, 300, false],
    ]);
  });

  it('has no leading copy span when the region starts at frame 0', () => {
    const plan = buildExportPlan(projectWithRegion(0, 40, {}));
    expect(plan.segments.map((s) => [s.startFrame, s.endFrame, s.mosh])).toEqual([
      [0, 40, true],
      [40, 300, false],
    ]);
  });

  it('never lets a pre-roll overlap the previous span', () => {
    const project = projectWithRegion(100, 130, {});
    project.effects.push({ ...project.effects[0]!, id: 'fx2', startFrame: 132, endFrame: 170 });
    const plan = buildExportPlan(project);
    for (let i = 1; i < plan.segments.length; i += 1) {
      expect(plan.segments[i]!.startFrame).toBeGreaterThanOrEqual(plan.segments[i - 1]!.endFrame);
    }
  });

  it('keeps audio only for a project it can map back to the source', () => {
    expect(buildExportPlan(projectWithRegion(10, 20, {})).hasAudio).toBe(true);

    const trimmed = projectWithRegion(10, 20, {});
    trimmed.clips[0]!.inFrame = 30;
    const plan = buildExportPlan(trimmed);
    expect(plan.hasAudio).toBe(false);
    expect(plan.warnings.join(' ')).toContain('không kèm tiếng');
  });

  it('reports no audio at all when the source has none', () => {
    const plan = buildExportPlan(projectWithRegion(10, 20, {}, false));
    expect(plan.hasAudio).toBe(false);
    expect(plan.warnings.join(' ')).not.toContain('không kèm tiếng');
  });
});

describe('audio spans', () => {
  const segments: ExportSegmentPlan[] = [
    { startFrame: 0, endFrame: 85, mosh: false, effectIds: [] },
    { startFrame: 85, endFrame: 160, mosh: true, effectIds: ['fx1'] },
    { startFrame: 160, endFrame: 300, mosh: false, effectIds: [] },
  ];

  it('melts only the region frames, not the pre-roll before them', () => {
    const spans = buildAudioSpans(segments, projectWithRegion(100, 160, {}));
    // Segment 85–160 carries 15 frames of pre-roll; the effect starts at 100,
    // so 85–100 must stay untouched.
    expect(spans.map((s) => [s.startFrame, s.endFrame, !!s.mangle])).toEqual([
      [0, 85, false],
      [85, 100, false],
      [100, 160, true],
      [160, 300, false],
    ]);
  });

  it('covers every frame of the timeline exactly once', () => {
    const spans = buildAudioSpans(segments, projectWithRegion(100, 160, {}));
    expect(spans[0]!.startFrame).toBe(0);
    expect(spans[spans.length - 1]!.endFrame).toBe(300);
    for (let i = 1; i < spans.length; i += 1) {
      expect(spans[i]!.startFrame).toBe(spans[i - 1]!.endFrame);
    }
  });

  it('leaves the audio alone when the region has mangling switched off', () => {
    const spans = buildAudioSpans(segments, projectWithRegion(100, 160, { audioMangle: false }));
    expect(spans.some((span) => span.mangle)).toBe(false);
    // The audio still gets cut into spans — it just stays clean throughout.
    expect(spans.reduce((sum, s) => sum + (s.endFrame - s.startFrame), 0)).toBe(300);
  });
});

describe('audio mangling filter', () => {
  const params = (over: Record<string, number | string | boolean>) => ({
    ...defaultParameters(),
    ...over,
  });

  it('does nothing at zero amount', () => {
    expect(mangleFilter(params({ audioAmount: 0, speed: 0.25 }))).toBe('');
  });

  it('drops the pitch and compensates the length so it stays in sync', () => {
    const filter = mangleFilter(params({ speed: 0.5, audioAmount: 100, intensity: 0 }));
    expect(filter).toContain(`asetrate=${Math.round(48000 * 0.5)}`);
    // atempo must undo the stretch, otherwise the audio would drift.
    expect(filter).toContain('atempo=2.0000');
    expect(filter).toContain('aresample=48000');
  });

  it('keeps atempo inside the range ffmpeg accepts, even at extreme speeds', () => {
    for (const speed of [0.05, 0.2, 1, 3, 4]) {
      const filter = mangleFilter(params({ speed, audioAmount: 100, intensity: 0 }));
      const atempo = /atempo=([\d.]+)/.exec(filter);
      if (!atempo) continue;
      const value = Number(atempo[1]);
      expect(value).toBeGreaterThanOrEqual(0.5);
      expect(value).toBeLessThanOrEqual(2);
    }
  });

  it('scales the warp down with the amount', () => {
    const full = mangleFilter(params({ speed: 0.5, audioAmount: 100, intensity: 0 }));
    const half = mangleFilter(params({ speed: 0.5, audioAmount: 50, intensity: 0 }));
    const rateOf = (filter: string) => Number(/asetrate=(\d+)/.exec(filter)?.[1] ?? 48000);
    expect(rateOf(half)).toBeGreaterThan(rateOf(full));
    expect(rateOf(half)).toBeLessThan(48000);
  });

  it('adds a stutter from the region intensity', () => {
    const filter = mangleFilter(params({ intensity: 100, speed: 1, audioAmount: 100 }));
    expect(filter).toContain('tremolo=');
  });

  it('produces a working preset mangle for Slow Motion', () => {
    const slow = DATAMOSH_PRESETS.find((p) => p.id === 'slow-motion')!;
    const filter = mangleFilter(params({ ...slow.params, audioAmount: 100 }));
    expect(filter).toContain('asetrate=');
  });
});

describe('audio filter graph', () => {
  it('trims and concatenates every span in one pass', () => {
    const spans = buildAudioSpans(
      [
        { startFrame: 0, endFrame: 90, mosh: false, effectIds: [] },
        { startFrame: 90, endFrame: 150, mosh: true, effectIds: ['fx1'] },
        { startFrame: 150, endFrame: 300, mosh: false, effectIds: [] },
      ],
      // A speed other than 1 so the mangle chain carries a pitch warp as well
      // as the stutter.
      projectWithRegion(100, 160, { speed: 0.5, intensity: 100 }),
    );
    const graph = buildAudioFilterGraph(spans, FPS);
    // 0–90 clean, 90–100 the pre-roll, 100–150 the effect, 150–300 clean.
    expect(graph).toContain('atrim=start=0.0000:end=3.0000');
    expect(graph).toContain('atrim=start=3.0000:end=3.3333');
    expect(graph).toContain('atrim=start=3.3333:end=5.0000');
    expect(graph).toContain('atrim=start=5.0000:end=10.0000');
    expect(graph).toContain('concat=n=4:v=0:a=1[out]');
    // Exactly one chain — the effect's own frames — is mangled.
    expect(graph.split('asetrate=')).toHaveLength(2);
  });
});
