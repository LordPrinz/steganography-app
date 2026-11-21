import { withErrorCorrection } from "../ecc/code.ts";
import { hamming74 } from "../ecc/hamming74.ts";
import { repetition } from "../ecc/repetition.ts";
import { dwtQim } from "../methods/dwt-qim.ts";
import { kochZhao } from "../methods/koch-zhao.ts";
import { lsb } from "../methods/lsb.ts";
import type { MethodCase } from "./method-contract.ts";

/** Odd-sized so a remainder strip is covered; 48 x 32 whole blocks hold 1536 bits. */
const KOCH_ZHAO_COVER = { width: 389, height: 259 };

/** Every configured method the shared suites run against. Add each new method here. */
export const methodCases: readonly MethodCase[] = [
  ...[1, 2, 3, 8].map((bitsPerChannel) => ({
    name: `lsb ${bitsPerChannel} bit(s) per channel`,
    method: lsb({ bitsPerChannel }),
  })),
  { name: "koch-zhao defaults", method: kochZhao(), coverSize: KOCH_ZHAO_COVER },
  {
    name: "koch-zhao (1,2) vs (2,1), strength 12",
    coverSize: KOCH_ZHAO_COVER,
    method: kochZhao({
      pair: [
        [1, 2],
        [2, 1],
      ],
      strength: 12,
    }),
  },
  {
    name: "koch-zhao defaults, Hamming(7,4)",
    coverSize: KOCH_ZHAO_COVER,
    method: withErrorCorrection(kochZhao(), hamming74()),
  },
  {
    name: "lsb 3 bits per channel, repetition x3",
    method: withErrorCorrection(lsb({ bitsPerChannel: 3 }), repetition({ factor: 3 })),
  },
  {
    name: "lsb 2 bits per channel, Hamming(7,4)",
    method: withErrorCorrection(lsb({ bitsPerChannel: 2 }), hamming74()),
  },
  ...(["LL", "HL", "LH"] as const).map((band) => ({
    name: `dwt-qim ${band} level 1, step 24`,
    method: dwtQim({ band, level: 1, step: 24 }),
  })),
  {
    name: "dwt-qim LL level 1, step 24, Hamming(7,4)",
    method: withErrorCorrection(dwtQim({ band: "LL", level: 1, step: 24 }), hamming74()),
  },
];
