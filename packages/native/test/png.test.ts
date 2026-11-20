import { describe, expect, test } from "bun:test";
import { PngFilter, pngFilter, pngUnfilter } from "../src/index.ts";
import { native } from "../src/library.ts";
import { pngFilterOracle, pngUnfilterOracle } from "./oracle/png.ts";
import { randomBytes } from "./random.ts";

const image = (width: number, height: number, seed?: number) => ({
  width,
  height,
  data: randomBytes(width * height * 4, seed),
});

const SHAPES = [
  [1, 1],
  [1, 5],
  [7, 1],
  [13, 7],
  [64, 48],
] as const;
const FILTERS = Object.values(PngFilter);

describe("pngFilter", () => {
  test.each(SHAPES.flatMap(([w, h]) => FILTERS.map((f) => [w, h, f] as const)))(
    "matches the TS oracle on %ix%i with filter %i",
    (width, height, filter) => {
      const input = image(width, height, width * 31 + height);
      expect(pngFilter(input, filter)).toEqual(pngFilterOracle(input, filter));
    },
  );

  test("adaptive filtering uses more than one filter on a photo-like image", () => {
    const width = 32;
    const height = 32;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      const x = i % width;
      const y = Math.floor(i / width);
      data.set([x * 8, y * 8, (x * y) & 0xff, y < 16 ? 255 : x * 8], i * 4);
    }
    const scanlines = pngFilter({ width, height, data });
    const used = new Set(Array.from({ length: height }, (_, y) => scanlines[y * (width * 4 + 1)]));
    expect(used.size).toBeGreaterThan(1);
  });

  test("rejects an unknown filter type", () => {
    expect(() => pngFilter(image(2, 2), 6 as PngFilter)).toThrow(RangeError);
  });
});

describe("pngUnfilter", () => {
  test.each(SHAPES.flatMap(([w, h]) => FILTERS.map((f) => [w, h, f] as const)))(
    "inverts pngFilter on %ix%i with filter %i",
    (width, height, filter) => {
      const input = image(width, height);
      expect(pngUnfilter(pngFilter(input, filter), width, height, 4).data).toEqual(input.data);
    },
  );

  test.each([3, 4] as const)("matches the TS oracle on random %i-channel scanlines", (channels) => {
    for (const [width, height] of SHAPES) {
      const scanlines = randomBytes((width * channels + 1) * height, width + height);
      for (let y = 0; y < height; y++) scanlines[y * (width * channels + 1)] = y % 5;
      const bytes = Uint8Array.from(scanlines);
      expect(pngUnfilter(bytes, width, height, channels).data).toEqual(
        pngUnfilterOracle(bytes, width, height, channels),
      );
    }
  });

  test("gives RGB pixels an opaque alpha channel", () => {
    const scanlines = Uint8Array.of(0, 1, 2, 3, 4, 5, 6, 1, 10, 20, 30, 1, 1, 1);
    expect(Array.from(pngUnfilter(scanlines, 2, 2, 3).data)).toEqual([
      1, 2, 3, 255, 4, 5, 6, 255, 10, 20, 30, 255, 11, 21, 31, 255,
    ]);
  });

  test("rejects an unknown filter type in any row", () => {
    const scanlines = new Uint8Array(3 * 9);
    scanlines[18] = 5;
    expect(() => pngUnfilter(scanlines, 2, 3, 4)).toThrow("row 2 has unknown filter type 5");
  });

  test("rejects a channel count other than 3 or 4", () => {
    expect(() => pngUnfilter(new Uint8Array(3), 1, 1, 2 as 3)).toThrow(RangeError);
  });

  test("rejects scanlines of the wrong length", () => {
    expect(() => pngUnfilter(new Uint8Array(8), 2, 1, 4)).toThrow("scanlines must have 9");
  });

  test("does not mutate its input", () => {
    const input = image(9, 4);
    const copy = input.data.slice();
    const scanlines = pngFilter(input);
    const filtered = scanlines.slice();
    pngUnfilter(scanlines, 9, 4, 4);
    expect(input.data).toEqual(copy);
    expect(scanlines).toEqual(filtered);
  });
});

describe("C-side validation (bypassing the client)", () => {
  const rgba = new Uint8Array(16);
  const scanlines = new Uint8Array(18);

  test("filter reports bad arguments", () => {
    const filter = (w: number, h: number, f: number, out = scanlines) =>
      native().stego_png_filter(rgba, rgba, w, h, f, out, out);
    expect(filter(2, 2, 5)).toBe(0);
    expect(filter(2, 2, 6)).toBe(-4);
    expect(filter(0, 2, 0)).toBe(-2);
    expect(filter(4, 1, 0)).toBe(-3);
    expect(filter(2, 2, 0, new Uint8Array(17))).toBe(-3);
  });

  test("unfilter reports bad arguments", () => {
    const unfilter = (w: number, h: number, channels: number, input = scanlines) =>
      native().stego_png_unfilter(input, input, w, h, channels, rgba, rgba);
    expect(unfilter(2, 2, 4)).toBe(0);
    expect(unfilter(2, 2, 2)).toBe(-4);
    expect(unfilter(2, 2, 3)).toBe(-3);
    expect(unfilter(16385, 1, 4)).toBe(-2);
    const bad = scanlines.slice();
    bad[9] = 7;
    expect(unfilter(2, 2, 4, bad)).toBe(-4);
  });
});
