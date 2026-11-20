import { describe, expect, test } from "bun:test";
import { lsbCapacityBits, lsbEmbed, lsbExtract } from "../src/index.ts";
import { native } from "../src/library.ts";
import { lsbEmbedOracle, lsbExtractOracle } from "./oracle/lsb.ts";
import { randomBytes } from "./random.ts";

const image = (width: number, height: number, seed?: number) => ({
  width,
  height,
  data: randomBytes(width * height * 4, seed),
});

const randomBits = (count: number, seed?: number) =>
  Uint8Array.from(randomBytes(count, seed), (byte) => byte & 1);

describe("lsbEmbed / lsbExtract", () => {
  test.each([1, 2, 3, 4, 7, 8])(
    "matches the TS oracle bit for bit with %i bit(s) per channel",
    (k) => {
      const cover = image(37, 23);
      const capacity = lsbCapacityBits(37, 23, k);
      for (const count of [0, 1, k * 3 + 1, capacity - 5, capacity]) {
        const bits = randomBits(count, count + 1);
        const stego = lsbEmbed(cover, k, bits);
        expect(stego.data).toEqual(lsbEmbedOracle(cover, k, bits).data);
        expect(lsbExtract(stego, k, capacity)).toEqual(lsbExtractOracle(stego, k, capacity));
        expect(lsbExtract(stego, k, count)).toEqual(bits);
      }
    },
  );

  test("touches only the low bits of R, G and B and leaves alpha alone", () => {
    const cover = image(16, 16);
    const stego = lsbEmbed(cover, 2, randomBits(lsbCapacityBits(16, 16, 2)));
    for (let i = 0; i < cover.data.length; i++) {
      const before = cover.data[i] as number;
      const after = stego.data[i] as number;
      if (i % 4 === 3) expect(after).toBe(before);
      else expect(after >> 2).toBe(before >> 2);
    }
  });

  test("fills each channel MSB first", () => {
    const cover = { width: 1, height: 1, data: Uint8ClampedArray.of(0, 0, 0, 200) };
    const stego = lsbEmbed(cover, 3, Uint8Array.of(1, 0, 0, 0, 1, 1, 1));
    expect(Array.from(stego.data)).toEqual([0b100, 0b011, 0b100, 200]);
  });

  test("uses only the lowest bit of each input element", () => {
    const cover = image(2, 1);
    expect(lsbEmbed(cover, 1, Uint8Array.of(3, 2, 255)).data).toEqual(
      lsbEmbed(cover, 1, Uint8Array.of(1, 0, 1)).data,
    );
  });

  test("does not mutate its input", () => {
    const cover = image(8, 8);
    const copy = cover.data.slice();
    const bits = randomBits(100);
    const bitsCopy = bits.slice();
    lsbExtract(lsbEmbed(cover, 1, bits), 1, 100);
    expect(cover.data).toEqual(copy);
    expect(bits).toEqual(bitsCopy);
  });

  test("handles the largest image the limits allow", () => {
    const cover = { width: 4096, height: 4096, data: new Uint8ClampedArray(4096 * 4096 * 4) };
    const capacity = lsbCapacityBits(4096, 4096, 1);
    const bits = randomBits(capacity);
    const extracted = lsbExtract(lsbEmbed(cover, 1, bits), 1, capacity);
    expect(Buffer.from(extracted.buffer).equals(Buffer.from(bits.buffer))).toBe(true);
  });
});

describe("client validation", () => {
  test.each([0, 9, 1.5, Number.NaN])("rejects %p bits per channel", (k) => {
    expect(() => lsbCapacityBits(4, 4, k)).toThrow(RangeError);
    expect(() => lsbEmbed(image(2, 2), k, new Uint8Array(1))).toThrow(RangeError);
    expect(() => lsbExtract(image(2, 2), k, 1)).toThrow(RangeError);
  });

  test("rejects one bit more than the capacity", () => {
    const capacity = lsbCapacityBits(3, 2, 2);
    expect(capacity).toBe(36);
    expect(() => lsbEmbed(image(3, 2), 2, new Uint8Array(capacity + 1))).toThrow(RangeError);
    expect(() => lsbExtract(image(3, 2), 2, capacity + 1)).toThrow(RangeError);
  });

  test.each([-1, 1.5, Number.NaN])("rejects a bit count of %p", (count) => {
    expect(() => lsbExtract(image(2, 2), 1, count)).toThrow(RangeError);
  });

  test("rejects bad dimensions and a data length that does not match them", () => {
    expect(() => lsbCapacityBits(0, 1, 1)).toThrow(RangeError);
    expect(() => lsbEmbed({ ...image(2, 2), width: 3 }, 1, new Uint8Array(1))).toThrow(
      "data must have 24",
    );
  });
});

describe("C-side validation (bypassing the client)", () => {
  const rgba = new Uint8Array(16);
  const out = new Uint8Array(16);

  const embed = (width: number, k: number, bits: Uint8Array, output = out) =>
    native().stego_lsb_embed(rgba, rgba, width, 2, k, bits, bits, output, output);
  const extract = (width: number, k: number, bits: Uint8Array) =>
    native().stego_lsb_extract(rgba, rgba, width, 2, k, bits, bits);

  test("accepts consistent arguments, including no bits", () => {
    expect(embed(2, 1, new Uint8Array(12))).toBe(0);
    expect(embed(2, 1, new Uint8Array(0))).toBe(0);
    expect(extract(2, 8, new Uint8Array(96))).toBe(0);
    expect(extract(2, 1, new Uint8Array(0))).toBe(0);
  });

  test("reports an out-of-range bits per channel", () => {
    expect(embed(2, 0, new Uint8Array(1))).toBe(-4);
    expect(extract(2, 9, new Uint8Array(1))).toBe(-4);
  });

  test("reports invalid dimensions", () => {
    expect(embed(0, 1, new Uint8Array(1))).toBe(-2);
    expect(extract(16385, 1, new Uint8Array(1))).toBe(-2);
  });

  test("reports more bits than fit and mismatched image buffers", () => {
    expect(embed(2, 1, new Uint8Array(13))).toBe(-3);
    expect(extract(2, 1, new Uint8Array(13))).toBe(-3);
    expect(embed(3, 1, new Uint8Array(1))).toBe(-3);
    expect(embed(2, 1, new Uint8Array(1), new Uint8Array(15))).toBe(-3);
  });
});
