/**
 * Reference Haar DWT + QIM. The transform uses the closed 2 x 2 formulas of the orthonormal Haar
 * step (LL = (a + b + c + d) / 2, ...) on fresh arrays instead of the in-place separable passes of
 * c/dwt.c, and the embedder is the same verify-and-correct loop written naively. Test-only.
 */
import { DWT_BANDS, type DwtBand, type DwtQimParams } from "../../src/dwt.ts";
import type { RgbaPixels } from "../../src/image.ts";

const MAX_PASSES = 16;

/** Mallat layout of the luminance after `level` Haar steps, `width` values per row. */
function haarForwardOracle(
  image: RgbaPixels,
  level: number,
): { plane: Float64Array; width: number } {
  const { width, height, data } = image;
  const plane = new Float64Array(width * height);
  let cw = (width >> level) << level;
  let ch = (height >> level) << level;
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const i = (y * width + x) * 4;
      plane[y * width + x] =
        0.299 * (data[i] as number) +
        0.587 * (data[i + 1] as number) +
        0.114 * (data[i + 2] as number);
    }
  }
  for (let l = 0; l < level; l++) {
    const source = Float64Array.from(plane);
    const at = (x: number, y: number) => source[y * width + x] as number;
    for (let y = 0; y < ch / 2; y++) {
      for (let x = 0; x < cw / 2; x++) {
        const a = at(2 * x, 2 * y);
        const b = at(2 * x + 1, 2 * y);
        const c = at(2 * x, 2 * y + 1);
        const d = at(2 * x + 1, 2 * y + 1);
        plane[y * width + x] = (a + b + c + d) / 2;
        plane[y * width + cw / 2 + x] = (a - b + c - d) / 2;
        plane[(ch / 2 + y) * width + x] = (a + b - c - d) / 2;
        plane[(ch / 2 + y) * width + cw / 2 + x] = (a - b - c + d) / 2;
      }
    }
    cw /= 2;
    ch /= 2;
  }
  return { plane, width };
}

/** Inverse of `haarForwardOracle` for a plane of the given size; returns luminance changes. */
function haarInverseOracle(
  plane: Float64Array,
  width: number,
  height: number,
  level: number,
): Float64Array {
  const out = Float64Array.from(plane);
  for (let l = level - 1; l >= 0; l--) {
    const cw = (width >> level) << (level - l);
    const ch = (height >> level) << (level - l);
    const source = Float64Array.from(out);
    for (let y = 0; y < ch / 2; y++) {
      for (let x = 0; x < cw / 2; x++) {
        const ll = source[y * width + x] as number;
        const hl = source[y * width + cw / 2 + x] as number;
        const lh = source[(ch / 2 + y) * width + x] as number;
        const hh = source[(ch / 2 + y) * width + cw / 2 + x] as number;
        out[2 * y * width + 2 * x] = (ll + hl + lh + hh) / 2;
        out[2 * y * width + 2 * x + 1] = (ll - hl + lh - hh) / 2;
        out[(2 * y + 1) * width + 2 * x] = (ll + hl - lh - hh) / 2;
        out[(2 * y + 1) * width + 2 * x + 1] = (ll - hl - lh + hh) / 2;
      }
    }
  }
  return out;
}

function bandOrigin(band: DwtBand, width: number, height: number, level: number) {
  return {
    x: band === "HL" ? width >> level : 0,
    y: band === "LH" ? height >> level : 0,
  };
}

function floorMod(value: number, step: number): number {
  return value - step * Math.floor(value / step);
}

function decode(value: number, step: number): number {
  const r = floorMod(value, step);
  return r >= step / 4 && r < (step * 3) / 4 ? 1 : 0;
}

/** Nearest lattice point of the bit; LL coefficients stay inside [0, 255 * 2^level]. */
function quantise(value: number, bit: number, step: number, band: DwtBand, level: number): number {
  const offset = bit ? step / 2 : 0;
  let q = Math.floor((value - offset) / step + 0.5) * step + offset;
  if (band === "LL") {
    const highest = 255 * 2 ** level;
    if (q > highest && q - step >= 0) q -= step;
    if (q < 0 && q + step <= highest) q += step;
  }
  return q;
}

export function dwtQimExtractOracle(image: RgbaPixels, params: DwtQimParams, bitCount: number) {
  const { width, height } = image;
  const { plane } = haarForwardOracle(image, params.level);
  const bandWidth = width >> params.level;
  const origin = bandOrigin(params.band, width, height, params.level);
  return Uint8Array.from({ length: bitCount }, (_, i) => {
    const x = origin.x + (i % bandWidth);
    const y = origin.y + Math.floor(i / bandWidth);
    return decode(plane[y * width + x] as number, params.step);
  });
}

export function dwtQimEmbedOracle(image: RgbaPixels, params: DwtQimParams, bits: Uint8Array) {
  const { width, height } = image;
  const { level, step } = params;
  const data = new Uint8ClampedArray(image.data);
  const bandWidth = width >> level;
  const origin = bandOrigin(params.band, width, height, level);
  const regionW = bandWidth << level;
  const regionH = (height >> level) << level;
  let failed = 0;
  if (bits.length === 0) return { data, failed };

  for (let pass = 0; ; pass++) {
    const { plane } = haarForwardOracle({ width, height, data }, level);
    const change = new Float64Array(width * height);
    let wrong = 0;
    bits.forEach((raw, i) => {
      const at = (origin.y + Math.floor(i / bandWidth)) * width + origin.x + (i % bandWidth);
      const bit = raw & 1;
      const bad = decode(plane[at] as number, step) !== bit;
      if (bad) wrong++;
      if (pass === 0 || bad)
        change[at] =
          quantise(plane[at] as number, bit, step, params.band, level) - (plane[at] as number);
    });
    if (pass > 0 && (wrong === 0 || pass === MAX_PASSES)) {
      failed = wrong;
      return { data, failed };
    }
    const delta = haarInverseOracle(change, width, height, level);
    for (let y = 0; y < regionH; y++) {
      for (let x = 0; x < regionW; x++) {
        const d = Math.floor((delta[y * width + x] as number) + 0.5);
        for (let c = 0; c < 3; c++) {
          const i = (y * width + x) * 4 + c;
          data[i] = (data[i] as number) + d;
        }
      }
    }
  }
}

export const ALL_BANDS = Object.keys(DWT_BANDS) as DwtBand[];
