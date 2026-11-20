import type { RefreshTokenRepository, UserRepository } from "./auth.ts";
import type { RefreshTokenRow, UserRow } from "./types.ts";

/** In-process user repository for tests; passes the same contract suite as the Postgres one. */
export function createMemoryUserRepository(): UserRepository {
  const users = new Map<string, UserRow>();
  const find = (match: (user: UserRow) => boolean) => users.values().find(match) ?? null;

  return {
    async create(email, passwordHash) {
      if (find((u) => u.email === email)) return null;
      const user: UserRow = {
        id: crypto.randomUUID(),
        email,
        password_hash: passwordHash,
        created_at: new Date(),
      };
      users.set(user.id, user);
      return user;
    },
    findByEmail: async (email) => find((u) => u.email === email),
    findById: async (id) => users.get(id) ?? null,
  };
}

/** In-process refresh token repository for tests; same semantics as the Postgres one. */
export function createMemoryRefreshTokenRepository(): RefreshTokenRepository {
  const tokens = new Map<string, RefreshTokenRow>();

  function insert(userId: string, tokenHash: string, expiresAt: Date): RefreshTokenRow {
    const row: RefreshTokenRow = {
      id: crypto.randomUUID(),
      user_id: userId,
      token_hash: tokenHash,
      expires_at: expiresAt,
      revoked_at: null,
      replaced_by: null,
      created_at: new Date(),
    };
    tokens.set(tokenHash, row);
    return row;
  }

  return {
    async issue(userId, { tokenHash, expiresAt }) {
      insert(userId, tokenHash, expiresAt);
    },
    async rotate(oldHash, { tokenHash, expiresAt }) {
      const old = tokens.get(oldHash);
      const now = new Date();
      if (old && !old.revoked_at && old.expires_at > now) {
        old.revoked_at = now;
        old.replaced_by = insert(old.user_id, tokenHash, expiresAt).id;
        return { status: "rotated", userId: old.user_id };
      }
      if (!old?.replaced_by) return { status: "invalid" };
      for (const row of tokens.values()) {
        if (row.user_id === old.user_id && !row.revoked_at) row.revoked_at = now;
      }
      return { status: "reused", userId: old.user_id };
    },
    async revoke(tokenHash) {
      const row = tokens.get(tokenHash);
      if (row && !row.revoked_at) row.revoked_at = new Date();
    },
  };
}
