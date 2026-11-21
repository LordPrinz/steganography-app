import { z } from "zod";
import { type Attack, Scenario } from "./attacks.ts";
import { StegoMethod } from "./methods.ts";
import { LayerList, MethodSelection } from "./selections.ts";

/** Largest image an experiment accepts, in pixels: the lab runs every attack on it, many times. */
export const EXPERIMENT_MAX_PIXELS = 1024 * 1024;
/** Most method x scenario runs (and stored attacked images) one experiment produces. */
export const MAX_EXPERIMENT_VARIANTS = 36;
/** Most scenarios a mode B request may choose. */
export const MAX_MODE_B_SCENARIOS = 16;
/** Most attacks across all scenarios of a mode B request: a scenario may chain up to 8. */
export const MAX_MODE_B_ATTACK_STEPS = 48;
/** Shortest image side an experiment accepts: SSIM needs an 11 x 11 window. */
export const EXPERIMENT_MIN_SIDE = 11;
/** Live (not yet expired) variant bytes one user may hold; beyond it variants are not stored. */
export const MAX_USER_VARIANT_BYTES = 512 * 1024 * 1024;

/** Mode A runs every one of these against every method. `[]` is the baseline without an attack. */
export const DEFAULT_SCENARIOS: readonly Scenario[] = [
  [],
  [{ type: "jpeg", quality: 90 }],
  [{ type: "jpeg", quality: 75 }],
  [{ type: "jpeg", quality: 50 }],
  [{ type: "resize", scale: 0.75 }],
  [{ type: "resize", scale: 0.5 }],
  [{ type: "blur", sigma: 0.5 }],
  [{ type: "blur", sigma: 1 }],
  [{ type: "blur", sigma: 2 }],
  [
    { type: "resize", scale: 0.5 },
    { type: "jpeg", quality: 75 },
  ],
  [
    { type: "blur", sigma: 1 },
    { type: "jpeg", quality: 75 },
  ],
].map((scenario) => Scenario.parse(scenario));

/** `none` or the attacks joined with `+`, e.g. `jpeg75` or `resize0.5+jpeg75`. */
export function scenarioLabel(scenario: Scenario): string {
  if (scenario.length === 0) return "none";
  return scenario.map(attackLabel).join("+");
}

function attackLabel(attack: Attack): string {
  if (attack.type === "jpeg") return `jpeg${attack.quality}`;
  if (attack.type === "resize") return `resize${attack.scale}`;
  return `blur${attack.sigma}`;
}

/** 1 to 16 scenarios that chain at most 48 attacks in total. */
const ScenarioList = z
  .array(Scenario)
  .min(1)
  .max(MAX_MODE_B_SCENARIOS)
  .refine(
    (scenarios) =>
      scenarios.reduce((sum, { length }) => sum + length, 0) <= MAX_MODE_B_ATTACK_STEPS,
    `At most ${MAX_MODE_B_ATTACK_STEPS} attacks across all scenarios`,
  );

/**
 * Mode A: every method with its defaults against the default scenarios. Mode B: one method (with
 * parameters and an optional error-correcting code) against the scenarios chosen. Mode "layered": 1 to
 * 3 methods, each with its own message, hidden together in one image by `hideLayered`, against the
 * scenarios chosen; every layer is measured on its own. The message has no length cap here, as for
 * encode: it is checked against the capacity of every method it runs.
 */
export const ExperimentRequest = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("A"), imageId: z.uuid(), message: z.string().min(1) }),
  z.strictObject({
    mode: z.literal("B"),
    imageId: z.uuid(),
    message: z.string().min(1),
    method: MethodSelection,
    scenarios: ScenarioList,
  }),
  z.strictObject({
    mode: z.literal("layered"),
    imageId: z.uuid(),
    layers: LayerList,
    scenarios: ScenarioList,
  }),
]);
export type ExperimentRequest = z.infer<typeof ExperimentRequest>;

export const ExperimentMode = z.enum(["A", "B", "layered"]);
export type ExperimentMode = z.infer<typeof ExperimentMode>;

/**
 * What the experiment job reads from `operations.params`; the message is never part of it. The API
 * expands mode A into explicit lists, so a later change of the defaults cannot alter a queued job.
 */
export const ExperimentParams = z.object({
  mode: ExperimentMode,
  /** In request order; for "layered" these are the layers, hidden together. */
  methods: z.array(MethodSelection).min(1),
  scenarios: z.array(Scenario).min(1),
});
export type ExperimentParams = z.infer<typeof ExperimentParams>;

export const EccCode = z.enum(["repetition", "hamming74"]);
export type EccCode = z.infer<typeof EccCode>;

/** One method x scenario run. PSNR and SSIM compare the attacked image with the cover. */
export const ExperimentVariant = z.object({
  method: StegoMethod,
  /** The error-correcting code used, if any. */
  ecc: EccCode.nullable(),
  scenario: Scenario,
  /** `scenarioLabel(scenario)`. */
  label: z.string(),
  /** The message was read back intact. */
  success: z.boolean(),
  /** Bit error rate over the payload bits, after error correction. */
  ber: z.number().min(0).max(1),
  /** Bit error rate of the raw channel under the code; null without error correction. */
  channelBer: z.number().min(0).max(1).nullable(),
  /** dB; null when the attacked image has the same luminance as the cover. */
  psnr: z.number().nullable(),
  ssim: z.number(),
  /** Milliseconds to attack the image and read the message back. */
  timeMs: z.number().nonnegative(),
  /**
   * The stored attacked image; null when it could not be stored (too large, or over the storage cap).
   * In layered mode all layers of a scenario share one image.
   */
  imageId: z.uuid().nullable(),
});
export type ExperimentVariant = z.infer<typeof ExperimentVariant>;

/**
 * What embedding did, before any attack. In layered mode the PSNR, SSIM and time are those of the
 * whole image with every layer, so they repeat on each layer's entry.
 */
export const ExperimentMethodSummary = z.object({
  method: StegoMethod,
  ecc: EccCode.nullable(),
  capacityBytes: z.number().int().nonnegative(),
  /** dB; null when the stego image has the same luminance as the cover. */
  stegoPsnr: z.number().nullable(),
  stegoSsim: z.number(),
  encodeMs: z.number().nonnegative(),
});
export type ExperimentMethodSummary = z.infer<typeof ExperimentMethodSummary>;

export const AttackGroup = z.enum(["none", "jpeg", "resize", "blur", "combined"]);
export type AttackGroup = z.infer<typeof AttackGroup>;

/** Variants of one method under one scenario, ready for a table and a line chart (x = strength). */
export const ExperimentAggregate = z.object({
  method: StegoMethod,
  ecc: EccCode.nullable(),
  attack: AttackGroup,
  /** JPEG quality, resize scale or blur sigma of a single attack; null for none and combined. */
  strength: z.number().nullable(),
  label: z.string(),
  successRate: z.number().min(0).max(1),
  meanBer: z.number().min(0).max(1),
  variants: z.number().int().positive(),
});
export type ExperimentAggregate = z.infer<typeof ExperimentAggregate>;

export const ExperimentResult = z.object({
  kind: z.literal("experiment"),
  mode: ExperimentMode,
  /** UTF-8 bytes of the message; the sum over the layers in layered mode. */
  messageBytes: z.number().int().nonnegative(),
  methods: z.array(ExperimentMethodSummary),
  variants: z.array(ExperimentVariant),
  aggregates: z.array(ExperimentAggregate),
});
export type ExperimentResult = z.infer<typeof ExperimentResult>;

/** What the history list shows of an experiment: no per-variant rows and no aggregates. */
export const ExperimentResultSummary = ExperimentResult.omit({ variants: true, aggregates: true });
export type ExperimentResultSummary = z.infer<typeof ExperimentResultSummary>;

export const ExperimentProgress = z.object({
  done: z.number().int().nonnegative(),
  total: z.number().int().positive(),
});
export type ExperimentProgress = z.infer<typeof ExperimentProgress>;
