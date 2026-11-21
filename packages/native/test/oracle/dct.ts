/**
 * Reference Koch–Zhao embed / extract written from the textbook DCT-II definition with Math.cos.
 * Same algorithm as c/dct.c, independent implementation. Test-only; never used at runtime.
 */
import type { DctPair } from "../../src/dct.ts";
import type { RgbaPixels } from "../../src/image.ts";

const ATTEMPTS = 6;

const alpha = (f: number) => Math.sqrt(f === 0 ? 1 / 8 : 2 / 8);

/** Basis function of frequency (u, v) at pixel (x, y) of a block. */
const basis = (u: number, v: number, x: number, y: number) =>
  alpha(u) *
  alpha(v) *
  Math.cos(((2 * x + 1) * u * Math.PI) / 16) *
  Math.cos(((2 * y + 1) * v * Math.PI) / 16);

const luma = (data: ArrayLike<number>, at: number) =>
  0.299 * (data[at] as number) +
  0.587 * (data[at + 1] as number) +
  0.114 * (data[at + 2] as number);

function coefficient(image: RgbaPixels, block: number, [u, v]: readonly [number, number]) {
  const perRow = Math.floor(image.width / 8);
  const x0 = (block % perRow) * 8;
  const y0 = Math.floor(block / perRow) * 8;
  let sum = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      sum += luma(image.data, ((y0 + y) * image.width + x0 + x) * 4) * basis(u, v, x, y);
    }
  }
  return sum;
}

export function dctExtractOracle(image: RgbaPixels, pair: DctPair, bitCount: number) {
  const bits = new Uint8Array(bitCount);
  for (let i = 0; i < bitCount; i++) {
    const [c1, c2] = [coefficient(image, i, pair[0]), coefficient(image, i, pair[1])];
    bits[i] = Math.abs(c1) > Math.abs(c2) ? 1 : 0;
  }
  return bits;
}

export function dctEmbedOracle(
  image: RgbaPixels,
  pair: DctPair,
  strength: number,
  bits: Uint8Array,
) {
  const data = new Uint8ClampedArray(image.data);
  const perRow = Math.floor(image.width / 8);
  for (let block = 0; block < bits.length; block++) {
    const bit = (bits[block] as number) & 1;
    const x0 = (block % perRow) * 8;
    const y0 = Math.floor(block / perRow) * 8;
    const c1 = coefficient(image, block, pair[0]);
    const c2 = coefficient(image, block, pair[1]);
    const a = Math.abs(c1);
    const b = Math.abs(c2);
    const satisfied = (bit ? a - b : b - a) >= strength;

    let margin = strength;
    for (let attempt = 0; attempt <= ATTEMPTS; attempt++, margin *= 2) {
      let hi = (a + b) / 2 + margin / 2;
      let lo = (a + b) / 2 - margin / 2;
      if (lo < 0) [hi, lo] = [margin, 0];
      const aNew = satisfied ? a : bit ? hi : lo;
      const bNew = satisfied ? b : bit ? lo : hi;
      const d1 = (c1 < 0 ? -aNew : aNew) - c1;
      const d2 = (c2 < 0 ? -bNew : bNew) - c2;
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          const at = ((y0 + y) * image.width + x0 + x) * 4;
          const d =
            d1 * basis(pair[0][0], pair[0][1], x, y) + d2 * basis(pair[1][0], pair[1][1], x, y);
          for (let c = 0; c < 3; c++) data[at + c] = (image.data[at + c] as number) + d;
        }
      }
      const out = { width: image.width, height: image.height, data };
      const [e1, e2] = [coefficient(out, block, pair[0]), coefficient(out, block, pair[1])];
      if (Math.abs(e1) > Math.abs(e2) === (bit === 1)) break;
    }
  }
  return { width: image.width, height: image.height, data };
}
