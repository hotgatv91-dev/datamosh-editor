/**
 * Lazy ffmpeg.wasm client.
 *
 * Nothing here loads until the user actually exports, so the initial app stays
 * tiny. @ffmpeg/ffmpeg runs the core in its own Web Worker, which keeps the UI
 * responsive without us managing another worker layer.
 */

import { FFmpeg } from '@ffmpeg/ffmpeg';
// Resolved through the package's `exports` map so no build step has to copy the
// ~25 MB core by hand. Both stay out of the initial bundle: the imports are only
// ever reached when the user exports.
import coreURL from '@ffmpeg/core?url';
import wasmURL from '@ffmpeg/core/wasm?url';
import { log } from '../log';

export interface FfmpegProgress {
  progress: number;
  timeMicros: number;
}

class FfmpegClient {
  private ffmpeg: FFmpeg | null = null;
  private loading: Promise<FFmpeg> | null = null;
  private progressListeners = new Set<(info: FfmpegProgress) => void>();
  private recentLogs: string[] = [];
  private failed: string | null = null;

  isReady(): boolean {
    return this.ffmpeg !== null;
  }

  get lastError(): string | null {
    return this.failed;
  }

  getLogs(): string[] {
    return this.recentLogs;
  }

  /** Resolves once the wasm core is loaded; safe to call repeatedly. */
  async load(onStage?: (message: string) => void): Promise<FFmpeg> {
    if (this.ffmpeg) return this.ffmpeg;
    if (this.loading) return this.loading;

    this.loading = (async () => {
      onStage?.('Loading encoder core (~25 MB, cached after the first export)');
      const instance = new FFmpeg();
      instance.on('progress', ({ progress, time }) => {
        const info: FfmpegProgress = { progress, timeMicros: time };
        this.progressListeners.forEach((fn) => fn(info));
      });
      instance.on('log', ({ message }) => {
        this.recentLogs.push(message);
        if (this.recentLogs.length > 200) this.recentLogs = this.recentLogs.slice(-200);
      });
      try {
        await instance.load({ coreURL, wasmURL });
      } catch (error) {
        this.failed = error instanceof Error ? error.message : String(error);
        this.loading = null;
        log.error('export', 'ffmpeg core failed to load', error);
        throw error;
      }
      this.ffmpeg = instance;
      log.info('export', 'ffmpeg core ready');
      return instance;
    })();

    return this.loading;
  }

  onProgress(fn: (info: FfmpegProgress) => void): () => void {
    this.progressListeners.add(fn);
    return () => this.progressListeners.delete(fn);
  }

  async exec(args: string[], timeoutMs = 15 * 60 * 1000): Promise<number> {
    const instance = await this.load();
    log.info('export', `ffmpeg ${args.join(' ')}`);
    const run = instance.exec(args);
    if (timeoutMs <= 0) return run;
    const timeout = new Promise<number>((_, reject) =>
      window.setTimeout(() => reject(new Error('ffmpeg timed out')), timeoutMs),
    );
    return Promise.race([run, timeout]);
  }

  async writeFile(name: string, data: Uint8Array): Promise<void> {
    const instance = await this.load();
    await instance.writeFile(name, data);
  }

  async readFile(name: string): Promise<Uint8Array> {
    const instance = await this.load();
    const data = await instance.readFile(name);
    return typeof data === 'string' ? new TextEncoder().encode(data) : data;
  }

  async deleteFile(name: string): Promise<void> {
    const instance = this.ffmpeg;
    if (!instance) return;
    try {
      await instance.deleteFile(name);
    } catch {
      /* already gone */
    }
  }

  async cleanup(names: string[]): Promise<void> {
    for (const name of names) await this.deleteFile(name);
  }

  terminate(): void {
    this.ffmpeg?.terminate();
    this.ffmpeg = null;
    this.loading = null;
  }
}

export const ffmpegClient = new FfmpegClient();

export function isCrossOriginIsolated(): boolean {
  return typeof globalThis.crossOriginIsolated === 'boolean' ? globalThis.crossOriginIsolated : false;
}

// Re-exported so existing callers keep working; the implementations live in
// engine/device.ts, which does not drag the encoder into the initial bundle.
export { deviceMemoryGb, isLikelyLowEndDevice } from '../device';
