/**
 * Headless frame renderer for the exact export path.
 *
 * It runs the *same* WebGL pipeline as the preview, one frame at a time, and
 * reads the result back as packed RGB. That is what makes "export matches the
 * preview" true rather than aspirational.
 */

import type { Id, Project } from '../project/types';
import type { FrameSource } from '../frames/types';
import { DatamoshPreviewRenderer, applyClipTransform } from '../datamosh/preview/renderer';
import { FrameMapCache, resolveTimelineFrame } from '../timeline/playback';
import { frameSourceRegistry } from '../frames';
import { mediaInfoFromAsset } from '../frames/types';
import { assetById } from '../timeline/derive';
import { log } from '../log';

export interface FrameRenderContext {
  render(startFrame: number, count: number): Promise<Uint8Array>;
  dispose(): void;
}

export async function createFrameRenderContext(
  project: Project,
  mediaFiles: Record<Id, File>,
  width: number,
  height: number,
): Promise<FrameRenderContext> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const renderer = new DatamoshPreviewRenderer(canvas);
  if (!renderer.available) throw new Error('WebGL2 is required to render frames');
  renderer.setRenderSize(width, height);
  renderer.setMode('effect', 0.5);

  const cache = new FrameMapCache();

  const ensureSource = async (mediaId: string): Promise<FrameSource | null> => {
    const existing = frameSourceRegistry.get(mediaId);
    if (existing) return existing;
    const file = mediaFiles[mediaId];
    const info = assetById(project, mediaId);
    if (!file || !info) return null;
    const result = await frameSourceRegistry.ensure(mediaId, file, mediaInfoFromAsset(info));
    return result.source;
  };

  return {
    render: (startFrame, count) =>
      rasterizeChunk(renderer, project, cache, ensureSource, startFrame, count, width, height),
    dispose: () => {
      renderer.dispose();
      canvas.width = 0;
      canvas.height = 0;
    },
  };
}

async function rasterizeChunk(
  renderer: DatamoshPreviewRenderer,
  project: Project,
  cache: FrameMapCache,
  ensureSource: (mediaId: string) => Promise<FrameSource | null>,
  startFrame: number,
  count: number,
  width: number,
  height: number,
): Promise<Uint8Array> {
  const gl = renderer.gl;
  if (!gl) throw new Error('WebGL context unavailable');
  const pixelCount = width * height;
  const rgba = new Uint8Array(pixelCount * 4);
  const out = new Uint8Array(pixelCount * 3 * count);
  let previousFrame = -1;

  for (let i = 0; i < count; i += 1) {
    const frame = startFrame + i;
    try {
      const resolved = resolveTimelineFrame(project, frame, cache);
      const source = resolved.mediaId ? await ensureSource(resolved.mediaId) : null;
      const image = source ? await source.getFrame(resolved.sourceFrame) : null;
      applyClipTransform(renderer, project, resolved);
      renderer.render({
        image,
        flipY: true,
        resolved,
        project,
        timelineFrame: frame,
        contiguous: previousFrame === frame - 1,
      });
      previousFrame = frame;

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
      const base = i * pixelCount * 3;
      // WebGL reads bottom-up; ffmpeg wants top-down RGB.
      for (let y = 0; y < height; y += 1) {
        const srcRow = (height - 1 - y) * width * 4;
        const dstRow = base + y * width * 3;
        for (let x = 0; x < width; x += 1) {
          const s = srcRow + x * 4;
          const d = dstRow + x * 3;
          out[d] = rgba[s]!;
          out[d + 1] = rgba[s + 1]!;
          out[d + 2] = rgba[s + 2]!;
        }
      }
    } catch (error) {
      log.error('export', `frame ${frame} failed to render`, error);
    }
  }
  return out;
}
