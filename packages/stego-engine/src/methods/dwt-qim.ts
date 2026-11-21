import {
  assertDwtQimParams,
  type DwtQimParams,
  dwtQimCapacityBits,
  dwtQimEmbed,
  dwtQimExtract,
} from "@stego/native";
import { type ConfiguredMethod, MethodId } from "../types.ts";

export type { DwtQimParams };

/**
 * Haar DWT of the luminance with quantisation index modulation: one bit per coefficient of one
 * band (`LL`, `HL` or `LH`) at one level, quantised with `step`. Without an attack the bits come
 * back exactly when `step` is above 2^(level + 1); saturated areas may need more, and `embed`
 * throws when a bit cannot be made to survive the conversion back to 8-bit pixels. The pixel loops
 * run in `@stego/native`.
 */
export function dwtQim(params: DwtQimParams): ConfiguredMethod {
  assertDwtQimParams(params);
  return {
    id: MethodId.DwtQim,
    capacityBits: (width, height) => dwtQimCapacityBits(width, height, params.level),
    embed(image, bits) {
      const { image: stego, failed } = dwtQimEmbed(image, params, bits);
      if (failed > 0) {
        throw new Error(
          `${failed} of ${bits.length} bits cannot survive rounding to 8-bit pixels; use a larger step`,
        );
      }
      return stego;
    },
    extract: (image, bitCount) => dwtQimExtract(image, params, bitCount),
  };
}
