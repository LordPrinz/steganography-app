/** Deterministic test data (xorshift32), so a failing case can be reproduced. */
export function randomBytes(length: number, seed = 0x9e3779b9): Uint8ClampedArray {
  const out = new Uint8ClampedArray(length);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}
