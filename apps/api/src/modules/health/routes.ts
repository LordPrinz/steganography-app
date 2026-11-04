import type { HealthResponse, ReadinessResponse } from "@stego/contracts";
import pkg from "../../../package.json" with { type: "json" };
import { json } from "../../lib/http.ts";
import type { KeyValueStore } from "../../lib/kv/store.ts";

const startedAt = performance.now();

export interface HealthDeps {
  kv: Pick<KeyValueStore, "ping">;
}

export function healthRoutes({ kv }: HealthDeps) {
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
        const redis = (await kv.ping()) ? "up" : "down";
        const ready = redis === "up";
        return json<ReadinessResponse>(
          { status: ready ? "ready" : "unavailable", checks: { redis } },
          { status: ready ? 200 : 503 },
        );
      },
    },
  };
}
