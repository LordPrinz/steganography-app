import { describe, expect, test } from "bun:test";
import { hide, reveal } from "../codec.ts";
import { noiseImage } from "../testing/images.ts";
import { MethodId } from "../types.ts";
import { kochZhao } from "./koch-zhao.ts";

const MESSAGE = "Koch-Zhao hides text in the DCT.";

describe("kochZhao", () => {
  test("holds one bit per whole 8 x 8 block", () => {
    const method = kochZhao();
    expect(method.id).toBe(MethodId.DctKochZhao);
    expect(method.capacityBits(384, 256)).toBe(48 * 32);
    expect(method.capacityBits(15, 17)).toBe(2);
    expect(method.capacityBits(7, 64)).toBe(0);
  });

  test.each([
    {
      pair: [
        [0, 0],
        [1, 1],
      ],
      strength: 30,
    },
    {
      pair: [
        [1, 1],
        [1, 1],
      ],
      strength: 30,
    },
    {
      pair: [
        [1, 1],
        [2, 8],
      ],
      strength: 30,
    },
    {
      pair: [
        [1, 2],
        [2, 1],
      ],
      strength: 0,
    },
  ] as const)("rejects the configuration %p", (params) => {
    expect(() => kochZhao(params)).toThrow(RangeError);
  });

  test("a frame hidden with another pair does not reveal", () => {
    const stego = hide(noiseImage(256, 128), MESSAGE, kochZhao());
    const other = kochZhao({
      pair: [
        [1, 2],
        [2, 1],
      ],
    });
    expect(reveal(stego, other).ok).toBe(false);
  });

  test("hides and reveals exactly in noise, including odd sizes", () => {
    const method = kochZhao();
    for (const cover of [noiseImage(256, 128), noiseImage(259, 133)]) {
      expect(reveal(hide(cover, MESSAGE, method), method)).toEqual({ ok: true, message: MESSAGE });
    }
  });
});
