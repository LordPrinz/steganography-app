import { afterEach, describe, expect, test } from "bun:test";
import { createMemoryObjectStore } from "./memory.ts";
import { createS3ObjectStore, type S3Config } from "./s3.ts";
import { MAX_PRESIGN_TTL_SECONDS, newImageKey, type ObjectStore } from "./store.ts";

// Shared contract: every ObjectStore adapter must pass the same suite.
// The S3 adapter runs only when a disposable bucket is configured (CI provides RustFS).
const { TEST_S3_ENDPOINT, TEST_S3_BUCKET, TEST_S3_ACCESS_KEY_ID, TEST_S3_SECRET_ACCESS_KEY } =
  Bun.env;
const s3Config: S3Config | undefined =
  TEST_S3_ENDPOINT && TEST_S3_BUCKET && TEST_S3_ACCESS_KEY_ID && TEST_S3_SECRET_ACCESS_KEY
    ? {
        endpoint: TEST_S3_ENDPOINT,
        region: Bun.env.TEST_S3_REGION ?? "auto",
        bucket: TEST_S3_BUCKET,
        accessKeyId: TEST_S3_ACCESS_KEY_ID,
        secretAccessKey: TEST_S3_SECRET_ACCESS_KEY,
      }
    : undefined;

const adapters: [string, () => ObjectStore][] = [["memory", createMemoryObjectStore]];
if (s3Config) adapters.push(["s3", () => createS3ObjectStore(s3Config)]);

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

describe.each(adapters)("ObjectStore (%s)", (_name, make) => {
  // Keys written by a test are removed afterwards, so a failure cannot leak into the shared bucket.
  const written: [ObjectStore, string][] = [];
  function fresh(): [ObjectStore, string] {
    const entry: [ObjectStore, string] = [make(), newImageKey("user-1")];
    written.push(entry);
    return entry;
  }
  afterEach(async () => {
    for (const [store, key] of written.splice(0)) await store.delete(key).catch(() => {});
  });

  test("get returns null for a missing key", async () => {
    const [store, key] = fresh();
    expect(await store.get(key)).toBeNull();
  });

  test("put, get and delete round-trip", async () => {
    const [store, key] = fresh();
    const bytes = new Uint8Array([...PNG_MAGIC, 1, 2, 3, 255, 0]);
    await store.put(key, bytes);
    expect(await store.get(key)).toEqual(bytes);
    await store.delete(key);
    expect(await store.get(key)).toBeNull();
  });

  test("put overwrites an existing key", async () => {
    const [store, key] = fresh();
    await store.put(key, new Uint8Array([1]));
    await store.put(key, new Uint8Array([2, 3]));
    expect(await store.get(key)).toEqual(new Uint8Array([2, 3]));
  });

  test("delete of a missing key does not throw", async () => {
    const [store, key] = fresh();
    await store.delete(key);
  });

  test("presignGet returns a URL for the key", async () => {
    const [store, key] = fresh();
    expect(await store.presignGet(key, 60)).toContain(key);
  });

  test("presignGet rejects a TTL outside 1..3600 seconds", async () => {
    const [store, key] = fresh();
    for (const ttl of [0, -1, 1.5, MAX_PRESIGN_TTL_SECONDS + 1]) {
      await expect(store.presignGet(key, ttl)).rejects.toBeInstanceOf(RangeError);
    }
    expect(await store.presignGet(key, MAX_PRESIGN_TTL_SECONDS)).toContain(key);
  });

  test("every operation rejects a key that newImageKey could not have produced", async () => {
    const store = make();
    const bad = [
      "users/../other/00000000-0000-4000-8000-000000000000.png",
      "/users/u/00000000-0000-4000-8000-000000000000.png",
      "other/u/00000000-0000-4000-8000-000000000000.png",
      "users/u/not-a-uuid.png",
      "users/u/00000000-0000-4000-8000-000000000000.jpg",
      "",
    ];
    for (const key of bad) {
      await expect(store.put(key, new Uint8Array([1]))).rejects.toBeInstanceOf(RangeError);
      await expect(store.get(key)).rejects.toBeInstanceOf(RangeError);
      await expect(store.delete(key)).rejects.toBeInstanceOf(RangeError);
      await expect(store.presignGet(key, 60)).rejects.toBeInstanceOf(RangeError);
    }
  });

  test("ping reports the bucket as up", async () => {
    expect(await make().ping()).toBe(true);
  });
});

describe.skipIf(!s3Config)("S3 adapter against a real bucket", () => {
  test("a presigned URL serves the object as image/png, the bare URL is refused", async () => {
    const store = createS3ObjectStore(s3Config as S3Config);
    const key = newImageKey("user-1");
    const bytes = new Uint8Array([...PNG_MAGIC, 9]);
    try {
      await store.put(key, bytes);
      const url = await store.presignGet(key, 60);
      const res = await fetch(url);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
      expect((await fetch(url.split("?")[0] as string)).status).toBeGreaterThanOrEqual(400);
    } finally {
      await store.delete(key);
    }
  });

  test("ping reports a missing bucket as down", async () => {
    const store = createS3ObjectStore({ ...(s3Config as S3Config), bucket: "no-such-bucket" });
    expect(await store.ping()).toBe(false);
  });
});

describe("S3 ping timeout", () => {
  test("a server that never answers makes ping resolve false", async () => {
    const hang = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) });
    try {
      const store = createS3ObjectStore(
        {
          endpoint: hang.url.href,
          region: "auto",
          bucket: "any",
          accessKeyId: "a",
          secretAccessKey: "b",
        },
        { pingTimeoutMs: 100 },
      );
      const started = performance.now();
      expect(await store.ping()).toBe(false);
      expect(performance.now() - started).toBeLessThan(2_000);
    } finally {
      await hang.stop(true);
    }
  });
});

describe("newImageKey", () => {
  test("has the shape users/{userId}/{uuid}.png and is unique", () => {
    const key = newImageKey("abc-123");
    expect(key).toMatch(/^users\/abc-123\/[0-9a-f-]{36}\.png$/);
    expect(newImageKey("abc-123")).not.toBe(key);
  });

  test("rejects a user id that could escape its prefix", () => {
    for (const id of ["", "../x", "a/b", "a b"]) {
      expect(() => newImageKey(id)).toThrow(RangeError);
    }
  });
});
