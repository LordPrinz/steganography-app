import type { ClaimedJob, JobQueue } from "@stego/db";
import type { JobHandlers } from "./handlers.ts";

export interface WorkerOptions {
  queue: Pick<JobQueue, "claim" | "complete" | "fail">;
  handlers: JobHandlers;
  /** Sleep between polls when the queue is empty. */
  pollIntervalMs?: number;
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
      const error = new Error(`No handler for job type "${job.operation.type}"`);
      warnIfLeaseLost(await queue.fail(job, error, { retry: false }), job);
      return;
    }
    let result: Awaited<ReturnType<typeof handler>>;
    try {
      result = await handler(job);
    } catch (error) {
      log.error(`Job ${job.id} attempt ${job.attempts} failed:`, error);
      warnIfLeaseLost(await queue.fail(job, error), job);
      return;
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
