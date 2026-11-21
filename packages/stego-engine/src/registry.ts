import { type ErrorCorrectingCode, withErrorCorrection } from "./ecc/code.ts";
import { hamming74 } from "./ecc/hamming74.ts";
import { repetition } from "./ecc/repetition.ts";
import { type DwtQimParams, dwtQim } from "./methods/dwt-qim.ts";
import { type KochZhaoParams, kochZhao } from "./methods/koch-zhao.ts";
import { type LsbParams, lsb } from "./methods/lsb.ts";
import type { ConfiguredMethod } from "./types.ts";

export type EccSelection = { code: "repetition"; factor: number } | { code: "hamming74" };

interface Selected<Id extends string, Params> {
  id: Id;
  params: Params;
  ecc?: EccSelection;
}

/** A method by name with its parameters and an optional error-correcting code, as a request carries it. */
export type MethodSelection =
  | Selected<"lsb", LsbParams>
  | Selected<"dct-koch-zhao", Partial<KochZhaoParams>>
  | Selected<"dwt-qim", DwtQimParams>;

type Factories = { [S in MethodSelection as S["id"]]: (params: S["params"]) => ConfiguredMethod };
type Codes = { [E in EccSelection as E["code"]]: (ecc: E) => ErrorCorrectingCode };

const METHODS: Factories = { lsb, "dct-koch-zhao": kochZhao, "dwt-qim": dwtQim };
const CODES: Codes = {
  repetition: ({ factor }) => repetition({ factor }),
  hamming74: () => hamming74(),
};

/**
 * Builds the configured method a selection names. Throws `RangeError` for parameters the method
 * rejects. A new method is one entry in `METHODS`.
 */
export function createMethod({ id, params, ecc }: MethodSelection): ConfiguredMethod {
  const method = (METHODS[id] as (params: unknown) => ConfiguredMethod)(params);
  if (!ecc) return method;
  const code = (CODES[ecc.code] as (ecc: EccSelection) => ErrorCorrectingCode)(ecc);
  return withErrorCorrection(method, code);
}
