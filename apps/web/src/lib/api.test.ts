import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { ApiRequestError, createApiClient, type RefreshClock } from "./api.ts";

const Thing = z.object({ n: z.number() });
const unauthorized = () =>
  Response.json(
    { error: { code: "unauthorized", message: "Authentication required" } },
    { status: 401 },
  );

type Handler = (path: string, call: number) => Response | Promise<Response>;

function setup(handler: Handler, opts: { locks?: boolean } = {}) {
  const calls: string[] = [];
  const counts = new Map<string, number>();
  const fetchFn = async (path: string) => {
    calls.push(path);
    const call = (counts.get(path) ?? 0) + 1;
    counts.set(path, call);
    return handler(path, call);
  };

  let time = 0;
  let refreshedAt = 0;
  const refreshClock: RefreshClock = { get: () => refreshedAt, set: (t) => (refreshedAt = t) };
  // A single-holder lock queue, like navigator.locks within one browser.
  let tail: Promise<unknown> = Promise.resolve();
  const locks = {
    request: ((_name: string, cb: () => Promise<unknown>) => {
      const run = tail.then(cb);
      tail = run.catch(() => undefined);
      return run;
    }) as unknown as LockManager["request"],
  };
  const client = createApiClient({
    fetch: fetchFn,
    locks: opts.locks ? locks : undefined,
    refreshClock,
    now: () => ++time,
  });
  return { client, calls };
}

const REFRESH = "/api/v1/auth/refresh";

describe("api client", () => {
  test("validates responses against the schema", async () => {
    const { client } = setup(() => Response.json({ n: "x" }));
    await expect(client.get("/api/v1/thing", Thing)).rejects.toThrow();
  });

  test("turns error bodies and Retry-After into ApiRequestError", async () => {
    const { client } = setup(() =>
      Response.json(
        { error: { code: "rate_limited", message: "Too many requests" } },
        { status: 429, headers: { "Retry-After": "42" } },
      ),
    );
    const error = await client.post("/api/v1/auth/login", {}).catch((e) => e);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ status: 429, code: "rate_limited", retryAfterSeconds: 42 });
  });

  test("maps a network failure to status 0", async () => {
    const client = createApiClient({
      fetch: (async () => {
        throw new TypeError("offline");
      }) as unknown as typeof fetch,
      refreshClock: { get: () => 0, set: () => {} },
    });
    expect(await client.get("/api/v1/thing", Thing).catch((e) => e)).toMatchObject({ status: 0 });
  });

  test("refreshes after a 401 and retries the request once", async () => {
    const { client, calls } = setup((path, call) => {
      if (path === REFRESH) return new Response(null, { status: 200 });
      return call === 1 ? unauthorized() : Response.json({ n: 1 });
    });
    expect(await client.get("/api/v1/thing", Thing)).toEqual({ n: 1 });
    expect(calls).toEqual(["/api/v1/thing", REFRESH, "/api/v1/thing"]);
  });

  test("does not loop when the retry is still 401", async () => {
    const { client, calls } = setup((path) =>
      path === REFRESH ? new Response(null, { status: 200 }) : unauthorized(),
    );
    const error = await client.get("/api/v1/thing", Thing).catch((e) => e);
    expect(error).toMatchObject({ status: 401 });
    expect(calls).toEqual(["/api/v1/thing", REFRESH, "/api/v1/thing"]);
  });

  test("throws the original 401 when the refresh is refused", async () => {
    const { client, calls } = setup(() => unauthorized());
    const error = await client.get("/api/v1/thing", Thing).catch((e) => e);
    expect(error).toMatchObject({ status: 401, code: "unauthorized" });
    expect(calls).toEqual(["/api/v1/thing", REFRESH]);
  });

  test("never refreshes for login, register or logout", async () => {
    const { client, calls } = setup(() => unauthorized());
    for (const path of ["login", "register", "logout"]) {
      await client.post(`/api/v1/auth/${path}`, {}).catch(() => undefined);
    }
    expect(calls).not.toContain(REFRESH);
  });

  test("concurrent 401s share one refresh", async () => {
    const seen = new Set<string>();
    const { client, calls } = setup(
      async (path) => {
        if (path === REFRESH) {
          await Bun.sleep(5);
          return new Response(null, { status: 200 });
        }
        if (!seen.has(path)) {
          seen.add(path);
          return unauthorized();
        }
        return Response.json({ n: 1 });
      },
      { locks: true },
    );
    const results = await Promise.all([
      client.get("/api/v1/a", Thing),
      client.get("/api/v1/b", Thing),
      client.get("/api/v1/c", Thing),
    ]);
    expect(results).toHaveLength(3);
    expect(calls.filter((c) => c === REFRESH)).toHaveLength(1);
  });

  test("skips the refresh when another tab refreshed after the request started", async () => {
    let clock = 100;
    let refreshedAt = 0;
    const calls: string[] = [];
    const client = createApiClient({
      fetch: async (path) => {
        calls.push(path);
        if (calls.length > 1) return Response.json({ n: 1 });
        // Another tab finishes its refresh while this response is in flight.
        clock = 150;
        refreshedAt = 150;
        return unauthorized();
      },
      refreshClock: { get: () => refreshedAt, set: (t) => (refreshedAt = t) },
      now: () => clock,
    });
    expect(await client.get("/api/v1/thing", Thing)).toEqual({ n: 1 });
    expect(calls).toEqual(["/api/v1/thing", "/api/v1/thing"]);
  });

  test("ignores a stored refresh time in the future", async () => {
    const calls: string[] = [];
    const client = createApiClient({
      fetch: async (path) => {
        calls.push(path);
        if (path === REFRESH) return new Response(null, { status: 200 });
        return calls.length === 1 ? unauthorized() : Response.json({ n: 1 });
      },
      refreshClock: { get: () => 9_999, set: () => {} },
      now: () => 100,
    });
    await client.get("/api/v1/thing", Thing);
    expect(calls).toContain(REFRESH);
  });

  test("refreshes without the lock when the lock request fails", async () => {
    const calls: string[] = [];
    const client = createApiClient({
      fetch: async (path) => {
        calls.push(path);
        if (path === REFRESH) return new Response(null, { status: 200 });
        return calls.length === 1 ? unauthorized() : Response.json({ n: 1 });
      },
      locks: {
        request: (async () => Promise.reject(new DOMException("denied", "SecurityError"))) as never,
      },
      refreshClock: { get: () => 0, set: () => {} },
      now: () => 100,
    });
    expect(await client.get("/api/v1/thing", Thing)).toEqual({ n: 1 });
    expect(calls).toEqual(["/api/v1/thing", REFRESH, "/api/v1/thing"]);
  });

  test("retry: false returns the 401 without refreshing", async () => {
    const { client, calls } = setup(() => unauthorized());
    await client.get("/api/v1/thing", Thing, { retry: false }).catch(() => undefined);
    expect(calls).toEqual(["/api/v1/thing"]);
  });

  test("does not replay FormData bodies", async () => {
    const { client, calls } = setup(() => unauthorized());
    await client.post("/api/v1/images", new FormData()).catch(() => undefined);
    expect(calls).toEqual(["/api/v1/images"]);
  });

  test("post without a schema resolves to undefined on 204", async () => {
    const { client } = setup(() => new Response(null, { status: 204 }));
    expect(await client.post("/api/v1/auth/logout")).toBeUndefined();
  });
});
