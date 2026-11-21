import type { OperationRepository } from "../operations.ts";
import type { OperationRow } from "../types.ts";

export interface MemoryOperationRepository extends OperationRepository {
  /** Stands in for the worker and for time passing: changes stored fields the repository never sets itself. */
  patch(id: string, fields: Partial<Pick<OperationRow, "status" | "result" | "created_at">>): void;
}

/** In-process operation repository for tests; passes the same contract suite as the Postgres one. */
export function createMemoryOperationRepository(): MemoryOperationRepository {
  const operations = new Map<string, OperationRow>();

  return {
    async createWithJob(op, { maxActive }) {
      const active = [...operations.values()].filter(
        (row) => row.user_id === op.userId && (row.status === "queued" || row.status === "running"),
      );
      if (active.length >= maxActive) return null;
      const row: OperationRow = {
        id: op.id,
        user_id: op.userId,
        type: op.type,
        method: op.method,
        source_image_id: op.sourceImageId,
        result_image_id: null,
        status: "queued",
        params: structuredClone(op.params),
        result: null,
        created_at: new Date(),
      };
      operations.set(row.id, row);
      return { ...row };
    },

    async findOwned(userId, id) {
      const row = operations.get(id);
      return row?.user_id === userId ? { ...row, error: null, failure_layer: null } : null;
    },

    async listPage(userId, { limit, after, filter = {} }) {
      const newestFirst = [...operations.values()]
        .filter(
          (row) =>
            row.user_id === userId &&
            (filter.type === undefined || row.type === filter.type) &&
            (filter.method === undefined || row.method === filter.method) &&
            (filter.status === undefined || row.status === filter.status),
        )
        .sort((a, b) => b.created_at.getTime() - a.created_at.getTime() || (a.id < b.id ? 1 : -1));
      const at = after && new Date(after.createdAt).getTime();
      const rest = after
        ? newestFirst.filter(
            (row) =>
              row.created_at.getTime() < (at as number) ||
              (row.created_at.getTime() === at && row.id < after.id),
          )
        : newestFirst;
      const page = rest.slice(0, limit);
      const last = rest.length > limit ? page.at(-1) : undefined;
      return {
        operations: page.map((row) => ({ ...row, error: null, failure_layer: null })),
        next: last ? { createdAt: last.created_at.toISOString(), id: last.id } : null,
      };
    },

    async deleteFinishedOwned(userId, id) {
      const row = operations.get(id);
      if (row?.user_id !== userId || (row.status !== "succeeded" && row.status !== "failed")) {
        return false;
      }
      return operations.delete(id);
    },

    patch(id, fields) {
      const row = operations.get(id);
      if (row) Object.assign(row, fields);
    },

    async attachResultImage(operationId, imageId) {
      const row = operations.get(operationId);
      if (row) row.result_image_id = imageId;
    },
  };
}
