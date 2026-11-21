import { describe, expect, test } from "bun:test";
import type { DwtQimParams } from "@stego/native";
import { hide, reveal } from "../codec.ts";
import { noiseImage } from "../testing/images.ts";
import { describeMethodContract } from "../testing/method-contract.ts";
import { MethodId } from "../types.ts";
import { dwtQim } from "./dwt-qim.ts";

// Level 1 runs in the shared suites (testing/methods.ts); deeper levels have too little capacity
// for the codec suite's large image.
describeMethodContract([
  { name: "dwt-qim LL level 2, step 32", method: dwtQim({ band: "LL", level: 2, step: 32 }) },
  { name: "dwt-qim HL level 2, step 32", method: dwtQim({ band: "HL", level: 2, step: 32 }) },
  { name: "dwt-qim LH level 3, step 48", method: dwtQim({ band: "LH", level: 3, step: 48 }) },
]);

describe("dwtQim", () => {
  test.each<DwtQimParams>([
    { band: "LL", level: 0, step: 24 },
    { band: "LL", level: 9, step: 24 },
    { band: "LL", level: 1, step: 0 },
    { band: "HH" as DwtQimParams["band"], level: 1, step: 24 },
  ])("rejects %o when configured", (params) => {
    expect(() => dwtQim(params)).toThrow(RangeError);
  });

  test("holds one bit per coefficient of the chosen level", () => {
    const method = dwtQim({ band: "HL", level: 2, step: 32 });
    expect(method.capacityBits(10, 9)).toBe(2 * 2);
    expect(method.capacityBits(64, 64)).toBe(16 * 16);
    expect(method.id).toBe(MethodId.DwtQim);
  });

  test("a message hidden in one band does not reveal from another", () => {
    const stego = hide(noiseImage(96, 96), "secret", dwtQim({ band: "LL", level: 1, step: 24 }));
    expect(reveal(stego, dwtQim({ band: "HL", level: 1, step: 24 })).ok).toBe(false);
  });

  test("embed throws when a bit cannot survive rounding to 8 bits", () => {
    const method = dwtQim({ band: "LL", level: 3, step: 1 });
    const bits = Uint8Array.from(noiseImage(64, 1).data.subarray(0, 64), (byte) => byte & 1);
    expect(() => method.embed(noiseImage(64, 64), bits)).toThrow("cannot survive");
  });
});
