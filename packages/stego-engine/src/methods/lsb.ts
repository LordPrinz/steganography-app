import { assertBitsPerChannel, lsbCapacityBits, lsbEmbed, lsbExtract } from "@stego/native";
import { type ConfiguredMethod, MethodId } from "../types.ts";

export interface LsbParams {
  /** Low bits replaced in each of R, G and B: 1–8. Alpha is never touched. */
  readonly bitsPerChannel: number;
}

/** Least significant bit embedding in the colour channels; the pixel loops run in `@stego/native`. */
export function lsb({ bitsPerChannel }: LsbParams): ConfiguredMethod {
  assertBitsPerChannel(bitsPerChannel);
  return {
    id: MethodId.Lsb,
    capacityBits: (width, height) => lsbCapacityBits(width, height, bitsPerChannel),
    embed: (image, bits) => lsbEmbed(image, bitsPerChannel, bits),
    extract: (image, bitCount) => lsbExtract(image, bitsPerChannel, bitCount),
  };
}
