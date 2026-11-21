import type { ApiError } from "@stego/contracts";
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

/** JSON bodies stay small. Bun's server-wide limit is raised for uploads, so this cap is enforced here. */
export const MAX_JSON_BYTES = 64 * 1024;

const payloadTooLarge = () => new HttpError(413, "payload_too_large", "Request body is too large");

/**
 * Reads the body, failing with a 413 as soon as it exceeds `maxBytes`. A declared Content-Length over
 * the cap is refused before any byte is read; the running count covers chunked bodies and false lengths.
 */
export async function readBody(req: Request, maxBytes: number): Promise<Uint8Array> {
  if (Number(req.headers.get("content-length")) > maxBytes) throw payloadTooLarge();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (req.body) {
    const reader = req.body.getReader();
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      size += chunk.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw payloadTooLarge();
      }
      chunks.push(chunk.value);
    }
  }
  return Buffer.concat(chunks);
}

/** Parses a JSON body against a contract schema; any failure is a 400 that never echoes the input. */
export async function parseBody<S extends z.ZodType>(
  req: Request,
  schema: S,
): Promise<z.output<S>> {
  const bytes = await readBody(req, MAX_JSON_BYTES);
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, "invalid_request", "Body must be JSON");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const details = parsed.error.issues.map(({ path, message }) => ({ path, message }));
    throw new HttpError(400, "invalid_request", "Invalid request body", details);
  }
  return parsed.data;
}
