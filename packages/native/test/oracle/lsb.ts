/**
 * Reference LSB embed / extract, one bit at a time. Same bit layout as c/lsb.c, written
 * independently of it. Test-only; never used at runtime.
 */
import type { RgbaPixels } from "../../src/image.ts";

/** Byte offset and bit position of bit `i` in an RGBA buffer. */
function locate(i: number, bitsPerChannel: number): [offset: number, shift: number] {
  const channel = Math.floor(i / bitsPerChannel);
  const pixel = Math.floor(channel / 3);
  return [pixel * 4 + (channel % 3), bitsPerChannel - 1 - (i % bitsPerChannel)];
}

export function lsbEmbedOracle(image: RgbaPixels, bitsPerChannel: number, bits: Uint8Array) {
  const data = new Uint8ClampedArray(image.data);
  for (let i = 0; i < bits.length; i++) {
    const [offset, shift] = locate(i, bitsPerChannel);
    const bit = (bits[i] as number) & 1;
    const cleared = (data[offset] as number) & ~(1 << shift);
    data[offset] = cleared | (bit << shift);
  }
  return { width: image.width, height: image.height, data };
}

export function lsbExtractOracle(image: RgbaPixels, bitsPerChannel: number, bitCount: number) {
  const bits = new Uint8Array(bitCount);
  for (let i = 0; i < bitCount; i++) {
    const [offset, shift] = locate(i, bitsPerChannel);
    bits[i] = ((image.data[offset] as number) >> shift) & 1;
  }
  return bits;
}
