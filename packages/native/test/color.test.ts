import { describe, expect, test } from "bun:test";
import { MAX_PIXELS } from "../src/image.ts";
import { NativeKernelError, rgbaToYcbcr, type YcbcrPlanes, ycbcrToRgba } from "../src/index.ts";
import { native } from "../src/library.ts";
import { check } from "../src/status.ts";
import { rgbaToYcbcrOracle, ycbcrToRgbaOracle } from "./oracle/color.ts";
import { randomBytes } from "./random.ts";

const image = (width: number, height: number, seed?: number) => ({
  width,
  height,
  data: randomBytes(width * height * 4, seed),
});

describe("rgbaToYcbcr / ycbcrToRgba", () => {
  test.each([
    [1, 1],
    [37, 23],
    [64, 48],
  ])("matches the TS oracle bit for bit on %ix%i", (width, height) => {
    const input = image(width, height);
    const planes = rgbaToYcbcr(input);
    const expected = rgbaToYcbcrOracle(input);
    expect(planes.y).toEqual(expected.y);
    expect(planes.cb).toEqual(expected.cb);
    expect(planes.cr).toEqual(expected.cr);
    expect(planes.alpha).toEqual(expected.alpha);
    expect(ycbcrToRgba(planes).data).toEqual(ycbcrToRgbaOracle(expected).data);
  });

  test("round-trips every 24-bit colour exactly", () => {
    const side = 4096; // 4096² = 2^24 pixels, one per colour, which is also MAX_PIXELS
    const data = new Uint8ClampedArray(side * side * 4);
    for (let c = 0; c < side * side; c++) {
      data[c * 4] = c >> 16;
      data[c * 4 + 1] = (c >> 8) & 0xff;
      data[c * 4 + 2] = c & 0xff;
      data[c * 4 + 3] = c & 0xff;
    }
    const out = ycbcrToRgba(rgbaToYcbcr({ width: side, height: side, data })).data;
    expect(Buffer.from(out.buffer).equals(Buffer.from(data.buffer))).toBe(true);
  });

  test("gives grey a luma equal to the grey level and neutral chroma", () => {
    const planes = rgbaToYcbcr({ width: 1, height: 1, data: Uint8ClampedArray.of(77, 77, 77, 9) });
    expect(planes.y[0]).toBeCloseTo(77, 4);
    expect(planes.cb[0]).toBeCloseTo(128, 4);
    expect(planes.cr[0]).toBeCloseTo(128, 4);
    expect(planes.alpha[0]).toBe(9);
  });

  test("clamps out-of-range and NaN planes when converting back", () => {
    const planes: YcbcrPlanes = {
      width: 3,
      height: 1,
      y: Float32Array.of(300, -20, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
      cb: Float32Array.of(128, 128, 128, 128, 128),
      cr: Float32Array.of(128, 128, 128, 128, 128),
      alpha: Uint8Array.of(1, 2, 3, 4, 5),
    };
    expect(Array.from(ycbcrToRgba({ ...planes, width: 5 }).data)).toEqual([
      255, 255, 255, 1, 0, 0, 0, 2, 0, 0, 0, 3, 255, 255, 255, 4, 0, 0, 0, 5,
    ]);
  });

  test("reads views with a non-zero byte offset like copies", () => {
    const input = image(5, 3);
    const backing = new Uint8ClampedArray(input.data.length + 12);
    backing.set(input.data, 7);
    const view = { ...input, data: backing.subarray(7, 7 + input.data.length) };
    const planes = rgbaToYcbcr(view);
    expect(planes.y).toEqual(rgbaToYcbcr(input).y);

    const yBacking = new Float32Array(planes.y.length + 4);
    yBacking.set(planes.y, 3);
    const shifted = { ...planes, y: yBacking.subarray(3, 3 + planes.y.length) };
    expect(ycbcrToRgba(shifted).data).toEqual(ycbcrToRgba(planes).data);
  });

  test("does not mutate its input", () => {
    const input = image(8, 8);
    const copy = input.data.slice();
    const planes = rgbaToYcbcr(input);
    const y = planes.y.slice();
    ycbcrToRgba(planes);
    expect(input.data).toEqual(copy);
    expect(planes.y).toEqual(y);
  });
});

describe("client validation", () => {
  test.each([
    [0, 1],
    [1, 0],
    [1.5, 2],
    [-1, 1],
    [16385, 1],
    [Number.NaN, 1],
  ])("rejects %p x %p", (width, height) => {
    expect(() => rgbaToYcbcr({ width, height, data: new Uint8ClampedArray(4) })).toThrow(
      RangeError,
    );
  });

  test("accepts the largest non-square image and rejects one more row", () => {
    const ok = { width: 16384, height: 1024, data: new Uint8ClampedArray(16384 * 1024 * 4) };
    expect(rgbaToYcbcr(ok).y.length).toBe(MAX_PIXELS);
    expect(() => rgbaToYcbcr({ ...ok, height: 1025 })).toThrow(`limit is ${MAX_PIXELS}`);
  });

  test("validates dimensions in the inverse direction too", () => {
    const planes = rgbaToYcbcr(image(2, 2));
    expect(() => ycbcrToRgba({ ...planes, width: 0 })).toThrow(RangeError);
    expect(() => ycbcrToRgba({ ...planes, width: 4, height: 1 })).not.toThrow();
    expect(() => ycbcrToRgba({ ...planes, width: 3 })).toThrow("y must have 6");
  });

  test("rejects images above MAX_PIXELS", () => {
    expect(() =>
      rgbaToYcbcr({ width: 4097, height: 4096, data: new Uint8ClampedArray(0) }),
    ).toThrow(`limit is ${MAX_PIXELS}`);
  });

  test("rejects a data length that does not match the dimensions", () => {
    expect(() => rgbaToYcbcr({ width: 2, height: 2, data: new Uint8ClampedArray(15) })).toThrow(
      "data must have 16 elements",
    );
  });

  test("rejects mismatched planes", () => {
    const planes = rgbaToYcbcr(image(2, 2));
    expect(() => ycbcrToRgba({ ...planes, cr: new Float32Array(3) })).toThrow("cr must have 4");
  });
});

describe("C-side validation (bypassing the client)", () => {
  const n = 4;
  const rgba = new Uint8Array(n * 4);
  const plane = () => new Float32Array(n);
  const alpha = new Uint8Array(n);

  function forward(width: number, height: number, input = rgba, y = plane()): number {
    const cb = plane();
    const cr = plane();
    return native().stego_rgba_to_ycbcr(
      input,
      input,
      width,
      height,
      y,
      y,
      cb,
      cb,
      cr,
      cr,
      alpha,
      alpha,
    );
  }

  test("accepts consistent arguments", () => {
    expect(forward(2, 2)).toBe(0);
  });

  test("reports invalid dimensions", () => {
    expect(forward(0, 4)).toBe(-2);
    expect(forward(16385, 1)).toBe(-2);
    expect(forward(4097, 4096)).toBe(-2);
  });

  test("reports a buffer length mismatch", () => {
    expect(forward(4, 2)).toBe(-3);
    expect(forward(2, 2, new Uint8Array(15))).toBe(-3);
    expect(forward(2, 2, rgba, new Float32Array(3))).toBe(-3);
  });

  test("checks the inverse direction too", () => {
    const y = plane();
    const out = new Uint8Array(n * 4 - 1);
    const code = native().stego_ycbcr_to_rgba(y, y, y, y, y, y, alpha, alpha, 2, 2, out, out);
    expect(code).toBe(-3);
  });

  test("status codes map to NativeKernelError", () => {
    expect(() => check("kernel", -3)).toThrow(
      new NativeKernelError("kernel", "length-mismatch", -3),
    );
    expect(() => check("kernel", -99)).toThrow("kernel failed: unknown (-99)");
    expect(() => check("kernel", 0)).not.toThrow();
  });
});
