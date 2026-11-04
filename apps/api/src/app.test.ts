import { afterAll, describe, expect, test } from "bun:test";
import { ApiError, HealthResponse, ReadinessResponse } from "@stego/contracts";
import { createServer } from "./app.ts";
import { createMemoryStore } from "./lib/kv/memory.ts";

const kv = createMemoryStore();
const server = createServer({ port: 0, kv });
const down = createServer({ port: 0, kv: { ...kv, ping: async () => false } });
afterAll(() => {
  server.stop(true);
  down.stop(true);
});

describe("api", () => {
  test("GET /api/v1/health", async () => {
    const res = await fetch(new URL("/api/v1/health", server.url));
    expect(res.status).toBe(200);
    expect(HealthResponse.parse(await res.json()).status).toBe("ok");
  });

  test("GET /api/v1/health/ready reports Redis up", async () => {
    const res = await fetch(new URL("/api/v1/health/ready", server.url));
    expect(res.status).toBe(200);
    expect(ReadinessResponse.parse(await res.json())).toEqual({
      status: "ready",
      checks: { redis: "up" },
    });
  });

  test("GET /api/v1/health/ready returns 503 when Redis is down", async () => {
    const res = await fetch(new URL("/api/v1/health/ready", down.url));
    expect(res.status).toBe(503);
    expect(ReadinessResponse.parse(await res.json()).checks.redis).toBe("down");
  });

  test("the unversioned path is gone", async () => {
    const res = await fetch(new URL("/api/health", server.url));
    expect(res.status).toBe(404);
  });

  test("unknown route returns a JSON 404", async () => {
    const res = await fetch(new URL("/api/nope", server.url));
    expect(res.status).toBe(404);
    expect(ApiError.parse(await res.json()).error.code).toBe("not_found");
  });
});
