import type { RgbaImage } from "../types.ts";

/** Deterministic noise image (xorshift32), so tests do not depend on luck. */
export function noiseImage(width: number, height: number, seed = 0x2545f491): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  let state = seed >>> 0 || 1;
  for (let i = 0; i < data.length; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    data[i] = state & 0xff;
  }
  return { width, height, data };
}
