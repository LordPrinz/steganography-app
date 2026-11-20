import type { HealthResponse, ReadinessResponse } from "@stego/contracts";
import type { ObjectStore } from "@stego/storage";
import pkg from "../../../package.json" with { type: "json" };
import { json } from "../../lib/http.ts";
import type { KeyValueStore } from "../../lib/kv/store.ts";

const startedAt = performance.now();

export interface HealthDeps {
  kv: Pick<KeyValueStore, "ping">;
  storage: Pick<ObjectStore, "ping">;
}

export function healthRoutes({ kv, storage }: HealthDeps) {
  return {
    /** Liveness: the process is up. */
    "/health": {
      GET: () =>
        json<HealthResponse>({
          status: "ok",
          version: pkg.version,
          uptimeSeconds: Math.round((performance.now() - startedAt) / 1000),
        }),
    },
    /** Readiness: the dependencies the API needs answer. */
    "/health/ready": {
      GET: async () => {
        const [redisUp, storageUp] = await Promise.all([kv.ping(), storage.ping()]);
        const redis = redisUp ? "up" : "down";
        const bucket = storageUp ? "up" : "down";
        const ready = redisUp && storageUp;
        return json<ReadinessResponse>(
          { status: ready ? "ready" : "unavailable", checks: { redis, storage: bucket } },
          { status: ready ? 200 : 503 },
        );
      },
    },
  };
}
