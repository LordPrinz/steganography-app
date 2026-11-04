/** Raw 8-bit RGBA pixels, row-major, 4 bytes per pixel. */
export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

export const MethodId = {
  Lsb: 1,
  DctKochZhao: 2,
  DwtQim: 3,
} as const;
export type MethodId = (typeof MethodId)[keyof typeof MethodId];

/**
 * A method with its parameters bound, e.g. `lsb({ bitsPerChannel: 1 })`. This is what the stego
 * codec receives. Methods only move bits (values 0/1) in and out of pixels; the codec owns
 * framing, UTF-8 and capacity checks.
 *
 * Every implementation must pass the method contract suite (`testing/method-contract.ts`).
 */
export interface ConfiguredMethod {
  readonly id: MethodId;
  /** Exact number of bits the method can embed into an image of the given size. */
  capacityBits(width: number, height: number): number;
  /**
   * Returns a new image of the same size with `bits` embedded, starting at bit position 0.
   * Does not mutate `image`. Throws `RangeError` when `bits` exceeds `capacityBits`.
   */
  embed(image: RgbaImage, bits: Uint8Array): RgbaImage;
  /**
   * Reads the first `bitCount` bits. `extract(image, n)` is a prefix of `extract(image, m)` for
   * `n < m`, so a caller can read the frame header first and the rest later. Throws `RangeError`
   * when `bitCount` exceeds `capacityBits`.
   */
  extract(image: RgbaImage, bitCount: number): Uint8Array;
}
