import { type ClaimedJob, JobError, type JobQueue } from "@stego/db";
import type { JobHandler, JobHandlers } from "./handlers.ts";

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

type Outcome =
  | { ok: true; result: Awaited<ReturnType<JobHandler>> }
  | { ok: false; error: unknown };

export function createWorker({
  queue,
  handlers,
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

  // Runs the handler with a heartbeat and a timeout; all timers are cleared before this returns.
  async function runHandler(handler: JobHandler, job: ClaimedJob): Promise<Outcome> {
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
        result: await Promise.race([handler(job, { signal: abort.signal }), aborted]),
      };
    } catch (error) {
      return { ok: false, error };
    } finally {
      clearInterval(heartbeat);
      clearTimeout(timeout);
      abort.abort();
    }
  }

  async function handle(job: ClaimedJob): Promise<void> {
    const handler = handlers[job.operation.type];
    if (!handler) {
      log.error(`Job ${job.id}: no handler for type "${job.operation.type}"`);
      warnIfLeaseLost(await queue.fail(job, new JobError("no_handler"), { retry: false }), job);
      return;
    }
    const outcome = await runHandler(handler, job);
    if (!outcome.ok) {
      log.error(`Job ${job.id} attempt ${job.attempts} failed:`, outcome.error);
      // A timeout would most likely repeat on the same input, so it is not retried.
      const retry = !(outcome.error instanceof JobError && outcome.error.code === "timeout");
      warnIfLeaseLost(await queue.fail(job, outcome.error, { retry }), job);
      return;
    }
    // A database error here must not count as a failed attempt of work that succeeded. It reaches the
    // loop's error handler and the lease brings the job back.
    warnIfLeaseLost(await queue.complete(job, outcome.result ?? null), job);
  }

  async function poll(): Promise<void> {
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
    stop() {
      running = false;
      wake?.();
    },
  };
}
