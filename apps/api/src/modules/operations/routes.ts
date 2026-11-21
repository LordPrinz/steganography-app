import {
  DecodeRequest,
  EncodeRequest,
  ListOperationsQuery,
  type Operation,
  type OperationAccepted,
  type OperationPage,
} from "@stego/contracts";
import type { KeyValueStore } from "@stego/kv";
import type { BunRequest } from "bun";
import { z } from "zod";
import { decodeCursor } from "../../lib/cursor.ts";
import { API_PREFIX, HttpError, json, parseBody } from "../../lib/http.ts";
import { createRateLimiter, enforce, type RateLimitOptions } from "../../lib/rate-limit.ts";
import type { RequireUser } from "../auth/routes.ts";
import { MAX_ENCODE_BODY_BYTES, refuse } from "./refusal.ts";
import type { OperationService } from "./service.ts";

export const OPERATION_RATE_LIMITS = {
  // Per user: each operation decodes an image in the worker, and encodes re-encode and store one.
  create: { name: "operation-user", limit: 120, windowMs: 60 * 60_000 },
} satisfies Record<string, RateLimitOptions>;

export interface OperationRoutesDeps {
  operations: OperationService;
  kv: KeyValueStore;
  requireUser: RequireUser;
}

const operationNotFound = () => new HttpError(404, "not_found", "Operation not found");

export function operationRoutes({ operations, kv, requireUser }: OperationRoutesDeps) {
  const createLimiter = createRateLimiter(kv, OPERATION_RATE_LIMITS.create);

  function accepted(operation: OperationAccepted): Response {
    return json(operation, {
      status: 202,
      headers: { Location: `${API_PREFIX}/operations/${operation.id}` },
    });
  }

  return {
    "/operations": {
      GET: async (req: BunRequest) => {
        const user = await requireUser(req);
        const query = ListOperationsQuery.safeParse(
          Object.fromEntries(new URL(req.url).searchParams),
        );
        if (!query.success) throw new HttpError(400, "invalid_request", "Invalid query");
        const { cursor, ...options } = query.data;
        const after = cursor === undefined ? undefined : decodeCursor(cursor);
        if (after === null) throw new HttpError(400, "invalid_cursor", "Invalid cursor");
        // Parameters and results of the user's own operations: never cached.
        return json<OperationPage>(await operations.list(user.id, { ...options, after }), {
          headers: { "Cache-Control": "no-store" },
        });
      },
    },

    "/operations/encode": {
      POST: async (req: BunRequest) => {
        const user = await requireUser(req);
        // Charged before validation and the ownership check on purpose: bad and refused requests cost work too.
        await enforce(() => createLimiter.hit(user.id));
        const body = await parseBody(req, EncodeRequest, MAX_ENCODE_BODY_BYTES);
        return accepted(await refuse(operations.encode(user.id, body)));
      },
    },

    "/operations/decode": {
      POST: async (req: BunRequest) => {
        const user = await requireUser(req);
        // Charged before validation and the ownership check on purpose, as for encode.
        await enforce(() => createLimiter.hit(user.id));
        const body = await parseBody(req, DecodeRequest);
        return accepted(await refuse(operations.decode(user.id, body)));
      },
    },

    "/operations/:id": {
      GET: async (req: BunRequest<"/operations/:id">) => {
        const user = await requireUser(req);
        const id = z.uuid().safeParse(req.params.id);
        if (!id.success) throw operationNotFound();
        const operation = await operations.get(user.id, id.data);
        if (!operation) throw operationNotFound();
        // The body can hold a decoded message.
        return json<Operation>(operation, { headers: { "Cache-Control": "no-store" } });
      },

      DELETE: async (req: BunRequest<"/operations/:id">) => {
        const user = await requireUser(req);
        const id = z.uuid().safeParse(req.params.id);
        if (!id.success) throw operationNotFound();
        if (!(await refuse(operations.remove(user.id, id.data)))) throw operationNotFound();
        return new Response(null, { status: 204 });
      },
    },
  };
}
