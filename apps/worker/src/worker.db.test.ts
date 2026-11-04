import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createJobQueue, type JobRow } from "@stego/db";
import { migrate } from "@stego/db/migrator";
import { SQL } from "bun";
import { createWorker } from "./worker.ts";

// Integration test: runs only when a disposable database is available (CI provides one).
const url = Bun.env.TEST_DATABASE_URL;
const schema = `test_${crypto.randomUUID().replaceAll("-", "")}`;
const admin = url ? new SQL({ url, max: 1 }) : undefined;
const sql = url ? new SQL({ url, max: 2, connection: { search_path: schema } }) : undefined;

beforeAll(async () => {
  if (!admin || !sql) return;
  await admin.unsafe(`CREATE SCHEMA ${schema}`);
  await migrate(sql);
});

afterAll(async () => {
  if (!admin || !sql) return;
  await sql.close();
  await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.close();
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
