/**
 * Media probing: name/size/duration/resolution/fps/codec.
 *
 * FPS is the interesting one. Containers store it, but only MP4/MOV expose it
 * cheaply, and a browser <video> element does not report it at all. So:
 *   1. MP4/MOV -> read the sample table (exact).
 *   2. otherwise -> measure with requestVideoFrameCallback (good enough).
 *   3. otherwise -> assume 30 and say so.
 */

import type { MediaInfo } from './types';
import { isMp4Family, readMp4Index } from './mp4Index';

export interface ProbeOptions {
  /** Reading the whole file for an exact index is only done below this size. */
  indexMaxBytes?: number;
}

export const INDEX_MAX_BYTES = 512 * 1024 * 1024;

export function createObjectUrl(file: File): string {
  return URL.createObjectURL(file);
}

/** Metadata that always works: every browser can open the file in a video tag. */
export async function probeVideoElement(file: File): Promise<{
  width: number;
  height: number;
  durationSec: number;
  hasAudio: boolean;
}> {
  const url = createObjectUrl(file);
  const video = document.createElement('video');
  video.preload = 'metadata';
  video.muted = true;
  video.playsInline = true;
  video.src = url;

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('metadata timeout')), 20_000);
      const done = () => {
        window.clearTimeout(timer);
        resolve();
      };
      video.onloadedmetadata = done;
      video.onerror = () => {
        window.clearTimeout(timer);
        reject(new Error('cannot read metadata'));
      };
    });

    // Chromium reports duration as Infinity for some fragmented streams until a
    // seek forces it to be resolved.
    if (!Number.isFinite(video.duration) || video.duration === 0) {
      video.currentTime = 1e101;
      await new Promise<void>((resolve) => {
        const timer = window.setTimeout(resolve, 3000);
        video.ontimeupdate = () => {
          video.ontimeupdate = null;
          window.clearTimeout(timer);
          resolve();
        };
      });
      video.currentTime = 0;
    }

    const width = video.videoWidth || 0;
    const height = video.videoHeight || 0;
    if (!width || !height) throw new Error('no video track');
    const hasAudio = detectAudio(video);
    return {
      width,
      height,
      durationSec: Number.isFinite(video.duration) ? video.duration : 0,
      hasAudio,
    };
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

function detectAudio(video: HTMLVideoElement): boolean {
  const anyVideo = video as HTMLVideoElement & {
    mozHasAudio?: boolean;
    webkitAudioDecodedByteCount?: number;
    audioTracks?: { length: number };
  };
  if (typeof anyVideo.mozHasAudio === 'boolean') return anyVideo.mozHasAudio;
  if (typeof anyVideo.webkitAudioDecodedByteCount === 'number') {
    return anyVideo.webkitAudioDecodedByteCount > 0;
  }
  if (anyVideo.audioTracks) return anyVideo.audioTracks.length > 0;
  return true;
}

/**
 * Measures fps by watching presented frames. Used for containers we cannot
 * index (WebM, MKV, MOV variants, ...).
 */
export async function measureFps(file: File, fallback = 30): Promise<number | null> {
  const url = createObjectUrl(file);
  const video = document.createElement('video');
  video.preload = 'auto';
  video.muted = true;
  video.playsInline = true;
  video.src = url;

  type RvfcVideo = HTMLVideoElement & {
    requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number;
  };
  const rvfc = video as RvfcVideo;
  if (typeof rvfc.requestVideoFrameCallback !== 'function') {
    URL.revokeObjectURL(url);
    return null;
  }

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('play timeout')), 8000);
      video.oncanplay = () => {
        window.clearTimeout(timer);
        resolve();
      };
      video.onerror = () => {
        window.clearTimeout(timer);
        reject(new Error('cannot play'));
      };
    });

    const times: number[] = [];
    await new Promise<void>((resolve) => {
      const stop = window.setTimeout(resolve, 900);
      const onFrame = (_now: number, meta: { mediaTime: number }) => {
        times.push(meta.mediaTime);
        if (times.length >= 24) {
          window.clearTimeout(stop);
          resolve();
          return;
        }
        rvfc.requestVideoFrameCallback?.(onFrame);
      };
      rvfc.requestVideoFrameCallback?.(onFrame);
      void video.play().catch(() => {
        window.clearTimeout(stop);
        resolve();
      });
    });
    video.pause();

    if (times.length < 4) return fallback;
    const deltas: number[] = [];
    for (let i = 1; i < times.length; i += 1) {
      const d = times[i]! - times[i - 1]!;
      if (d > 0.001) deltas.push(d);
    }
    if (!deltas.length) return fallback;
    deltas.sort((a, b) => a - b);
    const median = deltas[Math.floor(deltas.length / 2)]!;
    const raw = 1 / median;
    // Snap to the usual frame rates, anything else is measurement noise.
    const common = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 120];
    const snapped = common.find((f) => Math.abs(f - raw) / f < 0.03);
    return snapped ?? Math.round(raw * 100) / 100;
  } catch {
    return null;
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

export async function probeMedia(
  file: File,
  options: ProbeOptions = {},
): Promise<MediaInfo & { fpsApproximate: boolean; frameAccurate: boolean }> {
  const indexMaxBytes = options.indexMaxBytes ?? INDEX_MAX_BYTES;
  const base = await probeVideoElement(file);
  const name = file.name;

  if (isMp4Family(name, file.type) && file.size <= indexMaxBytes) {
    try {
      const index = await readMp4Index(file);
      if (index && index.sampleCount > 0) {
        const durationSec = index.durationSec || base.durationSec;
        const fps = index.sampleCount / Math.max(0.001, durationSec);
        return {
          name,
          sizeBytes: file.size,
          durationSec,
          width: index.width || base.width,
          height: index.height || base.height,
          fps: normalizeFps(fps),
          container: index.container,
          videoCodec: index.codec,
          hasAudio: index.hasAudio || base.hasAudio,
          lastModified: file.lastModified,
          fpsApproximate: false,
          frameAccurate: true,
        };
      }
    } catch {
      // fall through to measurement
    }
  }

  const measured = await measureFps(file, 30);
  const fps = measured ?? 30;
  return {
    name,
    sizeBytes: file.size,
    durationSec: base.durationSec,
    width: base.width,
    height: base.height,
    fps,
    container: (name.split('.').pop() ?? 'video').toLowerCase(),
    videoCodec: 'unknown',
    hasAudio: base.hasAudio,
    lastModified: file.lastModified,
    fpsApproximate: measured === null,
    frameAccurate: false,
  };
}

export function normalizeFps(fps: number): number {
  if (!Number.isFinite(fps) || fps <= 0) return 30;
  const rounded = Math.round(fps * 1000) / 1000;
  // 23.976 / 29.97 / 59.94 style rates
  const presets: [number, number][] = [
    [24000 / 1001, 23.976],
    [30000 / 1001, 29.97],
    [60000 / 1001, 59.94],
    [25, 25],
    [24, 24],
    [30, 30],
    [50, 50],
    [60, 60],
    [48, 48],
    [120, 120],
  ];
  for (const [exact, label] of presets) {
    if (Math.abs(rounded - exact) / exact < 0.02) return label;
  }
  return rounded;
}
