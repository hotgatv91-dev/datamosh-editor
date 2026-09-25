/**
 * Real-time preview renderer.
 *
 * Per rendered frame:
 *   1. upload the source frame (once),
 *   2. estimate the motion field between this frame and the previous one,
 *   3. for every datamosh lane: adjust the motion vectors with the effect's
 *      parameters, then warp + accumulate the previous output along them,
 *   4. apply the basic (non-datamosh) effect passes,
 *   5. draw to the canvas with transform, adjust and split view.
 *
 * Motion estimation happens at a fixed luma resolution rather than at export
 * resolution, which is what keeps this usable on integrated GPUs and mid-range
 * Android devices.
 */

import type { ParamBag, Project } from '../../project/types';
import type { ResolvedEffect, ResolvedFrame } from '../../timeline/playback';
import { numParam, strParam } from '../params';
import type { ProgramInfo, RenderTarget } from '../../gl/glUtils';
import {
  FULLSCREEN_VERTEX_SHADER,
  bindTexture,
  createProgram,
  createRenderTarget,
  createSourceTexture,
  drawFullscreen,
  resizeRenderTarget,
} from '../../gl/glUtils';
import { MotionEstimator, type MotionQuality } from '../../motion/motionField';
import { COMPOSITE_FS, DISPLAY_FS, MV_ADJUST_FS, WARP_FS } from './shaders';
import { BASIC_FX_FS, BASIC_FX_INDEX, basicFxParams } from '../../effects/shaders';
import { log } from '../../log';

export interface RendererStats {
  renderMs: number;
  motion: boolean;
  lanes: number;
  framesDrawn: number;
}

export interface RenderInput {
  image: TexImageSource | null;
  flipY: boolean;
  resolved: ResolvedFrame | null;
  project: Project;
  timelineFrame: number;
  /** False after a seek/cut so history is not stretched across the jump. */
  contiguous: boolean;
}

interface LaneState {
  accumA: RenderTarget;
  accumB: RenderTarget;
  mvAdj: RenderTarget;
  toggle: boolean;
  width: number;
  height: number;
}

export type SplitMode = 'original' | 'effect' | 'split';

export class DatamoshPreviewRenderer {
  readonly gl: WebGL2RenderingContext | null;
  private canvas: HTMLCanvasElement;
  private ok = false;
  private lost = false;

  private motion: MotionEstimator | null = null;
  private motionQuality: MotionQuality = 'full';
  private programs: {
    mvAdjust: ProgramInfo;
    warp: ProgramInfo;
    composite: ProgramInfo;
    display: ProgramInfo;
    basicFx: ProgramInfo;
  } | null = null;

  private srcA: WebGLTexture | null = null;
  private srcB: WebGLTexture | null = null;
  private srcToggle = false;
  private renderA: RenderTarget | null = null;
  private renderB: RenderTarget | null = null;

  private lanes = new Map<string, LaneState>();
  private renderWidth = 0;
  private renderHeight = 0;
  private mode: SplitMode = 'effect';
  private splitPosition = 0.5;
  private elapsed = 0;
  private stats: RendererStats = { renderMs: 0, motion: false, lanes: 0, framesDrawn: 0 };
  private disposed = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    let gl: WebGL2RenderingContext | null = null;
    try {
      gl = canvas.getContext('webgl2', {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: false,
        powerPreference: 'high-performance',
      });
    } catch (error) {
      log.error('preview', 'WebGL2 context creation failed', error);
    }

    this.gl = gl;
    if (!gl) return;

    canvas.addEventListener('webglcontextlost', this.onContextLost);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored);

    try {
      this.programs = {
        mvAdjust: createProgram(gl, FULLSCREEN_VERTEX_SHADER, MV_ADJUST_FS, [
          'uMv',
          'uMvPrev',
          'uBlockUv',
          'uRadius',
          'uIntensity',
          'uStretch',
          'uPersistence',
          'uBlend',
          'uThreshold',
          'uAcceleration',
          'uSwapWeight',
          'uSwapFade',
          'uCorruption',
          'uDirection',
          'uUseDirection',
          'uTime',
        ]),
        warp: createProgram(gl, FULLSCREEN_VERTEX_SHADER, WARP_FS, [
          'uCur',
          'uPrev',
          'uAccum',
          'uMv',
          'uTexel',
          'uRadius',
          'uWarpScale',
          'uSmear',
          'uWeight',
          'uDecayFactor',
        ]),
        composite: createProgram(gl, FULLSCREEN_VERTEX_SHADER, COMPOSITE_FS, [
          'uBase',
          'uTop',
          'uAmount',
        ]),
        display: createProgram(gl, FULLSCREEN_VERTEX_SHADER, DISPLAY_FS, [
          'uTex',
          'uResolution',
          'uScale',
          'uRotation',
          'uOffset',
          'uFlip',
          'uAdjust',
          'uBlur',
        ]),
        basicFx: createProgram(gl, FULLSCREEN_VERTEX_SHADER, BASIC_FX_FS, [
          'uTex',
          'uEffect',
          'uParams',
          'uTime',
          'uResolution',
        ]),
      };
      this.motion = new MotionEstimator(gl);
      this.srcA = createSourceTexture(gl);
      this.srcB = createSourceTexture(gl);
      this.renderA = createRenderTarget(gl, 8, 8, { linear: true });
      this.renderB = createRenderTarget(gl, 8, 8, { linear: true });
      this.ok = true;
    } catch (error) {
      log.error('preview', 'WebGL init failed', error);
      this.ok = false;
    }
  }

  get available(): boolean {
    return this.ok && !this.lost;
  }

  getStats(): RendererStats {
    return this.stats;
  }

  setMode(mode: SplitMode, splitPosition: number): void {
    this.mode = mode;
    this.splitPosition = splitPosition;
  }

  /** Render scale: the preview may run below source resolution on weak devices. */
  setRenderSize(width: number, height: number): void {
    const w = Math.max(64, Math.round(width));
    const h = Math.max(36, Math.round(height));
    if (w === this.renderWidth && h === this.renderHeight) return;
    this.renderWidth = w;
    this.renderHeight = h;
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    if (!this.gl) return;
    if (this.renderA) resizeRenderTarget(this.gl, this.renderA, w, h);
    if (this.renderB) resizeRenderTarget(this.gl, this.renderB, w, h);
    for (const lane of this.lanes.values()) {
      resizeRenderTarget(this.gl, lane.accumA, w, h);
      resizeRenderTarget(this.gl, lane.accumB, w, h);
      resizeRenderTarget(this.gl, lane.mvAdj, w, h);
      lane.width = w;
      lane.height = h;
    }
    this.motion?.invalidateHistory();
  }

  /**
   * Preview motion-field quality (see MotionEstimator). This is the user's
   * lever when the preview is too heavy for the machine, so it takes effect
   * immediately and invalidates the motion history it depends on.
   */
  setMotionQuality(quality: MotionQuality): void {
    if (quality === this.motionQuality) return;
    this.motionQuality = quality;
    // The field geometry changes, so the next frame must not smear into a field
    // that was computed at a different resolution.
    this.motion?.invalidateHistory();
  }

  invalidateHistory(): void {
    this.motion?.invalidateHistory();
    for (const lane of this.lanes.values()) lane.toggle = false;
  }

  render(input: RenderInput): RendererStats {
    const started = performance.now();
    const gl = this.gl;
    if (!gl || !this.ok || this.lost || !this.programs || !this.srcA || !this.srcB) return this.stats;
    if (!input.image) {
      return this.stats;
    }

    this.elapsed += 1 / 60;

    const srcCur = this.srcToggle ? this.srcA : this.srcB;
    const srcPrev = this.srcToggle ? this.srcB : this.srcA;
    uploadFrame(gl, srcCur, input.image, input.flipY);
    const datamoshLanes = (input.resolved?.datamosh ?? []).filter((lane) => lane.effect.enabled);
    const anyDatamosh = datamoshLanes.length > 0;

    const blockSize = anyDatamosh
      ? Number(strParam(datamoshLanes[datamoshLanes.length - 1]!.params, 'blockSize', '8'))
      : 8;
    const radius = anyDatamosh
      ? numParam(datamoshLanes[datamoshLanes.length - 1]!.params, 'mvPrecision', 3)
      : 3;
    this.motion?.configure(
      this.renderWidth || gl.drawingBufferWidth,
      this.renderHeight || gl.drawingBufferHeight,
      Number.isFinite(blockSize) ? blockSize : 8,
      radius,
      this.motionQuality,
    );

    if (!input.contiguous) this.invalidateHistory();

    const motionInfo = anyDatamosh ? this.motion?.estimate(srcCur) ?? null : null;

    let output: WebGLTexture = srcCur;
    let laneCount = 0;

    if (anyDatamosh && motionInfo) {
      for (const lane of datamoshLanes) {
        const state = this.ensureLane(lane.effect.id);
        const read = state.toggle ? state.accumB : state.accumA;
        const write = state.toggle ? state.accumA : state.accumB;

        const initialised = input.contiguous && this.laneWasActive(lane.effect.id);
        if (!initialised) {
          // Seed the accumulator with the current frame so persistence has a
          // sane reference instead of a stale one from another region.
          gl.useProgram(this.programs.composite.program);
          bindTexture(gl, 0, output, this.programs.composite.uniforms.uBase);
          bindTexture(gl, 1, output, this.programs.composite.uniforms.uTop);
          gl.uniform1f(this.programs.composite.uniforms.uAmount, 0);
          drawFullscreen(gl, read);
        }

        this.applyMvAdjust(lane, motionInfo.texture, motionInfo.previousTexture, state.mvAdj, input);
        this.applyWarp(output, srcPrev, read, state.mvAdj.texture, write, lane, {
          radius: motionInfo.radius,
          gridWidth: motionInfo.gridWidth,
          gridHeight: motionInfo.gridHeight,
          lumaWidth: motionInfo.lumaWidth,
          lumaHeight: motionInfo.lumaHeight,
        });

        output = write.texture;
        state.toggle = !state.toggle;
        this.markLaneActive(lane.effect.id);
        laneCount += 1;
      }
    } else {
      this.clearLaneActivity();
    }

    // Basic (non-datamosh) effects, applied in lane order after datamosh.
    const basicEffects = (input.resolved?.effects ?? []).filter((e) => e.type !== 'datamosh');
    if (basicEffects.length && this.renderA && this.renderB) {
      let source: WebGLTexture = output;
      let flip = false;
      for (const effect of basicEffects) {
        const target = flip ? this.renderA : this.renderB;
        this.applyBasicFx(source, target, effect, input);
        source = target.texture;
        flip = !flip;
      }
      output = source;
    }

    this.drawDisplay(srcCur, output);

    this.srcToggle = !this.srcToggle;
    this.stats = {
      renderMs: performance.now() - started,
      motion: !!motionInfo,
      lanes: laneCount,
      framesDrawn: this.stats.framesDrawn + 1,
    };
    return this.stats;
  }

  /* ------------------------------------------------------------- passes */

  private applyMvAdjust(
    lane: ResolvedEffect,
    mvCurrent: WebGLTexture,
    mvPrevious: WebGLTexture,
    target: RenderTarget,
    input: RenderInput,
  ): void {
    const gl = this.gl!;
    const program = this.programs!.mvAdjust;
    const params = lane.params;
    const envelope = lane.envelope;
    const progress = lane.progress;

    const intensity = 1 + (numParam(params, 'intensity', 60) / 100) * 1.6 * (0.35 + envelope * 0.65);
    const stretch = (numParam(params, 'stretch', 40) / 100) * 1.2 * envelope;
    const persistence = (numParam(params, 'persistence', 45) / 100) * envelope;
    const blend = numParam(params, 'blend', 0) / 100;
    const acceleration = 1 + (numParam(params, 'acceleration', 15) / 100) * progress;
    const accelThreshold = boolOf(params, 'accelThreshold');
    const rawThreshold = numParam(params, 'threshold', 0);
    const threshold = (rawThreshold / 100) * 6 * (accelThreshold ? acceleration : 1);
    const swapWeight = numParam(params, 'swapWeight', 0) / 100;
    const fadeIn = numParam(params, 'swapFadeIn', 6);
    const fadeOut = numParam(params, 'swapFadeOut', 6);
    const length = Math.max(1, lane.effect.endFrame - lane.effect.startFrame);
    const offset = lane.frameOffset;
    const swapFade =
      (fadeIn > 0 ? Math.min(1, offset / fadeIn) : 1) *
      (fadeOut > 0 ? Math.min(1, (length - offset) / fadeOut) : 1);
    const corruption = numParam(params, 'corruption', 0) / 100;
    const direction = numParam(params, 'direction', 0);
    const useDirection = direction > 0 ? 1 : 0;

    gl.useProgram(program.program);
    bindTexture(gl, 0, mvCurrent, program.uniforms.uMv);
    bindTexture(gl, 1, mvPrevious, program.uniforms.uMvPrev);
    const blockUv = this.motionTextureUv();
    gl.uniform2f(program.uniforms.uBlockUv, blockUv[0], blockUv[1]);
    gl.uniform1f(program.uniforms.uRadius, this.motion?.info()?.radius ?? 3);
    gl.uniform1f(program.uniforms.uIntensity, intensity);
    gl.uniform1f(program.uniforms.uStretch, stretch);
    gl.uniform1f(program.uniforms.uPersistence, persistence);
    gl.uniform1f(program.uniforms.uBlend, blend);
    gl.uniform1f(program.uniforms.uThreshold, threshold);
    gl.uniform1f(program.uniforms.uAcceleration, acceleration);
    gl.uniform1f(program.uniforms.uSwapWeight, swapWeight);
    gl.uniform1f(program.uniforms.uSwapFade, swapFade);
    gl.uniform1f(program.uniforms.uCorruption, corruption);
    gl.uniform1f(program.uniforms.uDirection, (direction * Math.PI) / 180);
    gl.uniform1f(program.uniforms.uUseDirection, useDirection);
    gl.uniform1f(program.uniforms.uTime, input.timelineFrame / Math.max(1, input.project.fps));
    drawFullscreen(gl, target);
  }

  private applyWarp(
    current: WebGLTexture,
    previousFrame: WebGLTexture,
    accumRead: RenderTarget,
    mv: WebGLTexture,
    target: RenderTarget,
    lane: ResolvedEffect,
    motionInfo: { radius: number; gridWidth: number; gridHeight: number; lumaWidth: number; lumaHeight: number },
  ): void {
    const gl = this.gl!;
    const program = this.programs!.warp;
    const params = lane.params;
    const envelope = lane.envelope;

    const persistence   = (numParam(params, 'persistence', 45) / 100) * envelope;
    const decay         = numParam(params, 'decay', 12) / 100;
    const smearLength   = numParam(params, 'smearLength', 40) / 100;
    const frameInfluence = numParam(params, 'frameInfluence', 45) / 100;
    const stretch       = numParam(params, 'stretch', 40) / 100;
    const freeze        = numParam(params, 'freezeDuration', 0);
    const regionOffset  = lane.frameOffset;

    // --- weight: how much of the ghost replaces the clean frame ---------------
    // persistence controls the strength; decay reduces it multiplicatively.
    const weight = Math.min(0.97, Math.max(0, persistence * (1 - decay * 0.5)));

    // --- warpScale: how far we shift along the motion vector ------------------
    // 1.0  = natural: the ghost follows exactly where motion says things went.
    // > 1  = stretch: the ghost is pulled further (smear/exaggerate effect).
    // smearLength amplifies the warp; stretch adds extra directional pull.
    // Both are already in [0,1] (from 0-100% UI), so their contribution is linear.
    const warpScale = 1.0 + smearLength * 3.0 + stretch * 1.5;

    // --- decayFactor: per-frame exponential falloff of the accum buffer --------
    // This is the factor applied ONCE per frame to the accumulated ghost.
    // (1 - decay) keeps most of the history; small decay = long tail.
    // Do NOT raise this to the power of regionOffset — that would make the
    // effect disappear within a few frames.
    const decayFactor = Math.max(0, 1.0 - decay);

    const freezeBoost = freeze > 0 && regionOffset < freeze ? 1 : 0;

    // uTexel: convert a 1-pixel MV displacement in *luma* space → UV fraction.
    // The MV is stored in luma-texel units, so we divide by luma resolution.
    const lumaW = Math.max(1, motionInfo.lumaWidth);
    const lumaH = Math.max(1, motionInfo.lumaHeight);
    const texelX = 1.0 / lumaW;
    const texelY = 1.0 / lumaH;

    gl.useProgram(program.program);
    bindTexture(gl, 0, current,             program.uniforms.uCur);
    bindTexture(gl, 1, previousFrame,       program.uniforms.uPrev);
    bindTexture(gl, 2, accumRead.texture,   program.uniforms.uAccum);
    bindTexture(gl, 3, mv,                  program.uniforms.uMv);
    gl.uniform2f(program.uniforms.uTexel, texelX, texelY);
    gl.uniform1f(program.uniforms.uRadius,      motionInfo.radius);
    gl.uniform1f(program.uniforms.uWarpScale,   freezeBoost ? 0.0 : warpScale);
    gl.uniform1f(program.uniforms.uSmear,       Math.max(frameInfluence, freezeBoost ? 1.0 : 0.0));
    gl.uniform1f(program.uniforms.uWeight,      freezeBoost ? Math.max(weight, 0.95) : weight);
    gl.uniform1f(program.uniforms.uDecayFactor, freezeBoost ? 1.0 : decayFactor);
    drawFullscreen(gl, target);
  }

  private applyBasicFx(
    source: WebGLTexture,
    target: RenderTarget,
    effect: { type: string; startFrame: number; parameters: Record<string, unknown> },
    input: RenderInput,
  ): void {
    const gl = this.gl!;
    const program = this.programs!.basicFx;
    const index = BASIC_FX_INDEX[effect.type] ?? 0;
    const [p0, p1, p2, p3] = basicFxParams(effect.type, effect.parameters);
    gl.useProgram(program.program);
    bindTexture(gl, 0, source, program.uniforms.uTex);
    gl.uniform1i(program.uniforms.uEffect, index);
    gl.uniform4f(program.uniforms.uParams, p0, p1, p2, p3);
    gl.uniform1f(program.uniforms.uTime, input.timelineFrame / Math.max(1, input.project.fps));
    gl.uniform2f(program.uniforms.uResolution, target.width, target.height);
    drawFullscreen(gl, target);
  }

  private drawDisplay(originalTexture: WebGLTexture, effectTexture: WebGLTexture): void {
    const gl = this.gl!;
    const program = this.programs!.display;
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.BLEND);
    gl.enable(gl.SCISSOR_TEST);

    const drawOne = (texture: WebGLTexture, x: number, w: number) => {
      gl.scissor(x, 0, w, height);
      gl.useProgram(program.program);
      bindTexture(gl, 0, texture, program.uniforms.uTex);
      gl.uniform2f(program.uniforms.uResolution, width, height);
      const scale = this.displayScale;
      gl.uniform2f(program.uniforms.uScale, scale.x, scale.y);
      gl.uniform1f(program.uniforms.uRotation, this.displayRotation);
      gl.uniform2f(program.uniforms.uOffset, this.displayOffset.x, this.displayOffset.y);
      gl.uniform2f(program.uniforms.uFlip, this.displayFlip.x, this.displayFlip.y);
      gl.uniform4f(
        program.uniforms.uAdjust,
        this.displayAdjust[0],
        this.displayAdjust[1],
        this.displayAdjust[2],
        this.displayAdjust[3],
      );
      gl.uniform1f(program.uniforms.uBlur, this.displayBlur);
      drawFullscreen(gl, null);
    };

    if (this.mode === 'original') {
      drawOne(originalTexture, 0, width);
    } else if (this.mode === 'effect') {
      drawOne(effectTexture, 0, width);
    } else {
      const splitX = Math.round(width * Math.min(0.95, Math.max(0.05, this.splitPosition)));
      drawOne(originalTexture, 0, splitX);
      drawOne(effectTexture, splitX, width - splitX);
    }
    gl.disable(gl.SCISSOR_TEST);
  }

  /* ------------------------------------------------------------- state */

  /** Transform/adjust for the primary clip, pushed in by the preview surface. */
  displayScale = { x: 1, y: 1 };
  displayRotation = 0;
  displayOffset = { x: 0, y: 0 };
  displayFlip = { x: 1, y: 1 };
  displayAdjust: [number, number, number, number] = [0, 0, 0, 0];
  displayBlur = 0;

  private ensureLane(effectId: string): LaneState {
    const gl = this.gl!;
    let lane = this.lanes.get(effectId);
    if (!lane) {
      const width = this.renderWidth || gl.drawingBufferWidth;
      const height = this.renderHeight || gl.drawingBufferHeight;
      lane = {
        accumA: createRenderTarget(gl, width, height, { linear: true }),
        accumB: createRenderTarget(gl, width, height, { linear: true }),
        mvAdj: createRenderTarget(gl, width, height, { linear: false }),
        toggle: false,
        width,
        height,
      };
      this.lanes.set(effectId, lane);
    } else if (lane.width !== this.renderWidth || lane.height !== this.renderHeight) {
      resizeRenderTarget(gl, lane.accumA, this.renderWidth, this.renderHeight);
      resizeRenderTarget(gl, lane.accumB, this.renderWidth, this.renderHeight);
      resizeRenderTarget(gl, lane.mvAdj, this.renderWidth, this.renderHeight);
      lane.width = this.renderWidth;
      lane.height = this.renderHeight;
    }
    return lane;
  }

  private activeLanes = new Set<string>();

  private laneWasActive(effectId: string): boolean {
    return this.activeLanes.has(effectId);
  }

  private markLaneActive(effectId: string): void {
    this.activeLanes.add(effectId);
  }

  private clearLaneActivity(): void {
    if (this.activeLanes.size) this.activeLanes.clear();
  }

  private motionTextureUv(): [number, number] {
    const info = this.motion?.info();
    if (!info) return [1 / 64, 1 / 36];
    return [1 / Math.max(1, info.gridWidth), 1 / Math.max(1, info.gridHeight)];
  }

  private onContextLost = (event: Event): void => {
    event.preventDefault();
    this.lost = true;
    log.error('preview', 'WebGL context lost');
  };

  private onContextRestored = (): void => {
    this.lost = false;
    log.info('preview', 'WebGL context restored');
  };

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    if (!gl) return;
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    for (const lane of this.lanes.values()) {
      for (const target of [lane.accumA, lane.accumB, lane.mvAdj]) {
        gl.deleteTexture(target.texture);
        gl.deleteFramebuffer(target.framebuffer);
      }
    }
    this.lanes.clear();
    if (this.renderA) {
      gl.deleteTexture(this.renderA.texture);
      gl.deleteFramebuffer(this.renderA.framebuffer);
    }
    if (this.renderB) {
      gl.deleteTexture(this.renderB.texture);
      gl.deleteFramebuffer(this.renderB.framebuffer);
    }
    if (this.srcA) gl.deleteTexture(this.srcA);
    if (this.srcB) gl.deleteTexture(this.srcB);
    this.motion?.dispose();
  }
}

function uploadFrame(
  gl: WebGL2RenderingContext,
  texture: WebGLTexture,
  image: TexImageSource,
  flipY: boolean,
): void {
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, flipY);
  try {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
  } catch (error) {
    log.warn('preview', 'frame upload failed', error);
  }
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.bindTexture(gl.TEXTURE_2D, null);
  if (image instanceof VideoFrame) image.close();
}

function boolOf(params: ParamBag, key: string): boolean {
  const value = params[key];
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return false;
}

/** Applies clip transform/adjust to the renderer's display stage. */
export function applyClipTransform(
  renderer: DatamoshPreviewRenderer,
  project: Project,
  resolved: ResolvedFrame | null,
): void {
  const clip = resolved?.clipId ? project.clips.find((c) => c.id === resolved.clipId) : null;
  if (!clip) {
    renderer.displayScale = { x: 1, y: 1 };
    renderer.displayRotation = 0;
    renderer.displayOffset = { x: 0, y: 0 };
    renderer.displayFlip = { x: 1, y: 1 };
    renderer.displayAdjust = [0, 0, 0, 0];
    renderer.displayBlur = 0;
    return;
  }
  renderer.displayScale = {
    x: clip.transform.scale / (1 - (clip.transform.crop.left + clip.transform.crop.right) / 200),
    y: clip.transform.scale / (1 - (clip.transform.crop.top + clip.transform.crop.bottom) / 200),
  };
  renderer.displayRotation = (clip.transform.rotation * Math.PI) / 180;
  renderer.displayOffset = { x: clip.transform.x / 100, y: clip.transform.y / 100 };
  renderer.displayFlip = {
    x: clip.transform.flipH ? -1 : 1,
    y: clip.transform.flipV ? -1 : 1,
  };
  renderer.displayAdjust = [
    clip.adjust.brightness / 100,
    clip.adjust.contrast / 100,
    clip.adjust.saturation / 100,
    clip.adjust.exposure / 100,
  ];
  renderer.displayBlur = clip.adjust.blur + nearestBasicBlur(project, clip.startFrame);
}

function nearestBasicBlur(project: Project, frame: number): number {
  const blur = project.effects.find(
    (e) => e.enabled && e.type === 'blur' && frame >= e.startFrame && frame < e.endFrame,
  );
  if (!blur) return 0;
  const value = blur.parameters.amount;
  return typeof value === 'number' ? value : 0;
}
