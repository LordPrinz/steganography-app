import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { ApiError, AuthResponse } from "@stego/contracts";
import { createRefreshTokenRepository, createUserRepository } from "@stego/db";
import { createTestDatabase } from "@stego/db/testing";
import { createServer, type ServerDeps } from "../../app.ts";
import type { KeyValueStore } from "../../lib/kv/store.ts";
import { TEST_JWT_SECRET, TEST_ORIGIN, testServerDeps } from "../../testing.ts";
import { ACCESS_COOKIE, AUTH_RATE_LIMITS, REFRESH_COOKIE } from "./routes.ts";
import { createAccessTokens } from "./tokens.ts";

// The flows run against the in-memory repositories, and again against Postgres when
// TEST_DATABASE_URL is set.
const testDb = createTestDatabase();
const sql = testDb?.sql;

beforeAll(async () => {
  await testDb?.setup();
});

afterAll(async () => {
  await testDb?.teardown();
});

const backends: [string, () => Promise<Partial<ServerDeps>>][] = [["memory", async () => ({})]];
if (sql) {
  backends.push([
    "postgres",
    async () => {
      await sql`TRUNCATE users CASCADE`;
      return { users: createUserRepository(sql), refreshTokens: createRefreshTokenRepository(sql) };
    },
  ]);
}

const EMAIL = "ann@example.com";
const PASSWORD = "correct horse battery";

/** A browser stand-in: keeps cookies between requests and sends the app's Origin. */
class Client {
  readonly cookies = new Map<string, string>();

  constructor(readonly baseUrl: URL) {}

  async request(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    const res = await fetch(new URL(`/api/v1${path}`, this.baseUrl), {
      method,
      headers: {
        origin: TEST_ORIGIN,
        cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const header of res.headers.getSetCookie()) {
      const cookie = new Bun.Cookie(header);
      if (cookie.isExpired() || cookie.value === "") this.cookies.delete(cookie.name);
      else this.cookies.set(cookie.name, cookie.value);
    }
    return res;
  }

  register(email = EMAIL, password = PASSWORD) {
    return this.request("POST", "/auth/register", { email, password });
  }

  login(email = EMAIL, password = PASSWORD) {
    return this.request("POST", "/auth/login", { email, password });
  }
}

async function errorCode(res: Response): Promise<string> {
  return ApiError.parse(await res.json()).error.code;
}

const servers: ReturnType<typeof createServer>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

describe.each(backends)("auth API (%s)", (_name, backend) => {
  async function start(overrides: Partial<ServerDeps> = {}) {
    const server = createServer(testServerDeps({ ...(await backend()), ...overrides }));
    servers.push(server);
    return new Client(server.url);
  }

  async function loggedIn(overrides: Partial<ServerDeps> = {}) {
    const client = await start(overrides);
    expect((await client.register()).status).toBe(202);
    expect((await client.login()).status).toBe(200);
    return client;
  }

  test("register, login and me", async () => {
    const client = await start();
    expect((await client.register("  Ann@Example.com ")).status).toBe(202);

    const login = await client.login();
    expect(login.status).toBe(200);
    const { user } = AuthResponse.parse(await login.json());
    expect(user.email).toBe(EMAIL);

    const me = await client.request("GET", "/auth/me");
    expect(me.status).toBe(200);
    expect(AuthResponse.parse(await me.json()).user).toEqual(user);
  });

  test("login sets httpOnly, SameSite=Lax cookies scoped to the API", async () => {
    const client = await start();
    await client.register();
    const cookies = (await client.login()).headers.getSetCookie().map((h) => new Bun.Cookie(h));
    const access = cookies.find((c) => c.name === ACCESS_COOKIE);
    const refresh = cookies.find((c) => c.name === REFRESH_COOKIE);
    expect(access?.httpOnly && refresh?.httpOnly).toBe(true);
    expect([access?.sameSite, refresh?.sameSite]).toEqual(["lax", "lax"]);
    expect(access?.path).toBe("/api/v1");
    expect(refresh?.path).toBe("/api/v1/auth");
    expect(access?.maxAge).toBe(15 * 60);
    // The test origin is http, so cookies are not Secure here.
    expect(access?.secure).toBe(false);
  });

  test("cookies are Secure when the app is served over https", async () => {
    const client = await start({ appOrigin: "https://stego.example" });
    await client.request(
      "POST",
      "/auth/register",
      { email: EMAIL, password: PASSWORD },
      {
        origin: "https://stego.example",
      },
    );
    const res = await client.request(
      "POST",
      "/auth/login",
      { email: EMAIL, password: PASSWORD },
      {
        origin: "https://stego.example",
      },
    );
    expect(res.headers.getSetCookie().every((h) => new Bun.Cookie(h).secure)).toBe(true);
  });

  test("registering a taken e-mail looks like a fresh registration", async () => {
    const client = await start();
    const first = await client.register();
    const second = await client.register(EMAIL, "another password");
    expect([first.status, second.status]).toEqual([202, 202]);
    expect(await second.text()).toBe(await first.text());
    // The original password still works; the second one was not applied.
    expect((await client.login()).status).toBe(200);
    expect((await client.login(EMAIL, "another password")).status).toBe(401);
  });

  test("wrong password and unknown e-mail fail the same way", async () => {
    const client = await start();
    await client.register();
    const wrong = await client.login(EMAIL, "wrong password");
    const unknown = await client.login("nobody@example.com", PASSWORD);
    expect([wrong.status, unknown.status]).toEqual([401, 401]);
    expect(await errorCode(wrong)).toBe("invalid_credentials");
    expect(await errorCode(unknown)).toBe("invalid_credentials");
    expect(client.cookies.size).toBe(0);
  });

  test("invalid bodies are 400 and never echo the password", async () => {
    const client = await start();
    const res = await client.register("not-an-email", "short");
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(ApiError.parse(JSON.parse(text)).error.code).toBe("invalid_request");
    expect(text).not.toContain("short");

    const notJson = await client.request("POST", "/auth/login", undefined, {
      "content-type": "application/json",
    });
    expect(notJson.status).toBe(400);
  });

  test("me without a session is 401", async () => {
    const client = await start();
    const res = await client.request("GET", "/auth/me");
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe("unauthorized");
  });

  test("an expired access token is rejected", async () => {
    const client = await loggedIn();
    const me = AuthResponse.parse(await (await client.request("GET", "/auth/me")).json()).user;
    const hourAgo = Date.now() - 3_600_000;
    const expired = createAccessTokens({
      secret: TEST_JWT_SECRET,
      ttlSeconds: 900,
      now: () => hourAgo,
    }).sign(me.id).token;
    client.cookies.set(ACCESS_COOKIE, expired);
    expect((await client.request("GET", "/auth/me")).status).toBe(401);
  });

  test("a tampered access token is rejected", async () => {
    const client = await loggedIn();
    const [header, , signature] = (client.cookies.get(ACCESS_COOKIE) ?? "").split(".");
    const payload = Buffer.from(
      JSON.stringify({ sub: crypto.randomUUID(), jti: "x", iat: 0, exp: 9_999_999_999 }),
    ).toString("base64url");
    client.cookies.set(ACCESS_COOKIE, `${header}.${payload}.${signature}`);
    expect((await client.request("GET", "/auth/me")).status).toBe(401);
  });

  test("refresh rotates both tokens", async () => {
    const client = await loggedIn();
    const before = new Map(client.cookies);
    const res = await client.request("POST", "/auth/refresh");
    expect(res.status).toBe(200);
    expect(AuthResponse.parse(await res.json()).user.email).toBe(EMAIL);
    expect(client.cookies.get(REFRESH_COOKIE)).not.toBe(before.get(REFRESH_COOKIE));
    expect(client.cookies.get(ACCESS_COOKIE)).not.toBe(before.get(ACCESS_COOKIE));
    expect((await client.request("GET", "/auth/me")).status).toBe(200);
  });

  test("reusing a refresh token after rotation revokes the session", async () => {
    const client = await loggedIn();
    const stolen = client.cookies.get(REFRESH_COOKIE) ?? "";
    expect((await client.request("POST", "/auth/refresh")).status).toBe(200);
    const rotated = client.cookies.get(REFRESH_COOKIE) ?? "";

    client.cookies.set(REFRESH_COOKIE, stolen);
    const reuse = await client.request("POST", "/auth/refresh");
    expect(reuse.status).toBe(401);
    expect(client.cookies.has(REFRESH_COOKIE)).toBe(false);

    // The legitimate holder's newer token died with it.
    client.cookies.set(REFRESH_COOKIE, rotated);
    expect((await client.request("POST", "/auth/refresh")).status).toBe(401);
  });

  test("refresh without a cookie is 401", async () => {
    const client = await start();
    expect((await client.request("POST", "/auth/refresh")).status).toBe(401);
  });

  test("logout revokes the refresh token and denylists the access token", async () => {
    const client = await loggedIn();
    const tokens = new Map(client.cookies);
    const res = await client.request("POST", "/auth/logout");
    expect(res.status).toBe(204);
    expect(client.cookies.size).toBe(0);

    // Replay the tokens the browser just dropped: the JWT is unexpired but on the denylist.
    for (const [name, value] of tokens) client.cookies.set(name, value);
    expect((await client.request("GET", "/auth/me")).status).toBe(401);
    expect((await client.request("POST", "/auth/refresh")).status).toBe(401);
  });

  test("logout without a session still succeeds", async () => {
    const client = await start();
    expect((await client.request("POST", "/auth/logout")).status).toBe(204);
  });

  describe("login failures", () => {
    const { limit, windowMs } = AUTH_RATE_LIMITS.loginFailures;
    const from = (ip: string) => ({ "x-forwarded-for": ip });
    const login = (client: Client, ip: string, email = EMAIL, password = "wrong password") =>
      client.request("POST", "/auth/login", { email, password }, from(ip));

    test("repeated failures from one IP get 429 with Retry-After", async () => {
      const client = await start({ trustProxy: true });
      await client.register();
      for (let i = 0; i < limit; i++) {
        expect((await login(client, "10.0.0.1")).status).toBe(401);
      }
      // Any spelling of the address counts against the same bucket, and so does the right password.
      const limited = await login(client, "10.0.0.1", " ANN@example.com", PASSWORD);
      expect(limited.status).toBe(429);
      expect(await errorCode(limited)).toBe("rate_limited");
      const retryAfter = Number(limited.headers.get("retry-after"));
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(windowMs / 1000);
    });

    test("another IP exhausting failures cannot lock the owner out", async () => {
      const client = await start({ trustProxy: true });
      await client.register();
      for (let i = 0; i <= limit; i++) await login(client, "203.0.113.9");
      expect((await login(client, "203.0.113.9", EMAIL, PASSWORD)).status).toBe(429);
      expect((await login(client, "10.0.0.1", EMAIL, PASSWORD)).status).toBe(200);
    });

    test("successful logins do not count as failures", async () => {
      const client = await start({ trustProxy: true });
      await client.register();
      for (let i = 0; i <= limit; i++) {
        expect((await login(client, "10.0.0.1", EMAIL, PASSWORD)).status).toBe(200);
      }
    });
  });

  test("register is rate limited per IP", async () => {
    const client = await start();
    const { limit } = AUTH_RATE_LIMITS.registerIp;
    for (let i = 0; i < limit; i++) {
      expect((await client.register(`user${i}@example.com`)).status).toBe(202);
    }
    const limited = await client.register("one-more@example.com");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).not.toBeNull();
  });

  test("a trusted proxy's X-Forwarded-For decides the client IP", async () => {
    const client = await start({ trustProxy: true });
    const { limit } = AUTH_RATE_LIMITS.registerIp;
    const from = (ip: string) => ({ "x-forwarded-for": `1.2.3.4, ${ip}` });
    for (let i = 0; i < limit; i++) {
      await client.request(
        "POST",
        "/auth/register",
        { email: `u${i}@x.io`, password: PASSWORD },
        from("10.0.0.1"),
      );
    }
    const sameIp = await client.request(
      "POST",
      "/auth/register",
      { email: "a@x.io", password: PASSWORD },
      from("10.0.0.1"),
    );
    const otherIp = await client.request(
      "POST",
      "/auth/register",
      { email: "b@x.io", password: PASSWORD },
      from("10.0.0.2"),
    );
    expect([sameIp.status, otherIp.status]).toEqual([429, 202]);
  });

  test("state-changing requests need the app's Origin", async () => {
    const client = await start();
    await client.register();
    const missing = await client.request(
      "POST",
      "/auth/login",
      { email: EMAIL, password: PASSWORD },
      {
        origin: "",
      },
    );
    const foreign = await client.request(
      "POST",
      "/auth/login",
      { email: EMAIL, password: PASSWORD },
      {
        origin: "https://evil.example",
      },
    );
    expect([missing.status, foreign.status]).toEqual([403, 403]);
    expect(await errorCode(foreign)).toBe("forbidden_origin");
    expect(client.cookies.size).toBe(0);
    // Reads are not affected.
    expect((await client.request("GET", "/auth/me", undefined, { origin: "" })).status).toBe(401);
  });

  test("with Redis down, login works and logout falls back to token expiry (ADR 0003)", async () => {
    const down = new Error("Redis down");
    const kv: KeyValueStore = {
      get: () => Promise.reject(down),
      set: () => Promise.reject(down),
      del: () => Promise.reject(down),
      increment: () => Promise.reject(down),
      ping: async () => false,
    };
    const error = console.error;
    console.error = () => {};
    try {
      const client = await loggedIn({ kv });
      const access = client.cookies.get(ACCESS_COOKIE) ?? "";
      expect((await client.request("POST", "/auth/logout")).status).toBe(204);
      client.cookies.set(ACCESS_COOKIE, access);
      // No denylist: the access token stays valid until it expires.
      expect((await client.request("GET", "/auth/me")).status).toBe(200);
    } finally {
      console.error = error;
    }
  });
});
