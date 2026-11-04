import { describe, expect, test } from "bun:test";
import { createMemoryStore } from "./kv/memory.ts";
import { createRateLimiter } from "./rate-limit.ts";

function fakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("rate limiter", () => {
  test("allows up to the limit, then blocks with a retry delay", async () => {
    const clock = fakeClock();
    const limiter = createRateLimiter(createMemoryStore(clock.now), {
      name: "login",
      limit: 2,
      windowMs: 60_000,
    });

    expect(await limiter.hit("1.2.3.4")).toEqual({ allowed: true, remaining: 1, retryAfterMs: 0 });
    expect(await limiter.hit("1.2.3.4")).toEqual({ allowed: true, remaining: 0, retryAfterMs: 0 });
    clock.advance(10_000);
    expect(await limiter.hit("1.2.3.4")).toEqual({
      allowed: false,
      remaining: 0,
      retryAfterMs: 50_000,
    });
  });

  test("the window resets", async () => {
    const clock = fakeClock();
    const limiter = createRateLimiter(createMemoryStore(clock.now), {
      name: "login",
      limit: 1,
      windowMs: 1_000,
    });
    await limiter.hit("a");
    expect((await limiter.hit("a")).allowed).toBe(false);
    clock.advance(1_000);
    expect((await limiter.hit("a")).allowed).toBe(true);
  });

  test("ids and limiter names are counted separately", async () => {
    const store = createMemoryStore();
    const login = createRateLimiter(store, { name: "login", limit: 1, windowMs: 60_000 });
    const upload = createRateLimiter(store, { name: "upload", limit: 1, windowMs: 60_000 });
    await login.hit("a");
    expect((await login.hit("b")).allowed).toBe(true);
    expect((await upload.hit("a")).allowed).toBe(true);
  });

  test("rejects a bad name, limit or window", () => {
    const store = createMemoryStore();
    const make = (o: { name?: string; limit?: number; windowMs?: number }) => () =>
      createRateLimiter(store, { name: "x", limit: 1, windowMs: 1_000, ...o });
    expect(make({ name: "login:a" })).toThrow(RangeError);
    expect(make({ limit: 0 })).toThrow(RangeError);
    expect(make({ windowMs: 0 })).toThrow(RangeError);
  });
});

describe("rate limiter keys", () => {
  test("hashes the id, so the raw value never reaches the store", async () => {
    const keys: string[] = [];
    const store = createMemoryStore();
    const spy = {
      ...store,
      increment: (key: string, ttlMs: number) => {
        keys.push(key);
        return store.increment(key, ttlMs);
      },
    };
    const limiter = createRateLimiter(spy, { name: "login", limit: 5, windowMs: 1_000 });
    await limiter.hit("alice@example.com");
    await limiter.hit("x".repeat(10_000));

    expect(keys[0]).toMatch(/^ratelimit:login:[0-9a-f]{64}$/);
    expect(keys[0]).not.toContain("alice");
    expect(keys[1]?.length).toBe(keys[0]?.length);
  });
});
