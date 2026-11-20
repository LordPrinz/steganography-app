/**
 * Reference separable blur over the whole image: a full vertical pass into a Float64Array, then a
 * horizontal pass. Accumulates in the same order as c/blur.c, so results match bit for bit.
 * Test-only; never used at runtime.
 */
import type { RgbaPixels } from "../../src/image.ts";

const clamp = (i: number, size: number) => Math.min(Math.max(i, 0), size - 1);

export function blurOracle(image: RgbaPixels, kernel: Float64Array) {
  const { width, height } = image;
  const radius = (kernel.length - 1) / 2;
  const vertical = new Float64Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++) {
          const source = image.data[(clamp(y + k, height) * width + x) * 4 + c] as number;
          sum += (kernel[k + radius] as number) * source;
        }
        vertical[(y * width + x) * 3 + c] = sum;
      }
    }
  }

  const data = new Uint8ClampedArray(image.data.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++) {
          const source = vertical[(y * width + clamp(x + k, width)) * 3 + c] as number;
          sum += (kernel[k + radius] as number) * source;
        }
        data[(y * width + x) * 4 + c] = Math.floor(sum + 0.5);
      }
      data[(y * width + x) * 4 + 3] = image.data[(y * width + x) * 4 + 3] as number;
    }
  }
  return { width, height, data };
}

/** Direct 2-D convolution with the outer product of `kernel`; differs from the separable form only by rounding. */
export function blur2dOracle(image: RgbaPixels, kernel: Float64Array) {
  const { width, height } = image;
  const radius = (kernel.length - 1) / 2;
  const data = new Uint8ClampedArray(image.data.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let j = -radius; j <= radius; j++) {
          for (let i = -radius; i <= radius; i++) {
            const weight = (kernel[j + radius] as number) * (kernel[i + radius] as number);
            const offset = (clamp(y + j, height) * width + clamp(x + i, width)) * 4 + c;
            sum += weight * (image.data[offset] as number);
          }
        }
        data[(y * width + x) * 4 + c] = Math.round(sum);
      }
      data[(y * width + x) * 4 + 3] = image.data[(y * width + x) * 4 + 3] as number;
    }
  }
  return { width, height, data };
}
