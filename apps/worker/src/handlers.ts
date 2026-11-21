import type { ClaimedJob, OperationType } from "@stego/db";

export interface JobContext {
  /**
   * Aborted when the job times out or its lease is lost. The worker moves on at that point, so check it
   * between steps, stop early and write no side effects (storage, rows) after it fires.
   */
  signal: AbortSignal;
  /**
   * The hidden messages to embed, one per layer in request order (a single entry for one message).
   * Throws `JobError("message_expired")` when they are gone, which fails the job without a retry. Keep
   * them out of errors, logs and results.
   */
  messages(): Promise<string[]>;
  /**
   * Hands what a decode found, by method id, to the user through Redis; it expires on its own and
   * never reaches Postgres.
   */
  reveal(revealed: Readonly<Record<string, string>>): Promise<void>;
}

/**
 * Returns the result stored on the operation. Throwing fails the attempt and the queue decides about
 * retries; throw `JobError` with a public code, since any other error is stored as "internal_error".
 * `job.operation.params` was written by the user: parse it with the contract schema before use. Never put
 * the hidden message in the result (it is persisted) or in an error message (errors are logged).
 */
export type JobHandler = (
  job: ClaimedJob,
  context: JobContext,
) => Promise<Record<string, unknown> | null | undefined>;

/** One handler per operation type. A new job type is a new entry here; the loop does not change. */
export type JobHandlers = Partial<Record<OperationType, JobHandler>>;
