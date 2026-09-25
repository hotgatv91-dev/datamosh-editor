/**
 * Export pipeline.
 *
 * Two paths, both real:
 *
 *  FAST (bitstream): the datamosh region is re-encoded to MPEG-4 in AVI, its
 *  I-frames are removed from the encoded stream (see avi.ts) and the result is
 *  re-encoded. This is where genuine decoder drift — actual datamosh — comes
 *  from.
 *
 *  EXACT (render frames): every frame is baked through the same WebGL pipeline
 *  the preview uses and piped to ffmpeg as raw video. Slower and heavier, but
 *  the output is what you watched in the preview.
 *
 * Either way the timeline is processed in segments so a long video never has to
 * sit in the wasm filesystem all at once.
 */

import type { Effect, Frame, Project } from '../project/types';
import { resolveParams } from '../datamosh/keyframes';
import { effectById } from '../timeline/derive';
import { clipAtFrame } from '../timeline/derive';
import { projectDuration } from '../timeline/derive';
import { applySurgery, parseAvi, regionTransformFromParams } from './avi';
import { buildExportAudio, muxAudioIntoVideo } from './audio';
import { buildAudioSpans, type AudioSpan, type ExportSegmentPlan } from './audioPlan';
import { ffmpegClient, isLikelyLowEndDevice } from './ffmpegClient';
import { log } from '../log';

export type ExportStage = 'preparing' | 'processing' | 'encoding' | 'complete';

export interface ExportProgressUpdate {
  stage: ExportStage;
  percent: number;
  message: string;
}

export interface ExportOptions {
  resolution: 'original' | '720' | '1080';
  fps: 'original' | 24 | 30 | 60;
  format: 'mp4' | 'webm';
  pipeline: 'bitstream' | 'preview-quality';
  onProgress: (update: ExportProgressUpdate) => void;
  /** Renders one output frame through the preview pipeline (exact path). */
  renderFrames?: (startFrame: number, count: number) => Promise<Uint8Array | null>;
  signal?: AbortSignal;
}

export interface ExportResult {
  blob: Blob;
  mimeType: string;
  method: 'bitstream-surgery' | 'frame-render';
  warnings: string[];
}

const SEGMENT_PREFIX = 'seg_';
const CHUNK_FRAMES = 24;

export interface ExportPlan {
  fps: number;
  frameDuration: number;
  width: number;
  height: number;
  hasAudio: boolean;
  moshSegments: {
    startFrame: number;
    endFrame: number;
    effectIds: string[];
  }[];
  /**
   * The timeline cut into encode segments with the mosh pre-roll already
   * applied. Both the video path and the audio path use this list, which is
   * what keeps the two in sync to the frame.
   */
  segments: ExportSegmentPlan[];
  simple: boolean;
  warnings: string[];
}

export function buildExportPlan(project: Project): ExportPlan {
  const warnings: string[] = [];
  const duration = projectDuration(project);
  const fps = project.fps || 30;

  const clip = project.clips[0];
  const asset = clip ? project.media.find((m) => m.id === clip.mediaId) : null;
  let width = asset?.width ?? 1280;
  let height = asset?.height ?? 720;

  const hasDatamosh = project.effects.some((e) => e.type === 'datamosh' && e.enabled);
  const assetHasAudio = !!asset?.hasAudio;

  const simple =
    project.clips.length <= 1 &&
    (!clip || (clip.speed === 1 && clip.inFrame === 0));

  if (project.clips.length > 1) {
    warnings.push('Multiple clips: effects are applied per source span, cuts are re-encoded.');
  }
  if (hasDatamosh && !simple) {
    warnings.push('Trimmed or sped-up video: the bitstream path uses the trimmed source range.');
  }
  if (isLikelyLowEndDevice()) {
    warnings.push('This device looks low-powered — expect a slow export.');
  }

  const moshSegments: ExportPlan['moshSegments'] = [];
  const moshEffects = project.effects
    .filter((e) => e.type === 'datamosh' && e.enabled)
    .sort((a, b) => a.startFrame - b.startFrame);

  // Audio is muxed back from the same timeline that has the audio track. A
  // trimmed or retimed project has no such mapping yet, so the sound is left
  // out — loudly, never silently.
  const hasAudio = assetHasAudio && simple;
  if (assetHasAudio && !hasAudio) {
    warnings.push(
      'Bản xuất không kèm tiếng: dự án đã bị cắt hoặc đổi tốc độ nên audio chưa được ghép lại.',
    );
  }

  for (const effect of moshEffects) {
    const existing = moshSegments[moshSegments.length - 1];
    if (existing && effect.startFrame <= existing.endFrame + 1) {
      existing.endFrame = Math.max(existing.endFrame, effect.endFrame);
      existing.effectIds.push(effect.id);
    } else {
      moshSegments.push({
        startFrame: effect.startFrame,
        endFrame: Math.min(effect.endFrame, Math.max(1, duration)),
        effectIds: [effect.id],
      });
    }
  }

  if (width > 1920) {
    width = 1920;
    warnings.push('Export capped at 1920 px wide.');
  }

  return {
    fps,
    frameDuration: duration,
    width,
    height,
    hasAudio,
    moshSegments,
    segments: buildSegments(fps, duration, moshSegments),
    simple,
    warnings,
  };
}

/**
 * Cuts the timeline into copy spans and mosh spans, with a little pre-roll so
 * the MPEG-4 encoder has a reference before the effect starts.
 */
function buildSegments(
  fps: number,
  duration: Frame,
  moshSegments: ExportPlan['moshSegments'],
): ExportSegmentPlan[] {
  const segments: ExportSegmentPlan[] = [];
  const preRoll = Math.max(1, Math.round(fps * 0.5));
  let cursor = 0;

  for (const segment of moshSegments) {
    const regionStart = Math.max(0, segment.startFrame - preRoll);
    if (regionStart > cursor) {
      segments.push({ startFrame: cursor, endFrame: regionStart, mosh: false, effectIds: [] });
    }
    const end = Math.min(duration, segment.endFrame);
    // Clamped so a pre-roll can never overlap the previous segment.
    const start = Math.max(cursor, regionStart);
    if (end > start) {
      segments.push({ startFrame: start, endFrame: end, mosh: true, effectIds: segment.effectIds });
    }
    cursor = Math.max(cursor, end);
  }

  if (cursor < duration) {
    segments.push({ startFrame: cursor, endFrame: duration, mosh: false, effectIds: [] });
  }
  return segments;
}

export function targetDimensions(
  sourceWidth: number,
  sourceHeight: number,
  resolution: ExportOptions['resolution'],
): { width: number; height: number } {
  const cap =
    resolution === '720' ? 720 : resolution === '1080' ? 1080 : Math.max(sourceWidth, sourceHeight);
  const longest = Math.max(sourceWidth, sourceHeight);
  if (longest <= cap) return { width: even(sourceWidth), height: even(sourceHeight) };
  const scale = cap / longest;
  return { width: even(sourceWidth * scale), height: even(sourceHeight * scale) };
}

function even(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

/* ------------------------------------------------------------------ run */

export async function runExport(
  project: Project,
  sourceBytes: Uint8Array,
  options: ExportOptions,
): Promise<ExportResult> {
  const plan = buildExportPlan(project);
  const warnings = [...plan.warnings];
  const { width, height } = targetDimensions(plan.width, plan.height, options.resolution);
  const outFps = options.fps === 'original' ? plan.fps : options.fps;

  options.onProgress({ stage: 'preparing', percent: 0, message: 'Loading encoder…' });
  await ffmpegClient.load((message) =>
    options.onProgress({ stage: 'preparing', percent: 2, message }),
  );

  const inputName = `input.${sourceNameExtension(project)}`;
  options.onProgress({ stage: 'preparing', percent: 6, message: 'Copying source into the encoder…' });
  await ffmpegClient.writeFile(inputName, sourceBytes);
  const audioSpans = plan.hasAudio ? buildAudioSpans(plan.segments, project) : [];

  try {
    if (options.pipeline === 'bitstream' && plan.moshSegments.length && options.renderFrames === undefined) {
      return await runBitstreamPath(
        project, inputName, plan, { width, height, outFps }, options, warnings, audioSpans,
      );
    }
    return await runRenderPath(
      project, inputName, plan, { width, height, outFps }, options, warnings, audioSpans,
    );
  } finally {
    await ffmpegClient.deleteFile(inputName);
  }
}

interface EncodingTarget {
  width: number;
  height: number;
  outFps: number;
}

async function runBitstreamPath(
  project: Project,
  inputName: string,
  plan: ExportPlan,
  target: EncodingTarget,
  options: ExportOptions,
  warnings: string[],
  audioSpans: AudioSpan[],
): Promise<ExportResult> {
  const segmentFiles: string[] = [];
  let segmentIndex = 0;

  const pushSegment = async (
    startFrame: Frame,
    endFrame: Frame,
    mode: 'copy' | 'mosh',
    effects: Effect[],
  ): Promise<void> => {
    const startSec = startFrame / plan.fps;
    const lenSec = Math.max(1 / plan.fps, (endFrame - startFrame) / plan.fps);
    const outName = `${SEGMENT_PREFIX}${segmentIndex}.mp4`;
    const progressBase = 10 + (segmentIndex / Math.max(1, plan.moshSegments.length + 1)) * 70;
    options.onProgress({
      stage: mode === 'mosh' ? 'processing' : 'encoding',
      percent: Math.round(progressBase),
      message:
        mode === 'mosh'
          ? `Reworking the encoded stream for ${startSec.toFixed(2)}s – ${(startSec + lenSec).toFixed(2)}s…`
          : `Encoding ${startSec.toFixed(2)}s – ${(startSec + lenSec).toFixed(2)}s…`,
    });

    if (mode === 'mosh') {
      const prepName = `${SEGMENT_PREFIX}${segmentIndex}_prep.avi`;
      const moshedName = `${SEGMENT_PREFIX}${segmentIndex}_moshed.avi`;
      const gop = Math.max(
        1,
        Math.round(
          effects.reduce((value, effect) => {
            const params = resolveParams(effect, effect.startFrame);
            const gopSize = params.gopSize;
            return typeof gopSize === 'number' ? Math.max(value, gopSize) : value;
          }, 24),
        ),
      );

      // Lossless-ish MPEG-4 in AVI: every frame becomes an addressable chunk.
      const prepareCode = await ffmpegClient.exec([
        '-ss', startSec.toFixed(4),
        '-t', lenSec.toFixed(4),
        '-i', inputName,
        '-an',
        '-c:v', 'mpeg4',
        '-bf', '0',
        '-g', String(gop),
        '-qscale:v', '2',
        '-pix_fmt', 'yuv420p',
        '-vtag', 'xvid',
        prepName,
      ]);
      if (prepareCode !== 0) {
        warnings.push('MPEG-4 preparation failed for one region; that region was re-encoded without mosh.');
        await ffmpegClient.exec(plainEncodeArgs(inputName, startSec, lenSec, target, 'libx264', outName));
        segmentFiles.push(outName);
        segmentIndex += 1;
        return;
      }

      const prepBytes = await ffmpegClient.readFile(prepName);
      let avi;
      try {
        avi = parseAvi(prepBytes);
      } catch (error) {
        warnings.push('The prepared AVI could not be indexed; that region was re-encoded without mosh.');
        log.error('export', 'AVI parse failed', error);
        await ffmpegClient.exec(plainEncodeArgs(inputName, startSec, lenSec, target, 'libx264', outName));
        segmentFiles.push(outName);
        segmentIndex += 1;
        await ffmpegClient.cleanup([prepName]);
        return;
      }

      // Region effects are expressed in segment-local frames; the segment starts
      // at the first effect's start frame so the mapping is a simple offset.
      const segmentStart = startFrame;
      const regions = effects.map((effect) => {
        const params = resolveParams(effect, effect.startFrame);
        return regionTransformFromParams(
          Math.max(0, effect.startFrame - segmentStart),
          Math.min(endFrame, effect.endFrame) - segmentStart,
          params,
        );
      });

      const surgery = applySurgery(avi, regions);
      log.info('export', 'AVI surgery applied', surgery.stats);
      await ffmpegClient.writeFile(moshedName, surgery.bytes);

      // -vsync cfr rebuilds constant timing after chunks were removed/duplicated.
      const finishCode = await ffmpegClient.exec([
        '-i', moshedName,
        '-an',
        '-r', String(target.outFps),
        '-vsync', 'cfr',
        '-vf', `scale=${target.width}:${target.height}:flags=bicubic`,
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '18',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        outName,
      ]);
      if (finishCode !== 0) throw new Error('ffmpeg failed to encode the moshed region');

      await ffmpegClient.cleanup([prepName, moshedName]);
    } else {
      const code = await ffmpegClient.exec(
        plainEncodeArgs(inputName, startSec, lenSec, target, 'libx264', outName),
      );
      if (code !== 0) throw new Error('ffmpeg failed to encode a segment');
    }

    segmentFiles.push(outName);
    segmentIndex += 1;
  };

  // The timeline was already cut into segments (with the pre-roll applied) by
  // buildExportPlan, so the audio spans line up with these exactly.
  for (const segment of plan.segments) {
    const effects = segment.mosh
      ? segment.effectIds
          .map((id) => effectById(project, id))
          .filter((effect): effect is Effect => !!effect)
      : [];
    await pushSegment(segment.startFrame, segment.endFrame, segment.mosh ? 'mosh' : 'copy', effects);
  }

  options.onProgress({ stage: 'encoding', percent: 84, message: 'Joining segments…' });
  const output = await concatSegments(segmentFiles, target, options, plan, inputName, audioSpans);
  return output;
}

function plainEncodeArgs(
  inputName: string,
  startSec: number,
  lenSec: number,
  target: EncodingTarget,
  encoder: string,
  outName: string,
): string[] {
  return [
    '-ss', startSec.toFixed(4),
    '-t', lenSec.toFixed(4),
    '-i', inputName,
    '-an',
    '-vf', `scale=${target.width}:${target.height}:flags=bicubic`,
    '-r', String(target.outFps),
    '-c:v', encoder,
    '-preset', 'veryfast',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    outName,
  ];
}

async function concatSegments(
  segmentFiles: string[],
  target: EncodingTarget,
  options: ExportOptions,
  plan: ExportPlan,
  inputName: string,
  audioSpans: AudioSpan[],
): Promise<ExportResult> {
  const container = options.format === 'webm' ? 'webm' : 'mp4';
  const finalName = `output.${container}`;
  const listName = 'segments.txt';
  let videoName: string;

  if (segmentFiles.length === 1 && container === 'mp4') {
    // A single MP4 segment is already the video track; there is nothing to join.
    videoName = segmentFiles[0]!;
  } else if (segmentFiles.length === 1) {
    const code = await ffmpegClient.exec([
      '-i', segmentFiles[0]!,
      '-c:v', 'libvpx-vp9',
      '-b:v', '0',
      '-crf', '32',
      '-pix_fmt', 'yuv420p',
      finalName,
    ]);
    if (code !== 0) throw new Error('ffmpeg failed to encode WebM');
    videoName = finalName;
  } else {
    await ffmpegClient.writeFile(
      listName,
      new TextEncoder().encode(segmentFiles.map((name) => `file '${name}'`).join('\n')),
    );

    if (container === 'mp4') {
      const code = await ffmpegClient.exec([
        '-f', 'concat',
        '-safe', '0',
        '-i', listName,
        '-c', 'copy',
        '-movflags', '+faststart',
        finalName,
      ]);
      if (code !== 0) {
        // Stream copy can fail when segment parameter sets differ; re-encode.
        options.onProgress({ stage: 'encoding', percent: 92, message: 'Re-encoding joined segments…' });
        const retry = await ffmpegClient.exec([
          '-f', 'concat',
          '-safe', '0',
          '-i', listName,
          '-c:v', 'libx264',
          '-preset', 'veryfast',
          '-crf', '18',
          '-pix_fmt', 'yuv420p',
          '-movflags', '+faststart',
          finalName,
        ]);
        if (retry !== 0) throw new Error('ffmpeg failed to join segments');
      }
    } else {
      const code = await ffmpegClient.exec([
        '-f', 'concat',
        '-safe', '0',
        '-i', listName,
        '-c:v', 'libvpx-vp9',
        '-b:v', '0',
        '-crf', '32',
        '-pix_fmt', 'yuv420p',
        finalName,
      ]);
      if (code !== 0) throw new Error('ffmpeg failed to produce WebM');
    }
    videoName = finalName;
  }

  // Audio last, and never fatal: a silent export is much worse than a failed
  // mangle, but a failed mangle must not throw away a good video either.
  const warnings = [...plan.warnings];
  let resultName = videoName;
  if (plan.hasAudio && audioSpans.length) {
    options.onProgress({ stage: 'encoding', percent: 94, message: 'Thêm tiếng vào bản xuất…' });
    const audio = await buildExportAudio(inputName, audioSpans, plan.fps, container);
    if (!audio) {
      warnings.push('Không dựng được track tiếng — bản xuất chỉ có hình.');
    } else {
      const muxedName = `muxed.${container}`;
      const ok = await muxAudioIntoVideo(videoName, audio.fileName, container, muxedName);
      await ffmpegClient.cleanup([audio.fileName]);
      if (ok) resultName = muxedName;
      else warnings.push('Không ghép được tiếng vào bản xuất — bản xuất chỉ có hình.');
    }
  }

  const data = await ffmpegClient.readFile(resultName);
  await ffmpegClient.cleanup([...segmentFiles, finalName, resultName, listName]);
  void target;
  return {
    blob: new Blob([toArrayBuffer(data)], { type: container === 'webm' ? 'video/webm' : 'video/mp4' }),
    mimeType: container === 'webm' ? 'video/webm' : 'video/mp4',
    method: 'bitstream-surgery',
    warnings,
  };
}

async function runRenderPath(
  project: Project,
  inputName: string,
  plan: ExportPlan,
  target: EncodingTarget,
  options: ExportOptions,
  warnings: string[],
  audioSpans: AudioSpan[],
): Promise<ExportResult> {
  if (!options.renderFrames) {
    warnings.push('Frame rendering is unavailable, so the datamosh region falls back to the fast path.');
    return runBitstreamPath(project, inputName, plan, target, options, warnings, audioSpans);
  }

  const segmentFiles: string[] = [];
  const total = plan.frameDuration;
  let index = 0;
  let frame = 0;

  while (frame < total) {
    if (options.signal?.aborted) throw new Error('Export cancelled');
    const count = Math.min(CHUNK_FRAMES, total - frame);
    const rawName = `chunk_${index}.raw`;
    const outName = `${SEGMENT_PREFIX}${index}.mp4`;

    options.onProgress({
      stage: 'processing',
      percent: Math.round(10 + (frame / total) * 70),
      message: `Rendering frames ${frame}–${frame + count} of ${total}…`,
    });
    const bytes = await options.renderFrames(frame, count);
    if (!bytes) throw new Error('Frame rendering failed');
    await ffmpegClient.writeFile(rawName, bytes);

    const code = await ffmpegClient.exec([
      '-f', 'rawvideo',
      '-pix_fmt', 'rgb24',
      '-s', `${target.width}x${target.height}`,
      '-r', String(target.outFps),
      '-i', rawName,
      '-an',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '18',
      '-pix_fmt', 'yuv420p',
      outName,
    ]);
    if (code !== 0) throw new Error('ffmpeg failed to encode rendered frames');

    await ffmpegClient.deleteFile(rawName);
    segmentFiles.push(outName);
    frame += count;
    index += 1;
  }

  options.onProgress({ stage: 'encoding', percent: 86, message: 'Joining rendered segments…' });
  const result = await concatSegments(segmentFiles, target, options, plan, inputName, audioSpans);
  return { ...result, method: 'frame-render', warnings };
}

function sourceNameExtension(project: Project): string {
  const asset = project.media[0];
  if (!asset) return 'mp4';
  const ext = asset.name.slice(asset.name.lastIndexOf('.') + 1).toLowerCase();
  return ['mp4', 'mov', 'm4v', 'webm', 'mkv'].includes(ext) ? ext : 'mp4';
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/** Frames that the exact path must render, in the order the timeline plays them. */
export function renderFrameList(project: Project, startFrame: Frame, count: number): Frame[] {
  const out: Frame[] = [];
  for (let i = 0; i < count; i += 1) {
    const frame = startFrame + i;
    if (clipAtFrame(project, frame)) out.push(frame);
  }
  return out;
}
