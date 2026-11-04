import { z } from "zod";

const Env = z.object({
  DATABASE_URL: z.url(),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().max(60_000).default(1_000),
  WORKER_JOB_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .max(2 ** 31 - 1)
    .default(10 * 60_000),
});
export type Env = z.infer<typeof Env>;

export function loadEnv(source: Record<string, string | undefined> = Bun.env): Env {
  const parsed = Env.safeParse(source);
  if (!parsed.success) {
    console.error(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
    process.exit(1);
  }
  return parsed.data;
}
