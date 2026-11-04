import { API_PREFIX, errorResponse, HttpError, mount } from "./lib/http.ts";
import type { KeyValueStore } from "./lib/kv/store.ts";
import { healthRoutes } from "./modules/health/routes.ts";

export interface ServerDeps {
  port: number;
  kv: KeyValueStore;
}

export function createServer({ port, kv }: ServerDeps) {
  return Bun.serve({
    port,
    routes: {
      ...mount(API_PREFIX, healthRoutes({ kv })),
    },
    fetch() {
      return errorResponse(new HttpError(404, "not_found", "Route not found"));
    },
    error: errorResponse,
  });
}
