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
  /** The token was already rotated: it leaked, so every session of the user was revoked. */
  | { status: "reused"; userId: string }
  /** Unknown, expired or revoked by logout. */
  | { status: "invalid" };

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

export function createRefreshTokenRepository(sql: SQL): RefreshTokenRepository {
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
        // The row lock taken by UPDATE makes a concurrent rotation of the same token see it revoked.
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

        const [old] = await tx<Pick<RefreshTokenRow, "user_id" | "replaced_by">[]>`
          SELECT user_id, replaced_by FROM refresh_tokens WHERE token_hash = ${oldHash}
        `;
        if (!old?.replaced_by) return { status: "invalid" };
        await tx`
          UPDATE refresh_tokens SET revoked_at = now()
          WHERE user_id = ${old.user_id} AND revoked_at IS NULL
        `;
        return { status: "reused", userId: old.user_id };
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
