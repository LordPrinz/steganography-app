import { arg, assertDimensions, assertLength, type RgbaPixels } from "./image.ts";
import { native } from "./library.ts";
import { check } from "./status.ts";

/** Mirrors STEGO_DWT_LL, STEGO_DWT_HL and STEGO_DWT_LH in c/stego.h. */
export const DWT_BANDS = { LL: 0, HL: 1, LH: 2 } as const;
export type DwtBand = keyof typeof DWT_BANDS;

/** Mirrors STEGO_DWT_MAX_LEVEL in c/stego.h. */
export const DWT_MAX_LEVEL = 8;

/** Largest accepted step, mirrors MAX_STEP in c/dwt.c. */
export const DWT_MAX_STEP = 65536;

export interface DwtQimParams {
  readonly band: DwtBand;
  /** Decomposition level, 1–8. */
  readonly level: number;
  /** Quantisation step, above 0 and at most 65536. */
  readonly step: number;
}

/** Throws a RangeError unless the parameters are ones the kernels accept. */
export function assertDwtQimParams({ band, level, step }: DwtQimParams): void {
  if (!(band in DWT_BANDS)) throw new RangeError(`band must be LL, HL or LH, got ${band}`);
  if (!Number.isInteger(level) || level < 1 || level > DWT_MAX_LEVEL) {
    throw new RangeError(`level must be an integer in 1–${DWT_MAX_LEVEL}, got ${level}`);
  }
  if (!(step > 0 && step <= DWT_MAX_STEP)) {
    throw new RangeError(`step must be in (0, ${DWT_MAX_STEP}], got ${step}`);
  }
}

/** One bit per coefficient of a band; the region left of the last full 2^level block is unused. */
export function dwtQimCapacityBits(width: number, height: number, level: number): number {
  assertDwtQimParams({ band: "LL", level, step: 1 });
  assertDimensions(width, height);
  return (width >> level) * (height >> level);
}

function validate(image: RgbaPixels, params: DwtQimParams, bitCount: number): void {
  assertDwtQimParams(params);
  const pixels = assertDimensions(image.width, image.height);
  assertLength("data", image.data.length, pixels * 4);
  const capacity = dwtQimCapacityBits(image.width, image.height, params.level);
  if (bitCount > capacity)
    throw new RangeError(`${bitCount} bits exceed the capacity of ${capacity}`);
}

/** Double buffers the kernels use as working memory: the transform plane and one line. */
function workspace(width: number, height: number) {
  return {
    plane: new Float64Array(width * height),
    line: new Float64Array(Math.max(width, height)),
  };
}

export interface DwtQimEmbedded {
  readonly image: RgbaPixels & { data: Uint8ClampedArray };
  /** Bits that would still read back wrongly after rounding and clamping to 8 bits. */
  readonly failed: number;
}

/**
 * Hides `bits` (lowest bit of each element) in the Haar DWT of the luminance, one per coefficient
 * of the chosen band and level, in row-major order of the band. Returns a new image; `failed`
 * counts the bits that could not be made to survive the conversion back to 8-bit RGB (0 when the
 * step is large enough and the image is not saturated).
 */
export function dwtQimEmbed(
  image: RgbaPixels,
  params: DwtQimParams,
  bits: Uint8Array,
): DwtQimEmbedded {
  validate(image, params, bits.length);
  const { width, height } = image;
  const { plane, line } = workspace(width, height);
  const data = new Uint8ClampedArray(image.data.length);
  const failed = new BigUint64Array(1);
  check(
    "dwtQimEmbed",
    native().stego_dwt_qim_embed(
      ...arg(image.data),
      width,
      height,
      DWT_BANDS[params.band],
      params.level,
      params.step,
      ...arg(bits),
      ...arg(plane),
      ...arg(line),
      ...arg(data),
      ...arg(failed),
    ),
  );
  return { image: { width, height, data }, failed: Number(failed[0]) };
}

/** Reads the first `bitCount` bits written by `dwtQimEmbed`, one per element (0 or 1). */
export function dwtQimExtract(
  image: RgbaPixels,
  params: DwtQimParams,
  bitCount: number,
): Uint8Array {
  if (!Number.isInteger(bitCount) || bitCount < 0) {
    throw new RangeError(`bitCount must be a non-negative integer, got ${bitCount}`);
  }
  validate(image, params, bitCount);
  const { width, height } = image;
  const { plane, line } = workspace(width, height);
  const bits = new Uint8Array(bitCount);
  check(
    "dwtQimExtract",
    native().stego_dwt_qim_extract(
      ...arg(image.data),
      width,
      height,
      DWT_BANDS[params.band],
      params.level,
      params.step,
      ...arg(plane),
      ...arg(line),
      ...arg(bits),
    ),
  );
  return bits;
}
