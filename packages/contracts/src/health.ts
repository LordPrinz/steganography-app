import { z } from "zod";

export const HealthResponse = z.object({
  status: z.literal("ok"),
  version: z.string(),
  uptimeSeconds: z.number().nonnegative(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

export const DependencyStatus = z.enum(["up", "down"]);
export type DependencyStatus = z.infer<typeof DependencyStatus>;

export const ReadinessResponse = z.object({
  status: z.enum(["ready", "unavailable"]),
  checks: z.object({ redis: DependencyStatus }),
});
export type ReadinessResponse = z.infer<typeof ReadinessResponse>;
