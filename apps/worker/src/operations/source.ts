import { type ImageRepository, JobError, type JobOperation } from "@stego/db";
import { decodeRgba, InvalidImageError, type RgbaImage } from "@stego/image-io";
import type { ObjectStore } from "@stego/storage";

export interface SourceDeps {
  images: Pick<ImageRepository, "findOwned">;
  storage: Pick<ObjectStore, "get">;
  /** Only a decode may read a variant, and only before it expires. */
  allowVariant?: boolean;
  now?: () => number;
}

/**
 * The operation's source image as pixels. The lookup is scoped to the operation's owner again, so a
 * forged `source_image_id` could not read someone else's object. Fails the job for good when the image
 * is gone (the user deleted it meanwhile) or does not decode.
 */
export async function loadSource(
  { images, storage, allowVariant = false, now = Date.now }: SourceDeps,
  operation: JobOperation,
): Promise<RgbaImage> {
  const row = operation.source_image_id
    ? await images.findOwned(operation.user_id, operation.source_image_id)
    : null;
  const usable =
    row &&
    (allowVariant || row.kind !== "variant") &&
    !(row.expires_at && row.expires_at.getTime() <= now());
  const bytes = usable ? await storage.get(row.storage_key) : null;
  if (!bytes) throw new JobError("source_missing");
  try {
    return await decodeRgba(bytes);
  } catch (error) {
    if (error instanceof InvalidImageError) throw new JobError("invalid_image", { cause: error });
    throw error;
  }
}
