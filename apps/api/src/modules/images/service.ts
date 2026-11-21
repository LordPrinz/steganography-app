import {
  type ImageDetail,
  type ImageMeta,
  type ImagePage,
  MAX_IMAGES_PER_USER,
  MAX_PNG_BYTES,
  MAX_USER_IMAGE_BYTES,
} from "@stego/contracts";
import type { ImageCursor, ImageRepository, ImageRow } from "@stego/db";
import { decodeRgba, encodePng } from "@stego/image-io";
import { newImageKey, type ObjectStore } from "@stego/storage";
import type { ConcurrencyLimit } from "../../lib/concurrency-limit.ts";
import { encodeCursor } from "../../lib/cursor.ts";

/** The bytes are not a PNG, JPEG or WebP, whatever the client claimed. */
export class UnsupportedImageError extends Error {
  override readonly name = "UnsupportedImageError";
}

export interface ImageService {
  /**
   * Stores an upload as a fresh PNG. Throws `UnsupportedImageError` for other formats and image-io's
   * `InvalidImageError` for bytes that do not decode (corrupt, or over the pixel limit),
   * `QuotaExceededError` and `ImageTooLargeError` for the size caps, and `BusyError` when every decode
   * slot is taken.
   */
  upload(userId: string, bytes: Uint8Array): Promise<ImageMeta>;
  list(userId: string, options: { limit: number; after?: ImageCursor }): Promise<ImagePage>;
  /** Null when the image does not exist or belongs to someone else. */
  get(userId: string, id: string): Promise<ImageDetail | null>;
  /** False when the image does not exist or belongs to someone else. */
  remove(userId: string, id: string): Promise<boolean>;
}

export interface ImageServiceDeps {
  images: ImageRepository;
  storage: Pick<ObjectStore, "put" | "delete" | "presignGet">;
  /** How long a presigned URL from `get` stays valid. */
  urlTtlSeconds: number;
  /** Bounds concurrent decodes; a full limit makes `upload` throw `BusyError`. */
  decodeLimit: ConcurrencyLimit;
  limits?: ImageLimits;
  now?: () => number;
}

export interface ImageLimits {
  maxImages: number;
  maxUserBytes: number;
  maxPngBytes: number;
}

export const DEFAULT_IMAGE_LIMITS: ImageLimits = {
  maxImages: MAX_IMAGES_PER_USER,
  maxUserBytes: MAX_USER_IMAGE_BYTES,
  maxPngBytes: MAX_PNG_BYTES,
};

/** The user already stores as many images, or as many bytes, as allowed. */
export class QuotaExceededError extends Error {
  override readonly name = "QuotaExceededError";
}

/** The re-encoded PNG is over the size ceiling. */
export class ImageTooLargeError extends Error {
  override readonly name = "ImageTooLargeError";
}

// Decoders have a long history of bugs, so only formats worth the risk reach them, picked by magic
// bytes. The Content-Type and the file name come from the client and prove nothing.
function isSupportedFormat(b: Uint8Array): boolean {
  const png = b.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => b[i] === byte);
  const jpeg = b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  const webp = b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP";
  return png || jpeg || webp;
}

function ascii(b: Uint8Array, from: number, to: number): string {
  return String.fromCharCode(...b.subarray(from, to));
}

export function toImageMeta(row: ImageRow): ImageMeta {
  return {
    id: row.id,
    kind: row.kind,
    format: "png",
    width: row.width,
    height: row.height,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    createdAt: row.created_at.toISOString(),
  };
}

export function createImageService({
  images,
  storage,
  urlTtlSeconds,
  decodeLimit,
  limits = DEFAULT_IMAGE_LIMITS,
  now = Date.now,
}: ImageServiceDeps): ImageService {
  return {
    async upload(userId, bytes) {
      if (!isSupportedFormat(bytes)) throw new UnsupportedImageError("Unsupported image format");
      // Cheap early refusal; `create` below checks again, atomically.
      const used = await images.usage(userId);
      if (used.count >= limits.maxImages || used.bytes >= limits.maxUserBytes) {
        throw new QuotaExceededError();
      }
      // Decoding and re-encoding drops every metadata chunk (EXIF, GPS, text) and any trailing data, and
      // applies the EXIF orientation. The original bytes are never stored. A decode holds up to 64 MiB of
      // pixels, so only a few run at once.
      const { decoded, png } = await decodeLimit.run(async () => {
        const decoded = await decodeRgba(bytes);
        return { decoded, png: await encodePng(decoded) };
      });
      if (png.byteLength > limits.maxPngBytes) throw new ImageTooLargeError();
      const key = newImageKey(userId);
      await storage.put(key, png);
      try {
        const row = await images.create(
          {
            userId,
            kind: "original",
            storageKey: key,
            format: "png",
            width: decoded.width,
            height: decoded.height,
            sizeBytes: png.byteLength,
            sha256: new Bun.CryptoHasher("sha256").update(png).digest("hex"),
          },
          { maxImages: limits.maxImages, maxBytes: limits.maxUserBytes },
        );
        if (!row) throw new QuotaExceededError();
        return toImageMeta(row);
      } catch (error) {
        await storage.delete(key).catch((cleanup) => {
          console.error("Could not remove an object whose row was not saved", key, cleanup);
        });
        throw error;
      }
    },

    async list(userId, options) {
      const page = await images.listPage(userId, options);
      return {
        images: page.images.map(toImageMeta),
        nextCursor: page.next && encodeCursor(page.next),
      };
    },

    async get(userId, id) {
      // Ownership first: a URL is only signed for the owner's own row.
      const row = await images.findOwned(userId, id);
      if (!row) return null;
      // An expired variant is gone for the user even before the worker's sweep removes it.
      if (row.expires_at && row.expires_at.getTime() <= now()) return null;
      const url = await storage.presignGet(row.storage_key, urlTtlSeconds);
      return {
        ...toImageMeta(row),
        url,
        urlExpiresAt: new Date(now() + urlTtlSeconds * 1000).toISOString(),
      };
    },

    async remove(userId, id) {
      const row = await images.findOwned(userId, id);
      if (!row) return false;
      // Object first: if it fails the row stays and the delete can be retried; deleting a missing
      // object is not an error. The other order would leave an object nothing points to.
      await storage.delete(row.storage_key);
      await images.deleteOwned(userId, id);
      return true;
    },
  };
}
