import type { ImageRepository } from "../images.ts";
import type { ImageRow } from "../types.ts";

/** In-process image repository for tests; passes the same contract suite as the Postgres one. */
export function createMemoryImageRepository(): ImageRepository {
  const images = new Map<string, ImageRow>();
  const owned = (userId: string, id: string) => {
    const row = images.get(id);
    return row?.user_id === userId ? row : null;
  };

  const usage = (userId: string) => {
    const own = [...images.values()].filter(
      (row) => row.user_id === userId && row.kind !== "variant",
    );
    return { count: own.length, bytes: own.reduce((sum, row) => sum + row.size_bytes, 0) };
  };

  return {
    async create(image, quota) {
      const used = usage(image.userId);
      if (used.count >= quota.maxImages || used.bytes + image.sizeBytes > quota.maxBytes) {
        return null;
      }
      const row: ImageRow = {
        id: crypto.randomUUID(),
        user_id: image.userId,
        kind: image.kind,
        storage_key: image.storageKey,
        format: image.format,
        width: image.width,
        height: image.height,
        size_bytes: image.sizeBytes,
        sha256: image.sha256,
        expires_at: null,
        created_at: new Date(),
      };
      images.set(row.id, row);
      return { ...row };
    },

    async createVariant(image, { ttlMs, maxBytes }) {
      const now = Date.now();
      const live = [...images.values()]
        .filter(
          (r) =>
            r.user_id === image.userId &&
            r.kind === "variant" &&
            (r.expires_at as Date).getTime() > now,
        )
        .reduce((sum, r) => sum + r.size_bytes, 0);
      if (live + image.sizeBytes > maxBytes) return null;
      const row: ImageRow = {
        id: crypto.randomUUID(),
        user_id: image.userId,
        kind: "variant",
        storage_key: image.storageKey,
        format: image.format,
        width: image.width,
        height: image.height,
        size_bytes: image.sizeBytes,
        sha256: image.sha256,
        expires_at: new Date(now + ttlMs),
        created_at: new Date(),
      };
      images.set(row.id, row);
      return { ...row };
    },

    async listExpired(now, limit, after) {
      const order = (a: ImageRow, b: ImageRow) =>
        (a.expires_at as Date).getTime() - (b.expires_at as Date).getTime() ||
        (a.id < b.id ? -1 : 1);
      return [...images.values()]
        .filter((row) => row.expires_at !== null && row.expires_at <= now)
        .sort(order)
        .filter(
          (row) =>
            !after ||
            (row.expires_at as Date).getTime() > after.expiresAt.getTime() ||
            ((row.expires_at as Date).getTime() === after.expiresAt.getTime() && row.id > after.id),
        )
        .slice(0, limit)
        .map((row) => ({ ...row }));
    },

    async usage(userId) {
      return usage(userId);
    },

    async findOwned(userId, id) {
      const row = owned(userId, id);
      return row && { ...row };
    },

    async listPage(userId, { limit, after }) {
      const newestFirst = [...images.values()]
        .filter((row) => row.user_id === userId && row.kind !== "variant")
        .sort((a, b) => b.created_at.getTime() - a.created_at.getTime() || (a.id < b.id ? 1 : -1));
      const start = after
        ? newestFirst.findIndex((row) => isBefore(row, after.createdAt, after.id))
        : 0;
      const rest = start < 0 ? [] : newestFirst.slice(start);
      const page = rest.slice(0, limit);
      const last = rest.length > limit ? page.at(-1) : undefined;
      return {
        images: page.map((row) => ({ ...row })),
        next: last ? { createdAt: last.created_at.toISOString(), id: last.id } : null,
      };
    },

    async deleteOwned(userId, id) {
      const row = owned(userId, id);
      if (row) images.delete(id);
      return row;
    },
  };
}

/** Whether `row` sorts after the cursor position in newest-first order. */
function isBefore(row: ImageRow, createdAt: string, id: string): boolean {
  const at = new Date(createdAt).getTime();
  return row.created_at.getTime() < at || (row.created_at.getTime() === at && row.id < id);
}
