import { describe, expect, test } from "bun:test";
import { Env } from "./env.ts";

const valid = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  JWT_SECRET: "0123456789abcdef0123456789abcdef0123456789",
  S3_ENDPOINT: "http://localhost:9000",
  S3_BUCKET: "stego",
  S3_ACCESS_KEY_ID: "k",
  S3_SECRET_ACCESS_KEY: "s",
  REDIS_URL: "redis://localhost:6379/0",
};

describe("env", () => {
  test("JWT_SECRET must be long and not the example value", () => {
    expect(Env.safeParse(valid).success).toBe(true);
    expect(Env.safeParse({ ...valid, JWT_SECRET: "short" }).success).toBe(false);
    const example = Env.safeParse({ ...valid, JWT_SECRET: "change-me-to-a-long-random-string" });
    expect(example.success).toBe(false);
    expect(example.error?.issues[0]?.message).toContain("openssl rand -base64 48");
  });

  test("TRUSTED_PROXIES is a normalised set of IPs, empty by default", () => {
    expect(Env.parse(valid).TRUSTED_PROXIES).toEqual(new Set());
    const parsed = Env.parse({ ...valid, TRUSTED_PROXIES: " 127.0.0.1, ::1 ,::FFFF:10.0.0.5" });
    expect(parsed.TRUSTED_PROXIES).toEqual(new Set(["127.0.0.1", "::1", "10.0.0.5"]));
    expect(Env.safeParse({ ...valid, TRUSTED_PROXIES: "next.internal" }).success).toBe(false);
  });
});
