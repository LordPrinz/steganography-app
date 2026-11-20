import { describe, expect, test } from "bun:test";
import { hide, reveal } from "../codec.ts";
import { noiseImage } from "../testing/images.ts";
import { MethodId } from "../types.ts";
import { lsb } from "./lsb.ts";

describe("lsb", () => {
  test.each([0, 9, 1.5])("rejects %p bits per channel when configured", (bitsPerChannel) => {
    expect(() => lsb({ bitsPerChannel })).toThrow(RangeError);
  });

  test("holds bitsPerChannel bits in each of R, G and B", () => {
    expect(lsb({ bitsPerChannel: 1 }).capacityBits(10, 4)).toBe(120);
    expect(lsb({ bitsPerChannel: 3 }).capacityBits(10, 4)).toBe(360);
    expect(lsb({ bitsPerChannel: 1 }).id).toBe(MethodId.Lsb);
  });

  test("a frame hidden with another bit depth does not reveal", () => {
    const stego = hide(noiseImage(32, 32), "secret", lsb({ bitsPerChannel: 1 }));
    expect(reveal(stego, lsb({ bitsPerChannel: 2 })).ok).toBe(false);
  });
});
