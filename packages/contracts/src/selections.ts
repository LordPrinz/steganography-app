import { z } from "zod";
import { StegoMethod } from "./methods.ts";

const Position = z.tuple([z.int().min(0).max(7), z.int().min(0).max(7)]);

const LsbParams = z.strictObject({ bitsPerChannel: z.int().min(1).max(8).default(1) });

const KochZhaoParams = z
  .strictObject({
    pair: z.tuple([Position, Position]).default([
      [3, 2],
      [2, 3],
    ]),
    strength: z.number().gt(0).max(1024).default(40),
  })
  .refine(
    ({ pair }) => pair.every(([u, v]) => u !== 0 || v !== 0),
    "The DC coefficient cannot be used",
  )
  .refine(({ pair: [a, b] }) => a[0] !== b[0] || a[1] !== b[1], "The two positions must differ");

// Rounding to 8-bit pixels moves a level-L coefficient by up to 2^L / 2, so the step has to exceed 2^(L+1).
const DwtQimParams = z
  .strictObject({
    band: z.enum(["LL", "HL", "LH"]).default("LL"),
    level: z.int().min(1).max(8).default(2),
    step: z.number().gt(0).max(255).default(32),
  })
  .refine(({ level, step }) => step > 2 ** (level + 1), "The step must exceed 2^(level + 1)");

const ErrorCorrection = z.discriminatedUnion("code", [
  z.strictObject({
    code: z.literal("repetition"),
    factor: z
      .int()
      .min(3)
      .max(15)
      .refine((n) => n % 2 === 1),
  }),
  z.strictObject({ code: z.literal("hamming74") }),
]);

/** One entry per method; a new method is a new entry here and in the engine's registry. */
const METHOD_SELECTIONS = {
  lsb: z.strictObject({
    id: z.literal("lsb"),
    params: LsbParams.prefault({}),
    ecc: ErrorCorrection.optional(),
  }),
  "dct-koch-zhao": z.strictObject({
    id: z.literal("dct-koch-zhao"),
    params: KochZhaoParams.prefault({}),
    ecc: ErrorCorrection.optional(),
  }),
  "dwt-qim": z.strictObject({
    id: z.literal("dwt-qim"),
    params: DwtQimParams.prefault({}),
    ecc: ErrorCorrection.optional(),
  }),
} satisfies Record<StegoMethod, z.ZodType>;

/** A method with its parameters (defaults fill the gaps) and an optional error-correcting code. */
export const MethodSelection = z.discriminatedUnion("id", [
  METHOD_SELECTIONS.lsb,
  METHOD_SELECTIONS["dct-koch-zhao"],
  METHOD_SELECTIONS["dwt-qim"],
]);
export type MethodSelection = z.output<typeof MethodSelection>;

/** What `decode` tries for `"auto"`: every method with its default parameters and no error correction. */
export const AUTO_SELECTIONS: readonly MethodSelection[] = StegoMethod.options.map((id) =>
  MethodSelection.parse({ id }),
);
