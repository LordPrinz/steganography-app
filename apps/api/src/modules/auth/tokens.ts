import { hkdfSync, timingSafeEqual } from "node:crypto";

export interface AccessClaims {
  /** User id. */
  sub: string;
  /** Token id, the key for the logout denylist. */
  jti: string;
  /** Seconds since the epoch. */
  iat: number;
  exp: number;
}

export interface AccessTokens {
  sign(userId: string): { token: string; claims: AccessClaims };
  /** The claims of a token we signed that has not expired, otherwise null. Never throws. */
  verify(token: string): AccessClaims | null;
}

export interface AccessTokenOptions {
  secret: string;
  ttlSeconds: number;
  /** Milliseconds since the epoch; injectable for expiry tests. */
  now?: () => number;
}

const encode = (value: string | Uint8Array) => Buffer.from(value).toString("base64url");

// The only header we issue. Comparing it verbatim rules out alg=none and algorithm confusion.
const HEADER = encode(JSON.stringify({ alg: "HS256", typ: "JWT" }));

/** HS256 JWTs. Bun has HMAC built in, so no JWT library (ADR 0002). */
export function createAccessTokens({
  secret,
  ttlSeconds,
  now = Date.now,
}: AccessTokenOptions): AccessTokens {
  // A key of its own, so JWT_SECRET can later key other things without one leaking into another.
  const key = new Uint8Array(hkdfSync("sha256", secret, "", "access-token", 32));
  const mac = (input: string) =>
    new Bun.CryptoHasher("sha256", key).update(input).digest() as Buffer;

  return {
    sign(userId) {
      const iat = Math.floor(now() / 1000);
      const claims: AccessClaims = {
        sub: userId,
        jti: crypto.randomUUID(),
        iat,
        exp: iat + ttlSeconds,
      };
      const signingInput = `${HEADER}.${encode(JSON.stringify(claims))}`;
      return { token: `${signingInput}.${encode(mac(signingInput))}`, claims };
    },

    verify(token) {
      const [header, payload, signature, ...rest] = token.split(".");
      if (header !== HEADER || payload === undefined || signature === undefined || rest.length) {
        return null;
      }
      // Compared as text: base64url decoding is lenient, so two spellings could decode to one MAC.
      const expected = Buffer.from(encode(mac(`${header}.${payload}`)));
      const actual = Buffer.from(signature);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;

      const claims = parseClaims(payload);
      if (!claims || claims.exp * 1000 <= now()) return null;
      return claims;
    },
  };
}

function parseClaims(payload: string): AccessClaims | null {
  try {
    const { sub, jti, iat, exp } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof sub !== "string" || typeof jti !== "string") return null;
    if (!Number.isInteger(iat) || !Number.isInteger(exp)) return null;
    return { sub, jti, iat, exp };
  } catch {
    return null;
  }
}

/** A refresh token: 256 random bits, sent to the client once and stored only as a hash. */
export function newRefreshToken(): string {
  return encode(crypto.getRandomValues(new Uint8Array(32)));
}

// No salt or slow hash needed: the token is random and long, so a leaked hash cannot be reversed.
export function hashRefreshToken(token: string): string {
  return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}
