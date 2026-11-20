import { arg, assertDimensions, assertLength, type RgbaPixels } from "./image.ts";
import { native } from "./library.ts";
import { check } from "./status.ts";

/** Largest sigma accepted; its kernel (2 * ceil(3 * 32) + 1 = 193 taps) fits STEGO_BLUR_MAX_TAPS. */
export const GAUSSIAN_MAX_SIGMA = 32;

/**
 * Normalised 1-D Gaussian with radius ceil(3 * sigma), which keeps more than 99.7% of the weight.
 * Built here rather than in C so the kernel does not depend on the platform's libm.
 */
export function gaussianKernel(sigma: number): Float64Array {
  if (!Number.isFinite(sigma) || sigma <= 0 || sigma > GAUSSIAN_MAX_SIGMA) {
    throw new RangeError(`sigma must be in (0, ${GAUSSIAN_MAX_SIGMA}], got ${sigma}`);
  }
  const radius = Math.ceil(3 * sigma);
  const kernel = new Float64Array(2 * radius + 1);
  let sum = 0;
  for (let k = -radius; k <= radius; k++) {
    const weight = Math.exp(-(k * k) / (2 * sigma * sigma));
    kernel[k + radius] = weight;
    sum += weight;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] = (kernel[i] as number) / sum;
  return kernel;
}

/**
 * Returns a copy of `image` with R, G and B blurred by a separable Gaussian; edge pixels repeat
 * past the border and alpha is copied unchanged.
 */
export function gaussianBlur(
  image: RgbaPixels,
  sigma: number,
): RgbaPixels & { data: Uint8ClampedArray } {
  const { width, height } = image;
  assertLength("data", image.data.length, assertDimensions(width, height) * 4);
  const kernel = gaussianKernel(sigma);
  const scratch = new Float64Array(width * 3);
  const data = new Uint8ClampedArray(image.data.length);
  check(
    "gaussianBlur",
    native().stego_blur_separable(
      ...arg(image.data),
      width,
      height,
      ...arg(kernel),
      ...arg(scratch),
      ...arg(data),
    ),
  );
  return { width, height, data };
}
