import { assertKochZhao, type DctPair, dctCapacityBits, dctEmbed, dctExtract } from "@stego/native";
import { type ConfiguredMethod, MethodId } from "../types.ts";

export interface KochZhaoParams {
  /** The two coefficients compared in each 8 × 8 block, as `[u, v]` frequencies (not DC). */
  readonly pair: DctPair;
  /** Margin P the two magnitudes are pushed apart by, in coefficient units (0–1024). */
  readonly strength: number;
}

/** Chosen in ADR 7: survives JPEG quality 75 on natural images at about 35 dB PSNR. */
export const KOCH_ZHAO_DEFAULTS: KochZhaoParams = {
  pair: [
    [3, 2],
    [2, 3],
  ],
  strength: 40,
};

/** Koch–Zhao embedding in the luminance DCT, one bit per whole 8 × 8 block. */
export function kochZhao({
  pair = KOCH_ZHAO_DEFAULTS.pair,
  strength = KOCH_ZHAO_DEFAULTS.strength,
}: Partial<KochZhaoParams> = {}): ConfiguredMethod {
  assertKochZhao(pair, strength);
  return {
    id: MethodId.DctKochZhao,
    capacityBits: (width, height) => dctCapacityBits(width, height),
    embed: (image, bits) => dctEmbed(image, pair, strength, bits),
    extract: (image, bitCount) => dctExtract(image, pair, bitCount),
  };
}
