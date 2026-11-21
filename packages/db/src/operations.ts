import type { SQL } from "bun";
import { enqueueJob } from "./jobs.ts";
import type { KeysetCursor } from "./keyset.ts";
import type { JobStatus, OperationRow, OperationType, StegoMethod } from "./types.ts";

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
  /** The layer a failed layered job stopped on. */
  failure_layer: number | null;
}

/** Narrows a listing; omitted fields match everything. `method: null` matches decodes that try every method. */
export interface OperationFilter {
  type?: OperationType;
  method?: StegoMethod | null;
  status?: JobStatus;
}

export interface OperationPage {
  operations: OperationView[];
  /** Cursor for the next page, or null at the end. */
  next: KeysetCursor | null;
}

type OperationViewWithCursor = OperationView & { cursor_at: string };

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
  /** Newest first. `limit` rows after `after` (the start when omitted) that match `filter`. */
  listPage(
    userId: string,
    options: { limit: number; after?: KeysetCursor; filter?: OperationFilter },
  ): Promise<OperationPage>;
  /**
   * Removes a succeeded or failed operation (its job goes with it; images stay) and returns whether
   * one was removed. Queued and running operations are left alone: a worker still writes to them.
   */
  deleteFinishedOwned(userId: string, id: string): Promise<boolean>;
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
        SELECT o.*, j.error, j.failure_layer
        FROM operations o LEFT JOIN jobs j ON j.operation_id = o.id
        WHERE o.id = ${id} AND o.user_id = ${userId}
      `;
      return row ?? null;
    },

    async listPage(userId, { limit, after, filter = {} }) {
      // One extra row tells whether another page exists. cursor_at is the timestamp as UTC text with
      // microseconds, which a JS Date would round.
      const rows = await sql<OperationViewWithCursor[]>`
        SELECT o.*, j.error, j.failure_layer,
               to_char(o.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
        FROM operations o LEFT JOIN jobs j ON j.operation_id = o.id
        WHERE o.user_id = ${userId}
          ${filter.type ? sql`AND o.type = ${filter.type}` : sql``}
          ${filter.method === undefined ? sql`` : filter.method === null ? sql`AND o.method IS NULL` : sql`AND o.method = ${filter.method}`}
          ${filter.status ? sql`AND o.status = ${filter.status}` : sql``}
          ${after ? sql`AND (o.created_at, o.id) < (${after.createdAt}::timestamptz, ${after.id}::uuid)` : sql``}
        ORDER BY o.created_at DESC, o.id DESC
        LIMIT ${limit + 1}
      `;
      const page = rows.slice(0, limit);
      const last = rows.length > limit ? page.at(-1) : undefined;
      return {
        operations: page.map(({ cursor_at: _, ...row }) => row),
        next: last ? { createdAt: last.cursor_at, id: last.id } : null,
      };
    },

    async deleteFinishedOwned(userId, id) {
      const rows = await sql`
        DELETE FROM operations
        WHERE id = ${id} AND user_id = ${userId} AND status IN ('succeeded', 'failed')
        RETURNING id
      `;
      return rows.length > 0;
    },

    async attachResultImage(operationId, imageId) {
      await sql`UPDATE operations SET result_image_id = ${imageId} WHERE id = ${operationId}`;
    },
  };
}
