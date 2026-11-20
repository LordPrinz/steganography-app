import { bitErrors, lumaMse, lumaSsim } from "@stego/native";
import type { RgbaImage } from "./types.ts";

/**
 * Peak signal-to-noise ratio in dB between the luminance of two images of the same size; alpha is
 * ignored. `Infinity` when the luminance is identical. Throws `RangeError` on a size mismatch.
 */
export function psnr(cover: RgbaImage, stego: RgbaImage): number {
  const mse = lumaMse(cover, stego);
  return mse === 0 ? Number.POSITIVE_INFINITY : 10 * Math.log10((255 * 255) / mse);
}

/**
 * Mean SSIM between the luminance of two images of the same size, using the parameters of Wang et
 * al. 2004 (11 x 11 Gaussian window, sigma 1.5, K1 0.01, K2 0.03, L 255). 1 for identical
 * luminance. Throws `RangeError` on a size mismatch or when a side is below 11 pixels.
 */
export function ssim(cover: RgbaImage, stego: RgbaImage): number {
  return lumaSsim(cover, stego);
}

/**
 * Share of positions where `actual` differs from `expected`, both one bit per element (lowest bit
 * used). 0 for empty arrays. Throws `RangeError` when the lengths differ.
 */
export function ber(expected: Uint8Array, actual: Uint8Array): number {
  const errors = bitErrors(expected, actual);
  return expected.length === 0 ? 0 : errors / expected.length;
}
