import { z } from "zod";

/** One attack of the robustness lab. Parameters are relative, so a scenario fits any image. */
export const Attack = z.discriminatedUnion("type", [
  z.object({ type: z.literal("jpeg"), quality: z.int().min(1).max(100) }),
  /** Scales both sides by `scale`; the lab scales back to the original size before decoding. */
  z.object({ type: z.literal("resize"), scale: z.number().min(0.1).max(1) }),
  z.object({ type: z.literal("blur"), sigma: z.number().gt(0).max(10) }),
]);
export type Attack = z.infer<typeof Attack>;
export type AttackType = Attack["type"];

/** Attacks applied in order. Empty means no attack, the baseline of an experiment. */
export const Scenario = z.array(Attack).max(8);
export type Scenario = z.infer<typeof Scenario>;
