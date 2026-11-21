import { HttpError } from "./http.ts";
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
  /** Requests counted in the current window, including this one for `hit`. */
  count: number;
  remaining: number;
  /** 0 when allowed; otherwise how long until the window resets (for `Retry-After`). */
  retryAfterMs: number;
}

export interface RateLimiter {
  /** Counts one request for `id` (an IP, an e-mail…) and says whether it may proceed. */
  hit(id: string): Promise<RateLimitResult>;
  /**
   * Says whether `id` is over the limit without counting a request, for limits that count only
   * failures. Retry-After is then the full window, an upper bound: the store does not expose the TTL.
   */
  peek(id: string): Promise<RateLimitResult>;
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

  const key = (id: string) => `ratelimit:${name}:${digest(id)}`;

  return {
    async hit(id) {
      const { count, ttlMs } = await store.increment(key(id), windowMs);
      const allowed = count <= limit;
      return {
        allowed,
        count,
        remaining: Math.max(0, limit - count),
        retryAfterMs: allowed ? 0 : Math.max(0, ttlMs),
      };
    },
    async peek(id) {
      const count = Number((await store.get(key(id))) ?? 0);
      const allowed = count < limit;
      return {
        allowed,
        count,
        remaining: Math.max(0, limit - count),
        retryAfterMs: allowed ? 0 : windowMs,
      };
    },
  };
}

/** Throws a 429 with `Retry-After` when over the limit. While the store is down, requests pass. */
export async function enforce(check: () => Promise<RateLimitResult>): Promise<void> {
  let result: RateLimitResult;
  try {
    result = await check();
  } catch (error) {
    // ADR 0003: counters live in Redis. While it is down, requests pass rather than locking everyone out.
    console.error("Rate limiter unavailable; letting the request through", error);
    return;
  }
  if (!result.allowed) {
    const retryAfter = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
    throw new HttpError(429, "rate_limited", "Too many requests", undefined, {
      "Retry-After": String(retryAfter),
    });
  }
}
