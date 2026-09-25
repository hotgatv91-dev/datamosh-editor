/**
 * Frame source factory + registry.
 *
 * The registry keeps one source per imported media asset, so switching between
 * clips does not re-open decoders.
 */

import type { FrameSource, MediaInfo } from './types';
import { INDEX_MAX_BYTES } from './probe';
import { WebCodecsFrameSource } from './webcodecsSource';
import { VideoElementFrameSource } from './videoElementSource';
import { log } from '../log';

/** Media bigger than this is streamed through a <video> element instead. */
export const FRAME_INDEX_MAX_BYTES = INDEX_MAX_BYTES;

export interface CreateFrameSourceResult {
  source: FrameSource;
  warnings: string[];
}

export async function createFrameSource(
  file: File,
  info: MediaInfo,
  onFatal?: (error: Error) => void,
): Promise<CreateFrameSourceResult> {
  const warnings: string[] = [];

  if (file.size <= FRAME_INDEX_MAX_BYTES) {
    try {
      const webcodecs = await WebCodecsFrameSource.open(file, { onFatal });
      if (webcodecs) {
        log.info('frames', `WebCodecs frame source ready for ${file.name} (${info.videoCodec})`);
        return { source: webcodecs, warnings };
      }
      warnings.push(
        'Frame-accurate decoding is unavailable for this file, so seeking is used instead.',
      );
      log.warn('frames', `Falling back to video element for ${file.name}`);
    } catch (error) {
      warnings.push(
        'Frame-accurate decoding is unavailable for this file, so seeking is used instead.',
      );
      log.warn('frames', 'WebCodecs source failed, falling back', error);
    }
  } else {
    warnings.push(
      'This file is large, so it is streamed instead of indexed. Export is still available.',
    );
    log.info('frames', `File above index limit, streaming ${file.name}`);
  }

  const element = await VideoElementFrameSource.open(file, info);
  return { source: element, warnings };
}

class FrameSourceRegistry {
  private sources = new Map<string, FrameSource>();
  /**
   * In-flight opens. The preview and the media panel both ask for a source the
   * moment a clip appears; without this the loser of the race would dispose the
   * winner's decoder while it is mid-stream.
   */
  private pending = new Map<string, Promise<CreateFrameSourceResult>>();

  get(mediaId: string): FrameSource | null {
    return this.sources.get(mediaId) ?? null;
  }

  set(mediaId: string, source: FrameSource): void {
    this.sources.get(mediaId)?.dispose();
    this.sources.set(mediaId, source);
  }

  async ensure(
    mediaId: string,
    file: File,
    info: MediaInfo,
    onFatal?: (error: Error) => void,
  ): Promise<CreateFrameSourceResult> {
    const existing = this.sources.get(mediaId);
    if (existing) return { source: existing, warnings: [] };
    const inFlight = this.pending.get(mediaId);
    if (inFlight) return inFlight;

    const task = createFrameSource(file, info, onFatal)
      .then((result) => {
        this.sources.get(mediaId)?.dispose();
        this.sources.set(mediaId, result.source);
        return result;
      })
      .finally(() => {
        this.pending.delete(mediaId);
      });
    this.pending.set(mediaId, task);
    return task;
  }

  dispose(mediaId: string): void {
    this.sources.get(mediaId)?.dispose();
    this.sources.delete(mediaId);
  }

  disposeAll(): void {
    for (const [, source] of this.sources) source.dispose();
    this.sources.clear();
    this.pending.clear();
  }
}

export const frameSourceRegistry = new FrameSourceRegistry();
