import { describe, expect, test } from "bun:test";
import { type Attack, Scenario } from "@stego/contracts";
import { gaussianBlur } from "@stego/native";
import { applyAttack, applyScenario } from "../src/attacks.ts";
import { decodeRgba, type RgbaImage } from "../src/png.ts";

const gradient = await decodeRgba(
  await Bun.file(new URL("./fixtures/gradient-64x48.png", import.meta.url)).bytes(),
);

/** Mean absolute difference over R, G and B. */
function meanError(a: RgbaImage, b: RgbaImage): number {
  let sum = 0;
  for (let i = 0; i < a.data.length; i++) {
    if (i % 4 !== 3) sum += Math.abs((a.data[i] as number) - (b.data[i] as number));
  }
  return sum / ((a.data.length / 4) * 3);
}

/** A 16 x 16 checkerboard of 1-pixel squares: the worst case for blur and downscaling. */
function checkerboard(): RgbaImage {
  const data = new Uint8ClampedArray(16 * 16 * 4);
  for (let i = 0; i < 16 * 16; i++) {
    const value = ((i % 16) + Math.floor(i / 16)) % 2 === 0 ? 0 : 255;
    data.set([value, value, value, 255], i * 4);
  }
  return { width: 16, height: 16, data };
}

describe("jpeg", () => {
  test("keeps the size and loses more at lower quality", async () => {
    const [q95, q20] = await Promise.all([
      applyAttack(gradient, { type: "jpeg", quality: 95 }),
      applyAttack(gradient, { type: "jpeg", quality: 20 }),
    ]);
    expect([q20.width, q20.height]).toEqual([64, 48]);
    expect(meanError(gradient, q95)).toBeLessThan(meanError(gradient, q20));
    expect(meanError(gradient, q20)).toBeGreaterThan(0);
  });

  test("rejects a quality outside 1–100", async () => {
    await expect(applyAttack(gradient, { type: "jpeg", quality: 0 })).rejects.toThrow(RangeError);
  });
});

describe("resize", () => {
  test("scales both sides and rounds to whole pixels", async () => {
    const half = await applyAttack(gradient, { type: "resize", scale: 0.5 });
    expect([half.width, half.height]).toEqual([32, 24]);
    const tiny = await applyAttack(gradient, { type: "resize", scale: 0.01 });
    expect([tiny.width, tiny.height]).toEqual([1, 1]);
  });

  test("is scaled back to the original size at the end of a scenario", async () => {
    const result = await applyScenario(gradient, [{ type: "resize", scale: 0.5 }]);
    expect([result.width, result.height]).toEqual([64, 48]);
    expect(meanError(gradient, result)).toBeLessThan(4);
  });
});

describe("blur", () => {
  test("is the native Gaussian blur", async () => {
    const blurred = await applyAttack(gradient, { type: "blur", sigma: 1.5 });
    expect(blurred.data).toEqual(gaussianBlur(gradient, 1.5).data);
  });

  test("flattens a checkerboard to grey away from the edges", async () => {
    const blurred = await applyAttack(checkerboard(), { type: "blur", sigma: 2 });
    for (let y = 6; y < 10; y++) {
      for (let x = 6; x < 10; x++) {
        expect(Math.abs((blurred.data[(y * 16 + x) * 4] as number) - 127.5)).toBeLessThan(2);
      }
    }
  });
});

describe("applyScenario", () => {
  test("returns the input unchanged for the empty baseline", async () => {
    expect(await applyScenario(gradient, [])).toBe(gradient);
  });

  test("runs a three-step chain in order and restores the size", async () => {
    const scenario = Scenario.parse(
      JSON.parse(
        JSON.stringify([
          { type: "resize", scale: 0.5 },
          { type: "jpeg", quality: 60 },
          { type: "blur", sigma: 1 },
        ] satisfies Attack[]),
      ),
    );

    let manual = gradient;
    for (const attack of scenario) manual = await applyAttack(manual, attack);
    expect([manual.width, manual.height]).toEqual([32, 24]);

    const result = await applyScenario(gradient, scenario);
    expect([result.width, result.height]).toEqual([64, 48]);
    expect(meanError(gradient, result)).toBeGreaterThan(0);
    expect(meanError(gradient, result)).toBeLessThan(8);
  });

  test("order matters: blurring before downscaling differs from blurring after", async () => {
    const image = checkerboard();
    const blurFirst = await applyScenario(image, [
      { type: "blur", sigma: 1 },
      { type: "resize", scale: 0.5 },
    ]);
    const resizeFirst = await applyScenario(image, [
      { type: "resize", scale: 0.5 },
      { type: "blur", sigma: 1 },
    ]);
    expect(blurFirst.data).not.toEqual(resizeFirst.data);
  });

  test("does not mutate its input", async () => {
    const copy = gradient.data.slice();
    await applyScenario(gradient, [
      { type: "blur", sigma: 2 },
      { type: "jpeg", quality: 50 },
    ]);
    expect(gradient.data).toEqual(copy);
  });
});
