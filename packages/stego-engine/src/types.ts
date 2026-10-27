/** Raw 8-bit RGBA pixels, row-major, 4 bytes per pixel. */
export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

/**
 * Contract every steganographic method implements. Methods operate on raw pixels
 * and bit streams only — framing, I/O and image formats live elsewhere.
 */
export interface StegoMethod<Params> {
  readonly id: MethodId;
  /** Number of bits the method can embed into an image of the given size. */
  capacityBits(width: number, height: number, params: Params): number;
  /** Returns a new image with `bits` (values 0/1) embedded. */
  embed(image: RgbaImage, bits: Uint8Array, params: Params): RgbaImage;
  /** Reads `bitCount` bits (values 0/1) from the image. */
  extract(image: RgbaImage, bitCount: number, params: Params): Uint8Array;
}

export const MethodId = {
  Lsb: 1,
  DctKochZhao: 2,
  DwtQim: 3,
} as const;
export type MethodId = (typeof MethodId)[keyof typeof MethodId];
