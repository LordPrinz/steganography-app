import { createDb, createJobQueue } from "@stego/db";
import {
  createMessageHandoff,
  createRedisStore,
  createRedisWakeSource,
  keepConnected,
} from "@stego/kv";
import { RedisClient } from "bun";
import { loadEnv } from "./env.ts";
import type { JobHandlers } from "./handlers.ts";
import { createWorker } from "./worker.ts";

const env = loadEnv();
const sql = createDb(env.DATABASE_URL);
const redis = new RedisClient(env.REDIS_URL, { enableOfflineQueue: false });
keepConnected(redis);
const kv = createRedisStore(redis);
// A subscribed connection can run almost no other command, so the wake-up listens on its own client.
const subscriber = new RedisClient(env.REDIS_URL, { enableOfflineQueue: false });
keepConnected(subscriber);
// Encode, decode and experiment handlers are registered here as their issues land.
const handlers: JobHandlers = {};
const worker = createWorker({
  queue: createJobQueue(sql),
  handlers,
  handoff: createMessageHandoff(kv),
  ready: () => kv.ping(),
  pollIntervalMs: env.WORKER_POLL_INTERVAL_MS,
  jobTimeoutMs: env.WORKER_JOB_TIMEOUT_MS,
});

const stopListening = createRedisWakeSource(subscriber).listen(() => worker.wake());

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    console.info(`${signal} received, finishing the current job`);
    worker.stop();
  });
}

console.info("Worker started");
await worker.run();
await stopListening();
await sql.close();
subscriber.close();
redis.close();
console.info("Worker stopped");
