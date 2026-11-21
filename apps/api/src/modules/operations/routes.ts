import {
  DecodeRequest,
  EncodeRequest,
  type Operation,
  type OperationAccepted,
} from "@stego/contracts";
import type { KeyValueStore } from "@stego/kv";
import type { BunRequest } from "bun";
import { z } from "zod";
import { API_PREFIX, HttpError, json, parseBody } from "../../lib/http.ts";
import { createRateLimiter, enforce, type RateLimitOptions } from "../../lib/rate-limit.ts";
import type { RequireUser } from "../auth/routes.ts";
import {
  InvalidMethodError,
  MessageTooLargeError,
  type OperationService,
  SourceNotFoundError,
  TooManyActiveOperationsError,
} from "./service.ts";

export const OPERATION_RATE_LIMITS = {
  // Per user: each operation decodes an image in the worker, and encodes re-encode and store one.
  create: { name: "operation-user", limit: 120, windowMs: 60 * 60_000 },
} satisfies Record<string, RateLimitOptions>;

/**
 * Room for a message of MAX_MESSAGE_BYTES in the worst JSON form (every control byte escaped as six
 * characters is 384 KiB), plus the rest of the request.
 */
export const MAX_ENCODE_BODY_BYTES = 512 * 1024;

export interface OperationRoutesDeps {
  operations: OperationService;
  kv: KeyValueStore;
  requireUser: RequireUser;
}

const operationNotFound = () => new HttpError(404, "not_found", "Operation not found");

/** Maps what the service refuses to the API's errors; anything else is a 500. */
async function refuse<T>(call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (error) {
    throw refusal(error);
  }
}

function refusal(error: unknown): unknown {
  if (error instanceof SourceNotFoundError) {
    return new HttpError(404, "image_not_found", "Image not found");
  }
  if (error instanceof InvalidMethodError) {
    return new HttpError(400, "invalid_request", "The method parameters are not valid");
  }
  if (error instanceof MessageTooLargeError) {
    return new HttpError(422, "message_too_large", "The message does not fit in the image", {
      needed: error.needed,
      available: error.available,
    });
  }
  if (error instanceof TooManyActiveOperationsError) {
    return new HttpError(
      429,
      "too_many_operations",
      "Too many operations in progress; wait for one to finish",
      undefined,
      { "Retry-After": "5" },
    );
  }
  return error;
}

export function operationRoutes({ operations, kv, requireUser }: OperationRoutesDeps) {
  const createLimiter = createRateLimiter(kv, OPERATION_RATE_LIMITS.create);

  function accepted(operation: OperationAccepted): Response {
    return json(operation, {
      status: 202,
      headers: { Location: `${API_PREFIX}/operations/${operation.id}` },
    });
  }

  return {
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
    },
  };
}
