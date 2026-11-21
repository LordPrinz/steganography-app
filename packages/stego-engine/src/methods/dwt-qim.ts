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
 * band (`LL`, `HL` or `LH`) at one level, quantised with `step`. Rounding to 8-bit pixels moves a
 * coefficient by up to 2^level / 2, so `step` must exceed 2^(level + 1); smaller steps are
 * rejected. Clamping at black and white is handled by embedding, reading back and correcting. No
 * step above the bound failed on flat, near-saturated or noise covers in the tests, but this is
 * not proven for every image, so `embed` throws if a bit still cannot round-trip. The pixel loops
 * run in `@stego/native`.
 */
export function dwtQim(params: DwtQimParams): ConfiguredMethod {
  assertDwtQimParams(params);
  if (params.step <= 2 ** (params.level + 1)) {
    throw new RangeError(
      `step must exceed ${2 ** (params.level + 1)} at level ${params.level}, got ${params.step}`,
    );
  }
  return {
    id: MethodId.DwtQim,
    capacityBits: (width, height) => dwtQimCapacityBits(width, height, params.level),
    embed(image, bits) {
      const { image: stego, failed } = dwtQimEmbed(image, params, bits);
      if (failed > 0) {
        throw new Error(`${failed} of ${bits.length} bits cannot survive rounding to 8-bit pixels`);
      }
      return stego;
    },
    extract: (image, bitCount) => dwtQimExtract(image, params, bitCount),
  };
}
