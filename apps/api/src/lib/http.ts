import type { ApiError } from "@stego/contracts";

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
  ) {
    super(message);
  }
}

export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    const body: ApiError = {
      error: { code: error.code, message: error.message, details: error.details },
    };
    return json(body, { status: error.status });
  }
  console.error(error);
  const body: ApiError = { error: { code: "internal", message: "Internal server error" } };
  return json(body, { status: 500 });
}
