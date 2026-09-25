/**
 * GLSL for the basic effects. One fragment shader with an effect switch keeps
 * the pass count low; these are colour/spatial distortions and are kept in a
 * completely separate namespace from datamosh.
 */

export const BASIC_FX_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform int uEffect;
uniform vec4 uParams;
uniform float uTime;
uniform vec2 uResolution;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

vec3 sampleSrc(vec2 uv) {
  return texture(uTex, clamp(uv, vec2(0.0), vec2(1.0))).rgb;
}

void main() {
  vec2 uv = vUv;
  vec3 rgb;

  if (uEffect == 0) {
    // Glitch: horizontal bands shifted sideways.
    float bands = max(1.0, uParams.z);
    float band = floor(uv.y * bands);
    float tick = floor(uTime * max(1.0, uParams.y));
    float jitter = (hash(vec2(band, tick)) - 0.5) * uParams.x * 0.12;
    uv.x += jitter;
    rgb = sampleSrc(uv);
    float tear = hash(vec2(band * 3.1, tick)) < uParams.x * 0.06 ? 1.0 : 0.0;
    rgb += tear * 0.08;
  } else if (uEffect == 1) {
    // RGB split.
    float angle = radians(uParams.y);
    vec2 dir = vec2(cos(angle), sin(angle));
    vec2 off = dir * uParams.x / uResolution;
    float jitter = 1.0 + (hash(vec2(floor(uTime * 12.0))) - 0.5) * uParams.z;
    rgb = vec3(
      sampleSrc(uv + off * jitter).r,
      sampleSrc(uv).g,
      sampleSrc(uv - off * jitter).b
    );
  } else if (uEffect == 2) {
    // Chromatic aberration, radial.
    vec2 center = uv - 0.5;
    float dist = length(center);
    float amount = uParams.x * (1.0 + uParams.y);
    rgb = vec3(
      sampleSrc(uv + center * dist * amount * 0.02).r,
      sampleSrc(uv).g,
      sampleSrc(uv - center * dist * amount * 0.02).b
    );
  } else if (uEffect == 3) {
    // VHS.
    float tick = floor(uTime * 20.0);
    float line = floor(uv.y * uResolution.y * 0.5);
    float wobble = (hash(vec2(line, tick)) - 0.5) * uParams.y * 0.02;
    uv.x += wobble;
    vec3 base = sampleSrc(uv);
    float grain = hash(uv * uResolution + tick) * uParams.w * 0.35;
    base += grain - uParams.w * 0.12;
    float luma = dot(base, vec3(0.299, 0.587, 0.114));
    base = mix(base, vec3(luma), clamp(uParams.z, 0.0, 1.0));
    rgb = mix(sampleSrc(vUv), base, clamp(uParams.x * 1.6, 0.0, 1.0));
  } else if (uEffect == 4) {
    // Noise.
    float tick = uParams.y > 0.5 ? floor(uTime * 24.0) : 0.0;
    float n = hash(uv * uResolution + tick * 31.0) - 0.5;
    vec3 col = vec3(n);
    if (uParams.z < 0.5) {
      col = vec3(hash(uv + tick) - 0.5, hash(uv.yx + tick * 2.0) - 0.5, hash(uv * 3.0 + tick) - 0.5);
    }
    rgb = sampleSrc(uv) + col * uParams.x * 0.6;
  } else if (uEffect == 5) {
    // Pixelate.
    vec2 blocks = max(vec2(1.0), uResolution / max(1.0, uParams.x));
    rgb = sampleSrc((floor(uv * blocks) + 0.5) / blocks);
  } else if (uEffect == 6) {
    // Blur.
    vec2 t = uParams.x / uResolution;
    rgb = sampleSrc(uv) * 0.36;
    rgb += sampleSrc(uv + vec2(t.x, 0.0)) * 0.16;
    rgb += sampleSrc(uv - vec2(t.x, 0.0)) * 0.16;
    rgb += sampleSrc(uv + vec2(0.0, t.y)) * 0.16;
    rgb += sampleSrc(uv - vec2(0.0, t.y)) * 0.16;
  } else if (uEffect == 7) {
    // Scanline.
    float density = max(1.0, uParams.x);
    float roll = fract(vUv.y + uTime * uParams.z * 0.15);
    float line = sin(roll * uResolution.y / density * 3.14159);
    float dark = (line * 0.5 + 0.5) * uParams.y;
    rgb = sampleSrc(uv) * (1.0 - dark * 0.6);
  } else {
    // Distortion: horizontal sine displacement.
    uv.x += sin(uv.y * uParams.y * 3.14159 + uTime * 1.5 + uParams.z) * uParams.x * 0.08;
    uv.y += cos(uv.x * uParams.y * 2.0 + uTime) * uParams.x * 0.02;
    rgb = sampleSrc(uv);
  }

  outColor = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}`;

/** Effect-type index used by BASIC_FX_FS. */
export const BASIC_FX_INDEX: Record<string, number> = {
  glitch: 0,
  rgbsplit: 1,
  chromatic: 2,
  vhs: 3,
  noise: 4,
  pixelate: 5,
  blur: 6,
  scanline: 7,
  distortion: 8,
};

export function basicFxParams(type: string, params: Record<string, unknown>): [number, number, number, number] {
  const num = (key: string, fallback = 0): number => {
    const value = params[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value !== '' && Number.isFinite(Number(value))) return Number(value);
    return fallback;
  };
  switch (type) {
    case 'glitch':
      return [num('amount', 35) / 100, num('speed', 6), num('blocks', 12), num('seed', 7)];
    case 'rgbsplit':
      return [num('amount', 6), num('angle', 0), num('jitter', 20) / 100, 0];
    case 'chromatic':
      return [num('amount', 1.6), num('falloff', 60) / 100, 0, 0];
    case 'vhs':
      return [
        num('amount', 45) / 100,
        num('jitter', 30) / 100,
        num('desaturate', 25) / 100,
        num('grain', 30) / 100,
      ];
    case 'noise':
      return [num('amount', 30) / 100, num('animated', 1), num('monochrome', 1), 0];
    case 'pixelate':
      return [Math.max(2, num('size', 12)), 0, 0, 0];
    case 'blur':
      return [num('amount', 4), 0, 0, 0];
    case 'scanline':
      return [Math.max(1, num('density', 3)), num('opacity', 35) / 100, num('roll', 20) / 100, 0];
    case 'distortion':
      return [num('amount', 20) / 100, num('frequency', 6), num('phase', 0), 0];
    default:
      return [0, 0, 0, 0];
  }
}
