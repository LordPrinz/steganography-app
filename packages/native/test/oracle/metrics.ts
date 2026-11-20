/**
 * Reference luminance MSE, SSIM and bit error count, straight from the definitions. SSIM sums the
 * full 11 x 11 window at every position, where c/metrics.c filters rows and columns separately, so
 * results agree to rounding only. Test-only; never used at runtime.
 */
import type { RgbaPixels } from "../../src/image.ts";

function luma({ width, height, data }: RgbaPixels): Float64Array {
  const y = new Float64Array(width * height);
  for (let i = 0; i < y.length; i++) {
    const r = data[i * 4] as number;
    const g = data[i * 4 + 1] as number;
    const b = data[i * 4 + 2] as number;
    y[i] = Math.fround(0.299 * r + 0.587 * g + 0.114 * b);
  }
  return y;
}

export function lumaMseOracle(a: RgbaPixels, b: RgbaPixels): number {
  const ya = luma(a);
  const yb = luma(b);
  let sum = 0;
  for (let i = 0; i < ya.length; i++) {
    const d = (ya[i] as number) - (yb[i] as number);
    sum += d * d;
  }
  return sum / ya.length;
}

const RADIUS = 5;
const SIGMA = 1.5;
const C1 = (0.01 * 255) ** 2;
const C2 = (0.03 * 255) ** 2;

/** 2-D Gaussian window, normalised to sum to 1. */
function gaussianWindow(): number[][] {
  const window: number[][] = [];
  let sum = 0;
  for (let dy = -RADIUS; dy <= RADIUS; dy++) {
    const row: number[] = [];
    for (let dx = -RADIUS; dx <= RADIUS; dx++) {
      const weight = Math.exp(-(dx * dx + dy * dy) / (2 * SIGMA * SIGMA));
      row.push(weight);
      sum += weight;
    }
    window.push(row);
  }
  return window.map((row) => row.map((weight) => weight / sum));
}

export function lumaSsimOracle(a: RgbaPixels, b: RgbaPixels): number {
  const { width, height } = a;
  const ya = luma(a);
  const yb = luma(b);
  const window = gaussianWindow();
  const size = 2 * RADIUS + 1;
  let total = 0;
  let count = 0;
  for (let top = 0; top + size <= height; top++) {
    for (let left = 0; left + size <= width; left++) {
      let ux = 0;
      let uy = 0;
      let uxx = 0;
      let uyy = 0;
      let uxy = 0;
      for (let dy = 0; dy < size; dy++) {
        for (let dx = 0; dx < size; dx++) {
          const weight = window[dy]?.[dx] as number;
          const at = (top + dy) * width + left + dx;
          const x = ya[at] as number;
          const y = yb[at] as number;
          ux += weight * x;
          uy += weight * y;
          uxx += weight * x * x;
          uyy += weight * y * y;
          uxy += weight * x * y;
        }
      }
      const vx = uxx - ux * ux;
      const vy = uyy - uy * uy;
      const vxy = uxy - ux * uy;
      total += ((2 * ux * uy + C1) * (2 * vxy + C2)) / ((ux * ux + uy * uy + C1) * (vx + vy + C2));
      count++;
    }
  }
  return total / count;
}

export function bitErrorsOracle(a: Uint8Array, b: Uint8Array): number {
  let errors = 0;
  for (let i = 0; i < a.length; i++) {
    if (((a[i] as number) & 1) !== ((b[i] as number) & 1)) errors++;
  }
  return errors;
}
