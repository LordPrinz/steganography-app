import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  ApiError,
  EXPERIMENT_MAX_PIXELS,
  Experiment,
  ExperimentParams,
  OperationAccepted,
  OperationPage,
} from "@stego/contracts";
import {
  createImageRepository,
  createOperationRepository,
  createRefreshTokenRepository,
  createUserRepository,
} from "@stego/db";
import { createTestDatabase } from "@stego/db/testing";
import { encodePng } from "@stego/image-io";
import { createMessageHandoff, createProgressStore } from "@stego/kv";
import { newImageKey } from "@stego/storage";
import { createServer, type ServerDeps } from "../../app.ts";
import { createRateLimiter } from "../../lib/rate-limit.ts";
import { Client } from "../../testing/client.ts";
import { testServerDeps } from "../../testing/server-deps.ts";
import { EXPERIMENT_RATE_LIMITS } from "./routes.ts";

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

const SECRET = "the-secret-message";

async function errorCode(res: Response): Promise<string> {
  return ApiError.parse(await res.json()).error.code;
}

const servers: ReturnType<typeof createServer>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

describe.each(backends)("experiments API (%s)", (_name, backend) => {
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
    const image = await ann.uploadMeta(await encodePng(pixels(256, 256)));
    const experiment = (c: Client, body: Record<string, unknown> = {}) =>
      c.postJson("/experiments", { mode: "A", imageId: image.id, message: SECRET, ...body });
    return {
      deps,
      kv: deps.kv,
      client,
      ann,
      image,
      experiment,
      handoff: createMessageHandoff(deps.kv),
    };
  }

  describe("POST /experiments", () => {
    test("mode A queues every method against the default scenarios, message in Redis only", async () => {
      const { ann, handoff, experiment, image } = await start();
      const res = await experiment(ann);
      expect(res.status).toBe(202);
      const accepted = OperationAccepted.parse(await res.json());
      expect(accepted.status).toBe("queued");
      expect(res.headers.get("location")).toBe(`/api/v1/experiments/${accepted.id}`);
      expect(await handoff.getMessages(accepted.id)).toEqual([SECRET]);

      const got = await ann.request("GET", `/experiments/${accepted.id}`);
      expect(got.status).toBe(200);
      expect(got.headers.get("cache-control")).toBe("no-store");
      const text = await got.text();
      expect(text).not.toContain(SECRET);
      const view = Experiment.parse(JSON.parse(text));
      expect(view).toMatchObject({
        id: accepted.id,
        type: "experiment",
        status: "queued",
        method: "auto",
        sourceImageId: image.id,
        result: null,
        progress: null,
        variantImages: {},
      });
      const params = ExperimentParams.parse(view.params);
      expect(params.mode).toBe("A");
      expect(params.methods.map((m) => m.id)).toEqual(["lsb", "dct-koch-zhao", "dwt-qim"]);
      expect(params.scenarios).toHaveLength(11);
      expect(JSON.stringify(view.params)).not.toContain(SECRET);
    });

    test("mode B takes one method with its code and the chosen scenarios", async () => {
      const { ann, experiment } = await start();
      const res = await experiment(ann, {
        mode: "B",
        method: { id: "lsb", ecc: { code: "repetition", factor: 3 } },
        scenarios: [[], [{ type: "jpeg", quality: 60 }]],
      });
      expect(res.status).toBe(202);
      const { id } = OperationAccepted.parse(await res.json());
      const view = Experiment.parse(await (await ann.request("GET", `/experiments/${id}`)).json());
      expect(view.method).toBe("lsb");
      expect(ExperimentParams.parse(view.params)).toMatchObject({
        mode: "B",
        methods: [{ id: "lsb", params: { bitsPerChannel: 1 }, ecc: { code: "repetition" } }],
        scenarios: [[], [{ type: "jpeg", quality: 60 }]],
      });
    });

    test("requires a signed-in user", async () => {
      const { deps, image } = await start();
      const server = createServer(deps);
      servers.push(server);
      const res = await new Client(server.url, "x@example.com").postJson("/experiments", {
        mode: "A",
        imageId: image.id,
        message: SECRET,
      });
      expect(res.status).toBe(401);
    });

    test("rejects a malformed request", async () => {
      const { ann, experiment } = await start();
      for (const body of [
        { mode: "C" },
        { message: "" },
        { imageId: "not-a-uuid" },
        { extra: 1 },
        { method: { id: "lsb" } },
        { mode: "B" },
        { mode: "B", method: { id: "lsb" }, scenarios: [] },
        { mode: "B", method: { id: "lsb" }, scenarios: Array.from({ length: 17 }, () => []) },
        { mode: "B", method: { id: "lsb" }, scenarios: [[{ type: "jpeg", quality: 101 }]] },
        { mode: "B", method: { id: "dwt-qim", params: { level: 3, step: 8 } }, scenarios: [[]] },
      ]) {
        const res = await experiment(ann, body);
        expect(res.status).toBe(400);
        expect(await errorCode(res)).toBe("invalid_request");
      }
    });

    test("refuses an image over the pixel limit", async () => {
      const { ann } = await start();
      const wide = await ann.uploadMeta(await encodePng(pixels(1100, 1000)));
      expect(wide.width * wide.height).toBeGreaterThan(EXPERIMENT_MAX_PIXELS);
      const res = await ann.postJson("/experiments", {
        mode: "A",
        imageId: wide.id,
        message: SECRET,
      });
      expect(res.status).toBe(422);
      const { error } = ApiError.parse(await res.json());
      expect(error.code).toBe("experiment_image_too_large");
      expect(error.details).toEqual({ pixels: 1_100_000, maxPixels: EXPERIMENT_MAX_PIXELS });
    });

    test("refuses an image with a side under 11 pixels", async () => {
      const { ann } = await start();
      const tiny = await ann.uploadMeta(await encodePng(pixels(10, 40)));
      const res = await ann.postJson("/experiments", {
        mode: "A",
        imageId: tiny.id,
        message: SECRET,
      });
      expect(res.status).toBe(422);
      const { error } = ApiError.parse(await res.json());
      expect(error.code).toBe("experiment_image_too_small");
      expect(error.details).toEqual({ minSide: 11 });
    });

    test("refuses mode B scenarios that chain more than 48 attacks in total", async () => {
      const { ann, experiment } = await start();
      const chain = Array.from({ length: 8 }, () => ({ type: "blur", sigma: 0.5 }));
      const body = (count: number) => ({
        mode: "B",
        method: { id: "lsb" },
        scenarios: Array.from({ length: count }, () => chain),
      });
      expect((await experiment(ann, body(6))).status).toBe(202);
      const res = await experiment(ann, body(7));
      expect(res.status).toBe(400);
      expect(await errorCode(res)).toBe("invalid_request");
    });

    test("does not take a variant as the source of an experiment or an encode, but decodes it", async () => {
      const { ann, deps, experiment } = await start();
      const variant = await deps.images.createVariant(
        {
          userId: ann.userId,
          storageKey: newImageKey(ann.userId),
          format: "png",
          width: 256,
          height: 256,
          sizeBytes: 100,
          sha256: "0".repeat(64),
        },
        { ttlMs: 60_000, maxBytes: 1e9 },
      );
      const imageId = (variant as NonNullable<typeof variant>).id;
      const exp = await experiment(ann, { imageId });
      expect(exp.status).toBe(404);
      expect(await errorCode(exp)).toBe("image_not_found");
      const enc = await ann.postJson("/operations/encode", {
        imageId,
        layers: [{ method: { id: "lsb" }, message: SECRET }],
      });
      expect(enc.status).toBe(404);
      const dec = await ann.postJson("/operations/decode", { imageId, method: "auto" });
      expect(dec.status).toBe(202);
    });

    test("serves no URL for an expired variant", async () => {
      const { ann, deps } = await start();
      const variant = (await deps.images.createVariant(
        {
          userId: ann.userId,
          storageKey: newImageKey(ann.userId),
          format: "png",
          width: 4,
          height: 4,
          sizeBytes: 100,
          sha256: "0".repeat(64),
        },
        { ttlMs: 1, maxBytes: 1e9 },
      )) as NonNullable<Awaited<ReturnType<typeof deps.images.createVariant>>>;
      await Bun.sleep(10);
      expect((await ann.request("GET", `/images/${variant.id}`)).status).toBe(404);
    });

    test("layered mode queues the layers, with each message in Redis only", async () => {
      const { ann, image, handoff } = await start();
      const res = await ann.postJson("/experiments", {
        mode: "layered",
        imageId: image.id,
        layers: [
          { method: { id: "dct-koch-zhao" }, message: "m-dct" },
          { method: { id: "lsb" }, message: "m-lsb" },
        ],
        scenarios: [[], [{ type: "jpeg", quality: 70 }]],
      });
      expect(res.status).toBe(202);
      const { id } = OperationAccepted.parse(await res.json());
      expect(await handoff.getMessages(id)).toEqual(["m-dct", "m-lsb"]);
      const text = await (await ann.request("GET", `/experiments/${id}`)).text();
      expect(text).not.toContain("m-dct");
      expect(text).not.toContain("m-lsb");
      const view = Experiment.parse(JSON.parse(text));
      expect(view.method).toBe("auto");
      expect(ExperimentParams.parse(view.params)).toMatchObject({
        mode: "layered",
        methods: [{ id: "dct-koch-zhao" }, { id: "lsb" }],
        scenarios: [[], [{ type: "jpeg", quality: 70 }]],
      });
    });

    test("layered mode counts layers times scenarios against the variant cap", async () => {
      const { ann, image } = await start();
      const body = (count: number) => ({
        mode: "layered",
        imageId: image.id,
        layers: [
          { method: { id: "lsb" }, message: "a" },
          { method: { id: "dwt-qim" }, message: "b" },
          { method: { id: "dct-koch-zhao" }, message: "c" },
        ],
        scenarios: Array.from({ length: count }, (_, i) => [{ type: "jpeg", quality: 50 + i }]),
      });
      expect((await ann.postJson("/experiments", body(12))).status).toBe(202);
      const res = await ann.postJson("/experiments", body(13));
      expect(res.status).toBe(400);
      const { error } = ApiError.parse(await res.json());
      expect(error).toMatchObject({
        code: "too_many_variants",
        details: { variants: 39, maxVariants: 36 },
      });
    });

    test("layered mode names the layer that does not fit", async () => {
      const { ann, image } = await start();
      const small = await ann.uploadMeta(await encodePng(pixels(32, 32)));
      const res = await ann.postJson("/experiments", {
        mode: "layered",
        imageId: small.id,
        layers: [
          { method: { id: "lsb" }, message: "fits" },
          { method: { id: "dct-koch-zhao" }, message: "does not" },
        ],
        scenarios: [[]],
      });
      expect(res.status).toBe(422);
      const { error } = ApiError.parse(await res.json());
      expect(error.details).toMatchObject({ layer: 1, method: "dct-koch-zhao" });
      expect(image.id).not.toBe(small.id);
    });

    test("refuses a message that does not fit every method, naming the method", async () => {
      const { ann } = await start();
      const small = await ann.uploadMeta(await encodePng(pixels(32, 32)));
      const res = await ann.postJson("/experiments", {
        mode: "A",
        imageId: small.id,
        message: SECRET,
      });
      expect(res.status).toBe(422);
      const { error } = ApiError.parse(await res.json());
      expect(error.code).toBe("message_too_large");
      // LSB holds it in 32 x 32; the first method that cannot is the DCT.
      expect(error.details).toMatchObject({ needed: SECRET.length, method: "dct-koch-zhao" });
      expect(JSON.stringify(error)).not.toContain(SECRET);
    });

    test("refuses a message over a single method's capacity in mode B", async () => {
      const { ann, experiment } = await start();
      const res = await experiment(ann, {
        mode: "B",
        method: { id: "lsb" },
        scenarios: [[]],
        message: "x".repeat(30_000),
      });
      expect(res.status).toBe(422);
      const { error } = ApiError.parse(await res.json());
      expect(error.details).toMatchObject({ needed: 30_000, method: "lsb" });
    });

    test("shares the active-operation cap and drops the message of a refused one", async () => {
      const { ann, experiment, deps } = await start();
      const accepted: string[] = [];
      for (let i = 0; i < 5; i++) {
        accepted.push(OperationAccepted.parse(await (await experiment(ann)).json()).id);
      }
      const res = await experiment(ann);
      expect(res.status).toBe(429);
      expect(await errorCode(res)).toBe("too_many_operations");
      const handoff = createMessageHandoff(deps.kv);
      for (const id of accepted) expect(await handoff.getMessages(id)).toEqual([SECRET]);
    });

    test("is rate limited per user, with its own limit", async () => {
      const { ann, experiment, kv } = await start();
      const limiter = createRateLimiter(kv, EXPERIMENT_RATE_LIMITS.create);
      for (let i = 0; i < EXPERIMENT_RATE_LIMITS.create.limit; i++) await limiter.hit(ann.userId);
      const res = await experiment(ann);
      expect(res.status).toBe(429);
      expect(await errorCode(res)).toBe("rate_limited");
    });

    test("does not use another user's image", async () => {
      const { client, experiment } = await start();
      const bob = await client("bob@example.com");
      const res = await experiment(bob);
      expect(res.status).toBe(404);
      expect(await errorCode(res)).toBe("image_not_found");
    });
  });

  describe("GET /experiments/:id", () => {
    test("is not found for another user, a missing id and a malformed id", async () => {
      const { client, ann, experiment } = await start();
      const { id } = OperationAccepted.parse(await (await experiment(ann)).json());
      const bob = await client("bob@example.com");
      for (const path of [
        `/experiments/${id}`,
        `/experiments/${crypto.randomUUID()}`,
        "/experiments/nope",
      ]) {
        const res = await bob.request("GET", path);
        expect(res.status).toBe(404);
        expect(await errorCode(res)).toBe("not_found");
      }
      expect((await ann.request("GET", "/experiments/nope")).status).toBe(404);
    });

    test("is not found for an operation that is not an experiment", async () => {
      const { ann, image } = await start();
      const res = await ann.postJson("/operations/decode", { imageId: image.id, method: "auto" });
      const { id } = OperationAccepted.parse(await res.json());
      expect((await ann.request("GET", `/operations/${id}`)).status).toBe(200);
      expect((await ann.request("GET", `/experiments/${id}`)).status).toBe(404);
    });

    test("needs a session", async () => {
      const { deps, image } = await start();
      const server = createServer(deps);
      servers.push(server);
      const anonymous = new Client(server.url, "anon@example.com");
      expect((await anonymous.request("GET", `/experiments/${image.id}`)).status).toBe(401);
    });

    test("shows the progress the worker reported while the experiment is active", async () => {
      const { ann, experiment, kv } = await start();
      const { id } = OperationAccepted.parse(await (await experiment(ann)).json());
      await createProgressStore(kv).put(id, { done: 7, total: 33 });
      const view = Experiment.parse(await (await ann.request("GET", `/experiments/${id}`)).json());
      expect(view.progress).toEqual({ done: 7, total: 33 });
    });
  });

  describe("history", () => {
    test("lists experiments and filters by type", async () => {
      const { ann, experiment, image } = await start();
      await experiment(ann);
      await ann.postJson("/operations/decode", { imageId: image.id, method: "auto" });
      const all = OperationPage.parse(await (await ann.request("GET", "/operations")).json());
      expect(all.operations.map((o) => o.type).sort()).toEqual(["decode", "experiment"]);
      const only = OperationPage.parse(
        await (await ann.request("GET", "/operations?type=experiment")).json(),
      );
      expect(only.operations).toHaveLength(1);
      expect(only.operations[0]).toMatchObject({ type: "experiment", method: "auto" });
    });
  });
});
