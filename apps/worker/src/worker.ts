import { type ClaimedJob, JobError, type JobQueue } from "@stego/db";
import type { MessageHandoff } from "@stego/kv";
import type { JobContext, JobHandler, JobHandlers } from "./handlers.ts";

export interface WorkerOptions {
  queue: Pick<JobQueue, "maxAttempts" | "claim" | "extend" | "complete" | "fail">;
  handlers: JobHandlers;
  handoff: Pick<MessageHandoff, "getMessage" | "deleteMessage" | "putRevealed">;
  /** The worker claims no job while this reports false (Redis down: jobs could not read their message). */
  ready?: () => Promise<boolean>;
  /** Sleep between polls when the queue is empty. */
  pollIntervalMs?: number;
  /** A job running longer than this is aborted and failed without retry. */
  jobTimeoutMs?: number;
  /** How often a running job's lease is renewed; keep it well below the queue's leaseMs. */
  heartbeatMs?: number;
  log?: Pick<Console, "error">;
}

export interface Worker {
  /** Resolves once stop() was called and the job in progress has finished. */
  run(): Promise<void>;
  /** Hint that a job may be waiting: cuts the current pause short. Repeated calls coalesce into one claim. */
  wake(): void;
  /** Stops picking new jobs; the current one runs to completion. */
  stop(): void;
}

type Outcome =
  | { ok: true; result: Awaited<ReturnType<JobHandler>> }
  | { ok: false; error: unknown };

// Repeating these on the same input cannot help.
const NO_RETRY = new Set(["timeout", "message_expired"]);

export function createWorker({
  queue,
  handlers,
  handoff,
  ready,
  pollIntervalMs = 1_000,
  jobTimeoutMs = 10 * 60_000,
  heartbeatMs = 30_000,
  log = console,
}: WorkerOptions): Worker {
  for (const [name, value] of Object.entries({ pollIntervalMs, jobTimeoutMs, heartbeatMs })) {
    if (!Number.isFinite(value) || value <= 0 || value > 2 ** 31 - 1) {
      throw new RangeError(`${name} must be a positive number of milliseconds`);
    }
  }

  let running = false;
  let loop: Promise<void> | undefined;
  let interrupt: (() => void) | undefined;
  // Set by wake(), cleared before each claim: a hint that arrives mid-claim skips the next pause.
  let woken = false;

  function idle(ms: number): Promise<void> {
    if (woken) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      interrupt = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  function warnIfLeaseLost(owned: boolean, job: ClaimedJob): void {
    if (!owned) log.error(`Job ${job.id} attempt ${job.attempts}: lease lost, outcome discarded`);
  }

  // Runs the handler with a heartbeat and a timeout; all timers are cleared before this returns.
  async function runHandler(handler: JobHandler, job: ClaimedJob): Promise<Outcome> {
    const operationId = job.operation_id;
    const context = (signal: AbortSignal): JobContext => ({
      signal,
      async message() {
        const message = await handoff.getMessage(operationId);
        if (message === null) throw new JobError("message_expired");
        return message;
      },
      reveal: (message) => handoff.putRevealed(operationId, message),
    });
    const abort = new AbortController();
    let renewing = false;
    const heartbeat = setInterval(async () => {
      // Skip a beat while the previous renewal is still in flight, so a slow database gets one query at a time.
      if (renewing) return;
      renewing = true;
      try {
        if (!(await queue.extend(job))) abort.abort(new JobError("lease_lost"));
      } catch (error) {
        if (!abort.signal.aborted) log.error(`Job ${job.id}: lease renewal failed:`, error);
      } finally {
        renewing = false;
      }
    }, heartbeatMs);
    const timeout = setTimeout(() => abort.abort(new JobError("timeout")), jobTimeoutMs);
    // The race settles on timeout even if the handler ignores the signal. A handler that blocks the
    // event loop (one long synchronous native call) delays both timers, so split work into steps.
    const aborted = new Promise<never>((_, reject) => {
      abort.signal.addEventListener("abort", () => reject(abort.signal.reason), { once: true });
    });
    // The finally block aborts after success too; nobody awaits the race loser then.
    aborted.catch(() => {});

    try {
      return {
        ok: true,
        result: await Promise.race([handler(job, context(abort.signal)), aborted]),
      };
    } catch (error) {
      return { ok: false, error };
    } finally {
      clearInterval(heartbeat);
      clearTimeout(timeout);
      abort.abort();
    }
  }

  // The message is kept across retries and dropped once the job can no longer run again. Losing the
  // delete only leaves it to its TTL.
  async function discardMessage(job: ClaimedJob): Promise<void> {
    try {
      await handoff.deleteMessage(job.operation_id);
    } catch (error) {
      log.error(`Job ${job.id}: could not delete the message:`, error);
    }
  }

  async function handle(job: ClaimedJob): Promise<void> {
    const handler = handlers[job.operation.type];
    if (!handler) {
      log.error(`Job ${job.id}: no handler for type "${job.operation.type}"`);
      const owned = await queue.fail(job, new JobError("no_handler"), { retry: false });
      warnIfLeaseLost(owned, job);
      if (owned) await discardMessage(job);
      return;
    }
    const outcome = await runHandler(handler, job);
    if (!outcome.ok) {
      log.error(`Job ${job.id} attempt ${job.attempts} failed:`, outcome.error);
      const retry = !(outcome.error instanceof JobError && NO_RETRY.has(outcome.error.code));
      const owned = await queue.fail(job, outcome.error, { retry });
      warnIfLeaseLost(owned, job);
      if (owned && (!retry || job.attempts >= queue.maxAttempts)) await discardMessage(job);
      return;
    }
    // A database error here must not count as a failed attempt of work that succeeded. It reaches the
    // loop's error handler and the lease brings the job back.
    const owned = await queue.complete(job, outcome.result ?? null);
    warnIfLeaseLost(owned, job);
    if (owned) await discardMessage(job);
  }

  async function poll(): Promise<void> {
    while (running) {
      woken = false;
      try {
        const job = (await ready?.()) === false ? null : await queue.claim();
        if (job) {
          await handle(job);
          continue;
        }
      } catch (error) {
        // Database hiccup: keep the loop alive and try again after the usual pause.
        log.error("Job queue error:", error);
      }
      if (running) await idle(pollIntervalMs);
    }
  }

  return {
    async run() {
      // Guard on the loop itself: after stop() the old loop may still be finishing its job.
      if (loop) throw new Error("Worker is already running");
      running = true;
      loop = poll();
      try {
        await loop;
      } finally {
        loop = undefined;
      }
    },
    wake() {
      woken = true;
      interrupt?.();
    },
    stop() {
      running = false;
      interrupt?.();
    },
  };
}
