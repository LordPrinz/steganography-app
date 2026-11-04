import type { ClaimedJob, OperationType } from "@stego/db";

/** Returns the result stored on the operation. Throwing fails the attempt; the queue decides about retries. */
export type JobHandler = (job: ClaimedJob) => Promise<Record<string, unknown> | null | undefined>;

/** One handler per operation type. A new job type is a new entry here; the loop does not change. */
export type JobHandlers = Partial<Record<OperationType, JobHandler>>;
