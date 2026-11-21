import { describe, expect, test } from "bun:test";
import {
  DWT_BANDS,
  type DwtBand,
  type DwtQimParams,
  dwtQimCapacityBits,
  dwtQimEmbed,
  dwtQimExtract,
} from "../src/index.ts";
import { ALL_BANDS, dwtQimEmbedOracle, dwtQimExtractOracle } from "./oracle/dwt.ts";
import { randomBytes } from "./random.ts";

const image = (width: number, height: number, seed?: number) => ({
  width,
  height,
  data: randomBytes(width * height * 4, seed),
});

const randomBits = (count: number, seed?: number) =>
  Uint8Array.from(randomBytes(count, seed), (byte) => byte & 1);

const params = (band: DwtBand, level: number, step = 40): DwtQimParams => ({ band, level, step });

describe("dwtQimEmbed / dwtQimExtract", () => {
  test.each(ALL_BANDS.flatMap((band) => [1, 2, 3].map((level) => [band, level] as const)))(
    "%s level %i matches the TS oracle and round-trips exactly",
    (band, level) => {
      // 45 x 29 is not a multiple of 2^level, so the untouched remainder is covered too.
      const cover = image(45, 29);
      const p = params(band, level);
      const capacity = dwtQimCapacityBits(45, 29, level);
      for (const count of [0, 1, capacity - 3, capacity]) {
        const bits = randomBits(count, count + 1);
        const { image: stego, failed } = dwtQimEmbed(cover, p, bits);
        const expected = dwtQimEmbedOracle(cover, p, bits);
        expect(failed).toBe(expected.failed);
        expect(stego.data).toEqual(expected.data);
        expect(dwtQimExtract(stego, p, count)).toEqual(bits);
        expect(dwtQimExtract(stego, p, capacity)).toEqual(dwtQimExtractOracle(stego, p, capacity));
      }
    },
  );

  test("leaves alpha and the pixels outside the transformed region unchanged", () => {
    const cover = image(45, 29);
    const level = 2;
    const stego = dwtQimEmbed(
      cover,
      params("LL", level),
      randomBits(dwtQimCapacityBits(45, 29, level)),
    ).image;
    const regionW = (45 >> level) << level;
    const regionH = (29 >> level) << level;
    for (let y = 0; y < 29; y++) {
      for (let x = 0; x < 45; x++) {
        const i = (y * 45 + x) * 4;
        expect(stego.data[i + 3]).toBe(cover.data[i + 3] as number);
        if (x >= regionW || y >= regionH) {
          expect(Array.from(stego.data.subarray(i, i + 3))).toEqual(
            Array.from(cover.data.subarray(i, i + 3)),
          );
        }
      }
    }
  });

  test("recovers bits from flat black, white and near-saturated covers at every step above the bound", () => {
    const lumas = [0, 1, 5, 20, 235, 245, 250, 252, 253, 254, 255];
    const steps = [12, 16, 24, 32, 48, 64, 96];
    for (const band of ALL_BANDS) {
      for (const level of [1, 2, 3]) {
        const bits = randomBits(Math.min(256, dwtQimCapacityBits(128, 128, level)), 7);
        for (const step of steps.filter((s) => s > 2 ** (level + 1))) {
          for (const luma of lumas) {
            const data = new Uint8ClampedArray(128 * 128 * 4).fill(luma);
            for (let i = 3; i < data.length; i += 4) data[i] = 255;
            const p = params(band, level, step);
            const { image: stego, failed } = dwtQimEmbed(
              { width: 128, height: 128, data },
              p,
              bits,
            );
            expect({ band, level, step, luma, failed }).toEqual({
              band,
              level,
              step,
              luma,
              failed: 0,
            });
            expect(dwtQimExtract(stego, p, bits.length)).toEqual(bits);
          }
        }
      }
    }
  });

  test("random near-saturated covers round-trip too", () => {
    for (const [low, span] of [
      [235, 20],
      [0, 20],
    ] as const) {
      const noise = randomBytes(64 * 64 * 4, low + 1);
      const data = Uint8ClampedArray.from(noise, (b, i) => (i % 4 === 3 ? 255 : low + (b % span)));
      for (const band of ALL_BANDS) {
        const p = params(band, 1, 24);
        const bits = randomBits(dwtQimCapacityBits(64, 64, 1), 9);
        const { image: stego, failed } = dwtQimEmbed({ width: 64, height: 64, data }, p, bits);
        expect(failed).toBe(0);
        expect(dwtQimExtract(stego, p, bits.length)).toEqual(bits);
      }
    }
  });

  test("counts the bits that cannot survive when the step is at or below 2^(level + 1)", () => {
    const cover = image(32, 32);
    const p = params("LL", 3, 1);
    const bits = randomBits(dwtQimCapacityBits(32, 32, 3));
    const { image: stego, failed } = dwtQimEmbed(cover, p, bits);
    const read = dwtQimExtract(stego, p, bits.length);
    const errors = read.reduce((sum, bit, i) => sum + (bit === bits[i] ? 0 : 1), 0);
    expect(errors).toBe(failed);
  });

  test("a 1 x 1 image has no capacity and is copied", () => {
    const cover = image(1, 1);
    expect(dwtQimCapacityBits(1, 1, 1)).toBe(0);
    const { image: stego, failed } = dwtQimEmbed(cover, params("LL", 1), new Uint8Array(0));
    expect(stego.data).toEqual(cover.data);
    expect(failed).toBe(0);
  });

  test("rejects more bits than the capacity, bad parameters and mismatched data", () => {
    const cover = image(8, 8);
    const capacity = dwtQimCapacityBits(8, 8, 2);
    expect(capacity).toBe(4);
    expect(() => dwtQimEmbed(cover, params("LL", 2), new Uint8Array(capacity + 1))).toThrow(
      RangeError,
    );
    expect(() => dwtQimExtract(cover, params("LL", 2), capacity + 1)).toThrow(RangeError);
    expect(() => dwtQimExtract(cover, params("LL", 2), -1)).toThrow(RangeError);
    for (const bad of [
      params("LL", 0),
      params("LL", 9),
      params("LL", 1.5),
      params("LL", 1, 0),
      params("LL", 1, Number.NaN),
      params("LL", 1, 65537),
      { band: "HH" as DwtBand, level: 1, step: 8 },
    ]) {
      expect(() => dwtQimExtract(cover, bad, 0)).toThrow(RangeError);
    }
    expect(() => dwtQimExtract({ ...cover, data: new Uint8Array(3) }, params("LL", 1), 0)).toThrow(
      RangeError,
    );
    expect(DWT_BANDS).toEqual({ LL: 0, HL: 1, LH: 2 });
  });
});
