import { type ClaimedJob, JobError, type JobQueue } from "@stego/db";
import type { JobHandlers } from "./handlers.ts";

export interface WorkerOptions {
  queue: Pick<JobQueue, "claim" | "extend" | "complete" | "fail">;
  handlers: JobHandlers;
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
  /** Stops picking new jobs; the current one runs to completion. */
  stop(): void;
}

export function createWorker({
  queue,
  handlers,
  pollIntervalMs = 1_000,
  jobTimeoutMs = 10 * 60_000,
  heartbeatMs = 30_000,
  log = console,
}: WorkerOptions): Worker {
  let running = false;
  let wake: (() => void) | undefined;

  function idle(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  function warnIfLeaseLost(owned: boolean, job: ClaimedJob): void {
    if (!owned) log.error(`Job ${job.id} attempt ${job.attempts}: lease lost, outcome discarded`);
  }

  async function handle(job: ClaimedJob): Promise<void> {
    const handler = handlers[job.operation.type];
    if (!handler) {
      log.error(`Job ${job.id}: no handler for type "${job.operation.type}"`);
      warnIfLeaseLost(await queue.fail(job, new JobError("no_handler"), { retry: false }), job);
      return;
    }
    const abort = new AbortController();
    const heartbeat = setInterval(async () => {
      try {
        if (!(await queue.extend(job))) abort.abort(new JobError("lease_lost"));
      } catch (error) {
        log.error(`Job ${job.id}: lease renewal failed:`, error);
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

    let result: Awaited<ReturnType<typeof handler>>;
    try {
      result = await Promise.race([handler(job, { signal: abort.signal }), aborted]);
    } catch (error) {
      log.error(`Job ${job.id} attempt ${job.attempts} failed:`, error);
      // A timeout would most likely repeat on the same input, so it is not retried.
      const retry = !(error instanceof JobError && error.code === "timeout");
      warnIfLeaseLost(await queue.fail(job, error, { retry }), job);
      return;
    } finally {
      clearInterval(heartbeat);
      clearTimeout(timeout);
      abort.abort();
    }
    // Outside the try: a database error here must not count as a failed attempt of work that succeeded.
    // It reaches the loop's error handler and the lease brings the job back.
    warnIfLeaseLost(await queue.complete(job, result ?? null), job);
  }

  return {
    async run() {
      if (running) throw new Error("Worker is already running");
      running = true;
      while (running) {
        try {
          const job = await queue.claim();
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
    },
    stop() {
      running = false;
      wake?.();
    },
  };
}
