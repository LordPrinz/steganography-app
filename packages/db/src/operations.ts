import type { SQL } from "bun";
import { enqueueJob } from "./jobs.ts";
import type { OperationRow, OperationType, StegoMethod } from "./types.ts";

export interface NewOperation {
  /** Chosen by the caller, so the hidden message can be left in Redis under it before the row exists. */
  id: string;
  userId: string;
  type: OperationType;
  method: StegoMethod | null;
  sourceImageId: string;
  /** User-chosen settings. Never the hidden message. */
  params: Record<string, unknown>;
}

/** An operation with the public error code of its job, set once the job failed. */
export interface OperationView extends OperationRow {
  error: string | null;
}

/** Every lookup takes the owner's id, so a caller cannot reach another user's operation by id alone. */
export interface OperationRepository {
  /**
   * Inserts the operation and its job in one transaction, unless the user already has `maxActive`
   * queued or running operations (then null). The count and the insert are one step per user, so
   * concurrent requests cannot overshoot.
   */
  createWithJob(
    operation: NewOperation,
    limit: { maxActive: number },
  ): Promise<OperationRow | null>;
  findOwned(userId: string, id: string): Promise<OperationView | null>;
  /** Points the operation at the image its job produced. */
  attachResultImage(operationId: string, imageId: string): Promise<void>;
}

export function createOperationRepository(sql: SQL): OperationRepository {
  return {
    createWithJob(op, { maxActive }) {
      return sql.begin(async (tx) => {
        // Serialises one user's requests, so the count below cannot go stale before the insert.
        await tx`SELECT 1 FROM users WHERE id = ${op.userId} FOR UPDATE`;
        const [active] = await tx<{ count: number }[]>`
          SELECT count(*)::int AS count FROM operations
          WHERE user_id = ${op.userId} AND status IN ('queued', 'running')
        `;
        if ((active?.count ?? 0) >= maxActive) return null;
        const [row] = await tx<OperationRow[]>`
          INSERT INTO operations (id, user_id, type, method, source_image_id, params)
          VALUES (${op.id}, ${op.userId}, ${op.type}, ${op.method}, ${op.sourceImageId},
                  ${op.params}::jsonb)
          RETURNING *
        `;
        await enqueueJob(tx, op.id);
        return row as OperationRow;
      });
    },

    async findOwned(userId, id) {
      const [row] = await sql<OperationView[]>`
        SELECT o.*, j.error
        FROM operations o LEFT JOIN jobs j ON j.operation_id = o.id
        WHERE o.id = ${id} AND o.user_id = ${userId}
      `;
      return row ?? null;
    },

    async attachResultImage(operationId, imageId) {
      await sql`UPDATE operations SET result_image_id = ${imageId} WHERE id = ${operationId}`;
    },
  };
}
