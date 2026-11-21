import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  ApiError,
  AuthResponse,
  ImageDetail,
  ImageMeta,
  ImagePage,
  MAX_UPLOAD_BYTES,
} from "@stego/contracts";
import {
  createImageRepository,
  createRefreshTokenRepository,
  createUserRepository,
  type ImageRepository,
} from "@stego/db";
import { createMemoryImageRepository, createTestDatabase } from "@stego/db/testing";
import { decodePng, encodePng } from "@stego/image-io";
import { createMemoryObjectStore, type ObjectStore } from "@stego/storage";
import { createServer, type ServerDeps } from "../../app.ts";
import { createConcurrencyLimit } from "../../lib/concurrency-limit.ts";
import { createRateLimiter } from "../../lib/rate-limit.ts";
import { TEST_ORIGIN, testServerDeps } from "../../testing/server-deps.ts";
import { IMAGE_RATE_LIMITS } from "./routes.ts";

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
      };
    },
  ]);
}

const PASSWORD = "correct horse battery";

/** A browser stand-in for one user: keeps cookies, sends the app's Origin. */
class Client {
  readonly cookies = new Map<string, string>();
  userId = "";

  constructor(
    readonly baseUrl: URL,
    readonly email: string,
  ) {}

  async request(method: string, path: string, init: RequestInit = {}) {
    const res = await fetch(new URL(`/api/v1${path}`, this.baseUrl), {
      ...init,
      method,
      headers: {
        origin: TEST_ORIGIN,
        cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
        ...init.headers,
      },
    });
    for (const header of res.headers.getSetCookie()) {
      const cookie = new Bun.Cookie(header);
      if (cookie.isExpired() || cookie.value === "") this.cookies.delete(cookie.name);
      else this.cookies.set(cookie.name, cookie.value);
    }
    return res;
  }

  async signIn() {
    const body = JSON.stringify({ email: this.email, password: PASSWORD });
    const headers = { "content-type": "application/json" };
    await this.request("POST", "/auth/register", { body, headers });
    const login = await this.request("POST", "/auth/login", { body, headers });
    this.userId = AuthResponse.parse(await login.json()).user.id;
  }

  upload(bytes: Uint8Array | string, { name = "photo.png", type = "image/png" } = {}) {
    const form = new FormData();
    form.set("file", new File([bytes as Uint8Array<ArrayBuffer>], name, { type }));
    return this.request("POST", "/images", { body: form });
  }

  async uploadMeta(bytes: Uint8Array) {
    const res = await this.upload(bytes);
    expect(res.status).toBe(201);
    return ImageMeta.parse(await res.json());
  }
}

/** A small RGBA test pattern; every pixel differs so a mix-up shows. */
function pixels(width: number, height: number) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data.set([i % 256, (i * 7) % 256, (i * 13) % 256, 255], i * 4);
  }
  return { width, height, data };
}

const testPng = () => encodePng(pixels(16, 12));

const PNG_SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const IHDR_END = 8 + 25; // signature + IHDR chunk

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(new TextEncoder().encode(type), 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, Bun.hash.crc32(chunk.subarray(4, 8 + data.length)));
  return chunk;
}

/** The PNG with an extra `tEXt` chunk (where cameras and editors leave comments) after the header. */
function withTextChunk(png: Uint8Array, text: string): Uint8Array {
  const chunk = pngChunk("tEXt", new TextEncoder().encode(`Comment\0${text}`));
  return Buffer.concat([png.subarray(0, IHDR_END), chunk, png.subarray(IHDR_END)]);
}

/** A well-formed all-black PNG of any size; `encodePng` itself refuses sizes over the pixel limit. */
async function blankPng(width: number, height: number): Promise<Uint8Array> {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr.set([8, 6], 8); // 8-bit RGBA
  const rows = Buffer.alloc(height * (1 + width * 4)); // filter byte 0 and black pixels
  const idat = new Uint8Array(await Bun.deflateSync(rows));
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", new Uint8Array()),
  ]);
}

async function errorCode(res: Response): Promise<string> {
  return ApiError.parse(await res.json()).error.code;
}

const servers: ReturnType<typeof createServer>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

describe.each(backends)("images API (%s)", (_name, backend) => {
  async function start(overrides: Partial<ServerDeps> = {}) {
    const deps = testServerDeps({ ...(await backend()), ...overrides });
    const server = createServer(deps);
    servers.push(server);
    const client = async (email: string) => {
      const c = new Client(server.url, email);
      await c.signIn();
      return c;
    };
    // The memory store behind `deps.storage` is a full ObjectStore; the server only needs part of it.
    const storage = deps.storage as ObjectStore;
    return { deps, storage, client, ann: await client("ann@example.com") };
  }

  describe("upload", () => {
    test("stores a normalised PNG and describes it", async () => {
      const { deps, storage, ann } = await start();
      const png = await testPng();
      const meta = await ann.uploadMeta(png);

      expect(meta).toMatchObject({ kind: "original", format: "png", width: 16, height: 12 });
      const stored = await storedBytes(storage, ann.userId, meta.id, deps.images);
      expect(stored.byteLength).toBe(meta.sizeBytes);
      expect(new Bun.CryptoHasher("sha256").update(stored).digest("hex")).toBe(meta.sha256);
      expect((await decodePng(stored)).data).toEqual((await decodePng(png)).data);
    });

    test("never stores the uploaded bytes: metadata chunks are dropped", async () => {
      const { deps, storage, ann } = await start();
      const marker = "gps-44.4,26.1-secret";
      const original = withTextChunk(await testPng(), marker);
      expect(Buffer.from(original).includes(marker)).toBe(true);

      const meta = await ann.uploadMeta(original);
      const stored = await storedBytes(storage, ann.userId, meta.id, deps.images);
      expect(Buffer.from(stored).includes(marker)).toBe(false);
      expect(Buffer.from(stored).equals(Buffer.from(original))).toBe(false);
    });

    test.each([
      ["JPEG", (png: Uint8Array) => new Bun.Image(png).jpeg({ quality: 85 }).bytes()],
      ["WebP", (png: Uint8Array) => new Bun.Image(png).webp().bytes()],
    ])("accepts %s and stores PNG", async (_format, convert) => {
      const { deps, storage, ann } = await start();
      const meta = await ann.uploadMeta(await convert(await testPng()));
      const stored = await storedBytes(storage, ann.userId, meta.id, deps.images);
      expect(Array.from(stored.subarray(0, 4))).toEqual([137, 80, 78, 71]);
      expect(meta).toMatchObject({ format: "png", width: 16, height: 12 });
    });

    test("the declared type and file name do not matter, the bytes do", async () => {
      const { ann } = await start();
      const res = await ann.upload(await testPng(), { name: "notes.txt", type: "text/plain" });
      expect(res.status).toBe(201);
    });

    test.each([
      ["a text file called .png", () => "just some text, not an image"],
      ["an SVG", () => '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
      ["a GIF", () => new Uint8Array([71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 0, 0, 0, 59])],
    ])("refuses %s with 415", async (_what, bytes) => {
      const { ann } = await start();
      const res = await ann.upload(bytes());
      expect(res.status).toBe(415);
      expect(await errorCode(res)).toBe("unsupported_image");
    });

    test("refuses a file with PNG magic bytes that does not decode", async () => {
      const { ann } = await start();
      const png = await testPng();
      for (const broken of [
        png.subarray(0, 40),
        Buffer.concat([png.subarray(0, 60), Buffer.alloc(30, 7)]),
      ]) {
        const res = await ann.upload(broken);
        expect(res.status).toBe(400);
        expect(await errorCode(res)).toBe("invalid_image");
      }
    });

    test("refuses an image over the pixel limit", async () => {
      const { ann } = await start();
      // 8192 x 2049 is just over 4096 x 4096 pixels; a flat image deflates to tens of KiB.
      const bomb = await blankPng(8192, 2049);
      expect(bomb.byteLength).toBeLessThan(MAX_UPLOAD_BYTES);
      const res = await ann.upload(bomb);
      expect(res.status).toBe(400);
      expect(await errorCode(res)).toBe("invalid_image");
    });

    test("refuses a file over the size limit with 413", async () => {
      const { ann } = await start();
      const res = await ann.upload(new Uint8Array(MAX_UPLOAD_BYTES + 1));
      expect(res.status).toBe(413);
    });

    test("refuses a whole body far over the limit with 413", async () => {
      const { ann } = await start();
      const res = await ann.upload(new Uint8Array(MAX_UPLOAD_BYTES * 2));
      expect(res.status).toBe(413);
    });

    test("needs a multipart body with a file part", async () => {
      const { ann } = await start();
      const json = await ann.request("POST", "/images", {
        body: "{}",
        headers: { "content-type": "application/json" },
      });
      expect([json.status, await errorCode(json)]).toEqual([415, "unsupported_media_type"]);

      const noFile = new FormData();
      noFile.set("file", "not a file, just a field");
      const field = await ann.request("POST", "/images", { body: noFile });
      expect([field.status, await errorCode(field)]).toEqual([400, "invalid_request"]);

      const empty = await ann.upload(new Uint8Array());
      expect([empty.status, await errorCode(empty)]).toEqual([400, "invalid_request"]);

      const garbled = await ann.request("POST", "/images", {
        body: "--x\r\nnot multipart at all",
        headers: { "content-type": "multipart/form-data; boundary=x" },
      });
      expect([garbled.status, await errorCode(garbled)]).toEqual([400, "invalid_request"]);
    });

    test("is rate limited per user", async () => {
      const { deps, ann, client } = await start();
      const limiter = createRateLimiter(deps.kv, IMAGE_RATE_LIMITS.upload);
      for (let i = 0; i < IMAGE_RATE_LIMITS.upload.limit; i++) await limiter.hit(ann.userId);

      const limited = await ann.upload(await testPng());
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);

      const bob = await client("bob@example.com");
      expect((await bob.upload(await testPng())).status).toBe(201);
    });

    test("with several file parts the first one counts", async () => {
      const { ann } = await start();
      const png = await testPng();
      const send = (...parts: (Uint8Array | string)[]) => {
        const form = new FormData();
        for (const part of parts) {
          form.append("file", new File([part as Uint8Array<ArrayBuffer>], "x.png"));
        }
        return ann.request("POST", "/images", { body: form });
      };
      expect((await send(png, "not an image")).status).toBe(201);
      expect((await send("not an image", png)).status).toBe(415);
    });

    test("refuses a chunked body over the server limit", async () => {
      const { ann } = await start();
      const chunk = new Uint8Array(1024 * 1024);
      let sent = 0;
      const body = new ReadableStream({
        pull(controller) {
          if (sent++ < 12) controller.enqueue(chunk);
          else controller.close();
        },
      });
      const res = await ann
        .request("POST", "/images", {
          body,
          headers: { "content-type": "multipart/form-data; boundary=x" },
          duplex: "half",
        } as RequestInit)
        .catch(() => null);
      // The server may cut the connection once the limit is hit.
      expect(res === null || res.status === 413).toBe(true);
    });

    test("answers 503 with Retry-After while every decode slot is busy", async () => {
      const decodeLimit = createConcurrencyLimit(1);
      const { ann } = await start({ decodeLimit });
      let release!: () => void;
      const held = decodeLimit.run(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );

      const busy = await ann.upload(await testPng());
      expect([busy.status, busy.headers.get("retry-after"), await errorCode(busy)]).toEqual([
        503,
        "2",
        "busy",
      ]);

      release();
      await held;
      expect((await ann.upload(await testPng())).status).toBe(201);
    });

    test("refuses uploads past the image count quota, and frees it on delete", async () => {
      const { ann, client } = await start({
        imageLimits: { maxImages: 2, maxUserBytes: 1e12, maxPngBytes: 1e9 },
      });
      const first = await ann.uploadMeta(await testPng());
      await ann.uploadMeta(await testPng());

      const over = await ann.upload(await testPng());
      expect([over.status, await errorCode(over)]).toEqual([413, "quota_exceeded"]);

      const bob = await client("bob@example.com");
      expect((await bob.upload(await testPng())).status).toBe(201);

      expect((await ann.request("DELETE", `/images/${first.id}`)).status).toBe(204);
      expect((await ann.upload(await testPng())).status).toBe(201);
    });

    test("refuses uploads past the byte quota and leaves no object behind", async () => {
      const png = await testPng();
      const written: string[] = [];
      const base = createMemoryObjectStore();
      const storage: ObjectStore = {
        ...base,
        put: async (key, bytes) => {
          written.push(key);
          await base.put(key, bytes);
        },
      };
      const { ann } = await start({
        storage,
        imageLimits: { maxImages: 100, maxUserBytes: png.byteLength * 2 - 1, maxPngBytes: 1e9 },
      });
      await ann.uploadMeta(png);

      const over = await ann.upload(png);
      expect([over.status, await errorCode(over)]).toEqual([413, "quota_exceeded"]);
      // The early check let it through (the first image alone fits); the atomic one refused, and the
      // object written in between was removed again.
      expect(written).toHaveLength(2);
      expect(await base.get(written[1] as string)).toBeNull();
      expect(await base.get(written[0] as string)).not.toBeNull();
    });

    test("refuses a re-encoded PNG over the size ceiling", async () => {
      const png = await testPng();
      const written: string[] = [];
      const base = createMemoryObjectStore();
      const storage: ObjectStore = {
        ...base,
        put: async (key, bytes) => {
          written.push(key);
          await base.put(key, bytes);
        },
      };
      const { ann } = await start({
        storage,
        imageLimits: { maxImages: 100, maxUserBytes: 1e12, maxPngBytes: png.byteLength - 1 },
      });

      const res = await ann.upload(png);
      expect([res.status, await errorCode(res)]).toEqual([413, "image_too_large"]);
      expect(written).toEqual([]);
    });

    test("removes the object when the row cannot be saved", async () => {
      const failing: ImageRepository = {
        ...createMemoryImageRepository(),
        create: async () => {
          throw new Error("database down");
        },
      };
      const written: string[] = [];
      const base = createMemoryObjectStore();
      const storage: ObjectStore = {
        ...base,
        put: async (key, bytes) => {
          written.push(key);
          await base.put(key, bytes);
        },
      };
      const { ann } = await start({ images: failing, storage });

      const res = await ann.upload(await testPng());
      expect(res.status).toBe(500);
      expect(written).toHaveLength(1);
      expect(await base.get(written[0] as string)).toBeNull();
    });
  });

  describe("gallery", () => {
    test("lists newest first, page by page", async () => {
      const { ann } = await start();
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        ids.unshift((await ann.uploadMeta(await testPng())).id);
        await Bun.sleep(5);
      }

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const query: string = `?limit=2${cursor ? `&cursor=${cursor}` : ""}`;
        const res = await ann.request("GET", `/images${query}`);
        expect(res.status).toBe(200);
        const page = ImagePage.parse(await res.json());
        seen.push(...page.images.map((image) => image.id));
        cursor = page.nextCursor;
        pages++;
      } while (cursor);

      expect(seen).toEqual(ids);
      expect(pages).toBe(3);
    });

    test("an empty gallery is an empty page", async () => {
      const { ann } = await start();
      const res = await ann.request("GET", "/images");
      expect(ImagePage.parse(await res.json())).toEqual({ images: [], nextCursor: null });
    });

    test.each(["limit=0", "limit=101", "limit=abc", "cursor=!!!", "cursor=e30"])(
      "rejects the query %s with 400",
      async (query) => {
        const { ann } = await start();
        const res = await ann.request("GET", `/images?${query}`);
        expect(res.status).toBe(400);
      },
    );

    test("a forged cursor cannot reach another user's images", async () => {
      const { ann, client } = await start();
      const bob = await client("bob@example.com");
      await bob.uploadMeta(await testPng());
      const own = await ann.uploadMeta(await testPng());

      const first = ImagePage.parse(await (await ann.request("GET", "/images")).json());
      expect(first.images.map((i) => i.id)).toEqual([own.id]);
      const forged = Buffer.from(
        JSON.stringify({ createdAt: "2999-01-01T00:00:00.000Z", id: crypto.randomUUID() }),
      ).toString("base64url");
      const page = ImagePage.parse(
        await (await ann.request("GET", `/images?cursor=${forged}`)).json(),
      );
      expect(page.images.map((i) => i.id)).toEqual([own.id]);
    });
  });

  describe("one image", () => {
    test("GET returns the metadata and a presigned URL for the image's object", async () => {
      const { ann } = await start();
      const meta = await ann.uploadMeta(await testPng());
      const res = await ann.request("GET", `/images/${meta.id}`);
      expect(res.status).toBe(200);
      const detail = ImageDetail.parse(await res.json());
      expect(detail).toMatchObject(meta);
      expect(detail.url).toContain(`users/${ann.userId}/`);
      expect(new Date(detail.urlExpiresAt).getTime()).toBeGreaterThan(Date.now());
    });

    test("DELETE removes the row and the object", async () => {
      const { deps, storage, ann } = await start();
      const meta = await ann.uploadMeta(await testPng());
      const key = await storageKey(deps.images, ann.userId, meta.id);
      expect(await storage.get(key)).not.toBeNull();

      const res = await ann.request("DELETE", `/images/${meta.id}`);
      expect(res.status).toBe(204);
      expect(await storage.get(key)).toBeNull();
      expect((await ann.request("GET", `/images/${meta.id}`)).status).toBe(404);
      expect((await ann.request("DELETE", `/images/${meta.id}`)).status).toBe(404);
      const list = ImagePage.parse(await (await ann.request("GET", "/images")).json());
      expect(list.images).toEqual([]);
    });

    test("DELETE keeps the row when the object cannot be removed, so it can be retried", async () => {
      let failing = true;
      const base = createMemoryObjectStore();
      const storage: ObjectStore = {
        ...base,
        delete: async (key) => {
          if (failing) throw new Error("storage down");
          await base.delete(key);
        },
      };
      const { ann } = await start({ storage });
      const meta = await ann.uploadMeta(await testPng());

      expect((await ann.request("DELETE", `/images/${meta.id}`)).status).toBe(500);
      expect((await ann.request("GET", `/images/${meta.id}`)).status).toBe(200);
      failing = false;
      expect((await ann.request("DELETE", `/images/${meta.id}`)).status).toBe(204);
    });

    test("a malformed id is a 404", async () => {
      const { ann } = await start();
      for (const id of ["nope", "1", "..%2F..%2Fetc", crypto.randomUUID()]) {
        expect((await ann.request("GET", `/images/${id}`)).status).toBe(404);
        expect((await ann.request("DELETE", `/images/${id}`)).status).toBe(404);
      }
    });
  });

  describe("ownership", () => {
    test("another user's image is a 404 for read and delete, and is left alone", async () => {
      const presigned: string[] = [];
      const base = createMemoryObjectStore();
      const storage: ObjectStore = {
        ...base,
        presignGet: async (key, ttl) => {
          presigned.push(key);
          return base.presignGet(key, ttl);
        },
      };
      const { deps, ann, client } = await start({ storage });
      const bob = await client("bob@example.com");
      const mine = await ann.uploadMeta(await testPng());
      const key = await storageKey(deps.images, ann.userId, mine.id);

      const missing = await bob.request("GET", `/images/${crypto.randomUUID()}`);
      const stolen = await bob.request("GET", `/images/${mine.id}`);
      expect(stolen.status).toBe(404);
      expect(await stolen.json()).toEqual(await missing.json());
      expect(presigned).toEqual([]);

      const deleted = await bob.request("DELETE", `/images/${mine.id}`);
      expect(deleted.status).toBe(404);
      expect(await base.get(key)).not.toBeNull();
      expect((await ann.request("GET", `/images/${mine.id}`)).status).toBe(200);

      const list = ImagePage.parse(await (await bob.request("GET", "/images")).json());
      expect(list.images).toEqual([]);
    });
  });

  describe("access", () => {
    test("every endpoint needs a session", async () => {
      const { ann } = await start();
      const meta = await ann.uploadMeta(await testPng());
      const stranger = new Client(ann.baseUrl, "nobody@example.com");
      const id = meta.id;

      const calls = [
        stranger.request("GET", "/images"),
        stranger.request("GET", `/images/${id}`),
        stranger.request("DELETE", `/images/${id}`),
        stranger.upload(await testPng()),
      ];
      for (const res of await Promise.all(calls)) expect(res.status).toBe(401);
    });

    test("uploads and deletes need the app's Origin", async () => {
      const { ann } = await start();
      const meta = await ann.uploadMeta(await testPng());
      const form = new FormData();
      form.set("file", new File([await testPng()], "a.png"));
      const post = await ann.request("POST", "/images", {
        body: form,
        headers: { origin: "https://evil.example" },
      });
      const del = await ann.request("DELETE", `/images/${meta.id}`, {
        headers: { origin: "https://evil.example" },
      });
      expect([post.status, del.status]).toEqual([403, 403]);
    });
  });
});

/** The stored object of an image, found through the repository. */
async function storedBytes(
  storage: ObjectStore,
  userId: string,
  id: string,
  images: ImageRepository,
): Promise<Uint8Array> {
  const object = await storage.get(await storageKey(images, userId, id));
  expect(object).not.toBeNull();
  return object as Uint8Array;
}

async function storageKey(images: ImageRepository, userId: string, id: string): Promise<string> {
  const row = await images.findOwned(userId, id);
  expect(row?.storage_key).toStartWith(`users/${userId}/`);
  return (row as { storage_key: string }).storage_key;
}
