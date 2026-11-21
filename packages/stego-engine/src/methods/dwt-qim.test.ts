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

  test("rejects a step at or below 2^(level + 1)", () => {
    expect(() => dwtQim({ band: "LL", level: 2, step: 8 })).toThrow(RangeError);
    expect(() => dwtQim({ band: "LL", level: 1, step: 4 })).toThrow(RangeError);
    expect(() => dwtQim({ band: "LL", level: 2, step: 9 })).not.toThrow();
  });

  test.each([0, 255, 253])("embeds into a flat cover of %i", (value) => {
    const cover = {
      width: 128,
      height: 128,
      data: new Uint8ClampedArray(128 * 128 * 4).fill(value),
    };
    for (let i = 3; i < cover.data.length; i += 4) cover.data[i] = 255;
    const method = dwtQim({ band: "LL", level: 1, step: 48 });
    expect(reveal(hide(cover, "hello world", method), method)).toEqual({
      ok: true,
      message: "hello world",
    });
  });
});
