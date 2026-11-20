/**
 * PNG <-> raw RGBA. `Bun.Image` decodes and encodes images but never exposes pixels, so this file
 * reads and writes the PNG container itself: chunks and zlib here, scanline filters in
 * `@stego/native`.
 */

import { promisify } from "node:util";
import { deflate, inflate } from "node:zlib";
import { assertDimensions, pngFilter, pngUnfilter, type RgbaPixels } from "@stego/native";
import { toPng } from "./pipeline.ts";

/** 8-bit RGBA pixels, row-major. Structurally the engine's `RgbaImage`. */
export type RgbaImage = RgbaPixels & { readonly data: Uint8ClampedArray };

const SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
/** Colour type (PNG spec, 11.2.2) to channel count; only truecolour, which `Bun.Image` emits. */
const CHANNELS: Record<number, 3 | 4> = { 2: 3, 6: 4 };

const inflateAsync = promisify(inflate);
const deflateAsync = promisify(deflate);

/** The input bytes are not an image this module can decode. `cause` holds the underlying error. */
export class InvalidImageError extends Error {
  override readonly name = "InvalidImageError";
}

/**
 * Decodes any format `Bun.Image` reads (EXIF orientation applied) to 8-bit RGBA. Throws
 * `InvalidImageError` when the input cannot be decoded.
 */
export async function decodeRgba(input: Uint8Array): Promise<RgbaImage> {
  let png: Uint8Array;
  try {
    png = await toPng(input);
  } catch (cause) {
    throw new InvalidImageError(`cannot decode image: ${(cause as Error).message}`, { cause });
  }
  return decodePng(png);
}

/** Encodes RGBA pixels as a lossless 8-bit RGBA PNG. */
export async function encodePng(image: RgbaPixels): Promise<Uint8Array> {
  const { width, height } = image;
  const idat = await deflateAsync(pngFilter(image));
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA; compression, filter method and interlace stay 0
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", new Uint8Array()),
  ]);
}

/**
 * Decodes a non-interlaced 8-bit RGB or RGBA PNG, the shape `Bun.Image#png()` produces. Other
 * PNGs go through `decodeRgba`, which normalises them first. Throws `InvalidImageError`.
 */
export async function decodePng(png: Uint8Array): Promise<RgbaImage> {
  if (png.length < SIGNATURE.length || SIGNATURE.some((byte, i) => png[i] !== byte)) {
    throw new InvalidImageError("not a PNG: bad signature");
  }

  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const idat: Uint8Array[] = [];
  let header: { width: number; height: number; channels: 3 | 4 } | undefined;
  let offset = SIGNATURE.length;
  for (;;) {
    if (offset + 12 > png.length) throw new InvalidImageError("PNG ends before IEND");
    const length = view.getUint32(offset);
    const end = offset + 12 + length;
    if (end > png.length) throw new InvalidImageError("PNG chunk runs past the end of the file");
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    const data = png.subarray(offset + 8, end - 4);
    if (Bun.hash.crc32(png.subarray(offset + 4, end - 4)) !== view.getUint32(end - 4)) {
      throw new InvalidImageError(`PNG chunk ${type} has a bad CRC`);
    }
    if ((type === "IHDR") === (header !== undefined)) {
      throw new InvalidImageError("PNG must have exactly one IHDR, as the first chunk");
    }
    if (type === "IHDR") header = readHeader(data);
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    // PLTE is optional for truecolour; any other critical (uppercase) chunk changes the meaning.
    else if (type !== "PLTE" && /^[A-Z]/.test(type)) {
      throw new InvalidImageError(`unsupported critical PNG chunk ${type}`);
    }
    offset = end;
  }
  if (!header || idat.length === 0) throw new InvalidImageError("PNG has no image data");

  const { width, height, channels } = header;
  const expected = (width * channels + 1) * height;
  let scanlines: Uint8Array;
  try {
    scanlines = await inflateAsync(Buffer.concat(idat), { maxOutputLength: expected });
  } catch (cause) {
    throw new InvalidImageError(`PNG image data is corrupt: ${(cause as Error).message}`, {
      cause,
    });
  }
  if (scanlines.length !== expected) {
    throw new InvalidImageError(
      `PNG image data has ${scanlines.length} bytes, expected ${expected}`,
    );
  }
  try {
    return pngUnfilter(scanlines, width, height, channels);
  } catch (cause) {
    // The client rejects a bad filter-type byte with a RangeError before calling C.
    if (!(cause instanceof RangeError)) throw cause;
    throw new InvalidImageError(`PNG image data is corrupt: ${cause.message}`, { cause });
  }
}

function readHeader(data: Uint8Array) {
  if (data.length !== 13) throw new InvalidImageError("PNG IHDR must be 13 bytes");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const [depth, colourType, compression, filter, interlace] = data.subarray(8);
  const channels = CHANNELS[colourType as number];
  if (depth !== 8 || !channels) {
    throw new InvalidImageError(`unsupported PNG: bit depth ${depth}, colour type ${colourType}`);
  }
  if (compression !== 0 || filter !== 0 || interlace !== 0) {
    throw new InvalidImageError(
      "unsupported PNG: unknown compression or filter method, or interlaced",
    );
  }
  const width = view.getUint32(0);
  const height = view.getUint32(4);
  try {
    assertDimensions(width, height);
  } catch (cause) {
    throw new InvalidImageError(`unsupported PNG size ${width}x${height}`, { cause });
  }
  return { width, height, channels };
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length + 12);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(data.length + 8, Bun.hash.crc32(out.subarray(4, data.length + 8)));
  return out;
}
