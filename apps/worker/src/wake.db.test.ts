import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createJobQueue } from "@stego/db";
import { createTestDatabase } from "@stego/db/testing";
import {
  createMemoryStore,
  createMessageHandoff,
  createRedisWakePublisher,
  createRedisWakeSource,
} from "@stego/kv";
import { RedisClient, type SQL } from "bun";
import { createWorker } from "./worker.ts";

const testDb = createTestDatabase();
const sql = testDb?.sql;
const redisUrl = Bun.env.TEST_REDIS_URL;

beforeAll(async () => {
  await testDb?.setup();
});

afterAll(async () => {
  await testDb?.teardown();
});

async function createOperation(db: SQL): Promise<string> {
  const [op] = await db<{ id: string }[]>`
    WITH u AS (INSERT INTO users (email, password_hash) VALUES (${`${crypto.randomUUID()}@test.local`}, 'x') RETURNING id)
    INSERT INTO operations (user_id, type) SELECT id, 'encode' FROM u RETURNING id
  `;
  if (!op) throw new Error("expected an operation");
  return op.id;
}

// A long poll interval makes the wake-up the only way a job can start within the test's bound.
describe.skipIf(!sql || !redisUrl)("worker wake-up over Redis", () => {
  test("a published job is claimed long before the next poll", async () => {
    const db = sql as SQL;
    const channel = `test:${crypto.randomUUID()}`;
    const publisherClient = new RedisClient(redisUrl as string, { enableOfflineQueue: false });
    const subscriberClient = new RedisClient(redisUrl as string, { enableOfflineQueue: false });
    await Promise.all([publisherClient.connect(), subscriberClient.connect()]);

    const claimed = Promise.withResolvers<void>();
    const worker = createWorker({
      queue: createJobQueue(db),
      handoff: createMessageHandoff(createMemoryStore()),
      log: { error: () => {} },
      pollIntervalMs: 60_000,
      handlers: { encode: async () => void claimed.resolve() },
    });
    const stopListening = createRedisWakeSource(subscriberClient, { channel }).listen(() =>
      worker.wake(),
    );
    const run = worker.run();
    await Bun.sleep(100);

    const operationId = await createOperation(db);
    await createJobQueue(db).enqueue(operationId);
    await createRedisWakePublisher(publisherClient, { channel }).notify();
    await Promise.race([
      claimed.promise,
      Bun.sleep(3_000).then(() => {
        throw new Error("the job was not claimed after the wake-up");
      }),
    ]);

    worker.stop();
    await run;
    await stopListening();
    publisherClient.close();
    subscriberClient.close();
  });
});

describe.skipIf(!sql)("worker without Redis", () => {
  test("a failed publish is logged and the next poll still claims the job", async () => {
    const db = sql as SQL;
    const down = new RedisClient("redis://127.0.0.1:1", { enableOfflineQueue: false });
    const logged: unknown[][] = [];
    const publisher = createRedisWakePublisher(down, {
      log: { error: (...args: unknown[]) => void logged.push(args) },
    });

    const claimed = Promise.withResolvers<void>();
    const worker = createWorker({
      queue: createJobQueue(db),
      handoff: createMessageHandoff(createMemoryStore()),
      log: { error: () => {} },
      pollIntervalMs: 50,
      handlers: { encode: async () => void claimed.resolve() },
    });
    const run = worker.run();

    const operationId = await createOperation(db);
    await createJobQueue(db).enqueue(operationId);
    await publisher.notify();
    expect(logged).toHaveLength(1);
    await Promise.race([
      claimed.promise,
      Bun.sleep(3_000).then(() => {
        throw new Error("the job was not claimed by polling");
      }),
    ]);

    worker.stop();
    await run;
    down.close();
  });
});
