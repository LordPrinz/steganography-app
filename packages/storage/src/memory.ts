import { assertPresignTtl, type ObjectStore } from "./store.ts";

/** In-process store for tests. Presigned URLs use a fake scheme and cannot be fetched. */
export function createMemoryObjectStore(): ObjectStore {
  const objects = new Map<string, Uint8Array>();
  return {
    async put(key, bytes) {
      objects.set(key, bytes.slice());
    },
    async get(key) {
      return objects.get(key)?.slice() ?? null;
    },
    async delete(key) {
      objects.delete(key);
    },
    async presignGet(key, ttlSeconds) {
      assertPresignTtl(ttlSeconds);
      return `memory://objects/${key}?expires=${ttlSeconds}`;
    },
    async ping() {
      return true;
    },
  };
}
