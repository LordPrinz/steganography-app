import { describe, expect, test } from "bun:test";
import { createMemoryImageRepository } from "@stego/db/testing";
import { createMemoryObjectStore, newImageKey } from "@stego/storage";
import { cleanupExpiredVariants } from "./cleanup.ts";

const USER = crypto.randomUUID();
const silent = { error: () => {} };

async function setup() {
  const images = createMemoryImageRepository();
  const storage = createMemoryObjectStore();
  async function add(kind: "variant" | "original", ttlMs = 1_000) {
    const storageKey = newImageKey(USER);
    await storage.put(storageKey, new Uint8Array([1]));
    const input = {
      userId: USER,
      storageKey,
      format: "png",
      width: 1,
      height: 1,
      sizeBytes: 1,
      sha256: "0".repeat(64),
    };
    if (kind === "variant") {
      const row = await images.createVariant(input, { ttlMs, maxBytes: 1e9 });
      return row as NonNullable<typeof row>;
    }
    const row = await images.create({ ...input, kind }, { maxImages: 10, maxBytes: 1e9 });
    return row as NonNullable<typeof row>;
  }
  return { images, storage, add };
}

describe("cleanupExpiredVariants", () => {
  test("removes expired variants, object and row, and leaves the rest", async () => {
    const { images, storage, add } = await setup();
    const expired = await add("variant", 1_000);
    const fresh = await add("variant", 3_600_000);
    const original = await add("original");

    const removed = await cleanupExpiredVariants({
      images,
      storage,
      now: () => new Date(Date.now() + 5_000),
    });

    expect(removed).toBe(1);
    expect(await images.findOwned(USER, expired.id)).toBeNull();
    expect(await storage.get(expired.storage_key)).toBeNull();
    expect(await images.findOwned(USER, fresh.id)).not.toBeNull();
    expect(await storage.get(fresh.storage_key)).not.toBeNull();
    expect(await images.findOwned(USER, original.id)).not.toBeNull();
  });

  test("works through several batches", async () => {
    const { images, storage, add } = await setup();
    for (let i = 0; i < 5; i++) await add("variant");
    const removed = await cleanupExpiredVariants({
      images,
      storage,
      now: () => new Date(Date.now() + 5_000),
      batchSize: 2,
    });
    expect(removed).toBe(5);
    expect(await images.listExpired(new Date(Date.now() + 5_000), 10)).toEqual([]);
  });

  test("keeps the row when the object cannot be deleted, and does not loop", async () => {
    const { images, storage, add } = await setup();
    const row = await add("variant");
    const removed = await cleanupExpiredVariants({
      images,
      storage: {
        delete: async () => {
          throw new Error("storage down");
        },
      },
      now: () => new Date(Date.now() + 5_000),
      log: silent,
    });
    expect(removed).toBe(0);
    expect(await images.findOwned(USER, row.id)).not.toBeNull();
    expect(await storage.get(row.storage_key)).not.toBeNull();
  });

  test("a row that keeps failing does not hold back newer ones", async () => {
    const { images, storage, add } = await setup();
    const stuck = [await add("variant", 500), await add("variant", 501)];
    const fine = [await add("variant", 502), await add("variant", 503), await add("variant", 504)];
    const stuckKeys = new Set(stuck.map((row) => row.storage_key));
    const removed = await cleanupExpiredVariants({
      images,
      storage: {
        delete: async (key) => {
          if (stuckKeys.has(key)) throw new Error("storage down");
          await storage.delete(key);
        },
      },
      now: () => new Date(Date.now() + 5_000),
      batchSize: 2,
      log: silent,
    });
    expect(removed).toBe(3);
    for (const row of fine) expect(await images.findOwned(USER, row.id)).toBeNull();
    for (const row of stuck) expect(await images.findOwned(USER, row.id)).not.toBeNull();
  });

  test("does nothing when nothing expired", async () => {
    const { images, storage, add } = await setup();
    await add("variant", 3_600_000);
    expect(await cleanupExpiredVariants({ images, storage })).toBe(0);
  });
});
