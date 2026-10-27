/**
 * Thin wrappers around `Bun.Image`. Every function takes and returns encoded bytes,
 * so callers never pass user-controlled file paths to the decoder.
 */

/** Upper bound on decoded pixels; guards against decompression bombs. */
export const MAX_PIXELS = 4096 * 4096;

export type ResizeFilter = "lanczos3" | "mitchell" | "mks2021" | "nearest";

export interface ImageInfo {
  width: number;
  height: number;
  format: string;
}

function open(input: Uint8Array): Bun.Image {
  return new Bun.Image(input.slice(), { maxPixels: MAX_PIXELS });
}

export async function readInfo(input: Uint8Array): Promise<ImageInfo> {
  const { width, height, format } = await open(input).metadata();
  return { width, height, format };
}

/** Decodes any supported format (EXIF orientation applied) and re-encodes it losslessly. */
export function toPng(input: Uint8Array): Promise<Uint8Array> {
  return open(input).png().bytes();
}

export function toJpeg(input: Uint8Array, quality: number): Promise<Uint8Array> {
  if (!Number.isInteger(quality) || quality < 1 || quality > 100) {
    throw new RangeError(`JPEG quality must be an integer in 1–100, got ${quality}`);
  }
  return open(input).jpeg({ quality }).bytes();
}

export function resize(
  input: Uint8Array,
  width: number,
  height: number,
  filter: ResizeFilter = "lanczos3",
): Promise<Uint8Array> {
  return open(input).resize(width, height, { fit: "fill", filter }).png().bytes();
}
