import type { RefreshTokenRepository, UserRepository } from "@stego/db";
import type { ObjectStore } from "@stego/storage";
import { requireOrigin } from "./lib/csrf.ts";
import { API_PREFIX, errorResponse, HttpError, mount } from "./lib/http.ts";
import type { KeyValueStore } from "./lib/kv/store.ts";
import { authRoutes } from "./modules/auth/routes.ts";
import { createAuthService } from "./modules/auth/service.ts";
import { createAccessTokens } from "./modules/auth/tokens.ts";
import { healthRoutes } from "./modules/health/routes.ts";

const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface ServerDeps {
  port: number;
  kv: KeyValueStore;
  storage: Pick<ObjectStore, "ping">;
  users: UserRepository;
  refreshTokens: RefreshTokenRepository;
  jwtSecret: string;
  /** The web app's origin: the only one allowed to make state-changing requests. */
  appOrigin: string;
  trustProxy: boolean;
}

export function createServer({
  port,
  kv,
  storage,
  users,
  refreshTokens,
  jwtSecret,
  appOrigin,
  trustProxy,
}: ServerDeps) {
  const auth = createAuthService({
    users,
    refreshTokens,
    kv,
    accessTokens: createAccessTokens({ secret: jwtSecret, ttlSeconds: ACCESS_TTL_SECONDS }),
    refreshTtlMs: REFRESH_TTL_MS,
  });

  return Bun.serve({
    port,
    routes: requireOrigin(
      {
        ...mount(API_PREFIX, healthRoutes({ kv, storage })),
        ...mount(
          API_PREFIX,
          authRoutes({
            auth,
            kv,
            accessTtlSeconds: ACCESS_TTL_SECONDS,
            refreshTtlMs: REFRESH_TTL_MS,
            secureCookies: appOrigin.startsWith("https:"),
            trustProxy,
          }),
        ),
      },
      appOrigin,
    ),
    fetch() {
      return errorResponse(new HttpError(404, "not_found", "Route not found"));
    },
    error: errorResponse,
  });
}
