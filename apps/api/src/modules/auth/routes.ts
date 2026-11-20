import { type AuthResponse, type AuthUser, LoginRequest, RegisterRequest } from "@stego/contracts";
import type { BunRequest, CookieInit, Server } from "bun";
import { clientIp, ipBucket } from "../../lib/client-ip.ts";
import { API_PREFIX, errorResponse, HttpError, json, parseBody } from "../../lib/http.ts";
import type { KeyValueStore } from "../../lib/kv/store.ts";
import {
  createRateLimiter,
  type RateLimiter,
  type RateLimitOptions,
  type RateLimitResult,
} from "../../lib/rate-limit.ts";
import type { AuthService, Session } from "./service.ts";

export const ACCESS_COOKIE = "access_token";
export const REFRESH_COOKIE = "refresh_token";

const MINUTE = 60_000;

/**
 * Fixed windows (ADR 0003). IPs are bucketed by `ipBucket` (IPv6 per /64). Login failures are counted
 * per e-mail and IP and only failures count, so another client's wrong guesses never get a user a 429.
 * Failures per account are counted too, but they slow logins down (`loginDelayMs`) instead of blocking.
 */
export const AUTH_RATE_LIMITS = {
  loginIp: { name: "login-ip", limit: 20, windowMs: 15 * MINUTE },
  loginFailures: { name: "login-failures", limit: 10, windowMs: 15 * MINUTE },
  loginAccountFailures: { name: "login-account-failures", limit: 100, windowMs: 60 * MINUTE },
  registerIp: { name: "register-ip", limit: 5, windowMs: 60 * MINUTE },
  refreshIp: { name: "refresh-ip", limit: 60, windowMs: 15 * MINUTE },
} satisfies Record<string, RateLimitOptions>;

const LOGIN_DELAY_STEP_MS = 100;
const MAX_LOGIN_DELAY_MS = 3_000;

/**
 * Delay before answering a login for an account with this many recent failures: none up to the
 * account limit, then 100 ms more per failure, capped at 3 s. It slows guessing spread over many IPs
 * without locking the owner out.
 */
export function loginDelayMs(accountFailures: number): number {
  const over = accountFailures - AUTH_RATE_LIMITS.loginAccountFailures.limit;
  return over <= 0 ? 0 : Math.min(MAX_LOGIN_DELAY_MS, over * LOGIN_DELAY_STEP_MS);
}

export interface AuthRoutesDeps {
  auth: AuthService;
  kv: KeyValueStore;
  accessTtlSeconds: number;
  refreshTtlMs: number;
  /** Secure cookies need HTTPS; true whenever the app origin is https. */
  secureCookies: boolean;
  /** Peers whose `X-Client-IP` header is believed (see `clientIp`). */
  trustedProxies: ReadonlySet<string>;
}

/** The guard every protected endpoint calls: the current user, or a 401. */
export type RequireUser = (req: BunRequest) => Promise<AuthUser>;

export function createRequireUser(auth: AuthService): RequireUser {
  return async (req) => {
    const token = req.cookies.get(ACCESS_COOKIE);
    const user = token ? await auth.authenticate(token) : null;
    if (!user) throw new HttpError(401, "unauthorized", "Authentication required");
    return user;
  };
}

export function authRoutes({
  auth,
  kv,
  accessTtlSeconds,
  refreshTtlMs,
  secureCookies,
  trustedProxies,
}: AuthRoutesDeps) {
  const limiters = Object.fromEntries(
    Object.entries(AUTH_RATE_LIMITS).map(([key, options]) => [key, createRateLimiter(kv, options)]),
  ) as Record<keyof typeof AUTH_RATE_LIMITS, RateLimiter>;
  const requireUser = createRequireUser(auth);
  const ip = (req: Request, server: Server<unknown>) =>
    ipBucket(clientIp(req, server, trustedProxies));

  // The refresh cookie only travels to the auth endpoints; the access cookie to the whole API.
  const accessCookie: CookieInit = {
    path: API_PREFIX,
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookies,
  };
  const refreshCookie: CookieInit = { ...accessCookie, path: `${API_PREFIX}/auth` };

  function setSession(req: BunRequest, session: Session): Response {
    req.cookies.set(ACCESS_COOKIE, session.accessToken, {
      ...accessCookie,
      maxAge: accessTtlSeconds,
    });
    req.cookies.set(REFRESH_COOKIE, session.refreshToken, {
      ...refreshCookie,
      maxAge: Math.floor(refreshTtlMs / 1000),
    });
    return json<AuthResponse>({ user: session.user });
  }

  function clearSession(req: BunRequest): void {
    req.cookies.delete({ name: ACCESS_COOKIE, path: accessCookie.path });
    req.cookies.delete({ name: REFRESH_COOKIE, path: refreshCookie.path });
  }

  return {
    "/auth/register": {
      POST: async (req: BunRequest, server: Server<unknown>) => {
        await enforce(() => limiters.registerIp.hit(ip(req, server)));
        const { email, password } = await parseBody(req, RegisterRequest);
        await auth.register(email, password);
        return new Response(null, { status: 202 });
      },
    },

    "/auth/login": {
      POST: async (req: BunRequest, server: Server<unknown>) => {
        const from = ip(req, server);
        await enforce(() => limiters.loginIp.hit(from));
        const { email, password } = await parseBody(req, LoginRequest);
        const failureKey = JSON.stringify([email, from]);
        await enforce(() => limiters.loginFailures.peek(failureKey));
        // Applied whatever the password, so the delay does not hint at whether a guess was right.
        const accountFailures = await limiters.loginAccountFailures
          .peek(email)
          .then((result) => result.count)
          .catch(() => 0);
        await Bun.sleep(loginDelayMs(accountFailures));

        const session = await auth.login(email, password);
        if (!session) {
          await Promise.all([
            limiters.loginFailures.hit(failureKey),
            limiters.loginAccountFailures.hit(email),
          ]).catch((error) => {
            console.error("Rate limiter unavailable; login failure not counted", error);
          });
          throw new HttpError(401, "invalid_credentials", "Invalid e-mail or password");
        }
        return setSession(req, session);
      },
    },

    "/auth/refresh": {
      POST: async (req: BunRequest, server: Server<unknown>) => {
        await enforce(() => limiters.refreshIp.hit(ip(req, server)));
        const token = req.cookies.get(REFRESH_COOKIE);
        const result = token ? await auth.refresh(token) : ({ status: "invalid" } as const);
        if (result.status === "ok") return setSession(req, result.session);
        // A superseded token means another tab just got fresh cookies; clearing them would log it out.
        // Returned, not thrown: Bun only attaches cookie changes to a handler's own response.
        if (result.status === "invalid") clearSession(req);
        return errorResponse(new HttpError(401, "unauthorized", "Session expired"));
      },
    },

    "/auth/logout": {
      POST: async (req: BunRequest) => {
        await auth.logout({
          accessToken: req.cookies.get(ACCESS_COOKIE) ?? undefined,
          refreshToken: req.cookies.get(REFRESH_COOKIE) ?? undefined,
        });
        clearSession(req);
        return new Response(null, { status: 204 });
      },
    },

    "/auth/me": {
      GET: async (req: BunRequest) => json<AuthResponse>({ user: await requireUser(req) }),
    },
  };
}

async function enforce(check: () => Promise<RateLimitResult>): Promise<void> {
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
