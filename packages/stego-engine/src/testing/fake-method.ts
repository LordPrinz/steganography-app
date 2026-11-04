import { type ConfiguredMethod, MethodId, type RgbaImage } from "../types.ts";

/**
 * Test-only stand-in until the real methods land: bit i goes into the lowest bit of the i-th
 * colour byte (R, G, B; alpha is skipped). It stays in TypeScript because it never runs in production.
 */
export function fakeMethod(id: MethodId = MethodId.Lsb): ConfiguredMethod {
  const capacityBits = (width: number, height: number) => width * height * 3;
  const offset = (bit: number) => Math.floor(bit / 3) * 4 + (bit % 3);

  return {
    id,
    capacityBits,
    embed(image: RgbaImage, bits: Uint8Array): RgbaImage {
      if (bits.length > capacityBits(image.width, image.height)) {
        throw new RangeError(`${bits.length} bits exceed the capacity`);
      }
      const data = new Uint8ClampedArray(image.data);
      for (let i = 0; i < bits.length; i++) {
        const at = offset(i);
        data[at] = ((data[at] as number) & 0xfe) | ((bits[i] as number) & 1);
      }
      return { width: image.width, height: image.height, data };
    },
    extract(image: RgbaImage, bitCount: number): Uint8Array {
      if (bitCount > capacityBits(image.width, image.height)) {
        throw new RangeError(`${bitCount} bits exceed the capacity`);
      }
      const bits = new Uint8Array(bitCount);
      for (let i = 0; i < bitCount; i++) bits[i] = (image.data[offset(i)] as number) & 1;
      return bits;
    },
  };
}

/** Same embedding as `method`, but writes frames under another method id. */
export function withId(method: ConfiguredMethod, id: MethodId): ConfiguredMethod {
  return {
    id,
    capacityBits: (width, height) => method.capacityBits(width, height),
    embed: (image, bits) => method.embed(image, bits),
    extract: (image, bitCount) => method.extract(image, bitCount),
  };
}
