import { type Experiment, ExperimentRequest, type OperationAccepted } from "@stego/contracts";
import type { KeyValueStore } from "@stego/kv";
import type { BunRequest } from "bun";
import { z } from "zod";
import { API_PREFIX, HttpError, json, parseBody } from "../../lib/http.ts";
import { createRateLimiter, enforce, type RateLimitOptions } from "../../lib/rate-limit.ts";
import type { RequireUser } from "../auth/routes.ts";
import { MAX_ENCODE_BODY_BYTES, refuse } from "../operations/refusal.ts";
import type { OperationService } from "../operations/service.ts";

export const EXPERIMENT_RATE_LIMITS = {
  // Per user: one experiment runs up to 36 attacks and stores as many images, far more than an encode.
  create: { name: "experiment-user", limit: 20, windowMs: 60 * 60_000 },
} satisfies Record<string, RateLimitOptions>;

export interface ExperimentRoutesDeps {
  operations: OperationService;
  kv: KeyValueStore;
  requireUser: RequireUser;
}

export function experimentRoutes({ operations, kv, requireUser }: ExperimentRoutesDeps) {
  const createLimiter = createRateLimiter(kv, EXPERIMENT_RATE_LIMITS.create);

  return {
    "/experiments": {
      POST: async (req: BunRequest) => {
        const user = await requireUser(req);
        // Charged before validation and the ownership check on purpose, as for encode.
        await enforce(() => createLimiter.hit(user.id));
        // The body carries a message like an encode request, so it gets the same cap.
        const body = await parseBody(req, ExperimentRequest, MAX_ENCODE_BODY_BYTES);
        const accepted: OperationAccepted = await refuse(operations.experiment(user.id, body));
        return json(accepted, {
          status: 202,
          headers: { Location: `${API_PREFIX}/experiments/${accepted.id}` },
        });
      },
    },

    "/experiments/:id": {
      GET: async (req: BunRequest<"/experiments/:id">) => {
        const user = await requireUser(req);
        const id = z.uuid().safeParse(req.params.id);
        const experiment = id.success ? await operations.getExperiment(user.id, id.data) : null;
        if (!experiment) throw new HttpError(404, "not_found", "Experiment not found");
        // Progress changes while it runs and the image URLs are presigned per request.
        return json<Experiment>(experiment, { headers: { "Cache-Control": "no-store" } });
      },
    },
  };
}
