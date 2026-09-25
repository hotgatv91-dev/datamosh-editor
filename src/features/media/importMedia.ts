/** Import: validate the file, read metadata, build a MediaAsset. */

import type { MediaAsset } from '../../engine/project/types';
import { AppError, MAX_FILE_BYTES, SOFT_FILE_BYTES, looksSupported } from '../../engine/errors';
import { probeMedia } from '../../engine/frames/probe';
import { normalizeFps } from '../../engine/frames/probe';
import { uid } from '../../engine/timeline/ops';
import { log } from '../../engine/log';

export interface ImportResult {
  asset: MediaAsset;
  warnings: string[];
  file: File;
}

export async function importVideoFile(file: File): Promise<ImportResult> {
  const warnings: string[] = [];

  if (!looksSupported(file.name, file.type)) {
    throw new AppError('unsupported-format', undefined, `Rejected file: ${file.name} (${file.type})`);
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new AppError(
      'too-large',
      undefined,
      `${file.name} is ${(file.size / 1024 ** 3).toFixed(2)} GB (limit 2 GB)`,
    );
  }
  if (file.size > SOFT_FILE_BYTES) {
    warnings.push('This video is large — preview will be slow on this device.');
  }

  log.info('import', `Probing ${file.name} (${(file.size / 1024 ** 2).toFixed(1)} MB)`);

  let probe: Awaited<ReturnType<typeof probeMedia>>;
  try {
    probe = await probeMedia(file);
  } catch (error) {
    log.error('import', 'Metadata probe failed', error);
    throw new AppError('decode-failed', undefined, errorText(error));
  }

  if (!probe.width || !probe.height) {
    throw new AppError('no-video-track', undefined, `No video track in ${file.name}`);
  }
  if (!Number.isFinite(probe.durationSec) || probe.durationSec <= 0) {
    throw new AppError('decode-failed', undefined, `Zero duration video: ${file.name}`);
  }

  const fps = normalizeFps(probe.fps);
  if (probe.fpsApproximate) {
    warnings.push(`Frame rate could not be read exactly — assuming ${fps} fps.`);
  }
  if (!probe.frameAccurate) {
    warnings.push('Frame-accurate decode unavailable for this file — using video element seeking.');
  }

  const asset: MediaAsset = {
    id: uid('media'),
    name: file.name,
    sizeBytes: file.size,
    durationFrames: Math.max(1, Math.round(probe.durationSec * fps)),
    width: probe.width,
    height: probe.height,
    fps,
    container: probe.container,
    videoCodec: probe.videoCodec || 'unknown',
    hasAudio: probe.hasAudio,
    lastModified: file.lastModified,
    addedAt: Date.now(),
  };

  log.info(
    'import',
    `Imported ${asset.name}: ${asset.width}x${asset.height} @ ${asset.fps}fps, ${asset.durationFrames} frames`,
  );

  return { asset, warnings, file };
}

export function acceptAttribute(): string {
  return 'video/*,.mp4,.mov,.m4v,.webm,.mkv,.avi,.ogv';
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
