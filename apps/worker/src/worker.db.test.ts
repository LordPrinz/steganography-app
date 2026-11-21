import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createJobQueue, type JobRow } from "@stego/db";
import { createTestDatabase } from "@stego/db/testing";
import { createMemoryStore, createMessageHandoff } from "@stego/kv";
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
      handoff: createMessageHandoff(createMemoryStore()),
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

  test("the hidden message reaches neither the database nor the log", async () => {
    const db = sql as SQL;
    const secret = `secret-${crypto.randomUUID()}`;
    const kv = createMemoryStore();
    const handoff = createMessageHandoff(kv);
    const queue = createJobQueue(db, { backoffBaseMs: 1 });
    const logged: unknown[][] = [];
    const log = { error: (...args: unknown[]) => void logged.push(args) };

    async function enqueue(): Promise<string> {
      const [op] = await db<{ id: string }[]>`
        WITH u AS (INSERT INTO users (email, password_hash) VALUES (${`${crypto.randomUUID()}@test.local`}, 'x') RETURNING id)
        INSERT INTO operations (user_id, type) SELECT id, 'encode' FROM u RETURNING id
      `;
      if (!op) throw new Error("expected an operation");
      await queue.enqueue(op.id);
      return op.id;
    }

    const delivered = await enqueue();
    await handoff.putMessage(delivered, secret);
    const expired = await enqueue();
    const seen: string[] = [];
    const worker = createWorker({
      queue,
      handoff,
      log,
      pollIntervalMs: 5,
      handlers: {
        encode: async (_job, context) => {
          seen.push(await context.message());
          return { embedded: true };
        },
      },
    });
    const done = worker.run();
    const settled = async () => {
      const rows = await db<{ status: string }[]>`
        SELECT status FROM operations WHERE id IN (${delivered}, ${expired})
      `;
      return rows.every((row) => row.status === "succeeded" || row.status === "failed");
    };
    while (!(await settled())) await Bun.sleep(10);
    worker.stop();
    await done;

    expect(seen).toEqual([secret]);
    const rows = await db<{ row: string }[]>`
      SELECT to_jsonb(o)::text AS row FROM operations o WHERE o.id IN (${delivered}, ${expired})
      UNION ALL
      SELECT to_jsonb(j)::text FROM jobs j WHERE j.operation_id IN (${delivered}, ${expired})
    `;
    expect(rows.length).toBe(4);
    expect(rows.some(({ row }) => row.includes(secret))).toBe(false);
    expect(JSON.stringify(logged)).not.toContain(secret);

    const [failed] = await db<{ status: string; error: string; attempts: number }[]>`
      SELECT status, error, attempts FROM jobs WHERE operation_id = ${expired}
    `;
    expect(failed).toEqual({ status: "failed", error: "message_expired", attempts: 1 });
    expect(await handoff.getMessage(delivered)).toBeNull();
  });
});
