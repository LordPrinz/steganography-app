import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createMemoryRefreshTokenRepository, createMemoryUserRepository } from "./auth.memory.ts";
import {
  createRefreshTokenRepository,
  createUserRepository,
  type RefreshTokenRepository,
  type UserRepository,
} from "./auth.ts";
import { createTestDatabase } from "./testing.ts";

// Shared contract: the Postgres repositories and the in-memory fakes the API tests use must agree.
// The Postgres run needs TEST_DATABASE_URL.
const testDb = createTestDatabase(4);
const sql = testDb?.sql;

beforeAll(async () => {
  await testDb?.setup();
});

afterAll(async () => {
  await testDb?.teardown();
});

interface Repos {
  users: UserRepository;
  tokens: RefreshTokenRepository;
}

const adapters: [string, () => Promise<Repos>][] = [
  [
    "memory",
    async () => ({
      users: createMemoryUserRepository(),
      tokens: createMemoryRefreshTokenRepository(),
    }),
  ],
];
if (sql) {
  adapters.push([
    "postgres",
    async () => {
      await sql`TRUNCATE users CASCADE`;
      return { users: createUserRepository(sql), tokens: createRefreshTokenRepository(sql) };
    },
  ]);
}

const inAnHour = () => new Date(Date.now() + 3_600_000);
const next = (tokenHash: string) => ({ tokenHash, expiresAt: inAnHour() });

describe.each(adapters)("auth repositories (%s)", (_name, make) => {
  let users: UserRepository;
  let tokens: RefreshTokenRepository;
  let userId: string;

  beforeEach(async () => {
    ({ users, tokens } = await make());
    const user = await users.create("a@x.io", "hash");
    if (!user) throw new Error("setup: user not created");
    userId = user.id;
  });

  test("create returns null for a taken e-mail; find by e-mail and id", async () => {
    expect(await users.create("a@x.io", "other")).toBeNull();
    expect((await users.findByEmail("a@x.io"))?.id).toBe(userId);
    expect((await users.findById(userId))?.password_hash).toBe("hash");
    expect(await users.findByEmail("b@x.io")).toBeNull();
  });

  test("rotate replaces a live token, and the new one rotates in turn", async () => {
    await tokens.issue(userId, next("t1"));
    expect(await tokens.rotate("t1", next("t2"))).toEqual({ status: "rotated", userId });
    expect(await tokens.rotate("t2", next("t3"))).toEqual({ status: "rotated", userId });
  });

  test("reusing a rotated token revokes every session of the user", async () => {
    await tokens.issue(userId, next("t1"));
    await tokens.issue(userId, next("other-device"));
    await tokens.rotate("t1", next("t2"));

    expect(await tokens.rotate("t1", next("t3"))).toEqual({ status: "reused", userId });
    expect(await tokens.rotate("t2", next("t4"))).toEqual({ status: "invalid" });
    expect(await tokens.rotate("other-device", next("t5"))).toEqual({ status: "invalid" });
  });

  test("concurrent rotations of one token let exactly one through", async () => {
    await tokens.issue(userId, next("t1"));
    const results = await Promise.all([
      tokens.rotate("t1", next("a")),
      tokens.rotate("t1", next("b")),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["reused", "rotated"]);
  });

  test("a revoked, expired or unknown token is invalid and revokes nothing else", async () => {
    await tokens.issue(userId, next("logged-out"));
    await tokens.issue(userId, { tokenHash: "expired", expiresAt: new Date(Date.now() - 1_000) });
    await tokens.issue(userId, next("live"));
    await tokens.revoke("logged-out");

    for (const hash of ["logged-out", "expired", "unknown"]) {
      expect(await tokens.rotate(hash, next(`${hash}-next`))).toEqual({ status: "invalid" });
    }
    expect(await tokens.rotate("live", next("live-next"))).toEqual({ status: "rotated", userId });
  });
});
