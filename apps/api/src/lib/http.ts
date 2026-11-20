import type { ApiError } from "@stego/contracts";
import type { Server } from "bun";
import type { z } from "zod";

export function json<T>(body: T, init?: ResponseInit): Response {
  return Response.json(body, init);
}

export const API_PREFIX = "/api/v1";

/** Mounts module routes (declared relative, e.g. "/health") under the API version prefix. */
export function mount<T extends Record<string, unknown>>(prefix: string, routes: T): T {
  return Object.fromEntries(
    Object.entries(routes).map(([path, handlers]) => [`${prefix}${path}`, handlers]),
  ) as T;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
  }
}

export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    const body: ApiError = {
      error: { code: error.code, message: error.message, details: error.details },
    };
    return json(body, { status: error.status, headers: error.headers });
  }
  console.error(error);
  const body: ApiError = { error: { code: "internal", message: "Internal server error" } };
  return json(body, { status: 500 });
}

/** Parses a JSON body against a contract schema; any failure is a 400 that never echoes the input. */
export async function parseBody<S extends z.ZodType>(
  req: Request,
  schema: S,
): Promise<z.output<S>> {
  const body = await req.json().catch(() => {
    throw new HttpError(400, "invalid_request", "Body must be JSON");
  });
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const details = parsed.error.issues.map(({ path, message }) => ({ path, message }));
    throw new HttpError(400, "invalid_request", "Invalid request body", details);
  }
  return parsed.data;
}

/**
 * The caller's IP. Behind a trusted proxy it is the last X-Forwarded-For entry, the one the proxy
 * itself appended; earlier entries are client-controlled.
 */
export function clientIp(req: Request, server: Server<unknown>, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = req.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
    if (forwarded) return forwarded;
  }
  return server.requestIP(req)?.address ?? "unknown";
}
