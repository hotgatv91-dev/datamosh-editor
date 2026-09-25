/**
 * Fallback frame source for containers we cannot index (WebM, MKV, ...) or when
 * WebCodecs cannot decode the codec on this device.
 *
 * It seeks a hidden <video> element and snapshots the presented frame. Seeking
 * costs 10–40 ms, so this path is noticeably less smooth and only
 * approximately frame accurate — hence `frameAccurate = false`, which the UI
 * surfaces instead of pretending otherwise.
 */

import type { FrameImage, FrameSource, MediaInfo } from './types';
import { createObjectUrl } from './probe';

type RvfcVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number;
};

export class VideoElementFrameSource implements FrameSource {
  readonly kind = 'video-element' as const;
  readonly frameAccurate = false;
  readonly info: MediaInfo;

  private video: RvfcVideo;
  private url: string;
  private ready = false;
  private lock: Promise<void> = Promise.resolve();
  private bitmap: ImageBitmap | null = null;
  private disposed = false;

  private constructor(video: RvfcVideo, url: string, info: MediaInfo) {
    this.video = video;
    this.url = url;
    this.info = info;
  }

  static async open(file: File, info: MediaInfo): Promise<VideoElementFrameSource> {
    const url = createObjectUrl(file);
    const video = document.createElement('video') as RvfcVideo;
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = 'anonymous';
    video.src = url;
    video.style.position = 'fixed';
    video.style.left = '-10000px';
    video.style.top = '0';
    video.style.width = '2px';
    video.style.opacity = '0';
    video.style.pointerEvents = 'none';
    document.body.appendChild(video);

    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('video element timeout')), 20_000);
      video.oncanplay = () => {
        window.clearTimeout(timer);
        resolve();
      };
      video.onerror = () => {
        window.clearTimeout(timer);
        reject(new Error('video element cannot load the file'));
      };
    });

    const source = new VideoElementFrameSource(video, url, info);
    source.ready = true;
    return source;
  }

  async getFrame(frameIndex: number): Promise<FrameImage | null> {
    if (this.disposed || !this.ready) return null;
    const frame = Math.max(0, Math.round(frameIndex));
    const task = this.lock.then(
      () => this.seekAndGrab(frame),
      () => this.seekAndGrab(frame),
    );
    this.lock = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private async seekAndGrab(frame: number): Promise<ImageBitmap | null> {
    if (this.disposed) return null;
    const targetTime = Math.min(
      Math.max(0, frame / Math.max(1, this.info.fps)),
      Math.max(0, this.info.durationSec - 1 / Math.max(1, this.info.fps)),
    );

    if (Math.abs(this.video.currentTime - targetTime) > 1e-4) {
      await new Promise<void>((resolve) => {
        const timer = window.setTimeout(resolve, 3000);
        const onSeeked = () => {
          window.clearTimeout(timer);
          this.video.removeEventListener('seeked', onSeeked);
          resolve();
        };
        this.video.addEventListener('seeked', onSeeked);
        try {
          this.video.currentTime = targetTime;
        } catch {
          window.clearTimeout(timer);
          resolve();
        }
      });
    }

    // If a newer request superseded this one while we were seeking, skip the
    // expensive snapshot: the queue will serve the newer frame next.
    if (this.disposed) return null;

    try {
      const bitmap = await createImageBitmap(this.video);
      this.replaceBitmap(bitmap);
      return bitmap;
    } catch {
      return null;
    }
  }

  private replaceBitmap(next: ImageBitmap): void {
    const previous = this.bitmap;
    this.bitmap = next;
    if (previous) previous.close();
  }

  prefetch(): void {
    /* seeking cannot be pipelined usefully on this path */
  }

  dispose(): void {
    this.disposed = true;
    this.bitmap?.close();
    this.bitmap = null;
    this.video.removeAttribute('src');
    this.video.load();
    this.video.remove();
    URL.revokeObjectURL(this.url);
  }
}
