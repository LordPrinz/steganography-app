import {
  createMemoryImageRepository,
  createMemoryOperationRepository,
  createMemoryRefreshTokenRepository,
  createMemoryUserRepository,
} from "@stego/db/testing";
import { createMemoryStore } from "@stego/kv";
import { createMemoryObjectStore } from "@stego/storage";
import type { ServerDeps } from "../app.ts";

export const TEST_ORIGIN = "http://localhost:3000";
export const TEST_JWT_SECRET = "test-secret-that-is-at-least-32-chars";

/** Server dependencies backed by in-memory fakes; override any of them per test. */
export function testServerDeps(overrides: Partial<ServerDeps> = {}): ServerDeps {
  return {
    port: 0,
    kv: createMemoryStore(),
    storage: createMemoryObjectStore(),
    users: createMemoryUserRepository(),
    images: createMemoryImageRepository(),
    operations: createMemoryOperationRepository(),
    refreshTokens: createMemoryRefreshTokenRepository(),
    jwtSecret: TEST_JWT_SECRET,
    appOrigin: TEST_ORIGIN,
    trustedProxies: new Set(),
    ...overrides,
  };
}
