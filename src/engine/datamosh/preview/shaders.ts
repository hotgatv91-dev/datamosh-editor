/**
 * GLSL for the real-time datamosh pipeline.
 *
 * The chain is:
 *   luma      -> small luma textures, the only thing motion search reads
 *   motion    -> per-block motion field (three-step search on SAD)
 *   mvAdjust  -> motion-vector manipulation: intensity, motion, stretch,
 *                persistence (averaging over previous fields), blend, threshold,
 *                acceleration, swap, direction, corruption
 *   warp      -> motion-compensated frame persistence (the smear/stretch itself)
 *   display   -> transform + split view
 *
 * Motion-vector manipulation followed by motion-compensated persistence is what
 * datamosh is. Nothing here is a colour glitch pass; those live in
 * engine/effects/shaders.ts and are labelled differently in the UI.
 */

export const LUMA_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
void main() {
  vec3 c = texture(uTex, vUv).rgb;
  float y = dot(c, vec3(0.299, 0.587, 0.114));
  outColor = vec4(y, y, y, 1.0);
}`;

export const MOTION_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uCur;
uniform sampler2D uPrev;
uniform vec2 uLumaSize;
uniform vec2 uBlock;      // half-extent of a block, in luma texels
uniform float uRadius;    // search radius, in luma texels

void main() {
  vec2 texel = 1.0 / uLumaSize;
  vec2 cell = floor(gl_FragCoord.xy);
  vec2 blockExtent = uBlock * 2.0;
  vec2 centerUv = (cell + 0.5) * blockExtent * texel;

  float cur[9];
  for (int i = 0; i < 9; i++) {
    vec2 off = (vec2(float(i % 3), float(i / 3)) - 1.0) * uBlock * texel;
    cur[i] = texture(uCur, clamp(centerUv + off, vec2(0.0), vec2(1.0))).r;
  }

  vec2 bestMv = vec2(0.0);
  float bestSad = 1e9;
  float step = max(1.0, uRadius);

  // Three-step search: coarse -> half -> unit refinement.
  for (int stage = 0; stage < 3; stage++) {
    vec2 stageBest = bestMv;
    float stageSad = bestSad;
    for (int i = 0; i < 9; i++) {
      vec2 cand = bestMv + (vec2(float(i % 3), float(i / 3)) - 1.0) * step;
      if (length(cand) > uRadius + 0.5) continue;
      vec2 candUv = cand * texel;
      float sad = 0.0;
      for (int k = 0; k < 9; k++) {
        vec2 off = (vec2(float(k % 3), float(k / 3)) - 1.0) * uBlock * texel;
        sad += abs(cur[k] - texture(uPrev, clamp(centerUv + off + candUv, vec2(0.0), vec2(1.0))).r);
      }
      if (sad < stageSad) {
        stageSad = sad;
        stageBest = cand;
      }
    }
    bestMv = stageBest;
    bestSad = stageSad;
    step = max(1.0, floor(step * 0.5));
  }

  outColor = vec4(bestMv / max(1.0, uRadius * 2.0) + 0.5, 0.0, 1.0);
}`;

export const MV_ADJUST_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uMv;
uniform sampler2D uMvPrev;
uniform vec2 uBlockUv;
uniform float uRadius;
uniform float uIntensity;
uniform float uStretch;
uniform float uPersistence;
uniform float uBlend;
uniform float uThreshold;
uniform float uAcceleration;
uniform float uSwapWeight;
uniform float uSwapFade;
uniform float uCorruption;
uniform float uDirection;
uniform float uUseDirection;
uniform float uTime;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

vec2 decode(vec2 enc) {
  return (enc - 0.5) * 2.0 * max(1.0, uRadius);
}

void main() {
  vec2 mv = decode(texture(uMv, vUv).rg);
  vec2 hist = decode(texture(uMvPrev, vUv).rg);

  // Motion persistence: an exponential tail of previous motion fields.
  vec2 persistMv = mix(mv, hist, clamp(uPersistence, 0.0, 0.94));

  float mag = length(persistMv);
  float scaledThreshold = uThreshold >= 0.0 ? uThreshold * uAcceleration : -abs(uThreshold) * uAcceleration;
  bool pass = true;
  if (abs(uThreshold) > 0.001) {
    pass = uThreshold < 0.0 ? mag < abs(scaledThreshold) : mag > max(0.0, scaledThreshold);
  }

  vec2 result = persistMv;
  if (pass) {
    vec2 dir = mag > 1e-4 ? persistMv / mag : vec2(0.0);
    vec2 along = uUseDirection > 0.5 ? vec2(cos(uDirection), sin(uDirection)) : dir;
    vec2 amplified = dir * mag * uIntensity + along * mag * uStretch;
    result = mix(amplified, persistMv, clamp(uBlend, 0.0, 1.0));
  }

  if (uSwapWeight > 0.001) {
    vec2 other = decode(texture(uMvPrev, clamp(vUv + vec2(uBlockUv.x * 4.0, 0.0), vec2(0.0), vec2(1.0))).rg);
    result = mix(result, other, clamp(uSwapWeight * uSwapFade, 0.0, 1.0));
  }

  if (uCorruption > 0.001) {
    vec2 cell = floor(vUv / max(uBlockUv, vec2(1e-5)));
    float block = hash(cell + floor(uTime * 5.0) * 17.0);
    if (block < uCorruption) result = vec2(0.0);
  }

  outColor = vec4(result / max(1.0, uRadius * 2.0) + 0.5, 0.0, 1.0);
}`;

export const WARP_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uCur;
uniform sampler2D uPrev;
uniform sampler2D uAccum;
uniform sampler2D uMv;
uniform vec2 uTexel;
uniform float uRadius;
uniform float uWarpScale;
uniform float uSmear;
uniform float uWeight;
uniform float uDecayFactor;

void main() {
  vec3 cur = texture(uCur, vUv).rgb;
  vec2 mv = (texture(uMv, vUv).rg - 0.5) * 2.0 * max(1.0, uRadius) * uTexel;
  vec2 warped = clamp(vUv + mv * uWarpScale, vec2(0.0), vec2(1.0));

  vec3 ghostAccum = texture(uAccum, warped).rgb * uDecayFactor;
  vec3 ghostPrev = texture(uPrev, warped).rgb;
  vec3 ghost = mix(ghostAccum, ghostPrev, clamp(uSmear, 0.0, 1.0));

  vec3 rgb = mix(cur, ghost, clamp(uWeight, 0.0, 1.0));
  outColor = vec4(rgb, 1.0);
}`;

/** Blends a datamosh pass output back onto the frame (lane stacking). */
export const COMPOSITE_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uBase;
uniform sampler2D uTop;
uniform float uAmount;
void main() {
  vec3 a = texture(uBase, vUv).rgb;
  vec3 b = texture(uTop, vUv).rgb;
  outColor = vec4(mix(a, b, clamp(uAmount, 0.0, 1.0)), 1.0);
}`;

export const DISPLAY_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform vec2 uResolution;
uniform vec2 uScale;
uniform float uRotation;
uniform vec2 uOffset;
uniform vec2 uFlip;
uniform vec4 uAdjust;   // brightness, contrast, saturation, exposure
uniform float uBlur;

void main() {
  vec2 uv = vUv - 0.5 - uOffset;
  float s = sin(-uRotation);
  float c = cos(-uRotation);
  uv = mat2(c, -s, s, c) * uv;
  uv = uv / max(uScale, vec2(0.0001));
  uv = uv * uFlip + 0.5;

  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  vec3 rgb;
  if (uBlur > 0.0) {
    vec2 t = uBlur / uResolution;
    rgb = texture(uTex, uv).rgb * 0.4;
    rgb += texture(uTex, uv + vec2(t.x, 0.0)).rgb * 0.15;
    rgb += texture(uTex, uv - vec2(t.x, 0.0)).rgb * 0.15;
    rgb += texture(uTex, uv + vec2(0.0, t.y)).rgb * 0.15;
    rgb += texture(uTex, uv - vec2(0.0, t.y)).rgb * 0.15;
  } else {
    rgb = texture(uTex, uv).rgb;
  }

  rgb *= exp2(uAdjust.w * 2.0);
  rgb = (rgb - 0.5) * (1.0 + uAdjust.y) + 0.5;
  rgb += uAdjust.x * 0.5;
  float luma = dot(rgb, vec3(0.299, 0.587, 0.114));
  rgb = mix(vec3(luma), rgb, 1.0 + uAdjust.z);

  outColor = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}`;
