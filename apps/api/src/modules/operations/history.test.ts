import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { ApiError, ImagePage, Operation, OperationAccepted, OperationPage } from "@stego/contracts";
import {
  createImageRepository,
  createOperationRepository,
  createRefreshTokenRepository,
  createUserRepository,
} from "@stego/db";
import { createTestDatabase, type MemoryOperationRepository } from "@stego/db/testing";
import { encodePng } from "@stego/image-io";
import { createMessageHandoff } from "@stego/kv";
import { createServer, type ServerDeps } from "../../app.ts";
import { Client } from "../../testing/client.ts";
import { testServerDeps } from "../../testing/server-deps.ts";

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

function testPng() {
  const data = new Uint8ClampedArray(32 * 32 * 4);
  for (let i = 0; i < 32 * 32; i++) data.set([i % 256, (i * 7) % 256, (i * 13) % 256, 255], i * 4);
  return encodePng({ width: 32, height: 32, data });
}

const SECRET = "the-secret-message";
const lsb = { id: "lsb", params: { bitsPerChannel: 2 } };

async function errorCode(res: Response): Promise<string> {
  return ApiError.parse(await res.json()).error.code;
}

const servers: ReturnType<typeof createServer>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

describe.each(backends)("operations history API (%s)", (name, backend) => {
  async function start() {
    const deps = testServerDeps(await backend());
    const server = createServer(deps);
    servers.push(server);
    const client = async (email: string) => {
      const c = new Client(server.url, email);
      await c.signIn();
      return c;
    };
    const ann = await client("ann@example.com");
    const image = await ann.uploadMeta(await testPng());

    /** What the worker and the clock do: sets the status and creation time of a stored operation. */
    async function patch(id: string, fields: { status?: string; createdAt?: string }) {
      if (name === "postgres" && sql) {
        if (fields.status)
          await sql`UPDATE operations SET status = ${fields.status} WHERE id = ${id}`;
        if (fields.createdAt) {
          await sql`UPDATE operations SET created_at = ${fields.createdAt}::timestamptz WHERE id = ${id}`;
        }
        return;
      }
      (deps.operations as MemoryOperationRepository).patch(id, {
        ...(fields.status && { status: fields.status as "succeeded" }),
        ...(fields.createdAt && { created_at: new Date(fields.createdAt) }),
      });
    }

    async function encode(c: Client, createdAt?: string, status = "succeeded", method = lsb) {
      const res = await c.postJson("/operations/encode", {
        imageId: image.id,
        message: SECRET,
        layers: [method],
      });
      expect(res.status).toBe(202);
      const { id } = OperationAccepted.parse(await res.json());
      await patch(id, { status, createdAt });
      return id;
    }

    async function decode(c: Client, method: unknown = "auto", createdAt?: string) {
      const res = await c.postJson("/operations/decode", { imageId: image.id, method });
      expect(res.status).toBe(202);
      const { id } = OperationAccepted.parse(await res.json());
      await patch(id, { status: "succeeded", createdAt });
      return id;
    }

    async function list(c: Client, query = "") {
      const res = await c.request("GET", `/operations${query}`);
      expect(res.status).toBe(200);
      return OperationPage.parse(await res.json());
    }

    return { deps, client, ann, image, encode, decode, list, patch };
  }

  const at = (second: number) => `2026-11-20T10:00:${String(second).padStart(2, "0")}.000Z`;

  describe("GET /operations", () => {
    test("is empty for a new user", async () => {
      const { ann, list } = await start();
      expect(await list(ann)).toEqual({ operations: [], nextCursor: null });
    });

    test("pages newest first without gaps or repeats", async () => {
      const { ann, encode, list } = await start();
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) ids.unshift(await encode(ann, at(i)));

      const seen: string[] = [];
      const sizes: number[] = [];
      let cursor: string | null = null;
      do {
        const page: OperationPage = await list(ann, `?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
        seen.push(...page.operations.map((op) => op.id));
        sizes.push(page.operations.length);
        cursor = page.nextCursor;
      } while (cursor);
      expect(seen).toEqual(ids);
      expect(sizes).toEqual([2, 2, 1]);
    });

    test("a page ending exactly at the last row has no next cursor", async () => {
      const { ann, encode, list } = await start();
      await encode(ann, at(1));
      await encode(ann, at(2));
      expect((await list(ann, "?limit=2")).nextCursor).toBeNull();
    });

    test("rows created in the same instant keep a stable order across pages", async () => {
      const { ann, encode, list } = await start();
      for (let i = 0; i < 5; i++) await encode(ann, at(7));
      const all = (await list(ann)).operations.map((op) => op.id);
      expect(new Set(all).size).toBe(5);

      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page: OperationPage = await list(ann, `?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
        seen.push(...page.operations.map((op) => op.id));
        cursor = page.nextCursor;
      } while (cursor);
      expect(seen).toEqual(all);
    });

    test("shows the stored fields and parameters", async () => {
      const { ann, image, encode, decode, list } = await start();
      const encoded = await encode(ann, at(1));
      const decoded = await decode(ann, "auto", at(2));
      const { operations } = await list(ann);
      expect(operations.map((op) => op.id)).toEqual([decoded, encoded]);
      expect(operations[0]).toMatchObject({
        type: "decode",
        method: "auto",
        status: "succeeded",
        sourceImageId: image.id,
        resultImageId: null,
        params: { method: "auto" },
        error: null,
        createdAt: at(2),
      });
      expect(operations[1]).toMatchObject({
        type: "encode",
        method: "lsb",
        params: { layers: [{ id: "lsb", params: { bitsPerChannel: 2 } }] },
      });
    });

    test("filters by type, method and status", async () => {
      const { ann, encode, decode, list } = await start();
      const a = await encode(ann, at(1));
      const b = await encode(ann, at(2), "failed", {
        id: "dwt-qim",
        params: { level: 1 },
      } as never);
      const c = await decode(ann, "auto", at(3));
      const d = await decode(ann, { id: "lsb", params: { bitsPerChannel: 1 } }, at(4));
      const ids = async (query: string) => (await list(ann, query)).operations.map((op) => op.id);

      expect(await ids("?type=encode")).toEqual([b, a]);
      expect(await ids("?type=decode")).toEqual([d, c]);
      expect(await ids("?method=lsb")).toEqual([d, a]);
      expect(await ids("?method=auto")).toEqual([c]);
      expect(await ids("?method=dwt-qim")).toEqual([b]);
      expect(await ids("?status=failed")).toEqual([b]);
      expect(await ids("?type=decode&method=lsb&status=succeeded")).toEqual([d]);
      expect(await ids("?type=encode&status=queued")).toEqual([]);
    });

    test("pages through a filtered listing", async () => {
      const { ann, encode, decode, list } = await start();
      const encodes: string[] = [];
      for (let i = 0; i < 3; i++) {
        encodes.unshift(await encode(ann, at(i * 2)));
        await decode(ann, "auto", at(i * 2 + 1));
      }
      const first = await list(ann, "?type=encode&limit=2");
      const second = await list(ann, `?type=encode&limit=2&cursor=${first.nextCursor}`);
      expect([...first.operations, ...second.operations].map((op) => op.id)).toEqual(encodes);
      expect(second.nextCursor).toBeNull();
    });

    test("never lists another user's operations", async () => {
      const { client, ann, encode, decode, list } = await start();
      await encode(ann, at(1));
      await decode(ann, "auto", at(2));
      const bob = await client("bob@example.com");
      expect(await list(bob)).toEqual({ operations: [], nextCursor: null });
      expect(await list(bob, "?type=encode")).toEqual({ operations: [], nextCursor: null });
    });

    test("a cursor taken from another user's page reveals nothing of theirs", async () => {
      const { client, ann, encode, list } = await start();
      for (let i = 0; i < 3; i++) await encode(ann, at(i));
      const bob = await client("bob@example.com");
      const mine = await list(ann, "?limit=1");
      const bobs = await list(bob, `?cursor=${mine.nextCursor}`);
      expect(bobs.operations).toEqual([]);
    });

    test("refuses forged cursors", async () => {
      const { ann } = await start();
      const forge = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
      for (const cursor of [
        "!!!",
        "e30",
        forge({ createdAt: "yesterday", id: crypto.randomUUID() }),
        forge({ createdAt: at(1), id: "'; DROP TABLE operations; --" }),
        forge({ createdAt: at(1) }),
      ]) {
        const res = await ann.request("GET", `/operations?cursor=${cursor}`);
        expect(res.status).toBe(400);
        expect(["invalid_cursor", "invalid_request"]).toContain(await errorCode(res));
      }
    });

    test.each(["limit=0", "limit=101", "limit=abc", "type=rot13", "method=rot13", "status=done"])(
      "rejects the query %s",
      async (query) => {
        const { ann } = await start();
        const res = await ann.request("GET", `/operations?${query}`);
        expect(res.status).toBe(400);
        expect(await errorCode(res)).toBe("invalid_request");
      },
    );

    test("leaves out the message, URLs and revealed text, and is not cached", async () => {
      const { deps, ann, encode, decode } = await start();
      await encode(ann, at(1));
      const decoded = await decode(ann, "auto", at(2));
      await createMessageHandoff(deps.kv).putRevealed(decoded, SECRET);
      const res = await ann.request("GET", "/operations");
      expect(res.headers.get("cache-control")).toBe("no-store");
      const text = await res.text();
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain("revealed");
      expect(text).not.toContain("http");
    });

    test("needs a session", async () => {
      const { deps } = await start();
      const server = createServer(deps);
      servers.push(server);
      const anonymous = new Client(server.url, "anon@example.com");
      expect((await anonymous.request("GET", "/operations")).status).toBe(401);
    });
  });

  describe("GET /operations/:id", () => {
    test("returns the parameters of the operation", async () => {
      const { ann, encode } = await start();
      const id = await encode(ann, at(1));
      const op = Operation.parse(await (await ann.request("GET", `/operations/${id}`)).json());
      expect(op.params).toEqual({ layers: [{ id: "lsb", params: { bitsPerChannel: 2 } }] });
    });
  });

  describe("DELETE /operations/:id", () => {
    test("removes a finished operation, keeps the images and the cached view goes too", async () => {
      const { ann, encode, list } = await start();
      const id = await encode(ann, at(1));
      const keep = await encode(ann, at(2), "failed");
      // Reading a finished operation caches it.
      expect((await ann.request("GET", `/operations/${id}`)).status).toBe(200);

      expect((await ann.request("DELETE", `/operations/${id}`)).status).toBe(204);
      expect((await ann.request("GET", `/operations/${id}`)).status).toBe(404);
      expect((await list(ann)).operations.map((op) => op.id)).toEqual([keep]);
      expect((await ann.request("DELETE", `/operations/${id}`)).status).toBe(404);

      const gallery = ImagePage.parse(await (await ann.request("GET", "/images")).json());
      expect(gallery.images).toHaveLength(1);
    });

    test("refuses an operation that is still queued or running", async () => {
      const { ann, encode, patch } = await start();
      const queued = await encode(ann, at(1), "queued");
      const running = await encode(ann, at(2), "running");
      for (const id of [queued, running]) {
        const res = await ann.request("DELETE", `/operations/${id}`);
        expect(res.status).toBe(409);
        expect(await errorCode(res)).toBe("operation_active");
      }
      await patch(queued, { status: "succeeded" });
      expect((await ann.request("DELETE", `/operations/${queued}`)).status).toBe(204);
    });

    test("is not found for another user's operation, which stays", async () => {
      const { client, ann, encode, list } = await start();
      const id = await encode(ann, at(1));
      const bob = await client("bob@example.com");
      const res = await bob.request("DELETE", `/operations/${id}`);
      expect(res.status).toBe(404);
      expect(await errorCode(res)).toBe("not_found");
      expect((await list(ann)).operations).toHaveLength(1);
    });

    test("is not found for a malformed id, and needs a session", async () => {
      const { deps, ann, image } = await start();
      expect((await ann.request("DELETE", "/operations/nope")).status).toBe(404);
      const server = createServer(deps);
      servers.push(server);
      const anonymous = new Client(server.url, "anon@example.com");
      expect((await anonymous.request("DELETE", `/operations/${image.id}`)).status).toBe(401);
    });
  });
});
