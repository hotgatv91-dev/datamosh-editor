/**
 * Device capability probes.
 *
 * These live in their own module on purpose: `ffmpegClient` pulls in
 * @ffmpeg/ffmpeg (and, through the exports map, the ~25 MB wasm core), so
 * anything that only wants to ask "is this a weak device?" must not import
 * through it. The store asks that question at startup to pick a preview
 * resolution, and the initial bundle has to stay small.
 */

export function deviceMemoryGb(): number | null {
  if (typeof navigator === 'undefined') return null;
  const value = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return typeof value === 'number' ? value : null;
}

/**
 * Also called while the store module is being evaluated, so it has to cope with
 * there being no `navigator` at all (tests, and any non-browser tooling).
 */
export function isLikelyLowEndDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  const memory = deviceMemoryGb();
  const cores = navigator.hardwareConcurrency ?? 4;
  return (memory !== null && memory <= 4) || cores <= 4;
}
