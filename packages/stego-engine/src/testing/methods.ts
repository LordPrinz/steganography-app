import { lsb } from "../methods/lsb.ts";
import type { MethodCase } from "./method-contract.ts";

/** Every configured method the shared suites run against. Add each new method here. */
export const methodCases: readonly MethodCase[] = [1, 2, 3, 8].map((bitsPerChannel) => ({
  name: `lsb ${bitsPerChannel} bit(s) per channel`,
  method: lsb({ bitsPerChannel }),
}));
