/**
 * Reference RGB <-> YCbCr straight from the JFIF formulas. Same operation order as c/color.c,
 * so results must match bit for bit. Test-only; never used at runtime.
 */
import type { RgbaPixels } from "../../src/image.ts";

function clampU8(v: number): number {
  if (!(v > 0)) return 0;
  if (v >= 255) return 255;
  return Math.floor(v + 0.5);
}

export function rgbaToYcbcrOracle({ width, height, data }: RgbaPixels) {
  const n = width * height;
  const y = new Float32Array(n);
  const cb = new Float32Array(n);
  const cr = new Float32Array(n);
  const alpha = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const r = data[i * 4] as number;
    const g = data[i * 4 + 1] as number;
    const b = data[i * 4 + 2] as number;
    y[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    cb[i] = 128.0 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    cr[i] = 128.0 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    alpha[i] = data[i * 4 + 3] as number;
  }
  return { width, height, y, cb, cr, alpha };
}

export function ycbcrToRgbaOracle(planes: ReturnType<typeof rgbaToYcbcrOracle>) {
  const { width, height, y, cb, cr, alpha } = planes;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const l = y[i] as number;
    const u = (cb[i] as number) - 128.0;
    const v = (cr[i] as number) - 128.0;
    data[i * 4] = clampU8(l + 1.402 * v);
    data[i * 4 + 1] = clampU8(l - 0.344136 * u - 0.714136 * v);
    data[i * 4 + 2] = clampU8(l + 1.772 * u);
    data[i * 4 + 3] = alpha[i] as number;
  }
  return { width, height, data };
}
