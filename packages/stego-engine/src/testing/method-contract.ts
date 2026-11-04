import { describe, expect, test } from "bun:test";
import type { ConfiguredMethod } from "../types.ts";
import { noiseImage } from "./images.ts";

export interface MethodCase {
  readonly name: string;
  readonly method: ConfiguredMethod;
}

function randomBits(count: number): Uint8Array {
  return Uint8Array.from(noiseImage(count, 1).data.subarray(0, count), (byte) => byte & 1);
}

/**
 * Contract every configured method must honour; the stego codec relies on each point.
 * Run it for every method: `describeMethodContract(cases)`.
 */
export function describeMethodContract(cases: readonly MethodCase[]): void {
  describe.each(cases)("method contract: $name", ({ method }) => {
    const cover = noiseImage(37, 23);
    const capacity = method.capacityBits(cover.width, cover.height);

    test("round-trips exactly capacityBits bits", () => {
      const bits = randomBits(capacity);
      expect(method.extract(method.embed(cover, bits), capacity)).toEqual(bits);
    });

    test("rejects one bit more than capacityBits", () => {
      expect(() => method.embed(cover, new Uint8Array(capacity + 1))).toThrow(RangeError);
      expect(() => method.extract(cover, capacity + 1)).toThrow(RangeError);
    });

    test("extract(n) is a prefix of extract(m)", () => {
      const stego = method.embed(cover, randomBits(capacity));
      const all = method.extract(stego, capacity);
      for (const n of [0, 1, 64, Math.floor(capacity / 2)]) {
        expect(method.extract(stego, n)).toEqual(all.subarray(0, n));
      }
    });

    test("embed does not mutate its input and preserves dimensions", () => {
      const before = new Uint8ClampedArray(cover.data);
      const stego = method.embed(cover, randomBits(capacity));
      expect(cover.data).toEqual(before);
      expect(stego.width).toBe(cover.width);
      expect(stego.height).toBe(cover.height);
      expect(stego.data.length).toBe(cover.data.length);
    });
  });
}
