import type { SQL } from "bun";
import type { KeysetCursor } from "./keyset.ts";
import type { ImageKind, ImageRow } from "./types.ts";

export interface NewImage {
  userId: string;
  kind: ImageKind;
  storageKey: string;
  format: string;
  width: number;
  height: number;
  sizeBytes: number;
  sha256: string;
}

/** An attacked image of the robustness lab; it has no quota and expires. */
export type NewVariant = Omit<NewImage, "kind">;

/** Position in a user's gallery. */
export type ImageCursor = KeysetCursor;

export interface ImagePage {
  images: ImageRow[];
  /** Cursor for the next page, or null at the end. */
  next: ImageCursor | null;
}

export interface ImageQuota {
  maxImages: number;
  maxBytes: number;
}

export interface ImageUsage {
  count: number;
  bytes: number;
}

/** Every lookup takes the owner's id, so a caller cannot reach another user's image by id alone. */
export interface ImageRepository {
  /**
   * Inserts the row unless that would take the user over `quota` (already `maxImages` images, or
   * `maxBytes` with this one). Returns null then. The check and the insert are one step per user, so
   * concurrent uploads cannot overshoot.
   */
  create(image: NewImage, quota: ImageQuota): Promise<ImageRow | null>;
  /**
   * Inserts a `variant` image that expires `ttlMs` from now, unless the user's live (unexpired) variants
   * would pass `maxBytes` with it; then null. The check and the insert are one step per user, under the
   * same lock as `create`. Variants count against no image quota and are not listed in the gallery.
   */
  createVariant(
    image: NewVariant,
    options: { ttlMs: number; maxBytes: number },
  ): Promise<ImageRow | null>;
  /**
   * Images (variants) whose expiry is at or before `now`, ordered by `(expires_at, id)`. Pass the last
   * row of the previous batch as `after` to continue past it.
   */
  listExpired(
    now: Date,
    limit: number,
    after?: { expiresAt: Date; id: string },
  ): Promise<ImageRow[]>;
  /** What the user's quota counts: variants are left out. */
  usage(userId: string): Promise<ImageUsage>;
  findOwned(userId: string, id: string): Promise<ImageRow | null>;
  /** Newest first, variants left out. `limit` rows after `after` (the start when omitted). */
  listPage(userId: string, options: { limit: number; after?: ImageCursor }): Promise<ImagePage>;
  /** Deletes the row and returns it (the caller removes the object), or null when not the user's. */
  deleteOwned(userId: string, id: string): Promise<ImageRow | null>;
}

type ImageRowWithCursor = ImageRow & { cursor_at: string };

async function readUsage(sql: SQL, userId: string): Promise<ImageUsage> {
  // sum() of an integer column is a bigint, which Bun returns as a string.
  const [row] = await sql<{ count: number; bytes: string }[]>`
    SELECT count(*)::int AS count, coalesce(sum(size_bytes), 0)::bigint AS bytes
    FROM images WHERE user_id = ${userId} AND kind <> 'variant'
  `;
  return { count: row?.count ?? 0, bytes: Number(row?.bytes ?? 0) };
}

export function createImageRepository(sql: SQL): ImageRepository {
  return {
    create(image, quota) {
      return sql.begin(async (tx) => {
        // Serialises one user's uploads, so the usage read below cannot go stale before the insert.
        await tx`SELECT 1 FROM users WHERE id = ${image.userId} FOR UPDATE`;
        const used = await readUsage(tx, image.userId);
        if (used.count >= quota.maxImages || used.bytes + image.sizeBytes > quota.maxBytes) {
          return null;
        }
        const [row] = await tx<ImageRow[]>`
          INSERT INTO images (user_id, kind, storage_key, format, width, height, size_bytes, sha256)
          VALUES (${image.userId}, ${image.kind}, ${image.storageKey}, ${image.format}, ${image.width},
                  ${image.height}, ${image.sizeBytes}, ${image.sha256})
          RETURNING *
        `;
        return row as ImageRow;
      });
    },

    createVariant(image, { ttlMs, maxBytes }) {
      const now = Date.now();
      return sql.begin(async (tx) => {
        // The lock `create` takes, so variants and uploads of one user never race each other.
        await tx`SELECT 1 FROM users WHERE id = ${image.userId} FOR UPDATE`;
        const [live] = await tx<{ bytes: string }[]>`
          SELECT coalesce(sum(size_bytes), 0)::bigint AS bytes FROM images
          WHERE user_id = ${image.userId} AND kind = 'variant'
            AND expires_at > ${new Date(now).toISOString()}::timestamptz
        `;
        if (Number(live?.bytes ?? 0) + image.sizeBytes > maxBytes) return null;
        const [row] = await tx<ImageRow[]>`
          INSERT INTO images (user_id, kind, storage_key, format, width, height, size_bytes, sha256, expires_at)
          VALUES (${image.userId}, 'variant', ${image.storageKey}, ${image.format}, ${image.width},
                  ${image.height}, ${image.sizeBytes}, ${image.sha256},
                  ${new Date(now + ttlMs).toISOString()}::timestamptz)
          RETURNING *
        `;
        return row as ImageRow;
      });
    },

    listExpired: (now, limit, after) => sql<ImageRow[]>`
      SELECT * FROM images
      WHERE expires_at IS NOT NULL AND expires_at <= ${now.toISOString()}::timestamptz
        ${after ? sql`AND (expires_at, id) > (${after.expiresAt.toISOString()}::timestamptz, ${after.id}::uuid)` : sql``}
      ORDER BY expires_at, id
      LIMIT ${limit}
    `,

    usage: (userId) => readUsage(sql, userId),

    async findOwned(userId, id) {
      const [row] = await sql<ImageRow[]>`
        SELECT * FROM images WHERE id = ${id} AND user_id = ${userId}
      `;
      return row ?? null;
    },

    async listPage(userId, { limit, after }) {
      // One extra row tells whether another page exists. cursor_at is the timestamp as UTC text with
      // microseconds, which a JS Date would round.
      const rows = await sql<ImageRowWithCursor[]>`
        SELECT *, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
        FROM images
        WHERE user_id = ${userId} AND kind <> 'variant'
          ${after ? sql`AND (created_at, id) < (${after.createdAt}::timestamptz, ${after.id}::uuid)` : sql``}
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit + 1}
      `;
      const page = rows.slice(0, limit);
      const last = rows.length > limit ? page.at(-1) : undefined;
      return {
        images: page.map(({ cursor_at: _, ...row }) => row),
        next: last ? { createdAt: last.cursor_at, id: last.id } : null,
      };
    },

    async deleteOwned(userId, id) {
      const [row] = await sql<ImageRow[]>`
        DELETE FROM images WHERE id = ${id} AND user_id = ${userId} RETURNING *
      `;
      return row ?? null;
    },
  };
}
