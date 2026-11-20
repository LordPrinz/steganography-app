import { withErrorCorrection } from "../ecc/code.ts";
import { hamming74 } from "../ecc/hamming74.ts";
import { repetition } from "../ecc/repetition.ts";
import { lsb } from "../methods/lsb.ts";
import type { MethodCase } from "./method-contract.ts";

/** Every configured method the shared suites run against. Add each new method here. */
export const methodCases: readonly MethodCase[] = [
  ...[1, 2, 3, 8].map((bitsPerChannel) => ({
    name: `lsb ${bitsPerChannel} bit(s) per channel`,
    method: lsb({ bitsPerChannel }),
  })),
  {
    name: "lsb 3 bits per channel, repetition x3",
    method: withErrorCorrection(lsb({ bitsPerChannel: 3 }), repetition({ factor: 3 })),
  },
  {
    name: "lsb 2 bits per channel, Hamming(7,4)",
    method: withErrorCorrection(lsb({ bitsPerChannel: 2 }), hamming74()),
  },
];
