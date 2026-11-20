import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  createRefreshTokenRepository,
  createUserRepository,
  type RefreshTokenRepository,
  type RefreshTokenRepositoryOptions,
  type UserRepository,
} from "./auth.ts";
import {
  createMemoryRefreshTokenRepository,
  createMemoryUserRepository,
  createTestDatabase,
} from "./testing/index.ts";

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

type Make = (options?: RefreshTokenRepositoryOptions) => Promise<Repos>;

const adapters: [string, Make][] = [
  [
    "memory",
    async (options) => ({
      users: createMemoryUserRepository(),
      tokens: createMemoryRefreshTokenRepository(options),
    }),
  ],
];
if (sql) {
  adapters.push([
    "postgres",
    async (options) => {
      await sql`TRUNCATE users CASCADE`;
      return {
        users: createUserRepository(sql),
        tokens: createRefreshTokenRepository(sql, options),
      };
    },
  ]);
}

const inAnHour = () => new Date(Date.now() + 3_600_000);
const next = (tokenHash: string) => ({ tokenHash, expiresAt: inAnHour() });

describe.each(adapters)("auth repositories (%s)", (_name, make) => {
  let users: UserRepository;
  let tokens: RefreshTokenRepository;
  let userId: string;

  async function setup(options?: RefreshTokenRepositoryOptions) {
    ({ users, tokens } = await make(options));
    const user = await users.create("a@x.io", "hash");
    if (!user) throw new Error("setup: user not created");
    userId = user.id;
  }

  beforeEach(() => setup());

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

  test("reusing a rotated token after the grace window revokes every session of the user", async () => {
    await setup({ reuseGraceMs: 100 });
    await tokens.issue(userId, next("t1"));
    await tokens.issue(userId, next("other-device"));
    await tokens.rotate("t1", next("t2"));
    await Bun.sleep(150);

    expect(await tokens.rotate("t1", next("t3"))).toEqual({ status: "reused", userId });
    expect(await tokens.rotate("t2", next("t4"))).toEqual({ status: "invalid" });
    expect(await tokens.rotate("other-device", next("t5"))).toEqual({ status: "invalid" });
  });

  test("a rotated token presented within the grace window is refused but revokes nothing", async () => {
    await tokens.issue(userId, next("t1"));
    await tokens.rotate("t1", next("t2"));
    expect(await tokens.rotate("t1", next("t3"))).toEqual({ status: "superseded" });
    expect(await tokens.rotate("t2", next("t4"))).toEqual({ status: "rotated", userId });
  });

  test("concurrent rotations of one token let exactly one through", async () => {
    await tokens.issue(userId, next("t1"));
    const results = await Promise.all([
      tokens.rotate("t1", next("a")),
      tokens.rotate("t1", next("b")),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["rotated", "superseded"]);
  });

  test("without a grace window the loser of a concurrent rotation revokes the winner's token", async () => {
    await setup({ reuseGraceMs: 0 });
    await tokens.issue(userId, next("t1"));
    const results = await Promise.all([
      tokens.rotate("t1", next("a")),
      tokens.rotate("t1", next("b")),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["reused", "rotated"]);
    // The family revocation saw the successor inserted by the concurrent rotation.
    expect(await tokens.rotate("a", next("a2"))).toEqual({ status: "invalid" });
    expect(await tokens.rotate("b", next("b2"))).toEqual({ status: "invalid" });
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
