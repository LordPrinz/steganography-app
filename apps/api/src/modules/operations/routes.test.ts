import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { ApiError, Operation, OperationAccepted } from "@stego/contracts";
import {
  createImageRepository,
  createOperationRepository,
  createRefreshTokenRepository,
  createUserRepository,
} from "@stego/db";
import { createTestDatabase } from "@stego/db/testing";
import { MAX_MESSAGE_BYTES } from "@stego/engine";
import { encodePng } from "@stego/image-io";
import { createMemoryStore, createMessageHandoff } from "@stego/kv";
import { createServer, type ServerDeps } from "../../app.ts";
import { createRateLimiter } from "../../lib/rate-limit.ts";
import { Client } from "../../testing/client.ts";
import { testServerDeps } from "../../testing/server-deps.ts";
import { MAX_ENCODE_BODY_BYTES, OPERATION_RATE_LIMITS } from "./routes.ts";

// Runs against the in-memory repositories, and again against Postgres when TEST_DATABASE_URL is set.
const testDb = createTestDatabase();
const sql = testDb?.sql;

beforeAll(async () => {
  await testDb?.setup();
});

afterAll(async () => {
  await testDb?.teardown();
});

const backends: [string, () => Promise<Partial<ServerDeps>>][] = [["memory", async () => ({})]];
if (sql) {
  backends.push([
    "postgres",
    async () => {
      await sql`TRUNCATE users CASCADE`;
      return {
        users: createUserRepository(sql),
        refreshTokens: createRefreshTokenRepository(sql),
        images: createImageRepository(sql),
        operations: createOperationRepository(sql),
      };
    },
  ]);
}

function pixels(width: number, height: number) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data.set([i % 256, (i * 7) % 256, (i * 13) % 256, 255], i * 4);
  }
  return { width, height, data };
}

const testPng = () => encodePng(pixels(32, 32));
const SECRET = "the-secret-message";
const lsb = { id: "lsb", params: { bitsPerChannel: 1 } };

async function errorCode(res: Response): Promise<string> {
  return ApiError.parse(await res.json()).error.code;
}

const servers: ReturnType<typeof createServer>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

describe.each(backends)("operations API (%s)", (_name, backend) => {
  async function start(overrides: Partial<ServerDeps> = {}) {
    const deps = testServerDeps({ ...(await backend()), ...overrides });
    const server = createServer(deps);
    servers.push(server);
    const client = async (email: string) => {
      const c = new Client(server.url, email);
      await c.signIn();
      return c;
    };
    const ann = await client("ann@example.com");
    const image = await ann.uploadMeta(await testPng());
    const handoff = createMessageHandoff(deps.kv);
    const encode = (c: Client, body: Record<string, unknown> = {}) =>
      c.postJson("/operations/encode", {
        imageId: image.id,
        message: SECRET,
        layers: [lsb],
        ...body,
      });
    return { deps, kv: deps.kv, client, ann, image, handoff, encode };
  }

  describe("encode", () => {
    test("accepts the request, queues it and leaves the message in Redis only", async () => {
      const { ann, handoff, encode, image } = await start();
      const res = await encode(ann);
      expect(res.status).toBe(202);
      const accepted = OperationAccepted.parse(await res.json());
      expect(accepted.status).toBe("queued");
      expect(res.headers.get("location")).toBe(`/api/v1/operations/${accepted.id}`);
      expect(await handoff.getMessage(accepted.id)).toBe(SECRET);

      const got = await ann.request("GET", `/operations/${accepted.id}`);
      expect(got.status).toBe(200);
      expect(got.headers.get("cache-control")).toBe("no-store");
      const text = await got.text();
      expect(text).not.toContain(SECRET);
      expect(Operation.parse(JSON.parse(text))).toMatchObject({
        id: accepted.id,
        type: "encode",
        status: "queued",
        method: "lsb",
        sourceImageId: image.id,
        resultImage: null,
        result: null,
        revealed: null,
      });
    });

    test("fills in default parameters", async () => {
      const { ann, encode } = await start();
      const res = await encode(ann, {
        message: "hi",
        layers: [{ id: "dwt-qim", params: { level: 1 } }],
      });
      expect(res.status).toBe(202);
    });

    test("requires a signed-in user", async () => {
      const { deps, image } = await start();
      const server = createServer(deps);
      servers.push(server);
      const res = await new Client(server.url, "x@example.com").postJson("/operations/encode", {
        imageId: image.id,
        message: SECRET,
        layers: [lsb],
      });
      expect(res.status).toBe(401);
    });

    test("rejects a malformed or unknown request", async () => {
      const { ann, encode } = await start();
      for (const body of [
        { message: "" },
        { layers: [] },
        { layers: [lsb, lsb] },
        { layers: [{ id: "lsb", params: { bitsPerChannel: 9 } }] },
        { layers: [{ id: "lsb", params: { bitsPerChannel: 1, extra: true } }] },
        { layers: [{ id: "dwt-qim", params: { level: 3, step: 8 } }] },
        {
          layers: [
            {
              id: "dct-koch-zhao",
              params: {
                pair: [
                  [0, 0],
                  [1, 2],
                ],
              },
            },
          ],
        },
        { layers: [{ id: "lsb", ecc: { code: "repetition", factor: 4 } }] },
        { layers: [{ id: "rot13" }] },
        { imageId: "not-a-uuid" },
        { extra: 1 },
      ]) {
        const res = await encode(ann, body);
        expect(res.status).toBe(400);
        expect(await errorCode(res)).toBe("invalid_request");
      }
    });

    test("refuses a message that does not fit, with the sizes", async () => {
      const { ann, encode, deps } = await start();
      const res = await encode(ann, { message: "x".repeat(5_000) });
      expect(res.status).toBe(422);
      const { error } = ApiError.parse(await res.json());
      expect(error.code).toBe("message_too_large");
      expect(error.details).toMatchObject({ needed: 5_000 });
      expect((error.details as { available: number }).available).toBeLessThan(5_000);
      expect(JSON.stringify(error)).not.toContain("xxxxx");
      expect(await deps.kv.get("op:x:message")).toBeNull();
    });

    test("counts error correction against the capacity", async () => {
      const { ann, encode } = await start();
      const message = "y".repeat(60);
      expect((await encode(ann, { message })).status).toBe(202);
      const res = await encode(ann, {
        message,
        layers: [{ ...lsb, ecc: { code: "repetition", factor: 7 } }],
      });
      expect(res.status).toBe(422);
    });

    test("limits the operations in progress and drops the message of a refused one", async () => {
      const base = createMemoryStore();
      const stored: string[] = [];
      const removed: string[] = [];
      const kv = {
        ...base,
        set: (key: string, value: string, ttlMs?: number) => {
          if (key.endsWith(":message")) stored.push(key);
          return base.set(key, value, ttlMs);
        },
        del: (key: string) => {
          removed.push(key);
          return base.del(key);
        },
      };
      const { ann, encode } = await start({ kv });
      for (let i = 0; i < 5; i++) expect((await encode(ann)).status).toBe(202);
      const res = await encode(ann);
      expect(res.status).toBe(429);
      expect(await errorCode(res)).toBe("too_many_operations");
      expect(res.headers.get("retry-after")).not.toBeNull();
      // The refused request left a message and removed it again: five stay.
      expect(stored.length).toBe(6);
      expect(removed.length).toBe(1);
      expect(stored.filter((key) => !removed.includes(key))).toHaveLength(5);
    });

    test("is rate limited per user", async () => {
      const { ann, encode, kv } = await start();
      const limiter = createRateLimiter(kv, OPERATION_RATE_LIMITS.create);
      for (let i = 0; i < OPERATION_RATE_LIMITS.create.limit; i++) await limiter.hit(ann.userId);
      const res = await encode(ann);
      expect(res.status).toBe(429);
      expect(await errorCode(res)).toBe("rate_limited");
    });

    test("does not use another user's image", async () => {
      const { client, encode } = await start();
      const bob = await client("bob@example.com");
      const res = await encode(bob);
      expect(res.status).toBe(404);
      expect(await errorCode(res)).toBe("image_not_found");
    });
  });

  describe("message size", () => {
    // 512 x 512 holds 98 KiB with one bit per channel, more than MAX_MESSAGE_BYTES plus the frame.
    const LIMIT = MAX_MESSAGE_BYTES;

    async function big() {
      const ctx = await start();
      const data = new Uint8ClampedArray(512 * 512 * 4).fill(128);
      const image = await ctx.ann.uploadMeta(await encodePng({ width: 512, height: 512, data }));
      const send = (message: string) =>
        ctx.encode(ctx.ann, { imageId: image.id, message, layers: [{ id: "lsb" }] });
      return { ...ctx, send };
    }

    test.each([
      ["ASCII", "a", 1],
      ["two-byte", "é", 2],
      ["three-byte", "✓", 3],
      ["four-byte", "😀", 4],
    ])(
      "%s: a message of exactly the limit is accepted, one byte more gets sizes",
      async (_n, unit, width) => {
        const { send } = await big();
        const atLimit = unit.repeat(Math.floor(LIMIT / width)) + "a".repeat(LIMIT % width);
        expect((await send(atLimit)).status).toBe(202);
        const over = await send(`${atLimit}a`);
        expect(over.status).toBe(422);
        const { error } = ApiError.parse(await over.json());
        expect(error).toMatchObject({
          code: "message_too_large",
          details: { needed: LIMIT + 1, available: LIMIT },
        });
      },
    );

    test("the worst JSON escaping of a maximal message still fits the body cap", async () => {
      const { send } = await big();
      // Every control byte becomes a six-character escape: 384 KiB of body for 64 KiB of message.
      const res = await send("\u0001".repeat(LIMIT));
      expect(res.status).toBe(202);
    });

    test("a body over the route's cap is a 413", async () => {
      const { send } = await big();
      const res = await send("a".repeat(MAX_ENCODE_BODY_BYTES));
      expect(res.status).toBe(413);
    });
  });

  describe("decode", () => {
    test("accepts one method or auto", async () => {
      const { ann, image } = await start();
      for (const [method, expected] of [
        ["auto", "auto"],
        [lsb, "lsb"],
        [{ id: "dct-koch-zhao" }, "dct-koch-zhao"],
      ] as const) {
        const res = await ann.postJson("/operations/decode", { imageId: image.id, method });
        expect(res.status).toBe(202);
        const { id } = OperationAccepted.parse(await res.json());
        const got = Operation.parse(await (await ann.request("GET", `/operations/${id}`)).json());
        expect(got).toMatchObject({ type: "decode", status: "queued", method: expected });
      }
    });

    test("rejects a malformed request", async () => {
      const { ann, image } = await start();
      for (const body of [
        { imageId: image.id },
        { imageId: image.id, method: "everything" },
        { imageId: image.id, method: { id: "lsb", params: { bitsPerChannel: 0 } } },
        { imageId: image.id, method: "auto", message: "x" },
      ]) {
        const res = await ann.postJson("/operations/decode", body);
        expect(res.status).toBe(400);
      }
    });

    test("does not use another user's image", async () => {
      const { client, image } = await start();
      const bob = await client("bob@example.com");
      const res = await bob.postJson("/operations/decode", { imageId: image.id, method: "auto" });
      expect(res.status).toBe(404);
      expect(await errorCode(res)).toBe("image_not_found");
    });

    test("is rate limited and capped like encode", async () => {
      const { ann, image } = await start();
      for (let i = 0; i < 5; i++) {
        const ok = await ann.postJson("/operations/decode", { imageId: image.id, method: "auto" });
        expect(ok.status).toBe(202);
      }
      const res = await ann.postJson("/operations/decode", { imageId: image.id, method: "auto" });
      expect(res.status).toBe(429);
    });
  });

  describe("GET /operations/:id", () => {
    test("is not found for another user's operation", async () => {
      const { client, ann, encode, handoff } = await start();
      const { id } = OperationAccepted.parse(await (await encode(ann)).json());
      const bob = await client("bob@example.com");
      const res = await bob.request("GET", `/operations/${id}`);
      expect(res.status).toBe(404);
      expect(await errorCode(res)).toBe("not_found");
      // The same answer as for an operation that never existed.
      const missing = await bob.request("GET", `/operations/${crypto.randomUUID()}`);
      expect(missing.status).toBe(404);
      expect(await errorCode(missing)).toBe("not_found");
      // A revealed message is not handed out either.
      await handoff.putRevealed(id, SECRET);
      expect(await (await bob.request("GET", `/operations/${id}`)).text()).not.toContain(SECRET);
    });

    test("is not found for a malformed id, and needs a session", async () => {
      const { ann, deps, image } = await start();
      expect((await ann.request("GET", "/operations/nope")).status).toBe(404);
      const server = createServer(deps);
      servers.push(server);
      const anonymous = new Client(server.url, "anon@example.com");
      expect((await anonymous.request("GET", `/operations/${image.id}`)).status).toBe(401);
    });
  });
});
