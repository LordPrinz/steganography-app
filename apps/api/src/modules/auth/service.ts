import type { AuthUser } from "@stego/contracts";
import type { RefreshTokenRepository, UserRepository, UserRow } from "@stego/db";
import type { KeyValueStore } from "@stego/kv";
import { type AccessTokens, hashRefreshToken, newRefreshToken } from "./tokens.ts";

export interface Session {
  user: AuthUser;
  accessToken: string;
  refreshToken: string;
}

export type RefreshResult =
  | { status: "ok"; session: Session }
  /** Another request rotated this token moments ago (two tabs); the caller keeps its cookies. */
  | { status: "superseded" }
  | { status: "invalid" };

export interface AuthService {
  /**
   * Creates the account unless the e-mail is taken. Both cases look the same to the caller (and take
   * about as long), so registering does not reveal which e-mails have accounts.
   */
  register(email: string, password: string): Promise<void>;
  /** Null for an unknown e-mail or a wrong password alike. */
  login(email: string, password: string): Promise<Session | null>;
  /** Rotates the refresh token. Anything but a live token is refused; reuse also revokes the family. */
  refresh(refreshToken: string): Promise<RefreshResult>;
  /** Revokes whichever of the two tokens is given. */
  logout(tokens: { accessToken?: string; refreshToken?: string }): Promise<void>;
  /** The user behind a valid, not logged-out access token, otherwise null. */
  authenticate(accessToken: string): Promise<AuthUser | null>;
}

export interface AuthServiceDeps {
  users: UserRepository;
  refreshTokens: RefreshTokenRepository;
  kv: Pick<KeyValueStore, "get" | "set">;
  accessTokens: AccessTokens;
  refreshTtlMs: number;
  now?: () => number;
}

const denylistKey = (jti: string) => `auth:denylist:${jti}`;

export function toAuthUser(user: UserRow): AuthUser {
  return { id: user.id, email: user.email, createdAt: user.created_at.toISOString() };
}

export function createAuthService({
  users,
  refreshTokens,
  kv,
  accessTokens,
  refreshTtlMs,
  now = Date.now,
}: AuthServiceDeps): AuthService {
  // Verified against when the e-mail is unknown, so a miss costs the same argon2 work as a hit.
  let dummyHash: Promise<string> | undefined;
  const timingDummy = () => {
    dummyHash ??= Bun.password.hash(crypto.randomUUID());
    return dummyHash;
  };

  const session = (user: UserRow, refreshToken: string): Session => ({
    user: toAuthUser(user),
    accessToken: accessTokens.sign(user.id).token,
    refreshToken,
  });
  const refreshExpiry = () => new Date(now() + refreshTtlMs);

  return {
    async register(email, password) {
      await users.create(email, await Bun.password.hash(password));
    },

    async login(email, password) {
      const user = await users.findByEmail(email);
      const valid = await Bun.password.verify(
        password,
        user?.password_hash ?? (await timingDummy()),
      );
      if (!user || !valid) return null;
      const refreshToken = newRefreshToken();
      await refreshTokens.issue(user.id, {
        tokenHash: hashRefreshToken(refreshToken),
        expiresAt: refreshExpiry(),
      });
      return session(user, refreshToken);
    },

    async refresh(refreshToken) {
      const next = newRefreshToken();
      const result = await refreshTokens.rotate(hashRefreshToken(refreshToken), {
        tokenHash: hashRefreshToken(next),
        expiresAt: refreshExpiry(),
      });
      if (result.status === "superseded") return { status: "superseded" };
      if (result.status === "reused") {
        console.warn(`Refresh token reuse for user ${result.userId}; all sessions revoked`);
      }
      if (result.status !== "rotated") return { status: "invalid" };
      const user = await users.findById(result.userId);
      return user ? { status: "ok", session: session(user, next) } : { status: "invalid" };
    },

    async logout({ accessToken, refreshToken }) {
      if (refreshToken) await refreshTokens.revoke(hashRefreshToken(refreshToken));
      const claims = accessToken ? accessTokens.verify(accessToken) : null;
      if (!claims) return;
      const ttlMs = claims.exp * 1000 - now();
      if (ttlMs <= 0) return;
      try {
        await kv.set(denylistKey(claims.jti), "1", Math.ceil(ttlMs));
      } catch (error) {
        // ADR 0003: without Redis the access token stays valid until it expires (minutes).
        console.error("Access token denylist unavailable; token stays valid until expiry", error);
      }
    },

    async authenticate(accessToken) {
      const claims = accessTokens.verify(accessToken);
      if (!claims) return null;
      try {
        if (await kv.get(denylistKey(claims.jti))) return null;
      } catch (error) {
        console.error("Access token denylist unavailable; skipping the check", error);
      }
      const user = await users.findById(claims.sub);
      return user ? toAuthUser(user) : null;
    },
  };
}
