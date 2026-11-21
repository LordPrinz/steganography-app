import { arg, assertDimensions, assertLength, type RgbaPixels } from "./image.ts";
import { native } from "./library.ts";
import { check } from "./status.ts";

/** Mirrors STEGO_DCT_MAX_STRENGTH and STEGO_DCT_SCRATCH_DOUBLES in c/stego.h. */
export const DCT_MAX_STRENGTH = 1024;
const SCRATCH_DOUBLES = 128;
const BLOCK = 8;

/** A DCT coefficient position inside an 8 x 8 block: `[u, v]`, horizontal and vertical frequency. */
export type DctPosition = readonly [u: number, v: number];

/** The two coefficients Koch–Zhao compares; the first is the larger one for a 1 bit. */
export type DctPair = readonly [first: DctPosition, second: DctPosition];

/** Throws a RangeError unless the pair and strength are ones the kernels accept. */
export function assertKochZhao(pair: DctPair, strength: number): void {
  for (const [u, v] of pair) {
    if (
      !Number.isInteger(u) ||
      !Number.isInteger(v) ||
      u < 0 ||
      v < 0 ||
      u >= BLOCK ||
      v >= BLOCK
    ) {
      throw new RangeError(`DCT frequencies must be integers in 0–${BLOCK - 1}, got [${u}, ${v}]`);
    }
    if (u === 0 && v === 0) throw new RangeError("the DC coefficient cannot be used");
  }
  if (pair[0][0] === pair[1][0] && pair[0][1] === pair[1][1]) {
    throw new RangeError("the two DCT positions must differ");
  }
  if (!(strength > 0 && strength <= DCT_MAX_STRENGTH)) {
    throw new RangeError(`strength must be in (0, ${DCT_MAX_STRENGTH}], got ${strength}`);
  }
}

/** Bits that fit into an image: one per whole 8 x 8 block. */
export function dctCapacityBits(width: number, height: number): number {
  assertDimensions(width, height);
  return Math.floor(width / BLOCK) * Math.floor(height / BLOCK);
}

function assertBitCount(image: RgbaPixels, bitCount: number): void {
  const pixels = assertDimensions(image.width, image.height);
  assertLength("data", image.data.length, pixels * 4);
  const capacity = dctCapacityBits(image.width, image.height);
  if (bitCount > capacity) {
    throw new RangeError(`${bitCount} bits exceed the capacity of ${capacity}`);
  }
}

/**
 * Returns a copy of `image` with `bits` (lowest bit of each element) in its first blocks, one per
 * 8 x 8 luminance block, row-major. Alpha and pixels outside whole blocks are copied. The result
 * reads back exactly: blocks that rounding or clipping would spoil are redone with a larger margin.
 */
export function dctEmbed(
  image: RgbaPixels,
  pair: DctPair,
  strength: number,
  bits: Uint8Array,
): RgbaPixels & { data: Uint8ClampedArray } {
  assertKochZhao(pair, strength);
  assertBitCount(image, bits.length);
  const { width, height } = image;
  const data = new Uint8ClampedArray(image.data.length);
  const [[u1, v1], [u2, v2]] = pair;
  check(
    "dctEmbed",
    native().stego_dct_embed(
      ...arg(image.data),
      width,
      height,
      u1,
      v1,
      u2,
      v2,
      strength,
      ...arg(bits),
      ...arg(new Float64Array(SCRATCH_DOUBLES)),
      ...arg(data),
    ),
  );
  return { width, height, data };
}

/** Reads the first `bitCount` bits written by `dctEmbed`, one per element (0 or 1). */
export function dctExtract(image: RgbaPixels, pair: DctPair, bitCount: number): Uint8Array {
  assertKochZhao(pair, 1);
  if (!Number.isInteger(bitCount) || bitCount < 0) {
    throw new RangeError(`bitCount must be a non-negative integer, got ${bitCount}`);
  }
  assertBitCount(image, bitCount);
  const bits = new Uint8Array(bitCount);
  const [[u1, v1], [u2, v2]] = pair;
  check(
    "dctExtract",
    native().stego_dct_extract(
      ...arg(image.data),
      image.width,
      image.height,
      u1,
      v1,
      u2,
      v2,
      ...arg(bits),
      ...arg(new Float64Array(SCRATCH_DOUBLES)),
    ),
  );
  return bits;
}
