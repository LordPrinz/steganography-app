import {
  createDb,
  createImageRepository,
  createJobQueue,
  createOperationRepository,
} from "@stego/db";
import {
  createMessageHandoff,
  createProgressStore,
  createRedisStore,
  createRedisWakeSource,
  keepConnected,
} from "@stego/kv";
import { createS3ObjectStore } from "@stego/storage";
import { RedisClient } from "bun";
import { cleanupExpiredVariants } from "./cleanup.ts";
import { loadEnv } from "./env.ts";
import type { JobHandlers } from "./handlers.ts";
import { createDecodeHandler } from "./operations/decode.ts";
import { createEncodeHandler } from "./operations/encode.ts";
import { createExperimentHandler } from "./operations/experiment.ts";
import { createWorker } from "./worker.ts";

const env = loadEnv();
const sql = createDb(env.DATABASE_URL);
const redis = new RedisClient(env.REDIS_URL, { enableOfflineQueue: false });
keepConnected(redis);
const kv = createRedisStore(redis);
// A subscribed connection can run almost no other command, so the wake-up listens on its own client.
const subscriber = new RedisClient(env.REDIS_URL, { enableOfflineQueue: false });
keepConnected(subscriber);
const storage = createS3ObjectStore({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  bucket: env.S3_BUCKET,
  accessKeyId: env.S3_ACCESS_KEY_ID,
  secretAccessKey: env.S3_SECRET_ACCESS_KEY,
});
const images = createImageRepository(sql);
const operations = createOperationRepository(sql);
const handlers: JobHandlers = {
  encode: createEncodeHandler({ images, operations, storage }),
  decode: createDecodeHandler({ images, storage }),
  experiment: createExperimentHandler({ images, storage, progress: createProgressStore(kv) }),
};
const worker = createWorker({
  queue: createJobQueue(sql),
  handlers,
  handoff: createMessageHandoff(kv),
  ready: () => kv.ping(),
  pollIntervalMs: env.WORKER_POLL_INTERVAL_MS,
  jobTimeoutMs: env.WORKER_JOB_TIMEOUT_MS,
});

// Attacked images of the lab expire after a day; a run that fails is retried on the next tick.
const variantCleanup = Bun.cron("*/15 * * * *", async () => {
  try {
    const removed = await cleanupExpiredVariants({ images, storage });
    if (removed > 0) console.info(`Removed ${removed} expired variant image(s)`);
  } catch (error) {
    console.error("Expired variant cleanup failed", error);
  }
});

const stopListening = createRedisWakeSource(subscriber).listen(() => worker.wake());

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    console.info(`${signal} received, finishing the current job`);
    variantCleanup.stop();
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
