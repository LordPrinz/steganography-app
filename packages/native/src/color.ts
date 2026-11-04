import { arg, assertDimensions, assertLength, type RgbaPixels } from "./image.ts";
import { native } from "./library.ts";
import { check } from "./status.ts";

/** Y, Cb and Cr planes (0..255, BT.601 full range as in JPEG) plus the untouched alpha channel. */
export interface YcbcrPlanes {
  readonly width: number;
  readonly height: number;
  readonly y: Float32Array;
  readonly cb: Float32Array;
  readonly cr: Float32Array;
  readonly alpha: Uint8Array;
}

export function rgbaToYcbcr(image: RgbaPixels): YcbcrPlanes {
  const { width, height, data } = image;
  const pixels = assertDimensions(width, height);
  assertLength("data", data.length, pixels * 4);

  const planes = {
    width,
    height,
    y: new Float32Array(pixels),
    cb: new Float32Array(pixels),
    cr: new Float32Array(pixels),
    alpha: new Uint8Array(pixels),
  };
  const { y, cb, cr, alpha } = planes;
  check(
    "rgbaToYcbcr",
    native().stego_rgba_to_ycbcr(
      ...arg(data),
      width,
      height,
      ...arg(y),
      ...arg(cb),
      ...arg(cr),
      ...arg(alpha),
    ),
  );
  return planes;
}

/** Inverse of `rgbaToYcbcr`; channels are rounded half up and clamped to 0..255. */
export function ycbcrToRgba(planes: YcbcrPlanes): RgbaPixels & { data: Uint8ClampedArray } {
  const { width, height, y, cb, cr, alpha } = planes;
  const pixels = assertDimensions(width, height);
  assertLength("y", y.length, pixels);
  assertLength("cb", cb.length, pixels);
  assertLength("cr", cr.length, pixels);
  assertLength("alpha", alpha.length, pixels);

  const data = new Uint8ClampedArray(pixels * 4);
  check(
    "ycbcrToRgba",
    native().stego_ycbcr_to_rgba(
      ...arg(y),
      ...arg(cb),
      ...arg(cr),
      ...arg(alpha),
      width,
      height,
      ...arg(data),
    ),
  );
  return { width, height, data };
}
