import { assertTtl, type KeyValueStore } from "./kv/store.ts";

export interface RateLimitOptions {
  /** Separates limiters, e.g. "login". Lowercase letters, digits and dashes. */
  name: string;
  /** Requests allowed per window. */
  limit: number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** 0 when allowed; otherwise how long until the window resets (for `Retry-After`). */
  retryAfterMs: number;
}

export interface RateLimiter {
  /** Counts one request for `id` (an IP, an e-mail…) and says whether it may proceed. */
  hit(id: string): Promise<RateLimitResult>;
}

// SHA-256 keeps keys a fixed size whatever the caller sends, and keeps e-mails and IPs out of Redis.
function digest(id: string): string {
  return new Bun.CryptoHasher("sha256").update(id).digest("hex");
}

/** Fixed-window rate limiter; the window is shared by every API instance using the same store. */
export function createRateLimiter(
  store: KeyValueStore,
  { name, limit, windowMs }: RateLimitOptions,
): RateLimiter {
  // No ":" in the name, so "login" + "a:b" can never collide with "login:a" + "b".
  if (!/^[a-z0-9-]+$/.test(name)) throw new RangeError(`invalid limiter name "${name}"`);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`limit must be a positive integer, got ${limit}`);
  }
  assertTtl(windowMs);

  return {
    async hit(id) {
      const { count, ttlMs } = await store.increment(`ratelimit:${name}:${digest(id)}`, windowMs);
      const allowed = count <= limit;
      return {
        allowed,
        remaining: Math.max(0, limit - count),
        retryAfterMs: allowed ? 0 : Math.max(0, ttlMs),
      };
    },
  };
}
