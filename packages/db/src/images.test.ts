import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createUserRepository } from "./auth.ts";
import {
  createImageRepository,
  type ImageCursor,
  type ImageRepository,
  type NewImage,
} from "./images.ts";
import { createMemoryImageRepository, createTestDatabase } from "./testing/index.ts";
import type { ImageRow } from "./types.ts";

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
  images: ImageRepository;
  /** A user the images can belong to (Postgres enforces the foreign key). */
  newUser(): Promise<string>;
}

const backends: [string, () => Promise<Backend>][] = [
  [
    "memory",
    async () => ({
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
        images: createImageRepository(sql),
        newUser: async () => {
          const user = await users.create(`${crypto.randomUUID()}@test.local`, "x");
          return (user as { id: string }).id;
        },
      };
    },
  ]);
}

function newImage(userId: string, overrides: Partial<NewImage> = {}): NewImage {
  return {
    userId,
    kind: "original",
    storageKey: `users/${userId}/${crypto.randomUUID()}.png`,
    format: "png",
    width: 4,
    height: 3,
    sizeBytes: 100,
    sha256: "a".repeat(64),
    ...overrides,
  };
}

const sleep = () => Bun.sleep(5);

/** Limits nothing in these tests reaches. */
const ROOMY = { maxImages: 1_000, maxBytes: 1e12 };

async function add(
  images: ImageRepository,
  userId: string,
  image = newImage(userId),
): Promise<ImageRow> {
  const row = await images.create(image, ROOMY);
  expect(row).not.toBeNull();
  return row as ImageRow;
}

describe.each(backends)("image repository (%s)", (_name, make) => {
  let backend: Backend;
  let images: ImageRepository;
  beforeEach(async () => {
    backend = await make();
    images = backend.images;
  });

  test("create returns the stored row", async () => {
    const userId = await backend.newUser();
    const input = newImage(userId);
    const row = await add(images, userId, input);
    expect(row).toMatchObject({
      user_id: userId,
      kind: "original",
      storage_key: input.storageKey,
      format: "png",
      width: 4,
      height: 3,
      size_bytes: 100,
      sha256: "a".repeat(64),
    });
    expect(row.created_at).toBeInstanceOf(Date);
    expect(await images.findOwned(userId, row.id)).toEqual(row);
  });

  test("findOwned and deleteOwned never see another user's image", async () => {
    const owner = await backend.newUser();
    const other = await backend.newUser();
    const row = await add(images, owner);

    expect(await images.findOwned(other, row.id)).toBeNull();
    expect(await images.deleteOwned(other, row.id)).toBeNull();
    expect(await images.findOwned(owner, row.id)).not.toBeNull();
  });

  test("deleteOwned returns the deleted row", async () => {
    const userId = await backend.newUser();
    const row = await add(images, userId);
    expect(await images.deleteOwned(userId, row.id)).toEqual(row);
    expect(await images.findOwned(userId, row.id)).toBeNull();
    expect(await images.deleteOwned(userId, row.id)).toBeNull();
  });

  test("listPage pages newest first without gaps or repeats", async () => {
    const userId = await backend.newUser();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.unshift((await add(images, userId)).id);
      await sleep();
    }

    const seen: string[] = [];
    let after: ImageCursor | undefined;
    const sizes: number[] = [];
    do {
      const page = await images.listPage(userId, { limit: 2, after });
      sizes.push(page.images.length);
      seen.push(...page.images.map((row) => row.id));
      after = page.next ?? undefined;
    } while (after);

    expect(seen).toEqual(ids);
    expect(sizes).toEqual([2, 2, 1]);
  });

  test("a page that ends exactly at the last row has no next cursor", async () => {
    const userId = await backend.newUser();
    await add(images, userId);
    await add(images, userId);
    const page = await images.listPage(userId, { limit: 2 });
    expect(page.images).toHaveLength(2);
    expect(page.next).toBeNull();
  });

  test("rows created in the same instant keep a stable order", async () => {
    const userId = await backend.newUser();
    for (let i = 0; i < 6; i++) await add(images, userId);

    const first = await images.listPage(userId, { limit: 3 });
    const second = await images.listPage(userId, { limit: 3, after: first.next as ImageCursor });
    const all = await images.listPage(userId, { limit: 10 });
    expect([...first.images, ...second.images].map((r) => r.id)).toEqual(
      all.images.map((r) => r.id),
    );
  });

  test("listPage only returns the user's own images", async () => {
    const userId = await backend.newUser();
    const other = await backend.newUser();
    const mine = await add(images, userId);
    await add(images, other);

    const page = await images.listPage(userId, { limit: 10 });
    expect(page.images.map((r) => r.id)).toEqual([mine.id]);
    expect(page.next).toBeNull();
  });

  test("usage counts the user's images and bytes", async () => {
    const userId = await backend.newUser();
    const other = await backend.newUser();
    expect(await images.usage(userId)).toEqual({ count: 0, bytes: 0 });
    await add(images, userId, newImage(userId, { sizeBytes: 100 }));
    await add(images, userId, newImage(userId, { sizeBytes: 250 }));
    await add(images, other);
    expect(await images.usage(userId)).toEqual({ count: 2, bytes: 350 });
  });

  test("create refuses an image over the count quota", async () => {
    const userId = await backend.newUser();
    const quota = { maxImages: 2, maxBytes: 1e12 };
    expect(await images.create(newImage(userId), quota)).not.toBeNull();
    expect(await images.create(newImage(userId), quota)).not.toBeNull();
    expect(await images.create(newImage(userId), quota)).toBeNull();
    expect((await images.usage(userId)).count).toBe(2);
    // Another user has their own allowance.
    expect(await images.create(newImage(await backend.newUser()), quota)).not.toBeNull();
  });

  test("create refuses an image that would pass the byte quota, and allows one that fills it", async () => {
    const userId = await backend.newUser();
    const quota = { maxImages: 100, maxBytes: 1_000 };
    expect(await images.create(newImage(userId, { sizeBytes: 600 }), quota)).not.toBeNull();
    expect(await images.create(newImage(userId, { sizeBytes: 401 }), quota)).toBeNull();
    expect(await images.create(newImage(userId, { sizeBytes: 400 }), quota)).not.toBeNull();
  });

  test("concurrent creates cannot overshoot the quota", async () => {
    const userId = await backend.newUser();
    const quota = { maxImages: 3, maxBytes: 1e12 };
    const results = await Promise.all(
      Array.from({ length: 8 }, () => images.create(newImage(userId), quota)),
    );
    expect(results.filter(Boolean)).toHaveLength(3);
    expect((await images.usage(userId)).count).toBe(3);
  });

  test("deleting an image frees its quota", async () => {
    const userId = await backend.newUser();
    const quota = { maxImages: 1, maxBytes: 1e12 };
    const row = await images.create(newImage(userId), quota);
    expect(await images.create(newImage(userId), quota)).toBeNull();
    await images.deleteOwned(userId, (row as ImageRow).id);
    expect(await images.create(newImage(userId), quota)).not.toBeNull();
  });
});

describe.skipIf(!sql)("images table", () => {
  test("the keyset index exists", async () => {
    const db = sql as NonNullable<typeof sql>;
    const rows = await db<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE tablename = 'images' AND schemaname = current_schema()
    `;
    expect(rows.map((r) => r.indexname)).toContain("images_user_gallery_idx");
  });
});
