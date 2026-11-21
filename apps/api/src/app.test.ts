import { afterAll, describe, expect, test } from "bun:test";
import { ApiError, HealthResponse, ReadinessResponse } from "@stego/contracts";
import { createMemoryObjectStore } from "@stego/storage";
import { createServer } from "./app.ts";
import { createMemoryStore } from "./lib/kv/memory.ts";
import { testServerDeps } from "./testing/server-deps.ts";

const kv = createMemoryStore();
const storage = createMemoryObjectStore();
const server = createServer(testServerDeps({ kv, storage }));
const redisDown = createServer(testServerDeps({ kv: { ...kv, ping: async () => false }, storage }));
const storageDown = createServer(
  testServerDeps({ kv, storage: { ...storage, ping: async () => false } }),
);
afterAll(() => {
  server.stop(true);
  redisDown.stop(true);
  storageDown.stop(true);
});

describe("api", () => {
  test("GET /api/v1/health", async () => {
    const res = await fetch(new URL("/api/v1/health", server.url));
    expect(res.status).toBe(200);
    expect(HealthResponse.parse(await res.json()).status).toBe("ok");
  });

  test("GET /api/v1/health/ready reports Redis and storage up", async () => {
    const res = await fetch(new URL("/api/v1/health/ready", server.url));
    expect(res.status).toBe(200);
    expect(ReadinessResponse.parse(await res.json())).toEqual({
      status: "ready",
      checks: { redis: "up", storage: "up" },
    });
  });

  test("GET /api/v1/health/ready returns 503 when Redis is down", async () => {
    const res = await fetch(new URL("/api/v1/health/ready", redisDown.url));
    expect(res.status).toBe(503);
    expect(ReadinessResponse.parse(await res.json()).checks).toEqual({
      redis: "down",
      storage: "up",
    });
  });

  test("GET /api/v1/health/ready returns 503 when the bucket is down", async () => {
    const res = await fetch(new URL("/api/v1/health/ready", storageDown.url));
    expect(res.status).toBe(503);
    expect(ReadinessResponse.parse(await res.json()).checks).toEqual({
      redis: "up",
      storage: "down",
    });
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
