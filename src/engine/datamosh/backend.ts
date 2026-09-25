/**
 * Datamosh backend abstraction.
 *
 * Two backends exist in v1 and both produce *real* datamosh through different
 * mechanisms:
 *
 *   preview-gl    real-time. Estimates a motion field on the GPU and applies
 *                 motion-vector transformations + motion-compensated frame
 *                 persistence. Fast, approximate, used while editing.
 *
 *   ffmpeg-wasm   bitstream level. Re-encodes the region to MPEG-4/AVI, removes
 *                 or duplicates encoded frame chunks (I-frame / P-frame surgery)
 *                 and re-encodes. Produces genuine decoder drift, which is the
 *                 artifact the technique is actually named after.
 *
 * A future `ffmpeg-server` backend implements the same interface, so the UI and
 * the project format do not change when a server renderer is added.
 */

import type { Effect, Frame, ParamBag, RenderMode } from '../project/types';

export type BackendId = 'preview-gl' | 'ffmpeg-wasm' | 'ffmpeg-server';

export interface BackendCapabilities {
  /** Can remove/duplicate encoded frame chunks. */
  bitstreamSurgery: boolean;
  /** Can it run acceptably on a mid-range Android device? */
  mobileSafe: boolean;
  /** Runs while the user drags a slider. */
  realtime: boolean;
  maxResolution: number;
  /** Params the backend implements; the inspector greys out the rest. */
  supports(param: string): boolean;
}

export interface RenderRegion {
  effectId: string;
  startFrame: Frame;
  endFrame: Frame;
  params: ParamBag;
  renderMode: RenderMode;
}

export interface RenderRequest {
  mediaId: string;
  regions: RenderRegion[];
  fps: number;
  width: number;
  height: number;
  frameCount: number;
  onProgress?: (progress: number, stage: string) => void;
  signal?: AbortSignal;
}

export interface RenderResult {
  blob: Blob;
  mimeType: string;
  bytes: number;
  /** How the artifact was produced, surfaced in the export summary. */
  method: 'bitstream-surgery' | 'frame-render';
  warnings: string[];
}

export interface DatamoshBackend {
  id: BackendId;
  label: string;
  capabilities: BackendCapabilities;
  prepare(): Promise<void>;
  isReady(): boolean;
  render(request: RenderRequest): Promise<RenderResult>;
  dispose(): void;
}

export function supportsParams(
  backend: DatamoshBackend,
  params: ParamBag,
  bitstreamOnlyIds: string[],
): string[] {
  const unsupported: string[] = [];
  for (const id of Object.keys(params)) {
    if (!backend.capabilities.supports(id)) unsupported.push(id);
    else if (!backend.capabilities.bitstreamSurgery && bitstreamOnlyIds.includes(id)) {
      unsupported.push(id);
    }
  }
  return unsupported;
}

/** Which export pipeline a set of effects implies. */
export function recommendedPipeline(effects: Effect[]): RenderMode {
  const datas = effects.filter((e) => e.type === 'datamosh' && e.enabled);
  if (!datas.length) return 'preview-quality';
  return datas.some((e) => e.renderMode === 'bitstream') ? 'bitstream' : 'preview-quality';
}

export function describePipeline(mode: RenderMode, hasBitstreamOnlyEffect: boolean): string {
  if (mode === 'bitstream') {
    return 'Bitstream surgery: I-frames are removed from the encoded stream, so motion from the previous shot bleeds into the next one.';
  }
  if (hasBitstreamOnlyEffect) {
    return 'Frame render: every frame is baked through the preview pipeline. Bitstream-only options are ignored.';
  }
  return 'Frame render: every frame is baked through the preview pipeline, so the export matches the preview exactly.';
}
