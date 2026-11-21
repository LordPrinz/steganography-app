import {
  type ConfiguredMethod,
  dwtQim,
  hamming74,
  kochZhao,
  lsb,
  repetition,
  withErrorCorrection,
} from "@stego/engine";
import type { DctPair } from "@stego/native";
import { z } from "zod";

export interface BenchMethod {
  readonly name: string;
  /** Parameters as shown in reports, e.g. `bits=2` or `LL L2 step=32, ecc=hamming74`. */
  readonly params: string;
  readonly method: ConfiguredMethod;
}

type Build = (raw: Record<string, string>) => { method: ConfiguredMethod; label: string };

/** Parses the `key=value` strings of a spec (defaults included), binds them and labels them. */
function entry<P extends object>(
  schema: z.ZodType<P>,
  create: (params: P) => ConfiguredMethod,
  describe: (params: P) => string,
): Build {
  return (raw) => {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
    return { method: create(parsed.data), label: describe(parsed.data) };
  };
}

const int = z.coerce.number().int();

// A coefficient pair is written as four digits: "3223" is (3,2) vs (2,3).
const pair = z
  .string()
  .regex(/^[0-7]{4}$/, "a pair is four digits, e.g. 3223")
  .transform(
    (s): DctPair => [
      [Number(s[0]), Number(s[1])],
      [Number(s[2]), Number(s[3])],
    ],
  );

/** Add a method here and `--method` and the presets can use it. */
const methods: Record<string, Build> = {
  lsb: entry(
    z.strictObject({ bitsPerChannel: int.default(1) }),
    lsb,
    ({ bitsPerChannel }) => `bits=${bitsPerChannel}`,
  ),
  kochZhao: entry(
    z.strictObject({ pair: pair.prefault("3223"), strength: z.coerce.number().default(40) }),
    kochZhao,
    ({ pair: [[u1, v1], [u2, v2]], strength }) => `(${u1},${v1}) vs (${u2},${v2}) P=${strength}`,
  ),
  dwtQim: entry(
    z.strictObject({
      band: z.enum(["LL", "HL", "LH"]).default("LL"),
      level: int.default(2),
      step: int.default(32),
    }),
    dwtQim,
    ({ band, level, step }) => `${band} L${level} step=${step}`,
  ),
};

const codes: Record<string, (arg: string) => ReturnType<typeof hamming74>> = {
  hamming74: () => hamming74(),
  repetition: (factor) => repetition({ factor: Number(factor) }),
};

export const METHOD_NAMES = Object.keys(methods);
export const CODE_NAMES = Object.keys(codes);

/**
 * Parses `name[:key=value,...]`, e.g. `kochZhao:pair=4334,strength=50`. The key `ecc` wraps the
 * method in an error-correcting code (`hamming74` or `repetition:3`). Throws `Error` with a
 * readable message for unknown names, keys or values.
 */
export function parseMethod(spec: string): BenchMethod {
  const colon = spec.indexOf(":");
  const name = colon < 0 ? spec : spec.slice(0, colon);
  const build = Object.hasOwn(methods, name) ? methods[name] : undefined;
  if (!build) {
    throw new Error(`unknown method "${name}", expected one of ${METHOD_NAMES.join(", ")}`);
  }

  const { ecc, ...own } = parseKeyValues(colon < 0 ? "" : spec.slice(colon + 1));
  let built: ReturnType<Build>;
  try {
    built = build(own);
  } catch (cause) {
    throw new Error(`bad parameters for ${name}: ${(cause as Error).message}`, { cause });
  }
  if (ecc === undefined) return { name, params: built.label, method: built.method };

  const [codeName = "", arg = ""] = ecc.split(":");
  const code = Object.hasOwn(codes, codeName) ? codes[codeName]?.(arg) : undefined;
  if (!code) throw new Error(`unknown ecc "${codeName}", expected one of ${CODE_NAMES.join(", ")}`);
  return {
    name,
    params: `${built.label}, ecc=${ecc}`,
    method: withErrorCorrection(built.method, code),
  };
}

function parseKeyValues(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of text.split(",").filter(Boolean)) {
    const eq = item.indexOf("=");
    if (eq <= 0) throw new Error(`expected key=value, got "${item}"`);
    out[item.slice(0, eq)] = item.slice(eq + 1);
  }
  return out;
}
