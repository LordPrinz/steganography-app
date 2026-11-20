/**
 * Port for the private image bucket. Callers hold keys from `newImageKey`; bytes in, bytes out.
 * Every object is a PNG: stego images and lab variants are stored lossless.
 */
export interface ObjectStore {
  /** Writes (or overwrites) an object with content type `image/png`. */
  put(key: string, bytes: Uint8Array): Promise<void>;
  /** The object's bytes, or null when the key does not exist. */
  get(key: string): Promise<Uint8Array | null>;
  /** Removes an object; a missing key is not an error. */
  delete(key: string): Promise<void>;
  /** A time-limited GET URL. Check ownership before handing one out. */
  presignGet(key: string, ttlSeconds: number): Promise<string>;
  /** True when the bucket answers; never throws. */
  ping(): Promise<boolean>;
}

/** Presigned URLs stay short-lived (DESIGN.md); SigV4 itself allows up to seven days. */
export const MAX_PRESIGN_TTL_SECONDS = 3600;

const USER_ID = /^[A-Za-z0-9_-]+$/;

/** A fresh key `users/{userId}/{uuid}.png`. The user id must be a single path-safe segment. */
export function newImageKey(userId: string): string {
  if (!USER_ID.test(userId)) throw new RangeError("userId must be letters, digits, '-' or '_'");
  return `users/${userId}/${crypto.randomUUID()}.png`;
}

const IMAGE_KEY =
  /^users\/[A-Za-z0-9_-]+\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/;

/** Adapters accept only keys shaped like `newImageKey` output, so a caller cannot reach other prefixes. */
export function assertImageKey(key: string): void {
  if (!IMAGE_KEY.test(key)) throw new RangeError(`Not an image key: ${key}`);
}

export function assertPresignTtl(ttlSeconds: number): void {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > MAX_PRESIGN_TTL_SECONDS) {
    throw new RangeError(
      `TTL must be an integer between 1 and ${MAX_PRESIGN_TTL_SECONDS} seconds, got ${ttlSeconds}`,
    );
  }
}
