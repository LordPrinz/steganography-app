import type {
  ImageRepository,
  OperationRepository,
  RefreshTokenRepository,
  UserRepository,
} from "@stego/db";
import {
  createMessageHandoff,
  createProgressStore,
  type KeyValueStore,
  type WakePublisher,
} from "@stego/kv";
import type { ObjectStore } from "@stego/storage";
import { type ConcurrencyLimit, createConcurrencyLimit } from "./lib/concurrency-limit.ts";
import { requireOrigin } from "./lib/csrf.ts";
import { API_PREFIX, errorResponse, HttpError, mount } from "./lib/http.ts";
import { authRoutes, createRequireUser } from "./modules/auth/routes.ts";
import { createAuthService } from "./modules/auth/service.ts";
import { createAccessTokens } from "./modules/auth/tokens.ts";
import { experimentRoutes } from "./modules/experiments/routes.ts";
import { healthRoutes } from "./modules/health/routes.ts";
import { imageRoutes, MAX_REQUEST_BYTES } from "./modules/images/routes.ts";
import { createImageService, type ImageLimits } from "./modules/images/service.ts";
import { operationRoutes } from "./modules/operations/routes.ts";
import { createOperationService } from "./modules/operations/service.ts";

const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const IMAGE_URL_TTL_SECONDS = 10 * 60;
const DECODE_SLOTS = 2;

export interface ServerDeps {
  port: number;
  kv: KeyValueStore;
  /** Wakes the worker after a job was enqueued. */
  wake: WakePublisher;
  storage: Pick<ObjectStore, "ping" | "put" | "delete" | "presignGet">;
  users: UserRepository;
  images: ImageRepository;
  operations: OperationRepository;
  refreshTokens: RefreshTokenRepository;
  jwtSecret: string;
  /** The web app's origin: the only one allowed to make state-changing requests. */
  appOrigin: string;
  /** Peers allowed to set X-Client-IP (see lib/client-ip.ts). */
  trustedProxies: ReadonlySet<string>;
  /** Concurrent image decodes allowed in this process (default 2). Uploads beyond it get a 503. */
  decodeLimit?: ConcurrencyLimit;
  /** Per-user image caps (default: the contract constants). */
  imageLimits?: ImageLimits;
}

export function createServer({
  port,
  kv,
  wake,
  storage,
  users,
  images,
  operations,
  refreshTokens,
  jwtSecret,
  appOrigin,
  trustedProxies,
  decodeLimit = createConcurrencyLimit(DECODE_SLOTS),
  imageLimits,
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
    decodeLimit,
    limits: imageLimits,
  });

  const operationService = createOperationService({
    operations,
    images,
    imageUrls: imageService,
    handoff: createMessageHandoff(kv),
    wake,
    kv,
    progress: createProgressStore(kv),
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
        ...mount(API_PREFIX, operationRoutes({ operations: operationService, kv, requireUser })),
        ...mount(API_PREFIX, experimentRoutes({ operations: operationService, kv, requireUser })),
      },
      appOrigin,
    ),
    fetch() {
      return errorResponse(new HttpError(404, "not_found", "Route not found"));
    },
    error: errorResponse,
  });
}
