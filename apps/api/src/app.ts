import type { ImageRepository, RefreshTokenRepository, UserRepository } from "@stego/db";
import type { ObjectStore } from "@stego/storage";
import { requireOrigin } from "./lib/csrf.ts";
import { API_PREFIX, errorResponse, HttpError, mount } from "./lib/http.ts";
import type { KeyValueStore } from "./lib/kv/store.ts";
import { authRoutes, createRequireUser } from "./modules/auth/routes.ts";
import { createAuthService } from "./modules/auth/service.ts";
import { createAccessTokens } from "./modules/auth/tokens.ts";
import { healthRoutes } from "./modules/health/routes.ts";
import { imageRoutes, MAX_REQUEST_BYTES } from "./modules/images/routes.ts";
import { createImageService } from "./modules/images/service.ts";

const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const IMAGE_URL_TTL_SECONDS = 10 * 60;

export interface ServerDeps {
  port: number;
  kv: KeyValueStore;
  storage: Pick<ObjectStore, "ping" | "put" | "delete" | "presignGet">;
  users: UserRepository;
  images: ImageRepository;
  refreshTokens: RefreshTokenRepository;
  jwtSecret: string;
  /** The web app's origin: the only one allowed to make state-changing requests. */
  appOrigin: string;
  /** Peers allowed to set X-Client-IP (see lib/client-ip.ts). */
  trustedProxies: ReadonlySet<string>;
}

export function createServer({
  port,
  kv,
  storage,
  users,
  images,
  refreshTokens,
  jwtSecret,
  appOrigin,
  trustedProxies,
}: ServerDeps) {
  const auth = createAuthService({
    users,
    refreshTokens,
    kv,
    accessTokens: createAccessTokens({ secret: jwtSecret, ttlSeconds: ACCESS_TTL_SECONDS }),
    refreshTtlMs: REFRESH_TTL_MS,
  });

  const requireUser = createRequireUser(auth);
  const imageService = createImageService({
    images,
    storage,
    urlTtlSeconds: IMAGE_URL_TTL_SECONDS,
  });

  return Bun.serve({
    port,
    // Bun applies one body limit to the whole server, so it is sized for uploads. JSON bodies are held to
    // 64 KiB by `parseBody`, uploads to MAX_UPLOAD_BYTES by the upload route.
    maxRequestBodySize: MAX_REQUEST_BYTES,
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
            trustedProxies,
          }),
        ),
        ...mount(API_PREFIX, imageRoutes({ images: imageService, kv, requireUser })),
      },
      appOrigin,
    ),
    fetch() {
      return errorResponse(new HttpError(404, "not_found", "Route not found"));
    },
    error: errorResponse,
  });
}
