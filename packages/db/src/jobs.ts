import type { SQL } from "bun";
import type { JobRow, OperationRow } from "./types.ts";

/** The part of an operation a job handler needs to do its work. */
export type JobOperation = Pick<
  OperationRow,
  "id" | "user_id" | "type" | "method" | "source_image_id" | "params"
>;

export interface ClaimedJob extends JobRow {
  operation: JobOperation;
}

export interface JobQueueOptions {
  /** Attempts before a job is marked failed for good. */
  maxAttempts?: number;
  /** Delay before the first retry; doubles with every further attempt. */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** A running job whose lock is older than this is treated as abandoned (worker crashed) and claimed again. */
  leaseMs?: number;
}

export interface FailOptions {
  /** false fails the job for good, e.g. when no handler exists for its type. */
  retry?: boolean;
}

export interface JobQueue {
  enqueue(operationId: string): Promise<JobRow>;
  claim(): Promise<ClaimedJob | null>;
  /** Returns false when the job was no longer ours (lease expired and another worker claimed it). */
  complete(job: ClaimedJob, result?: Record<string, unknown> | null): Promise<boolean>;
  fail(job: ClaimedJob, error: unknown, options?: FailOptions): Promise<boolean>;
}

const DEFAULTS = {
  maxAttempts: 3,
  backoffBaseMs: 5_000,
  backoffMaxMs: 5 * 60_000,
  leaseMs: 15 * 60_000,
} satisfies Required<JobQueueOptions>;

const MAX_ERROR_LENGTH = 2_000;

/** Inserts a queued job. Pass a transaction to enqueue atomically with the operation row. */
export async function enqueueJob(sql: SQL, operationId: string, runAfter?: Date): Promise<JobRow> {
  const [job] = await sql<JobRow[]>`
    INSERT INTO jobs (operation_id, run_after)
    VALUES (${operationId}, COALESCE(${runAfter ?? null}::timestamptz, now()))
    RETURNING *
  `;
  if (!job) throw new Error("INSERT INTO jobs returned no row");
  return job;
}

export function backoffMs(attempt: number, baseMs: number, maxMs: number): number {
  return Math.min(baseMs * 2 ** Math.max(0, attempt - 1), maxMs);
}

export function createJobQueue(sql: SQL, options: JobQueueOptions = {}): JobQueue {
  const { maxAttempts, backoffBaseMs, backoffMaxMs, leaseMs } = { ...DEFAULTS, ...options };
  for (const [name, value] of Object.entries({
    maxAttempts,
    backoffBaseMs,
    backoffMaxMs,
    leaseMs,
  })) {
    if (!Number.isFinite(value) || value <= 0)
      throw new RangeError(`${name} must be a positive number`);
  }
  const leaseSecs = leaseMs / 1000;

  // A crashed worker leaves its job running. Abandoned jobs with attempts left are claimed again by
  // claim(); the rest are failed here so a job that keeps killing workers cannot loop forever.
  async function failAbandoned(): Promise<void> {
    await sql`
      WITH dead AS (
        UPDATE jobs
        SET status = 'failed', error = 'Lease expired: worker stopped while running the job',
            locked_at = NULL, finished_at = now()
        WHERE status = 'running'
          AND locked_at < now() - make_interval(secs => ${leaseSecs})
          AND attempts >= ${maxAttempts}
        RETURNING operation_id
      )
      UPDATE operations SET status = 'failed' FROM dead WHERE operations.id = dead.operation_id
    `;
  }

  return {
    enqueue: (operationId) => enqueueJob(sql, operationId),

    async claim() {
      await failAbandoned();
      // One statement: pick, lock and mark running atomically. SKIP LOCKED lets parallel workers
      // pass over rows another worker is claiming instead of waiting on them.
      const [job] = await sql<ClaimedJob[]>`
        WITH next AS (
          SELECT id FROM jobs
          WHERE (status = 'queued' AND run_after <= now())
             OR (status = 'running' AND locked_at < now() - make_interval(secs => ${leaseSecs})
                 AND attempts < ${maxAttempts})
          ORDER BY run_after
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        ),
        claimed AS (
          UPDATE jobs SET status = 'running', attempts = jobs.attempts + 1, locked_at = now()
          FROM next WHERE jobs.id = next.id
          RETURNING jobs.*
        ),
        op AS (
          UPDATE operations SET status = 'running'
          FROM claimed WHERE operations.id = claimed.operation_id
          RETURNING operations.id, operations.user_id, operations.type, operations.method,
                    operations.source_image_id, operations.params
        )
        SELECT claimed.*, jsonb_build_object(
          'id', op.id, 'user_id', op.user_id, 'type', op.type, 'method', op.method,
          'source_image_id', op.source_image_id, 'params', op.params
        ) AS operation
        FROM claimed JOIN op ON op.id = claimed.operation_id
      `;
      return job ?? null;
    },

    async complete(job, result = null) {
      return sql.begin(async (tx) => {
        // attempts acts as a fencing token: after a lease expiry another worker owns a higher attempt.
        const updated = await tx`
          UPDATE jobs SET status = 'succeeded', error = NULL, locked_at = NULL, finished_at = now()
          WHERE id = ${job.id} AND status = 'running' AND attempts = ${job.attempts}
          RETURNING id
        `;
        if (updated.length === 0) return false;
        await tx`
          UPDATE operations SET status = 'succeeded', result = ${result}::jsonb
          WHERE id = ${job.operation_id}
        `;
        return true;
      });
    },

    async fail(job, error, { retry = true } = {}) {
      const message = errorMessage(error);
      const final = !retry || job.attempts >= maxAttempts;
      const delaySecs = backoffMs(job.attempts, backoffBaseMs, backoffMaxMs) / 1000;
      return sql.begin(async (tx) => {
        const updated = final
          ? await tx`
              UPDATE jobs SET status = 'failed', error = ${message}, locked_at = NULL, finished_at = now()
              WHERE id = ${job.id} AND status = 'running' AND attempts = ${job.attempts}
              RETURNING id
            `
          : await tx`
              UPDATE jobs SET status = 'queued', error = ${message}, locked_at = NULL,
                              run_after = now() + make_interval(secs => ${delaySecs})
              WHERE id = ${job.id} AND status = 'running' AND attempts = ${job.attempts}
              RETURNING id
            `;
        if (updated.length === 0) return false;
        await tx`
          UPDATE operations SET status = ${final ? "failed" : "queued"}::job_status
          WHERE id = ${job.operation_id}
        `;
        return true;
      });
    },
  };
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_ERROR_LENGTH);
}
