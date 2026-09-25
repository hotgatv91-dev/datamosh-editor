/**
 * GPU motion estimation.
 *
 * A downscaled luma pair is searched per block with a three-step SAD search
 * (see MOTION_FS). The result is a motion field that the datamosh passes
 * consume, i.e. the app manipulates real motion information rather than faking
 * an effect with colour noise.
 *
 * The field is stored as RG8 with the vector normalised by the search radius,
 * which is plenty of precision for warp lookups.
 *
 * The estimator owns only the luma + motion targets; the caller uploads the
 * source frame and passes the texture in, so frames are uploaded exactly once
 * per rendered frame.
 */

import type { ProgramInfo, RenderTarget } from '../gl/glUtils';
import {
  FULLSCREEN_VERTEX_SHADER,
  bindTexture,
  createProgram,
  createRenderTarget,
  drawFullscreen,
  resizeRenderTarget,
} from '../gl/glUtils';
import { LUMA_FS, MOTION_FS } from '../datamosh/preview/shaders';

export interface MotionFieldInfo {
  /** Motion field of the current frame. */
  texture: WebGLTexture;
  /** Motion field of the previous frame (for persistence). */
  previousTexture: WebGLTexture;
  gridWidth: number;
  gridHeight: number;
  lumaWidth: number;
  lumaHeight: number;
  /** Search radius in luma texels. */
  radius: number;
  /** Source pixels per luma texel (motion vectors are in luma texels). */
  lumaScale: number;
  /** Block half-extent in luma texels, exposed for debug overlays. */
  blockHalf: number;
}

const LUMA_DIVISOR = 4;
/** Coarse luma grid used by the `fast` quality preset. */
const FAST_LUMA_DIVISOR = 8;

/**
 * Preview motion-field quality. The three-step SAD search below is the single
 * most expensive thing the preview does, so it is the loudest dial the user
 * gets: `fast` quarters the search grid and halves the radius, and `flat`
 * skips the search completely.
 */
export type MotionQuality = 'full' | 'fast' | 'flat';

export class MotionEstimator {
  private gl: WebGL2RenderingContext;
  private lumaProgram: ProgramInfo;
  private motionProgram: ProgramInfo;

  private lumaA: RenderTarget;
  private lumaB: RenderTarget;
  private motionA: RenderTarget;
  private motionB: RenderTarget;

  private hasPrevious = false;
  private lumaToggle = false;
  private motionToggle = false;
  private currentInfo: MotionFieldInfo | null = null;

  private lumaWidth = 0;
  private lumaHeight = 0;
  private blockHalf = 1;
  private radius = 3;
  private quality: MotionQuality = 'full';
  private divisor = LUMA_DIVISOR;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.lumaProgram = createProgram(gl, FULLSCREEN_VERTEX_SHADER, LUMA_FS, ['uTex']);
    this.motionProgram = createProgram(gl, FULLSCREEN_VERTEX_SHADER, MOTION_FS, [
      'uCur',
      'uPrev',
      'uLumaSize',
      'uBlock',
      'uRadius',
    ]);
    this.lumaA = createRenderTarget(gl, 32, 18, { linear: true });
    this.lumaB = createRenderTarget(gl, 32, 18, { linear: true });
    this.motionA = createRenderTarget(gl, 8, 5, { linear: false });
    this.motionB = createRenderTarget(gl, 8, 5, { linear: false });
  }

  /** Configure the field geometry for a source size. Cheap when unchanged. */
  configure(
    sourceWidth: number,
    sourceHeight: number,
    blockSize: number,
    radius: number,
    quality: MotionQuality = 'full',
  ): void {
    const divisor = quality === 'fast' ? FAST_LUMA_DIVISOR : LUMA_DIVISOR;
    const lw = Math.max(16, Math.round(sourceWidth / divisor));
    const lh = Math.max(9, Math.round(sourceHeight / divisor));
    const blockHalf = Math.max(1, Math.round(blockSize / divisor / 2));
    const clampedRadius = Math.min(
      6,
      Math.max(1, Math.round(quality === 'fast' ? radius / 2 : radius)),
    );

    if (
      lw === this.lumaWidth &&
      lh === this.lumaHeight &&
      blockHalf === this.blockHalf &&
      clampedRadius === this.radius &&
      divisor === this.divisor &&
      quality === this.quality
    ) {
      return;
    }

    this.lumaWidth = lw;
    this.lumaHeight = lh;
    this.blockHalf = blockHalf;
    this.radius = clampedRadius;
    this.quality = quality;
    this.divisor = divisor;

    resizeRenderTarget(this.gl, this.lumaA, lw, lh);
    resizeRenderTarget(this.gl, this.lumaB, lw, lh);
    const gridW = Math.max(1, Math.ceil(lw / (blockHalf * 2)));
    const gridH = Math.max(1, Math.ceil(lh / (blockHalf * 2)));
    resizeRenderTarget(this.gl, this.motionA, gridW, gridH);
    resizeRenderTarget(this.gl, this.motionB, gridW, gridH);
    this.hasPrevious = false;
  }

  /** True once a previous frame exists, so motion is meaningful. */
  hasMotion(): boolean {
    return this.hasPrevious && this.currentInfo !== null;
  }

  /**
   * Computes the luma of `sourceTexture` and, when a previous frame is
   * available, the motion field between them.
   */
  estimate(sourceTexture: WebGLTexture): MotionFieldInfo | null {
    if (this.quality === 'flat') return this.estimateFlat();
    const gl = this.gl;
    const lumaCurrent = this.lumaToggle ? this.lumaA : this.lumaB;
    const lumaPrevious = this.lumaToggle ? this.lumaB : this.lumaA;

    gl.useProgram(this.lumaProgram.program);
    bindTexture(gl, 0, sourceTexture, this.lumaProgram.uniforms.uTex);
    drawFullscreen(gl, lumaCurrent);

    let result: MotionFieldInfo | null = null;
    if (this.hasPrevious) {
      const motionCurrent = this.motionToggle ? this.motionA : this.motionB;
      const motionPrevious = this.motionToggle ? this.motionB : this.motionA;

      gl.useProgram(this.motionProgram.program);
      bindTexture(gl, 0, lumaCurrent.texture, this.motionProgram.uniforms.uCur);
      bindTexture(gl, 1, lumaPrevious.texture, this.motionProgram.uniforms.uPrev);
      gl.uniform2f(this.motionProgram.uniforms.uLumaSize, this.lumaWidth, this.lumaHeight);
      gl.uniform2f(this.motionProgram.uniforms.uBlock, this.blockHalf, this.blockHalf);
      gl.uniform1f(this.motionProgram.uniforms.uRadius, this.radius);
      drawFullscreen(gl, motionCurrent);

      this.motionToggle = !this.motionToggle;
      this.currentInfo = {
        texture: motionCurrent.texture,
        previousTexture: motionPrevious.texture,
        gridWidth: motionCurrent.width,
        gridHeight: motionCurrent.height,
        lumaWidth: this.lumaWidth,
        lumaHeight: this.lumaHeight,
        radius: this.radius,
        lumaScale: LUMA_DIVISOR,
        blockHalf: this.blockHalf,
      };
      result = this.currentInfo;
    }

    this.lumaToggle = !this.lumaToggle;
    this.hasPrevious = true;
    return result;
  }

  /**
   * Performance mode: the field is left at exactly zero, so the warp and the
   * accumulation still run (the smear and the bloom are what datamosh looks
   * like) while the per-block search — the expensive part — is skipped.
   *
   * 0.5 is the field's zero: vectors are stored as `mv / (radius * 2) + 0.5`.
   */
  private estimateFlat(): MotionFieldInfo | null {
    const gl = this.gl;
    const motionCurrent = this.motionToggle ? this.motionA : this.motionB;
    const motionPrevious = this.motionToggle ? this.motionB : this.motionA;
    for (const target of [motionCurrent, motionPrevious]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
      gl.clearColor(0.5, 0.5, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    this.motionToggle = !this.motionToggle;
    this.currentInfo = {
      texture: motionCurrent.texture,
      previousTexture: motionPrevious.texture,
      gridWidth: motionCurrent.width,
      gridHeight: motionCurrent.height,
      lumaWidth: this.lumaWidth,
      lumaHeight: this.lumaHeight,
      radius: 1,
      lumaScale: this.divisor,
      blockHalf: this.blockHalf,
    };
    return this.currentInfo;
  }

  /** After a seek or a cut, the next frame must not smear into the old one. */
  invalidateHistory(): void {
    this.hasPrevious = false;
    this.currentInfo = null;
  }

  info(): MotionFieldInfo | null {
    return this.currentInfo;
  }

  dispose(): void {
    const gl = this.gl;
    for (const target of [this.lumaA, this.lumaB, this.motionA, this.motionB]) {
      gl.deleteTexture(target.texture);
      gl.deleteFramebuffer(target.framebuffer);
    }
    gl.deleteProgram(this.lumaProgram.program);
    gl.deleteProgram(this.motionProgram.program);
  }
}
