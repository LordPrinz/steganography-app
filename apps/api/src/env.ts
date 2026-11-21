import { isIP } from "node:net";
import { z } from "zod";
import { normalizeIp } from "./lib/client-ip.ts";

export const Env = z.object({
  API_PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.url(),
  JWT_SECRET: z
    .string()
    .min(32)
    .refine((secret) => !secret.startsWith("change-me"), {
      message: "JWT_SECRET is still the example value; generate one with `openssl rand -base64 48`",
    }),
  APP_ORIGIN: z
    .url({ protocol: /^https?$/ })
    .default("http://localhost:3000")
    .transform((url) => new URL(url).origin),
  // Comma-separated peer addresses allowed to set X-Client-IP (the Next server behind Caddy).
  TRUSTED_PROXIES: z
    .string()
    .default("")
    .transform((list) =>
      list
        .split(",")
        .map((ip) => normalizeIp(ip.trim()))
        .filter(Boolean),
    )
    .refine((ips) => ips.every((ip) => isIP(ip)), "TRUSTED_PROXIES must list IP addresses")
    .transform((ips) => new Set(ips)),
  S3_ENDPOINT: z.url(),
  S3_REGION: z.string().default("auto"),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
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
