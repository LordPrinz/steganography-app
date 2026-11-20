import { HttpError } from "./http.ts";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

type Handler = (req: Request, ...rest: never[]) => unknown;

/**
 * Puts an Origin check in front of every route handler. State-changing requests (POST, PUT, PATCH,
 * DELETE…) need an Origin equal to `allowedOrigin`, otherwise 403. Browsers send Origin on such
 * requests; other clients (curl, scripts) must set it themselves. SameSite=Lax cookies alone would
 * still let a sibling subdomain post with the user's cookies.
 */
export function requireOrigin<T extends Record<string, unknown>>(
  routes: T,
  allowedOrigin: string,
): T {
  const check = (handler: Handler): Handler => {
    return (req, ...rest) => {
      if (!SAFE_METHODS.has(req.method) && req.headers.get("origin") !== allowedOrigin) {
        throw new HttpError(403, "forbidden_origin", "Request origin not allowed");
      }
      return handler(req, ...rest);
    };
  };
  const wrap = (handlers: unknown): unknown => {
    if (typeof handlers === "function") return check(handlers as Handler);
    if (typeof handlers !== "object" || handlers === null || handlers instanceof Response) {
      return handlers;
    }
    return Object.fromEntries(Object.entries(handlers).map(([method, h]) => [method, wrap(h)]));
  };
  return Object.fromEntries(
    Object.entries(routes).map(([path, handlers]) => [path, wrap(handlers)]),
  ) as T;
}
