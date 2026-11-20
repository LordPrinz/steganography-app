/**
 * Contract every attack must honour. The sample map is keyed by attack type, so a new attack in the
 * `Attack` schema does not type-check until it has a sample here, and then runs this whole suite.
 */
import { describe, expect, test } from "bun:test";
import type { Attack, AttackType } from "@stego/contracts";
import { applyAttack, applyScenario } from "../src/attacks.ts";
import { decodeRgba, type RgbaImage } from "../src/png.ts";

const samples: { [T in AttackType]: Extract<Attack, { type: T }> } = {
  jpeg: { type: "jpeg", quality: 50 },
  resize: { type: "resize", scale: 0.5 },
  blur: { type: "blur", sigma: 1.5 },
};

const cover = await decodeRgba(
  await Bun.file(new URL("./fixtures/gradient-64x48.png", import.meta.url)).bytes(),
);

function expectValidImage(image: RgbaImage): void {
  expect(image.data).toBeInstanceOf(Uint8ClampedArray);
  expect(Number.isInteger(image.width) && image.width > 0).toBe(true);
  expect(Number.isInteger(image.height) && image.height > 0).toBe(true);
  expect(image.data.length).toBe(image.width * image.height * 4);
}

describe.each(Object.values(samples))("attack contract: $type", (attack) => {
  test("returns a valid RGBA image", async () => {
    expectValidImage(await applyAttack(cover, attack));
  });

  test("keeps the original size once run as a scenario", async () => {
    const result = await applyScenario(cover, [attack]);
    expectValidImage(result);
    expect([result.width, result.height]).toEqual([cover.width, cover.height]);
  });

  test("returns a new image and does not mutate its input", async () => {
    const copy = cover.data.slice();
    const result = await applyAttack(cover, attack);
    expect(result.data).not.toBe(cover.data);
    expect(cover.data).toEqual(copy);
  });
});
