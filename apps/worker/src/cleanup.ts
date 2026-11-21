import type { ImageRepository } from "@stego/db";
import type { ObjectStore } from "@stego/storage";

export interface CleanupDeps {
  images: Pick<ImageRepository, "listExpired" | "deleteOwned">;
  storage: Pick<ObjectStore, "delete">;
  now?: () => Date;
  batchSize?: number;
  log?: Pick<Console, "error">;
}

const DEFAULT_BATCH_SIZE = 100;

/**
 * Deletes the variants whose expiry has passed, object first and row second: a failure in between
 * leaves a row that the next run retries, never an object nobody can find. Batches follow each other
 * by `(expires_at, id)`, so a row that keeps failing does not hold back the newer ones. Returns how
 * many rows it removed.
 */
export async function cleanupExpiredVariants({
  images,
  storage,
  now = () => new Date(),
  batchSize = DEFAULT_BATCH_SIZE,
  log = console,
}: CleanupDeps): Promise<number> {
  const cutoff = now();
  let removed = 0;
  let after: { expiresAt: Date; id: string } | undefined;
  for (;;) {
    const batch = await images.listExpired(cutoff, batchSize, after);
    for (const row of batch) {
      try {
        await storage.delete(row.storage_key);
        await images.deleteOwned(row.user_id, row.id);
        removed++;
      } catch (error) {
        log.error("Could not delete an expired variant", row.id, error);
      }
    }
    const last = batch.at(-1);
    if (!last || batch.length < batchSize) return removed;
    after = { expiresAt: last.expires_at as Date, id: last.id };
  }
}
