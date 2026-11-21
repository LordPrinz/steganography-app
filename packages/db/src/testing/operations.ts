import type { OperationRepository } from "../operations.ts";
import type { OperationRow } from "../types.ts";

/** In-process operation repository for tests; passes the same contract suite as the Postgres one. */
export function createMemoryOperationRepository(): OperationRepository {
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
      return row?.user_id === userId ? { ...row, error: null } : null;
    },

    async attachResultImage(operationId, imageId) {
      const row = operations.get(operationId);
      if (row) row.result_image_id = imageId;
    },
  };
}
