import { assertImageKey, assertPresignTtl, type ObjectStore } from "./store.ts";

/** In-process store for tests. Presigned URLs use a fake scheme and cannot be fetched. */
export function createMemoryObjectStore(): ObjectStore {
  const objects = new Map<string, Uint8Array>();
  return {
    async put(key, bytes) {
      assertImageKey(key);
      objects.set(key, bytes.slice());
    },
    async get(key) {
      assertImageKey(key);
      return objects.get(key)?.slice() ?? null;
    },
    async delete(key) {
      assertImageKey(key);
      objects.delete(key);
    },
    async presignGet(key, ttlSeconds) {
      assertImageKey(key);
      assertPresignTtl(ttlSeconds);
      return `memory://objects/${key}?expires=${ttlSeconds}`;
    },
    async ping() {
      return true;
    },
  };
}
