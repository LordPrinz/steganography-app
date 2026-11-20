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

const USER_ID = /^[A-Za-z0-9_-]+$/;

/** A fresh key `users/{userId}/{uuid}.png`. The user id must be a single path-safe segment. */
export function newImageKey(userId: string): string {
  if (!USER_ID.test(userId)) throw new RangeError("userId must be letters, digits, '-' or '_'");
  return `users/${userId}/${crypto.randomUUID()}.png`;
}

export function assertPresignTtl(ttlSeconds: number): void {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new RangeError(`TTL must be a positive integer of seconds, got ${ttlSeconds}`);
  }
}
