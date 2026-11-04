import { createDb, createJobQueue } from "@stego/db";
import { loadEnv } from "./env.ts";
import type { JobHandlers } from "./handlers.ts";
import { createWorker } from "./worker.ts";

const env = loadEnv();
const sql = createDb(env.DATABASE_URL);
// Encode, decode and experiment handlers are registered here as their issues land.
const handlers: JobHandlers = {};
const worker = createWorker({
  queue: createJobQueue(sql),
  handlers,
  pollIntervalMs: env.WORKER_POLL_INTERVAL_MS,
  jobTimeoutMs: env.WORKER_JOB_TIMEOUT_MS,
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    console.info(`${signal} received, finishing the current job`);
    worker.stop();
  });
}

console.info("Worker started");
await worker.run();
await sql.close();
console.info("Worker stopped");
