import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { backoffMs, createJobQueue, enqueueJob, JobError } from "./jobs.ts";
import { migrate } from "./migrator.ts";
import type { JobRow, OperationRow } from "./types.ts";

// Integration test: runs only when a disposable database is available (CI provides one).
const url = Bun.env.TEST_DATABASE_URL;
const schema = `test_${crypto.randomUUID().replaceAll("-", "")}`;
const admin = url ? new SQL({ url, max: 1 }) : undefined;
// Several connections, all pointed at the test schema, so concurrent claims really run in parallel.
const sql = url ? new SQL({ url, max: 4, connection: { search_path: schema } }) : undefined;

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

beforeEach(async () => {
  if (sql) await sql`TRUNCATE users, operations, jobs CASCADE`;
});

describe("backoffMs", () => {
  test("doubles per attempt and stops at the cap", () => {
    expect([1, 2, 3, 4].map((a) => backoffMs(a, 1_000, 5_000))).toEqual([
      1_000, 2_000, 4_000, 5_000,
    ]);
  });
});

describe("JobError", () => {
  test("accepts short snake_case codes only", () => {
    expect(new JobError("decode_failed").code).toBe("decode_failed");
    expect(() => new JobError("Contains the message: hello")).toThrow(RangeError);
  });
});

describe("createJobQueue options", () => {
  test("rejects non-positive limits", () => {
    const unused = {} as SQL;
    expect(() => createJobQueue(unused, { maxAttempts: 0 })).toThrow(
      "maxAttempts must be a positive number",
    );
    expect(() => createJobQueue(unused, { leaseMs: -1 })).toThrow(
      "leaseMs must be a positive number",
    );
  });
});

describe.skipIf(!sql)("job queue", () => {
  const db = sql as SQL;

  async function newOperation(params: Record<string, unknown> = {}): Promise<OperationRow> {
    const [user] = await db<{ id: string }[]>`
      INSERT INTO users (email, password_hash) VALUES (${`${crypto.randomUUID()}@test.local`}, 'x') RETURNING id
    `;
    const [op] = await db<OperationRow[]>`
      INSERT INTO operations (user_id, type, method, params)
      VALUES (${user?.id}, 'encode', 'lsb', ${params}::jsonb) RETURNING *
    `;
    return op as OperationRow;
  }

  async function jobRow(id: string): Promise<JobRow> {
    const [row] = await db<JobRow[]>`SELECT * FROM jobs WHERE id = ${id}`;
    return row as JobRow;
  }

  async function operationStatus(id: string): Promise<string> {
    const [row] = await db<{ status: string }[]>`SELECT status FROM operations WHERE id = ${id}`;
    return row?.status ?? "";
  }

  test("enqueueJob inserts a queued job", async () => {
    const op = await newOperation();
    const job = await enqueueJob(db, op.id);
    expect(job).toMatchObject({
      operation_id: op.id,
      status: "queued",
      attempts: 0,
      locked_at: null,
    });
  });

  test("enqueue joins the caller's transaction and allows one job per operation", async () => {
    const op = await newOperation();
    const queue = createJobQueue(db);
    await expect(
      db.begin(async (tx) => {
        await queue.enqueue(op.id, { tx });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await db`SELECT id FROM jobs`).toHaveLength(0);

    await queue.enqueue(op.id);
    await expect(queue.enqueue(op.id)).rejects.toThrow();
  });

  test("claim marks the job and its operation running and returns the operation", async () => {
    const op = await newOperation({ strength: 1 });
    const queue = createJobQueue(db);
    const queued = await queue.enqueue(op.id);

    const job = await queue.claim();
    expect(job).toMatchObject({ id: queued.id, status: "running", attempts: 1 });
    expect(job?.locked_at).toBeInstanceOf(Date);
    expect(job?.operation).toEqual({
      id: op.id,
      user_id: op.user_id,
      type: "encode",
      method: "lsb",
      source_image_id: null,
      params: { strength: 1 },
    });
    expect(await operationStatus(op.id)).toBe("running");
    expect(await queue.claim()).toBeNull();
  });

  test("claim ignores jobs scheduled for later", async () => {
    const op = await newOperation();
    await enqueueJob(db, op.id, new Date(Date.now() + 60_000));
    expect(await createJobQueue(db).claim()).toBeNull();
  });

  test("claim skips rows locked by another transaction instead of waiting", async () => {
    const queue = createJobQueue(db);
    const locked = await queue.enqueue((await newOperation()).id);
    const free = await queue.enqueue((await newOperation()).id);
    await db`UPDATE jobs SET run_after = now() - interval '1 minute' WHERE id = ${locked.id}`;

    const other = await db.reserve();
    try {
      await other`BEGIN`;
      await other`SELECT id FROM jobs WHERE id = ${locked.id} FOR UPDATE`;
      const job = await queue.claim();
      expect(job?.id).toBe(free.id);
    } finally {
      await other`ROLLBACK`;
      other.release();
    }
  });

  test("parallel claims never hand out the same job twice", async () => {
    const queue = createJobQueue(db);
    for (let i = 0; i < 6; i++) await queue.enqueue((await newOperation()).id);

    const claimed = await Promise.all(Array.from({ length: 8 }, () => queue.claim()));
    const ids = claimed.flatMap((job) => (job ? [job.id] : []));
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
  });

  test("complete marks the job succeeded and stores the result on the operation", async () => {
    const op = await newOperation();
    const queue = createJobQueue(db);
    await queue.enqueue(op.id);
    const job = await queue.claim();
    if (!job) throw new Error("expected a job");

    expect(await queue.complete(job, { psnr: 51.2 })).toBe(true);
    const row = await jobRow(job.id);
    expect(row).toMatchObject({ status: "succeeded", locked_at: null, error: null });
    expect(row.finished_at).toBeInstanceOf(Date);
    const [opRow] = await db<OperationRow[]>`SELECT * FROM operations WHERE id = ${op.id}`;
    expect(opRow).toMatchObject({ status: "succeeded", result: { psnr: 51.2 } });
  });

  test("fail requeues with exponential backoff until attempts run out", async () => {
    const op = await newOperation();
    const queue = createJobQueue(db, { maxAttempts: 2, backoffBaseMs: 60_000 });
    await queue.enqueue(op.id);
    const first = await queue.claim();
    if (!first) throw new Error("expected a job");

    const before = Date.now();
    expect(await queue.fail(first, new JobError("storage_unavailable"))).toBe(true);
    const retried = await jobRow(first.id);
    expect(retried).toMatchObject({
      status: "queued",
      error: "storage_unavailable",
      attempts: 1,
      locked_at: null,
    });
    expect(retried.run_after.getTime()).toBeGreaterThanOrEqual(before + 59_000);
    expect(await operationStatus(op.id)).toBe("queued");
    expect(await queue.claim()).toBeNull();

    await db`UPDATE jobs SET run_after = now() WHERE id = ${first.id}`;
    const second = await queue.claim();
    expect(second?.attempts).toBe(2);
    if (!second) throw new Error("expected a job");
    await queue.fail(second, new Error("secret text from user input"));

    const failed = await jobRow(first.id);
    // Only JobError codes are stored; anything else could carry user data.
    expect(failed).toMatchObject({ status: "failed", error: "internal_error", attempts: 2 });
    expect(failed.finished_at).toBeInstanceOf(Date);
    expect(await operationStatus(op.id)).toBe("failed");
  });

  test("fail with retry: false fails the job on the first attempt", async () => {
    const queue = createJobQueue(db, { maxAttempts: 5 });
    await queue.enqueue((await newOperation()).id);
    const job = await queue.claim();
    if (!job) throw new Error("expected a job");

    await queue.fail(job, new Error("no handler"), { retry: false });
    expect(await jobRow(job.id)).toMatchObject({ status: "failed", attempts: 1 });
  });

  test("a job abandoned past its lease is claimed again and the old owner is fenced off", async () => {
    const queue = createJobQueue(db, { leaseMs: 60_000, maxAttempts: 3 });
    await queue.enqueue((await newOperation()).id);
    const stale = await queue.claim();
    if (!stale) throw new Error("expected a job");
    await db`UPDATE jobs SET locked_at = now() - interval '2 minutes' WHERE id = ${stale.id}`;

    const reclaimed = await queue.claim();
    expect(reclaimed).toMatchObject({ id: stale.id, attempts: 2 });
    expect(await queue.extend(stale)).toBe(false);
    expect(await queue.extend(reclaimed as typeof stale)).toBe(true);
    expect(await queue.complete(stale)).toBe(false);
    expect(await queue.fail(stale, "late")).toBe(false);
    expect((await jobRow(stale.id)).status).toBe("running");
  });

  test("an abandoned job with no attempts left is failed instead of claimed", async () => {
    const op = await newOperation();
    const queue = createJobQueue(db, { leaseMs: 60_000, maxAttempts: 1 });
    await queue.enqueue(op.id);
    const job = await queue.claim();
    if (!job) throw new Error("expected a job");
    await db`UPDATE jobs SET locked_at = now() - interval '2 minutes' WHERE id = ${job.id}`;

    expect(await queue.claim()).toBeNull();
    expect(await jobRow(job.id)).toMatchObject({
      status: "failed",
      error: "lease_expired",
      locked_at: null,
    });
    expect(await operationStatus(op.id)).toBe("failed");
  });
});
