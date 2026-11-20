import { describe, expect, test } from "bun:test";
import { ber, hide, lsb, psnr, ssim } from "./index.ts";
import { noiseImage } from "./testing/images.ts";

function gradient(width: number, height: number) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 4; c++) data[(y * width + x) * 4 + c] = (x * 7 + y * 3 + c * 40) % 256;
    }
  }
  return { width, height, data };
}

describe("psnr", () => {
  test("is Infinity for identical images", () => {
    const image = noiseImage(16, 16);
    expect(psnr(image, { ...image, data: image.data.slice() })).toBe(Number.POSITIVE_INFINITY);
  });

  test("matches scikit-image (see packages/native/test/metrics.test.ts)", () => {
    expect(psnr(gradient(32, 24), noiseImage(32, 24, 1))).toBeCloseTo(10.780232788293041, 10);
  });

  test("stays high after hiding a message with one LSB per channel", () => {
    const cover = gradient(64, 64);
    const value = psnr(cover, hide(cover, "a short secret", lsb({ bitsPerChannel: 1 })));
    expect(value).toBeGreaterThan(50);
    expect(value).toBeLessThan(Number.POSITIVE_INFINITY);
  });

  test("rejects images of different sizes", () => {
    expect(() => psnr(noiseImage(4, 4), noiseImage(4, 5))).toThrow(RangeError);
  });
});

describe("ssim", () => {
  test("is 1 for identical images", () => {
    const image = noiseImage(16, 16);
    expect(ssim(image, { ...image, data: image.data.slice() })).toBe(1);
  });

  test("matches scikit-image (see packages/native/test/metrics.test.ts)", () => {
    expect(ssim(gradient(32, 24), noiseImage(32, 24, 1))).toBeCloseTo(-0.02380079335172043, 12);
  });

  test("rejects images of different sizes and images smaller than one window", () => {
    expect(() => ssim(noiseImage(12, 12), noiseImage(12, 13))).toThrow(RangeError);
    expect(() => ssim(noiseImage(10, 20), noiseImage(10, 20))).toThrow(RangeError);
  });
});

describe("ber", () => {
  test("is the share of differing bits", () => {
    expect(ber(Uint8Array.of(0, 1, 1, 0), Uint8Array.of(0, 1, 0, 1))).toBe(0.5);
    expect(ber(Uint8Array.of(1, 0, 1), Uint8Array.of(1, 0, 1))).toBe(0);
  });

  test("is 0 for empty bit arrays", () => {
    expect(ber(new Uint8Array(0), new Uint8Array(0))).toBe(0);
  });

  test("rejects bit arrays of different lengths", () => {
    expect(() => ber(new Uint8Array(8), new Uint8Array(7))).toThrow(RangeError);
  });
});
