import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createUserRepository } from "./auth.ts";
import { createImageRepository, type ImageRepository } from "./images.ts";
import type { KeysetCursor } from "./keyset.ts";
import {
  createOperationRepository,
  type NewOperation,
  type OperationRepository,
} from "./operations.ts";
import {
  createMemoryImageRepository,
  createMemoryOperationRepository,
  createTestDatabase,
} from "./testing/index.ts";

// Shared contract: the Postgres repository and the in-memory fake the API tests use must agree.
// The Postgres run needs TEST_DATABASE_URL.
const testDb = createTestDatabase(2);
const sql = testDb?.sql;

beforeAll(async () => {
  await testDb?.setup();
});

afterAll(async () => {
  await testDb?.teardown();
});

interface Backend {
  operations: OperationRepository;
  images: ImageRepository;
  newUser(): Promise<string>;
  /** Stands in for the worker and the clock. */
  patch(
    id: string,
    fields: { status?: "succeeded" | "failed" | "running"; createdAt?: string },
  ): Promise<void>;
}

const backends: [string, () => Promise<Backend>][] = [
  [
    "memory",
    async () => {
      const operations = createMemoryOperationRepository();
      return {
        operations,
        images: createMemoryImageRepository(),
        newUser: async () => crypto.randomUUID(),
        patch: async (id, { status, createdAt }) =>
          operations.patch(id, {
            ...(status && { status }),
            ...(createdAt && { created_at: new Date(createdAt) }),
          }),
      };
    },
  ],
];
if (sql) {
  const users = createUserRepository(sql);
  backends.push([
    "postgres",
    async () => {
      await sql`TRUNCATE users CASCADE`;
      return {
        operations: createOperationRepository(sql),
        images: createImageRepository(sql),
        newUser: async () => {
          const user = await users.create(`${crypto.randomUUID()}@test.local`, "x");
          return (user as { id: string }).id;
        },
        patch: async (id, { status, createdAt }) => {
          if (status) await sql`UPDATE operations SET status = ${status} WHERE id = ${id}`;
          if (createdAt) {
            await sql`UPDATE operations SET created_at = ${createdAt}::timestamptz WHERE id = ${id}`;
          }
        },
      };
    },
  ]);
}

describe.each(backends)("operation repository (%s)", (name, setup) => {
  async function fixture() {
    const backend = await setup();
    const userId = await backend.newUser();
    const image = await backend.images.create(
      {
        userId,
        kind: "original",
        storageKey: `users/${userId}/${crypto.randomUUID()}.png`,
        format: "png",
        width: 4,
        height: 4,
        sizeBytes: 10,
        sha256: "a".repeat(64),
      },
      { maxImages: 10, maxBytes: 1e9 },
    );
    const sourceImageId = (image as { id: string }).id;
    const create = (maxActive = 5, overrides: Partial<NewOperation> = {}) =>
      backend.operations.createWithJob(
        {
          id: crypto.randomUUID(),
          userId,
          type: "encode",
          method: "lsb",
          sourceImageId,
          params: { layers: [] },
          ...overrides,
        },
        { maxActive },
      );
    /** A finished operation created at a chosen time. */
    const finished = async (createdAt: string, overrides: Partial<NewOperation> = {}) => {
      const id = ((await create(100, overrides)) as { id: string }).id;
      await backend.patch(id, { status: "succeeded", createdAt });
      return id;
    };
    return { ...backend, userId, sourceImageId, create, finished };
  }

  test("creates a queued operation the owner can read back", async () => {
    const { operations, userId, create } = await fixture();
    const row = await create();
    expect(row).toMatchObject({ user_id: userId, type: "encode", method: "lsb", status: "queued" });
    expect(await operations.findOwned(userId, (row as { id: string }).id)).toMatchObject({
      id: row?.id,
      params: { layers: [] },
      result: null,
      error: null,
    });
  });

  test("refuses a new operation at the active cap", async () => {
    const { create } = await fixture();
    expect(await create(2)).not.toBeNull();
    expect(await create(2)).not.toBeNull();
    expect(await create(2)).toBeNull();
  });

  test("concurrent requests cannot overshoot the cap", async () => {
    const { create } = await fixture();
    const rows = await Promise.all(Array.from({ length: 6 }, () => create(3)));
    expect(rows.filter((row) => row !== null)).toHaveLength(3);
  });

  test("does not show an operation to another user", async () => {
    const { operations, newUser, create } = await fixture();
    const row = await create();
    expect(await operations.findOwned(await newUser(), (row as { id: string }).id)).toBeNull();
  });

  const at = (second: number) => `2026-11-20T10:00:${String(second).padStart(2, "0")}.000Z`;

  test("listPage pages newest first without gaps or repeats", async () => {
    const { operations, userId, finished } = await fixture();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.unshift(await finished(at(i)));
    const seen: string[] = [];
    const sizes: number[] = [];
    let after: KeysetCursor | undefined;
    do {
      const page = await operations.listPage(userId, { limit: 2, after });
      seen.push(...page.operations.map((row) => row.id));
      sizes.push(page.operations.length);
      after = page.next ?? undefined;
    } while (after);
    expect(seen).toEqual(ids);
    expect(sizes).toEqual([2, 2, 1]);
  });

  test("listPage ends without a cursor at the last row", async () => {
    const { operations, userId, finished } = await fixture();
    await finished(at(1));
    await finished(at(2));
    const page = await operations.listPage(userId, { limit: 2 });
    expect(page.operations).toHaveLength(2);
    expect(page.next).toBeNull();
  });

  test("rows created in the same instant keep a stable order", async () => {
    const { operations, userId, finished } = await fixture();
    for (let i = 0; i < 6; i++) await finished(at(5));
    const first = await operations.listPage(userId, { limit: 3 });
    const second = await operations.listPage(userId, {
      limit: 3,
      after: first.next as KeysetCursor,
    });
    const all = await operations.listPage(userId, { limit: 10 });
    expect([...first.operations, ...second.operations].map((r) => r.id)).toEqual(
      all.operations.map((r) => r.id),
    );
    expect(second.next).toBeNull();
  });

  // The in-memory fake stores milliseconds, like the JS Date it uses.
  test.skipIf(name === "memory")(
    "the cursor keeps the microseconds a Date would drop",
    async () => {
      const { operations, userId, finished } = await fixture();
      const newer = await finished("2026-11-20T10:00:00.123900Z");
      const older = await finished("2026-11-20T10:00:00.123100Z");
      const first = await operations.listPage(userId, { limit: 1 });
      expect(first.operations.map((r) => r.id)).toEqual([newer]);
      const second = await operations.listPage(userId, {
        limit: 1,
        after: first.next as KeysetCursor,
      });
      expect(second.operations.map((r) => r.id)).toEqual([older]);
    },
  );

  test("listPage filters by type, method and status", async () => {
    const { operations, userId, finished, create, sourceImageId } = await fixture();
    const encoded = await finished(at(1));
    const decoded = await finished(at(2), { type: "decode", method: null, params: {} });
    const dwt = await finished(at(3), { method: "dwt-qim" });
    const queued = ((await create(100, { method: "lsb" })) as { id: string }).id;
    const ids = async (filter: Parameters<OperationRepository["listPage"]>[1]["filter"]) =>
      (await operations.listPage(userId, { limit: 10, filter })).operations.map((r) => r.id);

    expect(await ids({ type: "decode" })).toEqual([decoded]);
    expect(await ids({ method: null })).toEqual([decoded]);
    expect(await ids({ method: "dwt-qim" })).toEqual([dwt]);
    expect(await ids({ method: "lsb" })).toEqual([queued, encoded]);
    expect(await ids({ status: "queued" })).toEqual([queued]);
    expect(await ids({ type: "encode", status: "succeeded" })).toEqual([dwt, encoded]);
    expect(await ids({})).toHaveLength(4);
    expect(sourceImageId).toBeTruthy();
  });

  test("listPage shows a failed job's error code and only the user's rows", async () => {
    const { operations, userId, newUser, finished } = await fixture();
    const id = await finished(at(1));
    const other = await operations.listPage(await newUser(), { limit: 10 });
    expect(other).toEqual({ operations: [], next: null });
    const page = await operations.listPage(userId, { limit: 10 });
    expect(page.operations).toMatchObject([{ id, error: null }]);
  });

  test("deleteFinishedOwned removes finished operations only, and only the owner's", async () => {
    const { operations, userId, newUser, create, finished, patch } = await fixture();
    const done = await finished(at(1));
    const queued = ((await create()) as { id: string }).id;
    const running = ((await create()) as { id: string }).id;
    await patch(running, { status: "running" });
    const failed = ((await create()) as { id: string }).id;
    await patch(failed, { status: "failed" });

    expect(await operations.deleteFinishedOwned(await newUser(), done)).toBe(false);
    expect(await operations.deleteFinishedOwned(userId, queued)).toBe(false);
    expect(await operations.deleteFinishedOwned(userId, running)).toBe(false);
    expect(await operations.deleteFinishedOwned(userId, done)).toBe(true);
    expect(await operations.deleteFinishedOwned(userId, failed)).toBe(true);
    expect(await operations.deleteFinishedOwned(userId, done)).toBe(false);
    expect(await operations.findOwned(userId, done)).toBeNull();
    expect(await operations.findOwned(userId, queued)).not.toBeNull();
  });

  test("records the result image", async () => {
    const { operations, userId, sourceImageId, create } = await fixture();
    const row = await create();
    const id = (row as { id: string }).id;
    await operations.attachResultImage(id, sourceImageId);
    expect(await operations.findOwned(userId, id)).toMatchObject({
      result_image_id: sourceImageId,
    });
  });
});

describe.skipIf(!sql)("operation repository against Postgres", () => {
  test("creating an operation also queues exactly one job", async () => {
    const db = sql as NonNullable<typeof sql>;
    await db`TRUNCATE users CASCADE`;
    const user = await createUserRepository(db).create(`${crypto.randomUUID()}@test.local`, "x");
    const userId = (user as { id: string }).id;
    const image = await createImageRepository(db).create(
      {
        userId,
        kind: "original",
        storageKey: `users/${userId}/${crypto.randomUUID()}.png`,
        format: "png",
        width: 4,
        height: 4,
        sizeBytes: 10,
        sha256: "a".repeat(64),
      },
      { maxImages: 10, maxBytes: 1e9 },
    );
    const id = crypto.randomUUID();
    await createOperationRepository(db).createWithJob(
      {
        id,
        userId,
        type: "decode",
        method: null,
        sourceImageId: (image as { id: string }).id,
        params: { method: "auto" },
      },
      { maxActive: 5 },
    );
    const jobs = await db<{ status: string }[]>`SELECT status FROM jobs WHERE operation_id = ${id}`;
    expect(jobs.map((job) => job.status)).toEqual(["queued"]);
  });

  test("a failed job's public error code shows on the operation", async () => {
    const db = sql as NonNullable<typeof sql>;
    await db`TRUNCATE users CASCADE`;
    const user = await createUserRepository(db).create(`${crypto.randomUUID()}@test.local`, "x");
    const userId = (user as { id: string }).id;
    const image = await createImageRepository(db).create(
      {
        userId,
        kind: "original",
        storageKey: `users/${userId}/${crypto.randomUUID()}.png`,
        format: "png",
        width: 4,
        height: 4,
        sizeBytes: 10,
        sha256: "a".repeat(64),
      },
      { maxImages: 10, maxBytes: 1e9 },
    );
    const id = crypto.randomUUID();
    const operations = createOperationRepository(db);
    await operations.createWithJob(
      {
        id,
        userId,
        type: "encode",
        method: "lsb",
        sourceImageId: (image as { id: string }).id,
        params: {},
      },
      { maxActive: 5 },
    );
    await db`UPDATE jobs SET status = 'failed', error = 'message_expired' WHERE operation_id = ${id}`;
    await db`UPDATE operations SET status = 'failed' WHERE id = ${id}`;
    expect(await operations.findOwned(userId, id)).toMatchObject({
      status: "failed",
      error: "message_expired",
    });
  });
});
