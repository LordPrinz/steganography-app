import { describe, expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import { PngFilter, pngFilter } from "@stego/native";
import { toJpeg, toPng } from "../src/pipeline.ts";
import { decodePng, decodeRgba, encodePng, type RgbaImage } from "../src/png.ts";

const fixture = (name: string) => Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).bytes();

/** Builds the RGBA image a fixture holds; the fixtures were written from these formulas. */
function expected(width: number, height: number, pixel: (x: number, y: number) => number[]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.set(pixel(x, y), (y * width + x) * 4);
  }
  return { width, height, data };
}
const r = (x: number, y: number) => (x * 37 + y * 11) & 255;
const g = (x: number, y: number) => (x * 5 + y * 67) & 255;
const b = (x: number, y: number) => (x * y * 3) & 255;
const a = (x: number, y: number) => (x * 19 + y * 41 + 7) & 255;
const v = (x: number, y: number) => (x * 29 + y * 53) & 255;

function randomImage(width: number, height: number): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  let x = 0x2545f491;
  for (let i = 0; i < data.length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    data[i] = x & 0xff;
  }
  return { width, height, data };
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, Bun.hash.crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Replaces bytes of a PNG chunk and fixes its CRC, so the decoder reaches the field under test. */
function patchChunk(png: Uint8Array, type: string, offset: number, bytes: number[]): Uint8Array {
  const out = png.slice();
  const view = new DataView(out.buffer);
  let at = 8;
  while (String.fromCharCode(...out.subarray(at + 4, at + 8)) !== type) {
    at += 12 + view.getUint32(at);
  }
  out.set(bytes, at + 8 + offset);
  const length = view.getUint32(at);
  view.setUint32(at + 8 + length, Bun.hash.crc32(out.subarray(at + 4, at + 8 + length)));
  return out;
}

describe("decodeRgba", () => {
  test("decodes an RGB PNG with odd dimensions, adding opaque alpha", async () => {
    const image = await decodeRgba(await fixture("rgb-13x7.png"));
    expect(image).toEqual(expected(13, 7, (x, y) => [r(x, y), g(x, y), b(x, y), 255]));
  });

  test("decodes an RGBA PNG", async () => {
    const image = await decodeRgba(await fixture("rgba-16x9.png"));
    expect(image).toEqual(expected(16, 9, (x, y) => [r(x, y), g(x, y), b(x, y), a(x, y)]));
  });

  test("decodes a grayscale PNG to equal RGB channels", async () => {
    const image = await decodeRgba(await fixture("gray-9x5.png"));
    expect(image).toEqual(expected(9, 5, (x, y) => [v(x, y), v(x, y), v(x, y), 255]));
  });

  test("decodes other formats after normalising them", async () => {
    const jpeg = await toJpeg(await fixture("gradient-64x48.png"), 90);
    const image = await decodeRgba(jpeg);
    expect(image.width).toBe(64);
    expect(image.height).toBe(48);
    expect(image.data.length).toBe(64 * 48 * 4);
  });

  test("rejects bytes that are not an image", async () => {
    await expect(decodeRgba(new TextEncoder().encode("not an image"))).rejects.toThrow();
  });
});

describe("encodePng", () => {
  test.each(["rgb-13x7.png", "rgba-16x9.png", "gray-9x5.png", "gradient-64x48.png"])(
    "encodePng(decodeRgba(png)) round-trips %s exactly",
    async (name) => {
      const image = await decodeRgba(await fixture(name));
      const encoded = await encodePng(image);
      expect(await decodePng(encoded)).toEqual(image);
      expect(await decodeRgba(encoded)).toEqual(image);
    },
  );

  test("writes PNGs that Bun.Image decodes to the same pixels", async () => {
    for (const [width, height] of [
      [1, 1],
      [3, 17],
      [31, 2],
      [100, 75],
    ] as const) {
      const image = randomImage(width, height);
      expect(await decodeRgba(await encodePng(image))).toEqual(image);
    }
  });

  test("writes an 8-bit RGBA, non-interlaced header", async () => {
    const png = await encodePng(randomImage(5, 3));
    const view = new DataView(png.buffer, png.byteOffset);
    expect(String.fromCharCode(...png.subarray(12, 16))).toBe("IHDR");
    expect([view.getUint32(16), view.getUint32(20)]).toEqual([5, 3]);
    expect(Array.from(png.subarray(24, 29))).toEqual([8, 6, 0, 0, 0]);
  });
});

describe("decodePng", () => {
  test.each(Object.entries(PngFilter).filter(([name]) => name !== "Adaptive"))(
    "decodes scanlines that all use the %s filter",
    async (_, filter) => {
      const image = randomImage(11, 6);
      const png = await encodePng(image);
      const ihdrEnd = 8 + 12 + 13;
      const idat = chunk("IDAT", deflateSync(pngFilter(image, filter)));
      const rebuilt = Buffer.concat([
        png.subarray(0, ihdrEnd),
        idat,
        png.subarray(png.length - 12),
      ]);
      expect(await decodePng(rebuilt)).toEqual(image);
    },
  );

  test("reads image data split over several IDAT chunks", async () => {
    const image = randomImage(640, 480);
    const png = await toPng(await encodePng(image));
    const idatCount = Buffer.from(png).toString("latin1").split("IDAT").length - 1;
    expect(idatCount).toBeGreaterThan(1);
    expect(await decodePng(png)).toEqual(image);
  });

  test("rejects a bad signature", async () => {
    const png = await encodePng(randomImage(2, 2));
    png[1] = 0;
    await expect(decodePng(png)).rejects.toThrow("bad signature");
  });

  test("rejects a chunk with a bad CRC", async () => {
    const png = await encodePng(randomImage(2, 2));
    png[29] = (png[29] as number) ^ 1;
    await expect(decodePng(png)).rejects.toThrow("IHDR has a bad CRC");
  });

  test("rejects a truncated file", async () => {
    const png = await encodePng(randomImage(2, 2));
    await expect(decodePng(png.subarray(0, png.length - 12))).rejects.toThrow("ends before IEND");
    await expect(decodePng(png.subarray(0, 50))).rejects.toThrow("past the end");
  });

  test.each([
    ["16-bit depth", 8, [16]],
    ["grayscale", 9, [0]],
    ["palette", 9, [3]],
    ["interlaced", 12, [1]],
  ] as const)("rejects an unsupported %s PNG", async (_, offset, bytes) => {
    const png = patchChunk(await encodePng(randomImage(2, 2)), "IHDR", offset, [...bytes]);
    await expect(decodePng(png)).rejects.toThrow("unsupported PNG");
  });

  test("rejects dimensions above the pixel limit before inflating", async () => {
    const png = patchChunk(await encodePng(randomImage(2, 2)), "IHDR", 0, [0, 1, 0, 0, 0, 0, 1, 1]);
    await expect(decodePng(png)).rejects.toThrow("unsupported PNG size 65536x257");
  });

  test("rejects image data of the wrong size", async () => {
    const png = patchChunk(await encodePng(randomImage(2, 2)), "IHDR", 4, [0, 0, 0, 3]);
    await expect(decodePng(png)).rejects.toThrow("has 18 bytes, expected 27");
  });
});
