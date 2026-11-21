import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  type EncodeResult,
  Experiment,
  ImagePage,
  Operation,
  OperationAccepted,
} from "@stego/contracts";
import {
  createImageRepository,
  createJobQueue,
  createOperationRepository,
  createRefreshTokenRepository,
  createUserRepository,
} from "@stego/db";
import { createTestDatabase } from "@stego/db/testing";
import { encodePng } from "@stego/image-io";
import {
  createMemoryStore,
  createMemoryWake,
  createMessageHandoff,
  createProgressStore,
  createRedisStore,
  type KeyValueStore,
} from "@stego/kv";
import { createMemoryObjectStore } from "@stego/storage";
import { RedisClient, type SQL } from "bun";
import { createServer } from "../../../api/src/app.ts";
import { Client } from "../../../api/src/testing/client.ts";
import { testServerDeps } from "../../../api/src/testing/server-deps.ts";
import { createWorker } from "../worker.ts";
import { createDecodeHandler } from "./decode.ts";
import { createEncodeHandler } from "./encode.ts";
import { createExperimentHandler } from "./experiment.ts";

// The whole path: API request, Postgres job, worker handler, stego image in storage, and back through a
// second request. Needs TEST_DATABASE_URL; the Redis variant also needs TEST_REDIS_URL.
const testDb = createTestDatabase(4);
const sql = testDb?.sql;
const redisUrl = Bun.env.TEST_REDIS_URL;

beforeAll(async () => {
  await testDb?.setup();
});

afterAll(async () => {
  await testDb?.teardown();
});

// Unique per run, so a match in a row or a log line can only come from this message.
const SECRET = `s-${crypto.randomUUID()}-é✓`;

function noise(width: number, height: number) {
  const data = new Uint8ClampedArray(width * height * 4);
  let state = 0x2545f491;
  for (let i = 0; i < data.length; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    data[i] = i % 4 === 3 ? 255 : state & 0xff;
  }
  return { width, height, data };
}

// `auto` marks the methods the "auto" decode finds, which tries defaults without error correction.
const methods = [
  { name: "lsb", layer: { id: "lsb", params: { bitsPerChannel: 1 } }, auto: true },
  {
    name: "lsb with repetition",
    layer: { id: "lsb", ecc: { code: "repetition", factor: 5 } },
    auto: false,
  },
  { name: "dct-koch-zhao", layer: { id: "dct-koch-zhao" }, auto: true },
  {
    name: "dct-koch-zhao with Hamming(7,4)",
    layer: { id: "dct-koch-zhao", ecc: { code: "hamming74" } },
    auto: false,
  },
  { name: "dwt-qim", layer: { id: "dwt-qim" }, auto: true },
] as const;

/** Keys under a fresh prefix, so rate-limit counters left by earlier runs do not block the sign-ins. */
function isolated(store: KeyValueStore): KeyValueStore {
  const ns = crypto.randomUUID();
  return {
    get: (key) => store.get(`${ns}:${key}`),
    set: (key, value, ttlMs) => store.set(`${ns}:${key}`, value, ttlMs),
    del: (key) => store.del(`${ns}:${key}`),
    increment: (key, ttlMs) => store.increment(`${ns}:${key}`, ttlMs),
    ping: () => store.ping(),
  };
}

const kvBackends: [string, () => KeyValueStore, boolean][] = [
  ["memory", () => createMemoryStore(), true],
  [
    "redis",
    () => isolated(createRedisStore(new RedisClient(redisUrl as string))),
    Boolean(redisUrl),
  ],
];

const stopWhenDone: (() => Promise<void>)[] = [];

// Everything the worker logs and everything written to the console while a test runs.
const logged: unknown[][] = [];
const consoleMethods = ["log", "info", "warn", "error", "debug"] as const;
const originalConsole = Object.fromEntries(consoleMethods.map((m) => [m, console[m]]));
beforeEach(() => {
  logged.length = 0;
  for (const m of consoleMethods) console[m] = (...args: unknown[]) => void logged.push(args);
});

afterEach(async () => {
  for (const stop of stopWhenDone.splice(0)) await stop();
  for (const m of consoleMethods) console[m] = originalConsole[m] as never;
});

/** The message, and the form it takes inside a JSON string, appear in none of the captured output. */
function expectNoSecretLogged(): void {
  const output = logged.map((args) => args.map((arg) => Bun.inspect(arg)).join(" ")).join("\n");
  expect(output).not.toContain(SECRET);
  expect(output).not.toContain(JSON.stringify(SECRET).slice(1, -1));
}

describe.skipIf(!sql).each(kvBackends)(
  "encode and decode through the API and the worker (%s)",
  (_name, makeKv, enabled) => {
    async function start() {
      const db = sql as SQL;
      await db`TRUNCATE users CASCADE`;
      const kv = makeKv();
      const wake = createMemoryWake();
      const images = createImageRepository(db);
      const operations = createOperationRepository(db);
      const storage = createMemoryObjectStore();
      const deps = testServerDeps({
        kv,
        wake,
        storage,
        images,
        operations,
        users: createUserRepository(db),
        refreshTokens: createRefreshTokenRepository(db),
      });
      const server = createServer(deps);
      const worker = createWorker({
        queue: createJobQueue(db),
        handlers: {
          encode: createEncodeHandler({ images, operations, storage }),
          decode: createDecodeHandler({ images, storage }),
          experiment: createExperimentHandler({
            images,
            storage,
            progress: createProgressStore(kv),
          }),
        },
        handoff: createMessageHandoff(kv),
        // The wake-up is what starts jobs here, not the poll.
        pollIntervalMs: 30_000,
        log: { error: (...args: unknown[]) => void logged.push(args) },
      });
      const stopListening = wake.listen(() => worker.wake());
      const running = worker.run();
      stopWhenDone.push(async () => {
        worker.stop();
        await running;
        await stopListening();
        server.stop(true);
      });

      const ann = new Client(server.url, "ann@example.com");
      await ann.signIn();
      const upload = await ann.uploadMeta(await encodePng(noise(256, 256)));

      async function finished(client: Client, id: string): Promise<Operation> {
        for (let i = 0; i < 600; i++) {
          const res = await client.request("GET", `/operations/${id}`);
          const operation = Operation.parse(await res.json());
          if (operation.status === "succeeded" || operation.status === "failed") return operation;
          await Bun.sleep(25);
        }
        throw new Error("operation did not finish");
      }

      async function run(path: string, body: Record<string, unknown>): Promise<Operation> {
        const res = await ann.postJson(path, body);
        expect(res.status).toBe(202);
        return finished(ann, OperationAccepted.parse(await res.json()).id);
      }

      return {
        db,
        kv,
        storage,
        ann,
        upload,
        server,
        finished,
        handoff: createMessageHandoff(kv),
        encode: (layer: object, message = SECRET) =>
          run("/operations/encode", { imageId: upload.id, layers: [{ method: layer, message }] }),
        decode: (imageId: string, method: unknown) =>
          run("/operations/decode", { imageId, method }),
      };
    }

    test.skipIf(!enabled).each(methods)("round trip: $name", async ({ layer, auto }) => {
      const { db, ann, upload, encode, decode, handoff } = await start();

      const encoded = await encode(layer);
      expect(encoded).toMatchObject({
        type: "encode",
        status: "succeeded",
        error: null,
        method: layer.id,
      });
      expect(encoded.result).toMatchObject({
        kind: "encode",
        layers: [{ method: layer.id, messageBytes: new TextEncoder().encode(SECRET).length }],
      });
      const stego = encoded.resultImage;
      expect(stego).toMatchObject({ kind: "stego", width: 256, height: 256 });
      expect(stego?.id).not.toBe(upload.id);
      expect(await handoff.getMessages(encoded.id)).toBeNull();

      const decoded = await decode((stego as NonNullable<typeof stego>).id, layer);
      expect(decoded).toMatchObject({ status: "succeeded", revealed: { [layer.id]: SECRET } });
      expect(decoded.result).toMatchObject({ kind: "decode", detected: layer.id });

      if (auto) {
        const detected = await decode((stego as NonNullable<typeof stego>).id, "auto");
        expect(detected).toMatchObject({ status: "succeeded", revealed: { [layer.id]: SECRET } });
        expect(detected.result).toMatchObject({ kind: "decode", detected: layer.id });
      }

      // Neither the message nor anything shaped like it was written to Postgres.
      const rows = await db<{ row: string }[]>`
      SELECT to_jsonb(o)::text AS row FROM operations o
      UNION ALL SELECT to_jsonb(j)::text FROM jobs j
      UNION ALL SELECT to_jsonb(i)::text FROM images i
    `;
      expect(rows.length).toBeGreaterThan(4);
      for (const { row } of rows) {
        expect(row).not.toContain(SECRET);
        expect(row).not.toContain(JSON.stringify(SECRET).slice(1, -1));
      }
      expectNoSecretLogged();
    });

    test.skipIf(!enabled)(
      "three layers round-trip: encode hides all, decode reveals each message by method",
      async () => {
        const { db, ann, upload, finished, decode, handoff, server } = await start();
        const messages = {
          lsb: `${SECRET}-lsb`,
          "dct-koch-zhao": `${SECRET}-dct`,
          "dwt-qim": `${SECRET}-dwt`,
        };
        const res = await ann.postJson("/operations/encode", {
          imageId: upload.id,
          // Not in embedding order: the engine decides that.
          layers: [
            { method: { id: "lsb" }, message: messages.lsb },
            { method: { id: "dwt-qim" }, message: messages["dwt-qim"] },
            { method: { id: "dct-koch-zhao" }, message: messages["dct-koch-zhao"] },
          ],
        });
        expect(res.status).toBe(202);
        const encoded = await finished(ann, OperationAccepted.parse(await res.json()).id);
        expect(encoded).toMatchObject({ type: "encode", status: "succeeded", method: "auto" });
        const result = encoded.result as EncodeResult;
        expect(result.layers.map((l) => l.method)).toEqual(["lsb", "dwt-qim", "dct-koch-zhao"]);
        expect(result.layers.every((l) => l.capacityBytes > l.messageBytes)).toBe(true);
        expect(result.psnr).toBeGreaterThan(25);
        expect(await handoff.getMessages(encoded.id)).toBeNull();

        const stego = (encoded.resultImage as NonNullable<typeof encoded.resultImage>).id;
        const auto = await decode(stego, "auto");
        expect(auto).toMatchObject({ status: "succeeded", revealed: messages });
        expect(auto.result).toMatchObject({ kind: "decode", found: expect.any(Array) });
        const one = await decode(stego, { id: "dwt-qim" });
        expect(one.revealed).toEqual({ "dwt-qim": messages["dwt-qim"] });

        // The history lists the layered encode under "auto"; nobody else can read any of it.
        const bob = new Client(server.url, "bob@example.com");
        await bob.signIn();
        expect((await bob.request("GET", `/operations/${encoded.id}`)).status).toBe(404);
        expect((await bob.request("GET", `/operations/${auto.id}`)).status).toBe(404);

        const rows = await db<{ row: string }[]>`
          SELECT to_jsonb(o)::text AS row FROM operations o
          UNION ALL SELECT to_jsonb(j)::text FROM jobs j
          UNION ALL SELECT to_jsonb(i)::text FROM images i
        `;
        for (const message of Object.values(messages)) {
          for (const { row } of rows) expect(row).not.toContain(message);
          const output = logged
            .map((args) => args.map((arg) => Bun.inspect(arg)).join(" "))
            .join("\n");
          expect(output).not.toContain(message);
        }
      },
    );

    test.skipIf(!enabled)(
      "a decode with a list of methods reveals layers that need their own parameters or a code",
      async () => {
        const { ann, upload, finished, decode } = await start();
        const layers = [
          { method: { id: "lsb" }, message: "plain" },
          { method: { id: "dwt-qim", params: { level: 2, step: 64 } }, message: "wavelet" },
          { method: { id: "dct-koch-zhao", ecc: { code: "hamming74" } }, message: "cosine" },
        ];
        const res = await ann.postJson("/operations/encode", { imageId: upload.id, layers });
        const encoded = await finished(ann, OperationAccepted.parse(await res.json()).id);
        expect(encoded.status).toBe("succeeded");
        const stego = (encoded.resultImage as NonNullable<typeof encoded.resultImage>).id;

        const auto = await decode(stego, "auto");
        expect(auto.revealed).toEqual({ lsb: "plain" });
        const listed = await decode(
          stego,
          layers.map(({ method }) => method),
        );
        expect(listed).toMatchObject({
          status: "succeeded",
          method: "auto",
          revealed: { lsb: "plain", "dwt-qim": "wavelet", "dct-koch-zhao": "cosine" },
        });
      },
    );

    test.skipIf(!enabled)("auto finds no message in an image that holds none", async () => {
      const { upload, decode } = await start();
      const clean = await decode(upload.id, "auto");
      expect(clean).toMatchObject({ status: "succeeded", revealed: null });
      expect(clean.result).toMatchObject({ kind: "decode", detected: null });
      const { attempts } = clean.result as { attempts: { method: string; outcome: string }[] };
      expect(attempts.map((a) => a.method)).toEqual(["lsb", "dct-koch-zhao", "dwt-qim"]);
      expect(attempts.every((a) => a.outcome === "no-message")).toBe(true);
    });

    test.skipIf(!enabled)("a failed job shows its public code and keeps no message", async () => {
      const { db, storage, upload, encode, handoff } = await start();
      const [row] = await db<
        { storage_key: string }[]
      >`SELECT storage_key FROM images WHERE id = ${upload.id}`;
      await storage.delete((row as NonNullable<typeof row>).storage_key);

      const failed = await encode({ id: "lsb" });
      expect(failed).toMatchObject({
        status: "failed",
        error: "source_missing",
        resultImage: null,
        result: null,
      });
      expect(await handoff.getMessages(failed.id)).toBeNull();
      const [job] = await db<
        { attempts: number }[]
      >`SELECT attempts FROM jobs WHERE operation_id = ${failed.id}`;
      expect(job?.attempts).toBe(1);
      // The failure was logged, and the log does not hold the message.
      expect(logged.length).toBeGreaterThan(0);
      expectNoSecretLogged();
      const rows = await db<{ row: string }[]>`
        SELECT to_jsonb(o)::text AS row FROM operations o UNION ALL SELECT to_jsonb(j)::text FROM jobs j
      `;
      expect(rows.some(({ row }) => row.includes(SECRET))).toBe(false);
    });

    test.skipIf(!enabled)(
      "a result image deleted later leaves the operation succeeded",
      async () => {
        const { ann, encode } = await start();
        const encoded = await encode({ id: "lsb" });
        expect(encoded.resultImage).not.toBeNull();
        const removed = await ann.request("DELETE", `/images/${encoded.resultImage?.id}`);
        expect(removed.status).toBe(204);
        const res = await ann.request("GET", `/operations/${encoded.id}`);
        expect(Operation.parse(await res.json())).toMatchObject({
          status: "succeeded",
          resultImage: null,
          result: { kind: "encode" },
        });
      },
    );

    test.skipIf(!enabled)(
      "an experiment runs the whole matrix and keeps its variants out of the gallery",
      async () => {
        const { db, server, ann, upload } = await start();
        const res = await ann.postJson("/experiments", {
          mode: "A",
          imageId: upload.id,
          message: SECRET,
        });
        expect(res.status).toBe(202);
        const { id } = OperationAccepted.parse(await res.json());
        expect(res.headers.get("location")).toBe(`/api/v1/experiments/${id}`);

        let experiment: Experiment | undefined;
        for (let i = 0; i < 1200; i++) {
          const got = await ann.request("GET", `/experiments/${id}`);
          experiment = Experiment.parse(await got.json());
          if (experiment.status === "succeeded" || experiment.status === "failed") break;
          await Bun.sleep(25);
        }
        expect(experiment).toMatchObject({ type: "experiment", status: "succeeded", error: null });
        const result = experiment?.result;
        if (result?.kind !== "experiment") throw new Error("not an experiment result");
        expect(result.variants).toHaveLength(33);
        expect(result.aggregates).toHaveLength(33);
        expect(
          result.variants.find((v) => v.method === "lsb" && v.label === "jpeg50"),
        ).toMatchObject({ success: false });
        expect(Object.keys(experiment?.variantImages ?? {})).toHaveLength(33);
        expect(experiment?.progress).toBeNull();

        // The stored attacked images are not in the gallery and not in the quota.
        const gallery = ImagePage.parse(await (await ann.request("GET", "/images")).json());
        expect(gallery.images.map((image) => image.id)).toEqual([upload.id]);
        const [counted] = await db<{ n: number }[]>`
          SELECT count(*)::int AS n FROM images WHERE kind = 'variant' AND expires_at > now()
        `;
        expect(counted?.n).toBe(33);

        // Only its owner reads it, and it is not served as another kind of operation.
        const bob = new Client(server.url, "bob@example.com");
        await bob.signIn();
        expect((await bob.request("GET", `/experiments/${id}`)).status).toBe(404);

        const rows = await db<{ row: string }[]>`
          SELECT to_jsonb(o)::text AS row FROM operations o
          UNION ALL SELECT to_jsonb(j)::text FROM jobs j
          UNION ALL SELECT to_jsonb(i)::text FROM images i
        `;
        for (const { row } of rows) expect(row).not.toContain(SECRET);
        expectNoSecretLogged();
      },
    );

    test.skipIf(!enabled)("other users cannot read an operation or its message", async () => {
      const { server, ann, upload, decode, handoff } = await start();
      const op = await decode(upload.id, "auto");
      await handoff.putRevealed(op.id, { lsb: SECRET });
      expect(await (await ann.request("GET", `/operations/${op.id}`)).text()).toContain(SECRET);

      const bob = new Client(server.url, "bob@example.com");
      await bob.signIn();
      const res = await bob.request("GET", `/operations/${op.id}`);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain(SECRET);
    });
  },
);
