/** Limits mirrored from c/stego.h; MAX_PIXELS matches image-io. */
export const MAX_SIDE = 16384;
export const MAX_PIXELS = 4096 * 4096;

/** 8-bit RGBA pixels, row-major. Structurally compatible with `RgbaImage` from the engine. */
export interface RgbaPixels {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array | Uint8ClampedArray;
}

/** Throws a RangeError unless the dimensions are positive integers the C side accepts. */
export function assertDimensions(width: number, height: number): number {
  for (const [name, value] of [
    ["width", width],
    ["height", height],
  ] as const) {
    if (!Number.isInteger(value) || value < 1 || value > MAX_SIDE) {
      throw new RangeError(`${name} must be an integer in 1–${MAX_SIDE}, got ${value}`);
    }
  }
  const pixels = width * height;
  if (pixels > MAX_PIXELS) {
    throw new RangeError(`image has ${pixels} pixels, the limit is ${MAX_PIXELS}`);
  }
  return pixels;
}

export function assertLength(name: string, actual: number, expected: number): void {
  if (actual !== expected) {
    throw new RangeError(`${name} must have ${expected} elements, got ${actual}`);
  }
}

/**
 * Expands a view into the `buffer, buffer_length` argument pair of a kernel. Passing both from
 * one value means a pointer can never be paired with the length of another buffer.
 */
export function arg<T extends ArrayBufferView>(view: T): readonly [T, T] {
  return [view, view];
}
