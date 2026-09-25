/**
 * Audio planning for the export — the pure half.
 *
 * Kept apart from audio.ts (which drives ffmpeg) for the same reason avi.ts is
 * apart from pipeline.ts: the decisions are testable on their own, with no
 * encoder, no browser and no wasm in the way.
 *
 * What it decides:
 *   - how the timeline is cut into audio spans, using the very same segment
 *     boundaries as the video so the two cannot drift apart;
 *   - how a datamosh region's audio melts, as an ffmpeg filter chain driven by
 *     the region's own parameters.
 */

import type { Effect, Frame, ParamBag, Project } from '../project/types';
import { resolveParams } from '../datamosh/keyframes';
import { boolParam, numParam } from '../datamosh/params';
import { effectById } from '../timeline/derive';

export const AUDIO_SAMPLE_RATE = 48000;
export const AUDIO_BITRATE = '192k';

/** One cut of the timeline, mirroring the video segments exactly. */
export interface ExportSegmentPlan {
  startFrame: Frame;
  endFrame: Frame;
  mosh: boolean;
  effectIds: string[];
}

export interface AudioSpan {
  startFrame: Frame;
  endFrame: Frame;
  /** Mangle parameters when this span sits inside a datamosh region. */
  mangle: ParamBag | null;
}

/**
 * Maps the video segments onto audio spans.
 *
 * A mosh segment is wider than its effect: it carries pre-roll so the MPEG-4
 * encoder has a reference to drift from. Only the effect's own frames may have
 * their audio melted, so each mosh segment is split at the region boundaries —
 * otherwise the sound would start warping half a second before the picture.
 */
export function buildAudioSpans(segments: ExportSegmentPlan[], project: Project): AudioSpan[] {
  const spans: AudioSpan[] = [];

  for (const segment of segments) {
    if (!segment.mosh) {
      spans.push({ startFrame: segment.startFrame, endFrame: segment.endFrame, mangle: null });
      continue;
    }

    const regions = segment.effectIds
      .map((id) => effectById(project, id))
      .filter(
        (candidate): candidate is Effect =>
          !!candidate && boolParam(resolveParams(candidate, candidate.startFrame), 'audioMangle', true),
      )
      .map((effect) => ({
        start: Math.max(segment.startFrame, effect.startFrame),
        end: Math.min(segment.endFrame, effect.endFrame),
        params: resolveParams(effect, effect.startFrame),
      }))
      .filter((region) => region.end > region.start)
      .sort((a, b) => a.start - b.start);

    let cursor = segment.startFrame;
    for (const region of regions) {
      // Overlap is impossible in practice; clamping guarantees it either way.
      const start = Math.max(cursor, region.start);
      if (start > cursor) {
        spans.push({ startFrame: cursor, endFrame: start, mangle: null });
      }
      if (region.end > start) {
        spans.push({ startFrame: start, endFrame: region.end, mangle: region.params });
        cursor = region.end;
      }
    }
    if (cursor < segment.endFrame) {
      spans.push({ startFrame: cursor, endFrame: segment.endFrame, mangle: null });
    }
  }

  return spans;
}

/**
 * The audio equivalent of the video drift, as an ffmpeg filter chain.
 *
 * `asetrate` reinterprets the samples at a different rate, which drops (or
 * raises) the pitch and stretches the span; `atempo` then squeezes it back to
 * the original length, so the only audible change is the pitch — exactly what
 * frame repetition does to the picture. `tremolo` adds the stutter, keyed to
 * the region's frame-repeat settings.
 *
 * `audioAmount` scales everything back toward "untouched", so 0% is the plain
 * original audio. Returns '' when there is nothing to do.
 */
export function mangleFilter(params: ParamBag, sampleRate = AUDIO_SAMPLE_RATE): string {
  const amount = Math.min(1, Math.max(0, numParam(params, 'audioAmount', 100) / 100));
  if (amount <= 0) return '';

  const parts: string[] = [];

  // Pitch warp. atempo must stay inside 0.5..2, which `rate` is clamped for.
  const speed = numParam(params, 'speed', 1);
  const target = Math.min(2, Math.max(0.5, speed));
  const rate = 1 + (target - 1) * amount;
  if (Math.abs(rate - 1) > 0.01) {
    parts.push(
      `asetrate=${Math.round(sampleRate * rate)}`,
      `aresample=${sampleRate}`,
      `atempo=${(1 / rate).toFixed(4)}`,
    );
  }

  // Stutter: repeat/hold settings become a tremolo in the same rhythm.
  const repeat = numParam(params, 'repeatCount', 1);
  const hold = numParam(params, 'holdFrames', 0);
  const intensity = numParam(params, 'intensity', 60);
  const depth = Math.min(0.95, (intensity / 200) * amount);
  if (depth > 0.05) {
    const hz = Math.min(18, Math.max(1.5, 2 + repeat * 1.5 + hold * 0.25));
    parts.push(`tremolo=f=${hz.toFixed(2)}:d=${depth.toFixed(2)}`);
  }

  return parts.join(',');
}

/**
 * The whole audio track as one `-filter_complex` graph: trim every span to its
 * exact length, mangle the mosh spans, then concatenate.
 *
 * One pass, not one encode per span: a per-span encode would add AAC encoder
 * padding (~21 ms) at every boundary and the audio would creep away from the
 * picture it is meant to be locked to.
 */
export function buildAudioFilterGraph(
  spans: AudioSpan[],
  fps: number,
  sampleRate = AUDIO_SAMPLE_RATE,
): string {
  const chains: string[] = [];
  const labels: string[] = [];

  spans.forEach((span, index) => {
    const start = span.startFrame / fps;
    const end = span.endFrame / fps;
    const label = `a${index}`;
    const mangle = span.mangle ? mangleFilter(span.mangle, sampleRate) : '';
    chains.push(
      `[0:a]atrim=start=${start.toFixed(4)}:end=${end.toFixed(4)},asetpts=N/SR/TB,` +
        `aresample=${sampleRate},aformat=channel_layouts=stereo` +
        `${mangle ? `,${mangle}` : ''}[${label}]`,
    );
    labels.push(`[${label}]`);
  });

  chains.push(`${labels.join('')}concat=n=${spans.length}:v=0:a=1[out]`);
  return chains.join(';');
}
