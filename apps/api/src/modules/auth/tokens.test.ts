import { describe, expect, test } from "bun:test";
import { createAccessTokens, hashRefreshToken, newRefreshToken } from "./tokens.ts";

const secret = "test-secret-that-is-at-least-32-chars";
const userId = "6f1c1f4e-5f7a-4a57-9c39-3a1f0e2b8d11";

function forge(header: object, payload: object, signature = "") {
  const part = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${part(header)}.${part(payload)}.${signature}`;
}

describe("access tokens", () => {
  test("verify returns the claims of a token it signed", () => {
    const tokens = createAccessTokens({ secret, ttlSeconds: 900 });
    const { token, claims } = tokens.sign(userId);
    expect(tokens.verify(token)).toEqual(claims);
    expect(claims.sub).toBe(userId);
    expect(claims.exp - claims.iat).toBe(900);
  });

  test("every token gets its own jti", () => {
    const tokens = createAccessTokens({ secret, ttlSeconds: 900 });
    expect(tokens.sign(userId).claims.jti).not.toBe(tokens.sign(userId).claims.jti);
  });

  test("rejects an expired token", () => {
    let now = Date.parse("2026-11-20T12:00:00Z");
    const tokens = createAccessTokens({ secret, ttlSeconds: 60, now: () => now });
    const { token } = tokens.sign(userId);
    now += 59_000;
    expect(tokens.verify(token)).not.toBeNull();
    now += 1_000;
    expect(tokens.verify(token)).toBeNull();
  });

  test("rejects a tampered payload", () => {
    const tokens = createAccessTokens({ secret, ttlSeconds: 900 });
    const [header, , signature] = tokens.sign(userId).token.split(".");
    const payload = Buffer.from(
      JSON.stringify({ sub: "someone-else", jti: "x", iat: 0, exp: 9_999_999_999 }),
    ).toString("base64url");
    expect(tokens.verify(`${header}.${payload}.${signature}`)).toBeNull();
  });

  test("rejects a tampered signature and a token signed with another secret", () => {
    const tokens = createAccessTokens({ secret, ttlSeconds: 900 });
    const { token } = tokens.sign(userId);
    const flipped = token.slice(0, -2) + (token.endsWith("AA") ? "BB" : "AA");
    expect(tokens.verify(flipped)).toBeNull();

    const other = createAccessTokens({ secret: `${secret}-other`, ttlSeconds: 900 });
    expect(tokens.verify(other.sign(userId).token)).toBeNull();
  });

  test("rejects alg=none and other headers", () => {
    const tokens = createAccessTokens({ secret, ttlSeconds: 900 });
    const claims = { sub: userId, jti: "j", iat: 0, exp: 9_999_999_999 };
    expect(tokens.verify(forge({ alg: "none", typ: "JWT" }, claims))).toBeNull();
    const [, , signature] = tokens.sign(userId).token.split(".");
    expect(tokens.verify(forge({ alg: "HS512", typ: "JWT" }, claims, signature))).toBeNull();
  });

  test("rejects malformed input without throwing", () => {
    const tokens = createAccessTokens({ secret, ttlSeconds: 900 });
    for (const bad of ["", "a", "a.b", "a.b.c", "a.b.c.d", `${tokens.sign(userId).token}.x`]) {
      expect(tokens.verify(bad)).toBeNull();
    }
  });
});

describe("refresh tokens", () => {
  test("are random 256-bit values and hash deterministically", () => {
    const token = newRefreshToken();
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    expect(newRefreshToken()).not.toBe(token);
    expect(hashRefreshToken(token)).toBe(hashRefreshToken(token));
    expect(hashRefreshToken(token)).not.toContain(token);
  });
});
