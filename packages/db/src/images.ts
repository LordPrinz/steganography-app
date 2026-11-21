import type { SQL } from "bun";
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

/**
 * Position in a user's gallery. `createdAt` is a full-precision ISO timestamp: Postgres keeps
 * microseconds, a JS Date only milliseconds, and a rounded cursor would skip or repeat rows.
 */
export interface ImageCursor {
  createdAt: string;
  id: string;
}

export interface ImagePage {
  images: ImageRow[];
  /** Cursor for the next page, or null at the end. */
  next: ImageCursor | null;
}

/** Every lookup takes the owner's id, so a caller cannot reach another user's image by id alone. */
export interface ImageRepository {
  create(image: NewImage): Promise<ImageRow>;
  findOwned(userId: string, id: string): Promise<ImageRow | null>;
  /** Newest first. `limit` rows after `after` (the start when omitted). */
  listPage(userId: string, options: { limit: number; after?: ImageCursor }): Promise<ImagePage>;
  /** Deletes the row and returns it (the caller removes the object), or null when not the user's. */
  deleteOwned(userId: string, id: string): Promise<ImageRow | null>;
}

type ImageRowWithCursor = ImageRow & { cursor_at: string };

export function createImageRepository(sql: SQL): ImageRepository {
  return {
    async create(image) {
      const [row] = await sql<ImageRow[]>`
        INSERT INTO images (user_id, kind, storage_key, format, width, height, size_bytes, sha256)
        VALUES (${image.userId}, ${image.kind}, ${image.storageKey}, ${image.format}, ${image.width},
                ${image.height}, ${image.sizeBytes}, ${image.sha256})
        RETURNING *
      `;
      return row as ImageRow;
    },

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
        WHERE user_id = ${userId}
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
