import type { ConfiguredMethod } from "../types.ts";

/**
 * A forward error-correcting code over bits (values 0/1). Codewords are independent and laid out
 * one after another, so the code of a prefix of the data is a prefix of the code.
 */
export interface ErrorCorrectingCode {
  /** Coded bits needed to carry `dataBits` data bits. */
  codeBits(dataBits: number): number;
  /** Most data bits that fit in `codeBits` coded bits. */
  dataBits(codeBits: number): number;
  /** Returns `codeBits(bits.length)` coded bits. */
  encode(bits: Uint8Array): Uint8Array;
  /** Corrects what it can and returns the first `dataBits` data bits. */
  decode(code: Uint8Array, dataBits: number): Uint8Array;
}

function assertWithin(bitCount: number, capacity: number): void {
  if (bitCount > capacity) {
    throw new RangeError(`${bitCount} bits exceed the capacity of ${capacity} bits`);
  }
}

/**
 * `method` with `code` applied to every bit it embeds. Capacity shrinks by the code rate, so the
 * codec's `capacity` reports message bytes after both the code and the frame overhead.
 */
export function withErrorCorrection(
  method: ConfiguredMethod,
  code: ErrorCorrectingCode,
): ConfiguredMethod {
  const capacityBits = (width: number, height: number) =>
    code.dataBits(method.capacityBits(width, height));
  return {
    id: method.id,
    capacityBits,
    embed: (image, bits) => {
      assertWithin(bits.length, capacityBits(image.width, image.height));
      return method.embed(image, code.encode(bits));
    },
    extract: (image, bitCount) => {
      assertWithin(bitCount, capacityBits(image.width, image.height));
      return code.decode(method.extract(image, code.codeBits(bitCount)), bitCount);
    },
  };
}
