import { S3Client } from "bun";
import { assertImageKey, assertPresignTtl, type ObjectStore } from "./store.ts";

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface S3StoreOptions {
  /** How long `ping` waits before reporting the bucket as down. */
  pingTimeoutMs?: number;
}

/** `ObjectStore` on Bun's built-in S3 client (R2 in production, RustFS locally). */
export function createS3ObjectStore(
  config: S3Config,
  { pingTimeoutMs = 2_000 }: S3StoreOptions = {},
): ObjectStore {
  const client = new S3Client(config);

  return {
    async put(key, bytes) {
      assertImageKey(key);
      await client.write(key, bytes, { type: "image/png" });
    },
    async get(key) {
      assertImageKey(key);
      try {
        return await client.file(key).bytes();
      } catch (error) {
        if ((error as { code?: string }).code === "NoSuchKey") return null;
        throw error;
      }
    },
    async delete(key) {
      assertImageKey(key);
      await client.delete(key);
    },
    async presignGet(key, ttlSeconds) {
      assertImageKey(key);
      assertPresignTtl(ttlSeconds);
      return client.presign(key, { method: "GET", expiresIn: ttlSeconds });
    },
    async ping() {
      let timer: Timer | undefined;
      const timeout = new Promise<false>((resolve) => {
        timer = setTimeout(resolve, pingTimeoutMs, false);
      });
      const listed = client.list({ maxKeys: 1 }).then(
        () => true,
        () => false,
      );
      try {
        return await Promise.race([listed, timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
