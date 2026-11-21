import { describe, expect, test } from "bun:test";
import { type DctPair, dctCapacityBits, dctEmbed, dctExtract } from "../src/index.ts";
import { native } from "../src/library.ts";
import { dctEmbedOracle, dctExtractOracle } from "./oracle/dct.ts";
import { randomBytes } from "./random.ts";

const image = (width: number, height: number, seed?: number) => ({
  width,
  height,
  data: randomBytes(width * height * 4, seed),
});

/** Smooth gradient, so most blocks need real work to reach the margin. */
const gradient = (width: number, height: number, fill?: number) => {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const value = fill ?? ((i % width) * 3 + Math.floor(i / width)) % 256;
    data.set([value, value, value, 255], i * 4);
  }
  return { width, height, data };
};

/** A gradient with 2 bits of noise: exactly flat or linear blocks have coefficients of 0 up to
 * rounding error, whose sign differs between implementations. */
const noisyGradient = (width: number, height: number) => {
  const cover = gradient(width, height);
  const noise = randomBytes(width * height);
  for (let i = 0; i < width * height * 4; i++) {
    if (i % 4 !== 3) cover.data[i] = (cover.data[i] as number) + ((noise[i >> 2] as number) & 3);
  }
  return cover;
};

const randomBits = (count: number, seed?: number) =>
  Uint8Array.from(randomBytes(count, seed), (byte) => byte & 1);

const pairs: DctPair[] = [
  [
    [4, 1],
    [3, 2],
  ],
  [
    [1, 2],
    [2, 1],
  ],
  [
    [0, 3],
    [7, 7],
  ],
];

describe("dctEmbed / dctExtract", () => {
  test.each(pairs.map((p) => [p] as const))("matches the TS oracle for pair %p", (pair) => {
    for (const cover of [image(45, 29), image(16, 8), noisyGradient(40, 24)]) {
      const capacity = dctCapacityBits(cover.width, cover.height);
      const bits = randomBits(capacity, capacity + 7);
      const stego = dctEmbed(cover, pair, 25, bits);
      expect(stego.data).toEqual(dctEmbedOracle(cover, pair, 25, bits).data);
      const read = dctExtract(stego, pair, capacity);
      expect(read).toEqual(bits);
      expect(read).toEqual(dctExtractOracle(stego, pair, capacity));
    }
  });

  test("recovers the bits exactly on noise, saturated and flat images at any strength", () => {
    const pair: DctPair = [
      [4, 1],
      [3, 2],
    ];
    for (const strength of [1, 10, 40, 200]) {
      for (const cover of [image(64, 40, strength), gradient(32, 32, 255), gradient(32, 32, 0)]) {
        const capacity = dctCapacityBits(cover.width, cover.height);
        for (const seed of [1, 2, 3]) {
          const bits = randomBits(capacity, seed);
          expect(dctExtract(dctEmbed(cover, pair, strength, bits), pair, capacity)).toEqual(bits);
        }
      }
    }
  });

  test("leaves alpha, pixels outside whole blocks and unused blocks untouched", () => {
    const pair = pairs[0] as DctPair;
    const cover = image(21, 19);
    const stego = dctEmbed(cover, pair, 30, randomBits(2));
    for (let y = 0; y < 19; y++) {
      for (let x = 0; x < 21; x++) {
        const inUsedBlock = y < 8 && x < 16;
        for (let c = 0; c < 4; c++) {
          const at = (y * 21 + x) * 4 + c;
          if (c === 3 || !inUsedBlock) expect(stego.data[at]).toBe(cover.data[at] as number);
        }
      }
    }
  });

  test("changes only luminance: chroma stays within rounding of the original", () => {
    const pair = pairs[0] as DctPair;
    const cover = gradient(32, 32);
    const stego = dctEmbed(cover, pair, 20, randomBits(16));
    for (let i = 0; i < 32 * 32; i++) {
      const [r, g, b] = [0, 1, 2].map(
        (c) => (stego.data[i * 4 + c] as number) - (cover.data[i * 4 + c] as number),
      );
      expect(Math.abs((r as number) - (g as number))).toBeLessThanOrEqual(1);
      expect(Math.abs((g as number) - (b as number))).toBeLessThanOrEqual(1);
    }
  });

  test("capacity is one bit per whole 8 x 8 block", () => {
    expect(dctCapacityBits(8, 8)).toBe(1);
    expect(dctCapacityBits(15, 16)).toBe(2);
    expect(dctCapacityBits(7, 100)).toBe(0);
  });

  test("does not mutate its input", () => {
    const cover = image(24, 24);
    const copy = cover.data.slice();
    const bits = randomBits(9);
    const bitsCopy = bits.slice();
    dctExtract(dctEmbed(cover, pairs[0] as DctPair, 20, bits), pairs[0] as DctPair, 9);
    expect(cover.data).toEqual(copy);
    expect(bits).toEqual(bitsCopy);
  });
});

describe("client validation", () => {
  const pair = pairs[0] as DctPair;

  test.each([
    [
      [
        [0, 0],
        [1, 1],
      ],
      10,
    ],
    [
      [
        [1, 1],
        [1, 1],
      ],
      10,
    ],
    [
      [
        [8, 1],
        [1, 1],
      ],
      10,
    ],
    [
      [
        [1, 1.5],
        [2, 1],
      ],
      10,
    ],
    [
      [
        [1, 1],
        [2, 1],
      ],
      0,
    ],
    [
      [
        [1, 1],
        [2, 1],
      ],
      Number.NaN,
    ],
    [
      [
        [1, 1],
        [2, 1],
      ],
      1025,
    ],
  ] as [DctPair, number][])("rejects pair %p with strength %p", (badPair, strength) => {
    expect(() => dctEmbed(image(8, 8), badPair, strength, new Uint8Array(1))).toThrow(RangeError);
  });

  test("rejects one bit more than the capacity", () => {
    expect(() => dctEmbed(image(16, 8), pair, 10, new Uint8Array(3))).toThrow(RangeError);
    expect(() => dctExtract(image(16, 8), pair, 3)).toThrow(RangeError);
    expect(() => dctExtract(image(16, 8), pair, -1)).toThrow(RangeError);
  });
});

describe("C-side validation (bypassing the client)", () => {
  const rgba = new Uint8Array(16 * 16 * 4);
  const out = new Uint8Array(16 * 16 * 4);
  const scratch = new Float64Array(128);
  const bits = new Uint8Array(4);

  const embed = (
    over: { u2?: number; strength?: number; count?: Uint8Array; width?: number } = {},
  ) =>
    native().stego_dct_embed(
      rgba,
      rgba,
      over.width ?? 16,
      16,
      1,
      1,
      over.u2 ?? 2,
      1,
      over.strength ?? 10,
      over.count ?? bits,
      over.count ?? bits,
      scratch,
      scratch,
      out,
      out,
    );

  test("accepts consistent arguments", () => {
    expect(embed()).toBe(0);
    expect(embed({ count: new Uint8Array(0) })).toBe(0);
  });

  test("reports bad positions and strengths", () => {
    expect(embed({ u2: 1 })).toBe(-4);
    expect(embed({ u2: 8 })).toBe(-4);
    expect(embed({ strength: 0 })).toBe(-4);
    expect(embed({ strength: 1025 })).toBe(-4);
    expect(embed({ strength: Number.NaN })).toBe(-4);
  });

  test("rejects an output that overlaps the input", () => {
    const shared = new Uint8Array(16 * 16 * 4 + 1);
    const input = shared.subarray(0, 16 * 16 * 4);
    const shifted = shared.subarray(1);
    const run = (output: Uint8Array) =>
      native().stego_dct_embed(
        input,
        input,
        16,
        16,
        1,
        1,
        2,
        1,
        10,
        bits,
        bits,
        scratch,
        scratch,
        output,
        output,
      );
    expect(run(input)).toBe(-4);
    expect(run(shifted)).toBe(-4);
  });

  test("reports dimensions, capacity and buffer mismatches", () => {
    expect(embed({ width: 0 })).toBe(-2);
    expect(embed({ count: new Uint8Array(5) })).toBe(-3);
    expect(embed({ width: 15 })).toBe(-3);
    expect(
      native().stego_dct_extract(
        rgba,
        rgba,
        16,
        16,
        1,
        1,
        2,
        1,
        bits,
        bits,
        new Float64Array(127),
        new Float64Array(127),
      ),
    ).toBe(-3);
  });
});
