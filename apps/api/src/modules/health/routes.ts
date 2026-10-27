import type { HealthResponse } from "@stego/contracts";
import pkg from "../../../package.json" with { type: "json" };
import { json } from "../../lib/http.ts";

const startedAt = performance.now();

export const healthRoutes = {
  "/api/health": {
    GET: () =>
      json<HealthResponse>({
        status: "ok",
        version: pkg.version,
        uptimeSeconds: Math.round((performance.now() - startedAt) / 1000),
      }),
  },
};
