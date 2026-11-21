import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createUserRepository } from "./auth.ts";
import {
  createImageRepository,
  type ImageCursor,
  type ImageRepository,
  type NewImage,
} from "./images.ts";
import { createMemoryImageRepository, createTestDatabase } from "./testing/index.ts";

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
    const row = await images.create(input);
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
    const row = await images.create(newImage(owner));

    expect(await images.findOwned(other, row.id)).toBeNull();
    expect(await images.deleteOwned(other, row.id)).toBeNull();
    expect(await images.findOwned(owner, row.id)).not.toBeNull();
  });

  test("deleteOwned returns the deleted row", async () => {
    const userId = await backend.newUser();
    const row = await images.create(newImage(userId));
    expect(await images.deleteOwned(userId, row.id)).toEqual(row);
    expect(await images.findOwned(userId, row.id)).toBeNull();
    expect(await images.deleteOwned(userId, row.id)).toBeNull();
  });

  test("listPage pages newest first without gaps or repeats", async () => {
    const userId = await backend.newUser();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.unshift((await images.create(newImage(userId))).id);
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
    await images.create(newImage(userId));
    await images.create(newImage(userId));
    const page = await images.listPage(userId, { limit: 2 });
    expect(page.images).toHaveLength(2);
    expect(page.next).toBeNull();
  });

  test("rows created in the same instant keep a stable order", async () => {
    const userId = await backend.newUser();
    for (let i = 0; i < 6; i++) await images.create(newImage(userId));

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
    const mine = await images.create(newImage(userId));
    await images.create(newImage(other));

    const page = await images.listPage(userId, { limit: 10 });
    expect(page.images.map((r) => r.id)).toEqual([mine.id]);
    expect(page.next).toBeNull();
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
