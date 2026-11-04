import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createJobQueue, type JobRow } from "@stego/db";
import { createTestDatabase } from "@stego/db/testing";
import type { SQL } from "bun";
import { createWorker } from "./worker.ts";

const testDb = createTestDatabase();
const sql = testDb?.sql;

beforeAll(async () => {
  await testDb?.setup();
});

afterAll(async () => {
  await testDb?.teardown();
});

describe.skipIf(!sql)("worker against Postgres", () => {
  test("retries a failing job and records the result once a later attempt succeeds", async () => {
    const db = sql as SQL;
    const [op] = await db<{ id: string }[]>`
      WITH u AS (INSERT INTO users (email, password_hash) VALUES (${`${crypto.randomUUID()}@test.local`}, 'x') RETURNING id)
      INSERT INTO operations (user_id, type) SELECT id, 'encode' FROM u RETURNING id
    `;
    if (!op) throw new Error("expected an operation");
    const queue = createJobQueue(db, { backoffBaseMs: 1 });
    const queued = await queue.enqueue(op.id);

    const worker = createWorker({
      queue,
      log: { error: () => {} },
      pollIntervalMs: 5,
      handlers: {
        encode: async (job) => {
          if (job.attempts === 1) throw new Error("transient");
          worker.stop();
          return { attempts: job.attempts };
        },
      },
    });
    await worker.run();

    const [job] = await db<JobRow[]>`SELECT * FROM jobs WHERE id = ${queued.id}`;
    expect(job).toMatchObject({ status: "succeeded", attempts: 2, error: null });
    const [operation] = await db<{ status: string; result: unknown }[]>`
      SELECT status, result FROM operations WHERE id = ${op.id}
    `;
    expect(operation).toEqual({ status: "succeeded", result: { attempts: 2 } });
  });
});
