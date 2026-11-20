import { arg, assertDimensions, assertLength, type RgbaPixels } from "./image.ts";
import { native } from "./library.ts";
import { check } from "./status.ts";

/** PNG filter types (PNG spec, section 9.2). `Adaptive` picks the cheapest one for each row. */
export const PngFilter = {
  None: 0,
  Sub: 1,
  Up: 2,
  Average: 3,
  Paeth: 4,
  Adaptive: 5,
} as const;
export type PngFilter = (typeof PngFilter)[keyof typeof PngFilter];

/**
 * Filters RGBA pixels into PNG scanlines: `height` rows of a filter-type byte followed by
 * `width * 4` bytes, ready for zlib.
 */
export function pngFilter(image: RgbaPixels, filter: PngFilter = PngFilter.Adaptive): Uint8Array {
  const { width, height, data } = image;
  const pixels = assertDimensions(width, height);
  assertLength("data", data.length, pixels * 4);
  if (!Number.isInteger(filter) || filter < PngFilter.None || filter > PngFilter.Adaptive) {
    throw new RangeError(`filter must be an integer in 0–${PngFilter.Adaptive}, got ${filter}`);
  }

  const scanlines = new Uint8Array((width * 4 + 1) * height);
  check(
    "pngFilter",
    native().stego_png_filter(...arg(data), width, height, filter, ...arg(scanlines)),
  );
  return scanlines;
}

/**
 * Reverses PNG filtering of 8-bit RGB (`channels` 3) or RGBA (4) scanlines and returns RGBA;
 * RGB pixels get alpha 255. Throws `RangeError` on a filter-type byte above 4.
 */
export function pngUnfilter(
  scanlines: Uint8Array,
  width: number,
  height: number,
  channels: 3 | 4,
): RgbaPixels & { data: Uint8ClampedArray } {
  const pixels = assertDimensions(width, height);
  if (channels !== 3 && channels !== 4) {
    throw new RangeError(`channels must be 3 or 4, got ${channels}`);
  }
  const stride = width * channels + 1;
  assertLength("scanlines", scanlines.length, stride * height);
  for (let row = 0; row < height; row++) {
    const filter = scanlines[row * stride] as number;
    if (filter > PngFilter.Paeth) {
      throw new RangeError(`row ${row} has unknown filter type ${filter}`);
    }
  }

  const data = new Uint8ClampedArray(pixels * 4);
  check(
    "pngUnfilter",
    native().stego_png_unfilter(...arg(scanlines), width, height, channels, ...arg(data)),
  );
  return { width, height, data };
}
