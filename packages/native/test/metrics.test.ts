import { describe, expect, test } from "bun:test";
import { bitErrors, lumaMse, lumaSsim, rgbaToYcbcr } from "../src/index.ts";
import { native } from "../src/library.ts";
import { bitErrorsOracle, lumaMseOracle, lumaSsimOracle } from "./oracle/metrics.ts";
import { randomBytes } from "./random.ts";

const random = (width: number, height: number, seed?: number) => ({
  width,
  height,
  data: randomBytes(width * height * 4, seed),
});

/** Channel c of pixel (x, y) is (7x + 3y + 40c) mod 256; alpha follows the same rule. */
function gradient(width: number, height: number) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 4; c++) data[(y * width + x) * 4 + c] = (x * 7 + y * 3 + c * 40) % 256;
    }
  }
  return { width, height, data };
}

/** Adds noise in -amp..amp to every channel, clamped to 0..255. */
function noisy(image: ReturnType<typeof random>, seed: number, amp: number) {
  const noise = randomBytes(image.data.length, seed);
  const data = new Uint8ClampedArray(image.data.length);
  for (let i = 0; i < data.length; i++) {
    data[i] = (image.data[i] as number) + ((noise[i] as number) % (2 * amp + 1)) - amp;
  }
  return { ...image, data };
}

const psnrOf = (mse: number) => 10 * Math.log10((255 * 255) / mse);

/*
 * Reference values from scikit-image 0.26.0 (numpy 2.5.5) on the same images, rebuilt in Python
 * with the same xorshift generator and luminance rounded to float32:
 *   structural_similarity(ya, yb, data_range=255, gaussian_weights=True, sigma=1.5,
 *                         use_sample_covariance=False)
 *   peak_signal_noise_ratio(ya, yb, data_range=255)
 */
const references = [
  {
    name: "random vs noisy (±10)",
    a: random(32, 24, 1),
    b: noisy(random(32, 24, 1), 2, 10),
    ssim: 0.9964761047233989,
    psnr: 36.044258432922014,
  },
  {
    name: "gradient vs noisy (±3)",
    a: gradient(32, 24),
    b: noisy(gradient(32, 24), 3, 3),
    ssim: 0.9942641855837825,
    psnr: 45.31138265814603,
  },
  {
    name: "gradient vs random",
    a: gradient(32, 24),
    b: random(32, 24, 1),
    ssim: -0.02380079335172043,
    psnr: 10.780232788293041,
  },
  {
    name: "11 x 11 gradient vs noisy (±20)",
    a: gradient(11, 11),
    b: noisy(gradient(11, 11), 4, 20),
    ssim: 0.7902331120970618,
    psnr: 29.740901942537885,
  },
];

describe("lumaMse", () => {
  test.each([
    [1, 1],
    [7, 1],
    [37, 23],
  ])("matches the TS oracle bit for bit on %ix%i", (width, height) => {
    const a = random(width, height, 5);
    const b = random(width, height, 6);
    expect(lumaMse(a, b)).toBe(lumaMseOracle(a, b));
  });

  test("uses the Y plane of rgbaToYcbcr and ignores alpha", () => {
    const a = random(9, 4, 7);
    const b = random(9, 4, 8);
    const ya = rgbaToYcbcr(a).y;
    const yb = rgbaToYcbcr(b).y;
    let sum = 0;
    for (let i = 0; i < ya.length; i++) sum += ((ya[i] as number) - (yb[i] as number)) ** 2;
    expect(lumaMse(a, b)).toBe(sum / ya.length);

    const alphaOnly = { ...a, data: a.data.map((v, i) => (i % 4 === 3 ? 255 - v : v)) };
    expect(lumaMse(a, alphaOnly)).toBe(0);
  });

  test.each(references)("gives the scikit-image PSNR for $name", ({ a, b, psnr }) => {
    expect(psnrOf(lumaMse(a, b))).toBeCloseTo(psnr, 10);
  });
});

describe("lumaSsim", () => {
  test.each(references)("matches scikit-image for $name", ({ a, b, ssim }) => {
    expect(lumaSsim(a, b)).toBeCloseTo(ssim, 12);
  });

  test.each([
    [11, 11],
    [12, 30],
    [40, 13],
  ])("matches the naive TS oracle on %ix%i", (width, height) => {
    const a = random(width, height, 9);
    const b = noisy(a, 10, 30);
    expect(lumaSsim(a, b)).toBeCloseTo(lumaSsimOracle(a, b), 12);
  });

  test("is exactly 1 for identical luminance, also on flat images", () => {
    const image = random(20, 15);
    expect(lumaSsim(image, { ...image, data: image.data.slice() })).toBe(1);
    const flat = { width: 11, height: 11, data: new Uint8ClampedArray(11 * 11 * 4).fill(90) };
    expect(lumaSsim(flat, flat)).toBe(1);
  });

  test("handles the largest image the limits allow", () => {
    const a = { width: 4096, height: 4096, data: new Uint8ClampedArray(4096 * 4096 * 4) };
    expect(lumaSsim(a, a)).toBe(1);
  });
});

describe("bitErrors", () => {
  test("matches the TS oracle and compares only the lowest bit", () => {
    const a = randomBytes(1000, 11);
    const b = randomBytes(1000, 12);
    const ua = new Uint8Array(a);
    const ub = new Uint8Array(b);
    expect(bitErrors(ua, ub)).toBe(bitErrorsOracle(ua, ub));
    expect(bitErrors(Uint8Array.of(1, 0, 3, 2), Uint8Array.of(1, 1, 1, 0))).toBe(1);
    expect(bitErrors(new Uint8Array(0), new Uint8Array(0))).toBe(0);
  });
});

describe("client validation", () => {
  test("rejects images of different sizes", () => {
    expect(() => lumaMse(random(4, 4), random(4, 5))).toThrow(RangeError);
    expect(() => lumaSsim(random(12, 12), random(11, 12))).toThrow("same size");
  });

  test("rejects a data length that does not match the dimensions", () => {
    expect(() => lumaMse({ ...random(2, 2), width: 3 }, random(3, 2))).toThrow(
      "a.data must have 24",
    );
  });

  test.each([
    [10, 11],
    [11, 10],
    [1, 1],
  ])("rejects SSIM on %ix%i, smaller than one window", (width, height) => {
    expect(() => lumaSsim(random(width, height), random(width, height))).toThrow(
      "SSIM needs at least 11x11",
    );
  });

  test("rejects bit arrays of different lengths", () => {
    expect(() => bitErrors(new Uint8Array(3), new Uint8Array(4))).toThrow(RangeError);
  });
});

describe("C-side validation (bypassing the client)", () => {
  const a = new Uint8Array(11 * 11 * 4);
  const out = new Float64Array(1);

  test("reports mismatched lengths and dimensions", () => {
    expect(native().stego_luma_mse(a, a, a, a, 11, 11, out, out)).toBe(0);
    expect(native().stego_luma_mse(a, a, a.subarray(1), a.subarray(1), 11, 11, out, out)).toBe(-3);
    expect(native().stego_luma_mse(a, a, a, a, 11, 11, out, new Float32Array(1))).toBe(-3);
    expect(native().stego_luma_mse(a, a, a, a, 0, 11, out, out)).toBe(-2);
    expect(native().stego_luma_ssim(a, a, a, a, 11, 11, out, out)).toBe(0);
    expect(native().stego_luma_ssim(a, a, a, a, 10, 11, out, out)).toBe(-3);
    const small = a.subarray(44);
    expect(native().stego_luma_ssim(small, small, small, small, 10, 11, out, out)).toBe(-2);
  });

  test("reports bit arrays of different lengths", () => {
    const errors = new BigUint64Array(1);
    expect(native().stego_bit_errors(a, a, a, a, errors, errors)).toBe(0);
    expect(native().stego_bit_errors(a, a, a.subarray(1), a.subarray(1), errors, errors)).toBe(-3);
  });
});
