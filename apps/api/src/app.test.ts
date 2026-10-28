import { afterAll, describe, expect, test } from "bun:test";
import { ApiError, HealthResponse } from "@stego/contracts";
import { createServer } from "./app.ts";

const server = createServer(0);
afterAll(() => server.stop(true));

describe("api", () => {
  test("GET /api/v1/health", async () => {
    const res = await fetch(new URL("/api/v1/health", server.url));
    expect(res.status).toBe(200);
    expect(HealthResponse.parse(await res.json()).status).toBe("ok");
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
