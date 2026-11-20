import { arg, assertDimensions, assertLength, type RgbaPixels } from "./image.ts";
import { native } from "./library.ts";
import { check } from "./status.ts";

/** Mirrors STEGO_LSB_MAX_BITS in c/stego.h. */
export const LSB_MAX_BITS_PER_CHANNEL = 8;

/** Throws a RangeError unless `bitsPerChannel` is an integer the LSB kernels accept. */
export function assertBitsPerChannel(bitsPerChannel: number): void {
  if (
    !Number.isInteger(bitsPerChannel) ||
    bitsPerChannel < 1 ||
    bitsPerChannel > LSB_MAX_BITS_PER_CHANNEL
  ) {
    throw new RangeError(
      `bitsPerChannel must be an integer in 1–${LSB_MAX_BITS_PER_CHANNEL}, got ${bitsPerChannel}`,
    );
  }
}

/** Bits that fit into the R, G and B channels of an image of the given size. */
export function lsbCapacityBits(width: number, height: number, bitsPerChannel: number): number {
  assertBitsPerChannel(bitsPerChannel);
  return assertDimensions(width, height) * 3 * bitsPerChannel;
}

function assertBitCount(image: RgbaPixels, bitsPerChannel: number, bitCount: number): void {
  const pixels = assertDimensions(image.width, image.height);
  assertLength("data", image.data.length, pixels * 4);
  const capacity = lsbCapacityBits(image.width, image.height, bitsPerChannel);
  if (bitCount > capacity) {
    throw new RangeError(`${bitCount} bits exceed the capacity of ${capacity}`);
  }
}

/**
 * Returns a copy of `image` with `bits` (one per element, lowest bit used) in the low
 * `bitsPerChannel` bits of R, G and B, filled MSB first. Alpha is copied unchanged.
 */
export function lsbEmbed(
  image: RgbaPixels,
  bitsPerChannel: number,
  bits: Uint8Array,
): RgbaPixels & { data: Uint8ClampedArray } {
  assertBitCount(image, bitsPerChannel, bits.length);
  const { width, height } = image;
  const data = new Uint8ClampedArray(image.data.length);
  check(
    "lsbEmbed",
    native().stego_lsb_embed(
      ...arg(image.data),
      width,
      height,
      bitsPerChannel,
      ...arg(bits),
      ...arg(data),
    ),
  );
  return { width, height, data };
}

/** Reads the first `bitCount` bits written by `lsbEmbed`, one per element (0 or 1). */
export function lsbExtract(
  image: RgbaPixels,
  bitsPerChannel: number,
  bitCount: number,
): Uint8Array {
  if (!Number.isInteger(bitCount) || bitCount < 0) {
    throw new RangeError(`bitCount must be a non-negative integer, got ${bitCount}`);
  }
  assertBitCount(image, bitsPerChannel, bitCount);
  const bits = new Uint8Array(bitCount);
  check(
    "lsbExtract",
    native().stego_lsb_extract(
      ...arg(image.data),
      image.width,
      image.height,
      bitsPerChannel,
      ...arg(bits),
    ),
  );
  return bits;
}
