import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { applyAttack, decodeRgba } from "@stego/image-io";
import { hide, measure, reveal } from "../codec.ts";
import { withErrorCorrection } from "../ecc/code.ts";
import { hamming74 } from "../ecc/hamming74.ts";
import { noiseImage } from "../testing/images.ts";
import { type ConfiguredMethod, MethodId } from "../types.ts";
import { kochZhao } from "./koch-zhao.ts";

const IMAGES = join(import.meta.dir, "..", "..", "bench", "images");
const natural = await Promise.all(
  readdirSync(IMAGES)
    .filter((name) => name.endsWith(".png"))
    .map(async (name) => decodeRgba(await Bun.file(join(IMAGES, name)).bytes())),
);

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

  test("hides and reveals exactly in photos and in noise, including odd sizes", () => {
    const method = kochZhao();
    for (const cover of [...natural, noiseImage(259, 133)]) {
      expect(reveal(hide(cover, MESSAGE, method), method)).toEqual({ ok: true, message: MESSAGE });
    }
  });
});

describe("kochZhao against JPEG (ADR 7)", () => {
  test("the defaults survive JPEG quality 75 on natural images", async () => {
    const method = kochZhao();
    for (const cover of natural) {
      const attacked = await applyAttack(hide(cover, MESSAGE, method), {
        type: "jpeg",
        quality: 75,
      });
      expect(measure(attacked, MESSAGE, method)).toEqual({ ok: true, ber: 0 });
    }
  });

  test("with Hamming(7,4) the defaults survive JPEG quality 50", async () => {
    const method = withErrorCorrection(kochZhao(), hamming74());
    for (const cover of natural) {
      const attacked = await applyAttack(hide(cover, MESSAGE, method), {
        type: "jpeg",
        quality: 50,
      });
      expect(reveal(attacked, method)).toEqual({ ok: true, message: MESSAGE });
    }
  });

  test("the strength decides survival: P = 10 loses clearly more bits than the default", async () => {
    const meanBer = async (method: ConfiguredMethod) => {
      let total = 0;
      for (const cover of natural) {
        const attacked = await applyAttack(hide(cover, MESSAGE, method), {
          type: "jpeg",
          quality: 75,
        });
        total += measure(attacked, MESSAGE, method).ber;
      }
      return total / natural.length;
    };
    expect(await meanBer(kochZhao({ strength: 10 }))).toBeGreaterThan(
      (await meanBer(kochZhao())) + 0.01,
    );
  });
});
