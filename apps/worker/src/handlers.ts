import type { ClaimedJob, OperationType } from "@stego/db";

export interface JobContext {
  /** Aborted when the job times out or its lease is lost. Check it between steps and stop early. */
  signal: AbortSignal;
}

/**
 * Returns the result stored on the operation. Throwing fails the attempt and the queue decides about
 * retries; throw `JobError` with a public code, since any other error is stored as "internal_error".
 * Never put the hidden message in the result: it is persisted.
 */
export type JobHandler = (
  job: ClaimedJob,
  context: JobContext,
) => Promise<Record<string, unknown> | null | undefined>;

/** One handler per operation type. A new job type is a new entry here; the loop does not change. */
export type JobHandlers = Partial<Record<OperationType, JobHandler>>;
