/**
 * Frame sources. A FrameSource hands out decoded frames by *index*, which is the
 * only interface the preview renderer and the exporter need.
 *
 *  - WebCodecsFrameSource: exact, random access, preferred (MP4/MOV).
 *  - VideoElementFrameSource: fallback for anything else; seeks a <video> and
 *    hands back an ImageBitmap. Less precise but always available.
 */

import type { MediaAsset } from '../project/types';

export type FrameImage = VideoFrame | ImageBitmap | HTMLVideoElement;

export interface MediaInfo {
  name: string;
  sizeBytes: number;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  container: string;
  videoCodec: string;
  hasAudio: boolean;
  lastModified: number;
}

export interface FrameSource {
  readonly info: MediaInfo;
  /** True when `getFrame` is frame accurate (WebCodecs). */
  readonly frameAccurate: boolean;
  readonly kind: 'webcodecs' | 'video-element';
  getFrame(frameIndex: number): Promise<FrameImage | null>;
  /** Best-effort hint for the scheduler; never required for correctness. */
  prefetch?(fromFrame: number, count: number): void;
  dispose(): void;
}

export interface FrameSourceFactoryOptions {
  indexMaxBytes?: number;
  onWarning?: (message: string) => void;
}

/**
 * The project keeps frame counts (the timeline unit) while frame sources speak
 * seconds, so the conversion lives in one place.
 */
export function mediaInfoFromAsset(asset: MediaAsset): MediaInfo {
  const fps = asset.fps > 0 ? asset.fps : 30;
  return {
    name: asset.name,
    sizeBytes: asset.sizeBytes,
    durationSec: asset.durationFrames / fps,
    width: asset.width,
    height: asset.height,
    fps,
    container: asset.container,
    videoCodec: asset.videoCodec,
    hasAudio: asset.hasAudio,
    lastModified: asset.lastModified,
  };
}
