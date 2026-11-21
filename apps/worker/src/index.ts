import {
  createDb,
  createImageRepository,
  createJobQueue,
  createOperationRepository,
} from "@stego/db";
import { createMessageHandoff, createRedisStore, keepConnected } from "@stego/kv";
import { createS3ObjectStore } from "@stego/storage";
import { RedisClient } from "bun";
import { loadEnv } from "./env.ts";
import type { JobHandlers } from "./handlers.ts";
import { createDecodeHandler } from "./operations/decode.ts";
import { createEncodeHandler } from "./operations/encode.ts";
import { createWorker } from "./worker.ts";

const env = loadEnv();
const sql = createDb(env.DATABASE_URL);
const redis = new RedisClient(env.REDIS_URL, { enableOfflineQueue: false });
keepConnected(redis);
const kv = createRedisStore(redis);
const storage = createS3ObjectStore({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  bucket: env.S3_BUCKET,
  accessKeyId: env.S3_ACCESS_KEY_ID,
  secretAccessKey: env.S3_SECRET_ACCESS_KEY,
});
const images = createImageRepository(sql);
const operations = createOperationRepository(sql);
// The experiment handler is registered here when the lab lands.
const handlers: JobHandlers = {
  encode: createEncodeHandler({ images, operations, storage }),
  decode: createDecodeHandler({ images, storage }),
};
const worker = createWorker({
  queue: createJobQueue(sql),
  handlers,
  handoff: createMessageHandoff(kv),
  ready: () => kv.ping(),
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
redis.close();
console.info("Worker stopped");
