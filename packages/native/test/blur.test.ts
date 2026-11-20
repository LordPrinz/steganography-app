import { describe, expect, test } from "bun:test";
import { GAUSSIAN_MAX_SIGMA, gaussianBlur, gaussianKernel } from "../src/index.ts";
import { native } from "../src/library.ts";
import { blur2dOracle, blurOracle } from "./oracle/blur.ts";
import { randomBytes } from "./random.ts";

const image = (width: number, height: number, seed?: number) => ({
  width,
  height,
  data: randomBytes(width * height * 4, seed),
});

describe("gaussianKernel", () => {
  test.each([0.3, 1, 1.5, 4.2, GAUSSIAN_MAX_SIGMA])(
    "is normalised, symmetric and 2 * ceil(3 sigma) + 1 taps long for sigma %p",
    (sigma) => {
      const kernel = gaussianKernel(sigma);
      const radius = Math.ceil(3 * sigma);
      expect(kernel.length).toBe(2 * radius + 1);
      expect(kernel.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
      for (let i = 0; i < radius; i++) {
        expect(kernel[i]).toBe(kernel[kernel.length - 1 - i] as number);
        expect(kernel[i]).toBeLessThan(kernel[i + 1] as number);
      }
    },
  );

  test.each([0, -1, GAUSSIAN_MAX_SIGMA + 0.01, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects sigma %p",
    (sigma) => {
      expect(() => gaussianKernel(sigma)).toThrow(RangeError);
      expect(() => gaussianBlur(image(2, 2), sigma)).toThrow(RangeError);
    },
  );
});

describe("gaussianBlur", () => {
  test.each([
    [1, 1, 1],
    [1, 9, 0.8],
    [9, 1, 2],
    [37, 23, 1],
    [37, 23, 2.5],
    [16, 16, 7],
  ])("matches the TS oracle bit for bit on %ix%i with sigma %p", (width, height, sigma) => {
    const input = image(width, height, width * 31 + height);
    expect(gaussianBlur(input, sigma).data).toEqual(blurOracle(input, gaussianKernel(sigma)).data);
  });

  test("is within one level of a direct 2-D convolution", () => {
    const input = image(23, 17);
    const separable = gaussianBlur(input, 1.7).data;
    const direct = blur2dOracle(input, gaussianKernel(1.7)).data;
    for (let i = 0; i < separable.length; i++) {
      expect(Math.abs((separable[i] as number) - (direct[i] as number))).toBeLessThanOrEqual(1);
    }
  });

  test("keeps a flat image flat and leaves alpha alone", () => {
    const flat = { width: 9, height: 7, data: new Uint8ClampedArray(9 * 7 * 4) };
    for (let i = 0; i < flat.data.length; i += 4) flat.data.set([10, 128, 250, i % 256], i);
    expect(gaussianBlur(flat, 3).data).toEqual(flat.data);
  });

  test("smooths noise", () => {
    const input = image(64, 64);
    const variance = (data: Uint8ClampedArray) => {
      let sum = 0;
      let squares = 0;
      for (let i = 0; i < data.length; i += 4) {
        sum += data[i] as number;
        squares += (data[i] as number) ** 2;
      }
      const n = data.length / 4;
      return squares / n - (sum / n) ** 2;
    };
    expect(variance(gaussianBlur(input, 2).data)).toBeLessThan(variance(input.data) / 10);
  });

  test("does not mutate its input", () => {
    const input = image(8, 8);
    const copy = input.data.slice();
    gaussianBlur(input, 1);
    expect(input.data).toEqual(copy);
  });

  test("handles the largest image the limits allow", () => {
    const input = { width: 4096, height: 4096, data: new Uint8ClampedArray(4096 * 4096 * 4) };
    expect(gaussianBlur(input, 1).data.length).toBe(input.data.length);
  });

  test("rejects bad dimensions and a data length that does not match them", () => {
    expect(() => gaussianBlur({ ...image(2, 2), width: 0 }, 1)).toThrow(RangeError);
    expect(() => gaussianBlur({ ...image(2, 2), width: 3 }, 1)).toThrow("data must have 24");
  });
});

describe("C-side validation (bypassing the client)", () => {
  const rgba = new Uint8Array(16);
  const out = new Uint8Array(16);
  const blur = (
    width: number,
    kernel = Float64Array.of(0.25, 0.5, 0.25),
    scratch = new Float64Array(width * 3),
    output = out,
  ) =>
    native().stego_blur_separable(
      rgba,
      rgba,
      width,
      2,
      kernel,
      kernel,
      scratch,
      scratch,
      output,
      output,
    );

  test("accepts consistent arguments", () => {
    expect(blur(2)).toBe(0);
    expect(blur(2, Float64Array.of(1))).toBe(0);
  });

  test("reports an even or too long kernel", () => {
    expect(blur(2, new Float64Array(2))).toBe(-4);
    expect(blur(2, new Float64Array(257))).toBe(-4);
  });

  test("reports invalid dimensions", () => {
    expect(blur(0)).toBe(-2);
    expect(blur(16385, undefined, new Float64Array(6))).toBe(-2);
  });

  test("reports mismatched buffers", () => {
    expect(blur(3, undefined, new Float64Array(9))).toBe(-3);
    expect(blur(2, undefined, new Float64Array(5))).toBe(-3);
    expect(blur(2, undefined, undefined, new Uint8Array(15))).toBe(-3);
  });
});
