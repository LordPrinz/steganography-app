import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createUserRepository } from "./auth.ts";
import { createImageRepository, type ImageRepository } from "./images.ts";
import { createOperationRepository, type OperationRepository } from "./operations.ts";
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
}

const backends: [string, () => Promise<Backend>][] = [
  [
    "memory",
    async () => ({
      operations: createMemoryOperationRepository(),
      images: createMemoryImageRepository(),
      newUser: async () => crypto.randomUUID(),
    }),
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
      };
    },
  ]);
}

describe.each(backends)("operation repository (%s)", (_name, setup) => {
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
    const create = (maxActive = 5) =>
      backend.operations.createWithJob(
        {
          id: crypto.randomUUID(),
          userId,
          type: "encode",
          method: "lsb",
          sourceImageId,
          params: { layers: [] },
        },
        { maxActive },
      );
    return { ...backend, userId, sourceImageId, create };
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
