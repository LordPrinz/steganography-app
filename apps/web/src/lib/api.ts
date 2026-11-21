import { ApiError } from "@stego/contracts";
import type { z } from "zod";

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Seconds from the `Retry-After` header, set on 429 responses. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

/** Auth endpoints whose 401 is an answer, not an expired session. */
const NO_REFRESH_PATHS = new Set([
  "/api/v1/auth/login",
  "/api/v1/auth/register",
  "/api/v1/auth/refresh",
  "/api/v1/auth/logout",
]);
const REFRESH_PATH = "/api/v1/auth/refresh";
const REFRESH_LOCK = "stego-auth-refresh";

/** When the last refresh finished, shared between tabs, so a tab that waited on the lock can skip its own. */
export interface RefreshClock {
  get(): number;
  set(time: number): void;
}

export interface ApiClientDeps {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  locks?: Pick<LockManager, "request">;
  refreshClock: RefreshClock;
  now?: () => number;
}

export interface ApiClient {
  /** Fetches a same-origin API route and validates the response against a contract schema. */
  get<S extends z.ZodType>(path: string, schema: S): Promise<z.infer<S>>;
  /** POSTs JSON. With a schema the response is validated; without one the body is ignored. */
  post<S extends z.ZodType>(path: string, body: unknown, schema: S): Promise<z.infer<S>>;
  post(path: string, body?: unknown): Promise<void>;
}

type Method = "GET" | "POST";

export function createApiClient({
  fetch,
  locks,
  refreshClock,
  now = Date.now,
}: ApiClientDeps): ApiClient {
  let inflightRefresh: Promise<boolean> | null = null;

  async function send(method: Method, path: string, body?: unknown): Promise<Response> {
    try {
      return await fetch(path, {
        method,
        credentials: "same-origin",
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiRequestError(0, "network", "Could not reach the server");
    }
  }

  async function refreshOnce(startedAt: number): Promise<boolean> {
    // Another tab refreshed while this one waited for the lock: the cookies are already new.
    if (refreshClock.get() >= startedAt) return true;
    const res = await send("POST", REFRESH_PATH).catch(() => null);
    if (!res?.ok) return false;
    refreshClock.set(now());
    return true;
  }

  /** One refresh at a time per tab (shared promise) and per browser (Web Lock). */
  function refresh(startedAt: number): Promise<boolean> {
    inflightRefresh ??= (
      locks ? locks.request(REFRESH_LOCK, () => refreshOnce(startedAt)) : refreshOnce(startedAt)
    ).finally(() => {
      inflightRefresh = null;
    });
    return inflightRefresh;
  }

  async function toError(res: Response): Promise<ApiRequestError> {
    const parsed = ApiError.safeParse(await res.json().catch(() => null));
    const retryAfter = Number.parseInt(res.headers.get("Retry-After") ?? "", 10);
    return new ApiRequestError(
      res.status,
      parsed.success ? parsed.data.error.code : "unknown",
      parsed.success ? parsed.data.error.message : res.statusText,
      retryAfter > 0 ? retryAfter : undefined,
    );
  }

  async function request(method: Method, path: string, body?: unknown): Promise<Response> {
    const startedAt = now();
    let res = await send(method, path, body);
    // A 401 may only mean the short-lived access cookie ran out. Refresh and retry exactly once;
    // the retry never refreshes again, so a session that is really gone cannot loop.
    if (res.status === 401 && !NO_REFRESH_PATHS.has(path) && (await refresh(startedAt))) {
      res = await send(method, path, body);
    }
    if (!res.ok) throw await toError(res);
    return res;
  }

  return {
    async get(path, schema) {
      return schema.parse(await (await request("GET", path)).json());
    },
    async post(path: string, body?: unknown, schema?: z.ZodType): Promise<never> {
      const res = await request("POST", path, body);
      return (schema ? schema.parse(await res.json()) : undefined) as never;
    },
  };
}

/** localStorage-backed clock; falls back to this tab's memory when storage is blocked. */
function browserRefreshClock(): RefreshClock {
  const key = "stego:refreshed-at";
  let local = 0;
  return {
    get() {
      try {
        return Math.max(local, Number(localStorage.getItem(key)) || 0);
      } catch {
        return local;
      }
    },
    set(time) {
      local = time;
      try {
        localStorage.setItem(key, String(time));
      } catch {
        // Storage blocked: the in-memory value still covers this tab.
      }
    },
  };
}

let browserClient: ApiClient | undefined;

function client(): ApiClient {
  browserClient ??= createApiClient({
    fetch: (...args) => fetch(...args),
    locks: typeof navigator === "undefined" ? undefined : navigator.locks,
    refreshClock: browserRefreshClock(),
  });
  return browserClient;
}

export function apiGet<S extends z.ZodType>(path: string, schema: S): Promise<z.infer<S>> {
  return client().get(path, schema);
}

export function apiPost<S extends z.ZodType>(
  path: string,
  body: unknown,
  schema: S,
): Promise<z.infer<S>>;
export function apiPost(path: string, body?: unknown): Promise<void>;
export function apiPost(path: string, body?: unknown, schema?: z.ZodType): Promise<unknown> {
  return schema ? client().post(path, body, schema) : client().post(path, body);
}
