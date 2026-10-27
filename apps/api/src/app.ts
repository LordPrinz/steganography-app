import { errorResponse, HttpError } from "./lib/http.ts";
import { healthRoutes } from "./modules/health/routes.ts";

export function createServer(port: number) {
  return Bun.serve({
    port,
    routes: {
      ...healthRoutes,
    },
    fetch() {
      return errorResponse(new HttpError(404, "not_found", "Route not found"));
    },
    error: errorResponse,
  });
}
