import { arg, assertDimensions, assertLength, type RgbaPixels } from "./image.ts";
import { native } from "./library.ts";
import { check } from "./status.ts";

/** Mirrors STEGO_SSIM_MIN_SIDE in c/stego.h: one 11 x 11 window. */
export const SSIM_MIN_SIDE = 11;
/** Mirrors STEGO_SSIM_SCRATCH_ROWS: two rings of 11 luminance rows plus five rows of sums. */
const SSIM_SCRATCH_ROWS = 2 * SSIM_MIN_SIDE + 5;

function assertSameSize(a: RgbaPixels, b: RgbaPixels): void {
  if (a.width !== b.width || a.height !== b.height) {
    throw new RangeError(
      `images must have the same size, got ${a.width}x${a.height} and ${b.width}x${b.height}`,
    );
  }
  const pixels = assertDimensions(a.width, a.height);
  assertLength("a.data", a.data.length, pixels * 4);
  assertLength("b.data", b.data.length, pixels * 4);
}

/** Mean squared error between the luminance planes (Y as in `rgbaToYcbcr`); alpha is ignored. */
export function lumaMse(a: RgbaPixels, b: RgbaPixels): number {
  assertSameSize(a, b);
  const out = new Float64Array(1);
  check(
    "lumaMse",
    native().stego_luma_mse(...arg(a.data), ...arg(b.data), a.width, a.height, ...arg(out)),
  );
  return out[0] as number;
}

/**
 * Mean SSIM between the luminance planes (Wang et al. 2004: 11 x 11 Gaussian window, sigma 1.5,
 * K1 0.01, K2 0.03, L 255). Both sides must be at least `SSIM_MIN_SIDE`.
 */
export function lumaSsim(a: RgbaPixels, b: RgbaPixels): number {
  assertSameSize(a, b);
  if (a.width < SSIM_MIN_SIDE || a.height < SSIM_MIN_SIDE) {
    throw new RangeError(
      `SSIM needs at least ${SSIM_MIN_SIDE}x${SSIM_MIN_SIDE} pixels, got ${a.width}x${a.height}`,
    );
  }
  const scratch = new Float64Array(a.width * SSIM_SCRATCH_ROWS);
  const out = new Float64Array(1);
  check(
    "lumaSsim",
    native().stego_luma_ssim(
      ...arg(a.data),
      ...arg(b.data),
      a.width,
      a.height,
      ...arg(scratch),
      ...arg(out),
    ),
  );
  return out[0] as number;
}

/** Positions where the lowest bits of `a` and `b` differ; both hold one bit per element. */
export function bitErrors(a: Uint8Array, b: Uint8Array): number {
  assertLength("b", b.length, a.length);
  const out = new BigUint64Array(1);
  check("bitErrors", native().stego_bit_errors(...arg(a), ...arg(b), ...arg(out)));
  return Number(out[0]);
}
