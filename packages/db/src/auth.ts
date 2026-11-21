import type { SQL } from "bun";
import type { RefreshTokenRow, UserRow } from "./types.ts";

export interface UserRepository {
  /** Returns null when the e-mail is already taken. */
  create(email: string, passwordHash: string): Promise<UserRow | null>;
  findByEmail(email: string): Promise<UserRow | null>;
  findById(id: string): Promise<UserRow | null>;
}

export type RotateResult =
  | { status: "rotated"; userId: string }
  /**
   * The token was rotated more than the grace window ago: it leaked, so every session of the user was
   * revoked.
   */
  | { status: "reused"; userId: string }
  /**
   * Rotated within the grace window, most likely by another tab refreshing at the same moment. The
   * token is not accepted, but nothing is revoked.
   */
  | { status: "superseded" }
  /** Unknown, expired or revoked by logout. */
  | { status: "invalid" };

export interface RefreshTokenRepositoryOptions {
  /** How long after a rotation the old token counts as a concurrent refresh rather than reuse. */
  reuseGraceMs?: number;
}

export const DEFAULT_REUSE_GRACE_MS = 10_000;

export interface NewRefreshToken {
  tokenHash: string;
  expiresAt: Date;
}

/** Refresh tokens are stored only as hashes; callers hash before every call. */
export interface RefreshTokenRepository {
  issue(userId: string, token: NewRefreshToken): Promise<void>;
  /** Revokes `oldHash` and issues `next` in its place, atomically. */
  rotate(oldHash: string, next: NewRefreshToken): Promise<RotateResult>;
  revoke(tokenHash: string): Promise<void>;
}

export function createUserRepository(sql: SQL): UserRepository {
  return {
    async create(email, passwordHash) {
      const [user] = await sql<UserRow[]>`
        INSERT INTO users (email, password_hash) VALUES (${email}, ${passwordHash})
        ON CONFLICT (email) DO NOTHING
        RETURNING *
      `;
      return user ?? null;
    },
    async findByEmail(email) {
      const [user] = await sql<UserRow[]>`SELECT * FROM users WHERE email = ${email}`;
      return user ?? null;
    },
    async findById(id) {
      const [user] = await sql<UserRow[]>`SELECT * FROM users WHERE id = ${id}`;
      return user ?? null;
    },
  };
}

export function createRefreshTokenRepository(
  sql: SQL,
  { reuseGraceMs = DEFAULT_REUSE_GRACE_MS }: RefreshTokenRepositoryOptions = {},
): RefreshTokenRepository {
  const graceSecs = reuseGraceMs / 1000;
  return {
    async issue(userId, { tokenHash, expiresAt }) {
      await sql`
        INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
        VALUES (${userId}, ${tokenHash}, ${expiresAt})
      `;
    },

    rotate(oldHash, { tokenHash, expiresAt }) {
      const nextId = crypto.randomUUID();
      return sql.begin(async (tx): Promise<RotateResult> => {
        const [owner] = await tx<Pick<RefreshTokenRow, "user_id">[]>`
          SELECT user_id FROM refresh_tokens WHERE token_hash = ${oldHash}
        `;
        if (!owner) return { status: "invalid" };
        // Serialises rotations and family revocation per user, so revoking everything cannot miss a
        // successor that a concurrent rotation is inserting.
        await tx`SELECT 1 FROM users WHERE id = ${owner.user_id} FOR UPDATE`;

        const [rotated] = await tx<{ user_id: string }[]>`
          WITH old AS (
            UPDATE refresh_tokens SET revoked_at = now(), replaced_by = ${nextId}
            WHERE token_hash = ${oldHash} AND revoked_at IS NULL AND expires_at > now()
            RETURNING user_id
          )
          INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at)
          SELECT ${nextId}, user_id, ${tokenHash}, ${expiresAt} FROM old
          RETURNING user_id
        `;
        if (rotated) return { status: "rotated", userId: rotated.user_id };

        // clock_timestamp, not now(): now() is when this transaction began, which can be before a
        // successor that a concurrent rotation created while we waited for the lock.
        const [old] = await tx<{ replaced_by: string | null; in_grace: boolean | null }[]>`
          SELECT old.replaced_by,
                 successor.created_at > clock_timestamp() - make_interval(secs => ${graceSecs}) AS in_grace
          FROM refresh_tokens old
          LEFT JOIN refresh_tokens successor ON successor.id = old.replaced_by
          WHERE old.token_hash = ${oldHash}
        `;
        if (!old?.replaced_by) return { status: "invalid" };
        if (old.in_grace) return { status: "superseded" };
        await tx`
          UPDATE refresh_tokens SET revoked_at = now()
          WHERE user_id = ${owner.user_id} AND revoked_at IS NULL
        `;
        return { status: "reused", userId: owner.user_id };
      });
    },

    async revoke(tokenHash) {
      await sql`
        UPDATE refresh_tokens SET revoked_at = now()
        WHERE token_hash = ${tokenHash} AND revoked_at IS NULL
      `;
    },
  };
}
