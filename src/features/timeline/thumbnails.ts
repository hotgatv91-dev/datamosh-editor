/**
 * Timeline thumbnails.
 *
 * A single strip per clip, generated lazily from the frame source and cached as
 * small ImageBitmaps. Generation is one frame at a time and never blocks the
 * render loop, so the canvas can stay a single element with zero DOM overhead.
 */

import type { FrameSource } from '../../engine/frames/types';

const THUMB_WIDTH = 64;
const THUMB_HEIGHT = 36;
const MAX_GENERATION_ATTEMPTS = 3;

interface CacheEntry {
  bitmap: ImageBitmap;
  at: number;
}

export class ThumbnailCache {
  private entries = new Map<string, CacheEntry>();
  private generating = new Map<string, Promise<void>>();
  private canvas: HTMLCanvasElement;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = THUMB_WIDTH;
    this.canvas.height = THUMB_HEIGHT;
  }

  key(mediaId: string, frame: number): string {
    return `${mediaId}@${frame}`;
  }

  get(mediaId: string, frame: number): ImageBitmap | null {
    const entry = this.entries.get(this.key(mediaId, frame));
    if (!entry) return null;
    entry.at = performance.now();
    return entry.bitmap;
  }

  /**
   * Requests a thumbnail. `onReady` is called when a new bitmap is available so
   * the caller can schedule a redraw.
   */
  request(
    mediaId: string,
    frame: number,
    source: FrameSource,
    onReady: () => void,
  ): void {
    const key = this.key(mediaId, frame);
    if (this.entries.has(key) || this.generating.has(key)) return;
    if (this.generating.size > MAX_GENERATION_ATTEMPTS) return;
    const task = this.generate(mediaId, frame, source)
      .then(() => onReady())
      .catch(() => undefined)
      .finally(() => this.generating.delete(key));
    this.generating.set(key, task);
  }

  private async generate(mediaId: string, frame: number, source: FrameSource): Promise<void> {
    const image = await source.getFrame(frame);
    if (!image) return;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    try {
      ctx.drawImage(image as CanvasImageSource, 0, 0, THUMB_WIDTH, THUMB_HEIGHT);
    } catch {
      return;
    } finally {
      if (image instanceof VideoFrame) image.close();
    }
    const bitmap = await createImageBitmap(this.canvas);
    const previous = this.entries.get(this.key(mediaId, frame));
    if (previous) previous.bitmap.close();
    this.entries.set(this.key(mediaId, frame), { bitmap, at: performance.now() });
    this.evict();
  }

  private evict(): void {
    const max = 240;
    if (this.entries.size <= max) return;
    const sorted = [...this.entries.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [key, entry] of sorted.slice(0, this.entries.size - max)) {
      entry.bitmap.close();
      this.entries.delete(key);
    }
  }

  clear(): void {
    for (const [, entry] of this.entries) entry.bitmap.close();
    this.entries.clear();
  }
}

export const THUMBNAIL_SIZE = { width: THUMB_WIDTH, height: THUMB_HEIGHT };
