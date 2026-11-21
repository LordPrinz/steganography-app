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

  describe("variants", () => {
    const { kind: _, ...variantInput } = newImage("unused");

    async function addVariant(userId: string, ttlMs = 60_000, sizeBytes = 100) {
      const row = await images.createVariant(
        {
          ...variantInput,
          sizeBytes,
          userId,
          storageKey: `users/${userId}/${crypto.randomUUID()}.png`,
        },
        { ttlMs, maxBytes: 1e12 },
      );
      return row as ImageRow;
    }

    test("createVariant stores an expiring variant row", async () => {
      const userId = await backend.newUser();
      const before = Date.now();
      const row = await addVariant(userId, 60_000);
      expect(row.kind).toBe("variant");
      expect(row.expires_at).toBeInstanceOf(Date);
      const expiresIn = (row.expires_at as Date).getTime() - before;
      expect(expiresIn).toBeGreaterThan(55_000);
      expect(expiresIn).toBeLessThan(65_000);
      expect(await images.findOwned(userId, row.id)).toEqual(row);
    });

    test("other kinds never expire", async () => {
      const userId = await backend.newUser();
      expect((await add(images, userId)).expires_at).toBeNull();
    });

    test("variants are not in the gallery and do not count against the quota", async () => {
      const userId = await backend.newUser();
      const mine = await add(images, userId, newImage(userId, { sizeBytes: 100 }));
      for (let i = 0; i < 3; i++) await addVariant(userId);

      expect((await images.listPage(userId, { limit: 10 })).images.map((r) => r.id)).toEqual([
        mine.id,
      ]);
      expect(await images.usage(userId)).toEqual({ count: 1, bytes: 100 });
      const quota = { maxImages: 2, maxBytes: 1e12 };
      expect(await images.create(newImage(userId), quota)).not.toBeNull();
    });

    test("createVariant refuses a variant that takes the user over the live byte cap", async () => {
      const userId = await backend.newUser();
      const other = await backend.newUser();
      const input = (user: string, sizeBytes: number) => ({
        ...variantInput,
        sizeBytes,
        userId: user,
        storageKey: `users/${user}/${crypto.randomUUID()}.png`,
      });
      const cap = { maxBytes: 250 };
      expect(
        await images.createVariant(input(userId, 100), { ttlMs: 60_000, ...cap }),
      ).not.toBeNull();
      expect(
        await images.createVariant(input(userId, 100), { ttlMs: 60_000, ...cap }),
      ).not.toBeNull();
      expect(await images.createVariant(input(userId, 100), { ttlMs: 60_000, ...cap })).toBeNull();
      expect(
        await images.createVariant(input(userId, 50), { ttlMs: 60_000, ...cap }),
      ).not.toBeNull();
      // Per user, and other kinds do not count.
      expect(
        await images.createVariant(input(other, 100), { ttlMs: 60_000, ...cap }),
      ).not.toBeNull();
      await add(images, userId, newImage(userId, { sizeBytes: 1_000 }));
    });

    test("expired variants no longer count against the cap", async () => {
      const userId = await backend.newUser();
      const input = {
        ...variantInput,
        sizeBytes: 100,
        userId,
        storageKey: `users/${userId}/${crypto.randomUUID()}.png`,
      };
      expect(await images.createVariant(input, { ttlMs: 1, maxBytes: 100 })).not.toBeNull();
      await Bun.sleep(10);
      const next = { ...input, storageKey: `users/${userId}/${crypto.randomUUID()}.png` };
      expect(await images.createVariant(next, { ttlMs: 60_000, maxBytes: 100 })).not.toBeNull();
    });

    test("listExpired continues after a cursor in (expires_at, id) order", async () => {
      const userId = await backend.newUser();
      const rows = [];
      for (let i = 0; i < 4; i++) rows.push(await addVariant(userId, 500 + i));
      const later = new Date(Date.now() + 10_000);
      const first = await images.listExpired(later, 2);
      expect(first.map((r) => r.id)).toEqual(rows.slice(0, 2).map((r) => r.id));
      const last = first.at(-1) as ImageRow;
      const second = await images.listExpired(later, 10, {
        expiresAt: last.expires_at as Date,
        id: last.id,
      });
      expect(second.map((r) => r.id)).toEqual(rows.slice(2).map((r) => r.id));
    });

    test("listExpired returns only variants past their expiry, oldest first", async () => {
      const userId = await backend.newUser();
      const soon = await addVariant(userId, 1_000);
      const sooner = await addVariant(userId, 500);
      await addVariant(userId, 3_600_000);
      await add(images, userId);

      const later = new Date(Date.now() + 10_000);
      expect((await images.listExpired(later, 10)).map((r) => r.id)).toEqual([sooner.id, soon.id]);
      expect(await images.listExpired(later, 1)).toHaveLength(1);
      expect(await images.listExpired(new Date(Date.now() - 1_000), 10)).toEqual([]);
    });
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
