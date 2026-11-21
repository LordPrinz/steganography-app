import { describe, expect, test } from "bun:test";
import { AUTO_SELECTIONS, type ImageDetail, MethodSelection } from "@stego/contracts";
import type {
  ImageRow,
  NewOperation,
  OperationRepository,
  OperationRow,
  OperationView,
} from "@stego/db";
import { createMethod } from "@stego/engine";
import {
  createMemoryStore,
  createMessageHandoff,
  createProgressStore,
  type KeyValueStore,
} from "@stego/kv";
import type { ImageService } from "../images/service.ts";
import {
  createOperationService,
  ExperimentImageTooLargeError,
  ExperimentImageTooSmallError,
  MessageTooLargeError,
  OperationActiveError,
  SourceNotFoundError,
  TooManyActiveOperationsError,
  TooManyVariantsError,
} from "./service.ts";

const USER = crypto.randomUUID();
const OTHER = crypto.randomUUID();
const IMAGE_ID = crypto.randomUUID();
const silent = { error: () => {} };

const image = { id: IMAGE_ID, user_id: USER, width: 64, height: 64 } as ImageRow;

function view(overrides: Partial<OperationView> = {}): OperationView {
  return {
    id: crypto.randomUUID(),
    user_id: USER,
    type: "decode",
    method: null,
    source_image_id: IMAGE_ID,
    result_image_id: null,
    status: "queued",
    params: {},
    result: null,
    created_at: new Date("2026-11-20T10:00:00Z"),
    error: null,
    failure_layer: null,
    ...overrides,
  };
}

function setup({
  rows = [] as OperationView[],
  create = async (): Promise<OperationRow | null> => view(),
  kv = createMemoryStore() as KeyValueStore,
  imageUrls = { get: async () => null } as Pick<ImageService, "get">,
  maxVariants = undefined as number | undefined,
  listed = [] as OperationView[],
  source = image,
  now = undefined as (() => number) | undefined,
} = {}) {
  const events: string[] = [];
  let lookups = 0;
  const operations: OperationRepository = {
    async createWithJob(op, limit) {
      events.push("create");
      const row = await create();
      if (row) events.push("committed");
      return row && { ...row, id: op.id, ...limit };
    },
    async findOwned(userId, id) {
      lookups++;
      return rows.find((row) => row.id === id && row.user_id === userId) ?? null;
    },
    async listPage() {
      return { operations: listed, next: null };
    },
    async deleteFinishedOwned(userId, id) {
      const row = rows.find((r) => r.id === id && r.user_id === userId);
      return row?.status === "succeeded" || row?.status === "failed";
    },
    async attachResultImage() {},
  };
  const service = createOperationService({
    operations,
    images: {
      findOwned: async (userId, id) => (userId === USER && id === IMAGE_ID ? source : null),
    },
    imageUrls,
    handoff: createMessageHandoff(kv),
    wake: { notify: async () => void events.push("notify") },
    kv,
    progress: createProgressStore(kv),
    maxVariants,
    now,
    log: silent,
  });
  return { service, events, kv, lookups: () => lookups, handoff: createMessageHandoff(kv) };
}

describe("wake-up", () => {
  test("is sent after the enqueue transaction committed", async () => {
    const { service, events } = setup();
    await service.decode(USER, { imageId: IMAGE_ID, method: "auto" });
    expect(events).toEqual(["create", "committed", "notify"]);
  });

  test("is not sent when the enqueue fails", async () => {
    const { service, events } = setup({
      create: async () => {
        throw new Error("database down");
      },
    });
    await expect(service.decode(USER, { imageId: IMAGE_ID, method: "auto" })).rejects.toThrow(
      "database down",
    );
    expect(events).toEqual(["create"]);
  });

  test("is not sent when the user is at the active cap", async () => {
    const { service, events } = setup({ create: async () => null });
    await expect(service.decode(USER, { imageId: IMAGE_ID, method: "auto" })).rejects.toThrow(
      TooManyActiveOperationsError,
    );
    expect(events).toEqual(["create"]);
  });

  test("is not sent for a request that never reaches the queue", async () => {
    const { service, events } = setup();
    await expect(service.decode(OTHER, { imageId: IMAGE_ID, method: "auto" })).rejects.toThrow();
    expect(events).toEqual([]);
  });
});

describe("message hand-off", () => {
  test("drops the message when the enqueue fails", async () => {
    const kv = createMemoryStore();
    const { service, handoff } = setup({
      kv,
      create: async () => {
        throw new Error("database down");
      },
    });
    const keys: string[] = [];
    const set = kv.set;
    kv.set = (key, value, ttl) => {
      keys.push(key);
      return set(key, value, ttl);
    };
    await expect(
      service.encode(USER, {
        imageId: IMAGE_ID,
        layers: [{ method: MethodSelection.parse({ id: "lsb" }), message: "hello" }],
      }),
    ).rejects.toThrow("database down");
    const [key] = keys;
    expect(key).toMatch(/^op:[0-9a-f-]{36}:message$/);
    expect(await handoff.getMessages((key as string).split(":")[1] as string)).toBeNull();
  });
});

describe("remove", () => {
  test("forgets the cached view of a deleted operation", async () => {
    const row = view({ status: "succeeded" });
    const { service, kv } = setup({ rows: [row] });
    await service.get(USER, row.id);
    expect(await kv.get(`op:${row.id}:view`)).not.toBeNull();
    expect(await service.remove(USER, row.id)).toBe(true);
    expect(await kv.get(`op:${row.id}:view`)).toBeNull();
  });

  test("drops the revealed message of a deleted operation", async () => {
    const row = view({ status: "succeeded" });
    const { service, handoff } = setup({ rows: [row] });
    await handoff.putRevealed(row.id, { lsb: "hidden text" });
    await service.remove(USER, row.id);
    expect(await handoff.getRevealed(row.id)).toBeNull();
  });

  test("still deletes when the key-value store is down", async () => {
    const down: KeyValueStore = {
      ...createMemoryStore(),
      del: async () => {
        throw new Error("redis down");
      },
    };
    const row = view({ status: "succeeded" });
    const { service } = setup({ rows: [row], kv: down });
    expect(await service.remove(USER, row.id)).toBe(true);
  });

  test("is false for a missing or foreign operation and leaves the cache alone", async () => {
    const row = view({ status: "succeeded" });
    const { service, kv } = setup({ rows: [row] });
    await service.get(USER, row.id);
    expect(await service.remove(OTHER, row.id)).toBe(false);
    expect(await service.remove(USER, crypto.randomUUID())).toBe(false);
    expect(await kv.get(`op:${row.id}:view`)).not.toBeNull();
  });

  test("refuses an operation that is queued or running", async () => {
    const row = view({ status: "running" });
    const { service } = setup({ rows: [row] });
    await expect(service.remove(USER, row.id)).rejects.toThrow(OperationActiveError);
  });
});

describe("polling", () => {
  test("serves a finished operation from the cache after the first read", async () => {
    const row = view({
      status: "succeeded",
      result: { kind: "decode", attempts: [], detected: null },
    });
    const { service, lookups } = setup({ rows: [row] });
    const first = await service.get(USER, row.id);
    const second = await service.get(USER, row.id);
    expect(second).toEqual(first as NonNullable<typeof first>);
    expect(first).toMatchObject({ status: "succeeded", result: { kind: "decode" } });
    expect(lookups()).toBe(1);
  });

  test("does not cache an operation that can still change", async () => {
    const row = view({ status: "running" });
    const { service, lookups } = setup({ rows: [row] });
    await service.get(USER, row.id);
    await service.get(USER, row.id);
    expect(lookups()).toBe(2);
  });

  test("a cached operation is not shown to another user", async () => {
    const row = view({ status: "failed", error: "message_expired" });
    const { service, lookups } = setup({ rows: [row] });
    expect(await service.get(USER, row.id)).toMatchObject({ error: "message_expired" });
    expect(await service.get(OTHER, row.id)).toBeNull();
    expect(lookups()).toBe(1);
  });

  test("shows an error code only once the operation failed", async () => {
    const retrying = view({ status: "queued", error: "internal_error" });
    const { service } = setup({ rows: [retrying] });
    expect(await service.get(USER, retrying.id)).toMatchObject({ error: null });
  });

  test("falls back to the database when the cache is down", async () => {
    const down: KeyValueStore = {
      ...createMemoryStore(),
      get: async () => {
        throw new Error("redis down");
      },
      set: async () => {
        throw new Error("redis down");
      },
    };
    const row = view({ status: "succeeded" });
    const { service } = setup({ rows: [row], kv: down });
    expect(await service.get(USER, row.id)).toMatchObject({ status: "succeeded" });
  });

  test("returns the revealed message while its key lives, never from the cache", async () => {
    const row = view({ status: "succeeded" });
    const { service, handoff } = setup({ rows: [row] });
    expect(await service.get(USER, row.id)).toMatchObject({ revealed: null });
    await handoff.putRevealed(row.id, { lsb: "hidden text" });
    expect(await service.get(USER, row.id)).toMatchObject({ revealed: { lsb: "hidden text" } });
    expect(await service.get(OTHER, row.id)).toBeNull();
  });

  test("shows a revealed message only for a succeeded decode", async () => {
    const row = view({ type: "encode", status: "succeeded" });
    const { service, handoff } = setup({ rows: [row] });
    await handoff.putRevealed(row.id, { lsb: "hidden text" });
    expect(await service.get(USER, row.id)).toMatchObject({ revealed: null });
  });
});

describe("failed layer", () => {
  test("is shown for a failed operation only", async () => {
    const failed = view({ status: "failed", error: "layer_conflict", failure_layer: 2 });
    const retrying = view({ status: "queued", error: "layer_conflict", failure_layer: 2 });
    const { service } = setup({ rows: [failed, retrying], listed: [failed, retrying] });
    expect(await service.get(USER, failed.id)).toMatchObject({
      error: "layer_conflict",
      failedLayer: 2,
    });
    expect(await service.get(USER, retrying.id)).toMatchObject({ error: null, failedLayer: null });
    const page = await service.list(USER, { limit: 10 });
    expect(page.operations.map((o) => o.failedLayer)).toEqual([2, null]);
  });
});

describe("method selections", () => {
  test("every selection the contract accepts builds in the engine", () => {
    for (const selection of AUTO_SELECTIONS) expect(() => createMethod(selection)).not.toThrow();
    for (const selection of [
      { id: "lsb", params: { bitsPerChannel: 8 }, ecc: { code: "hamming74" } },
      { id: "dct-koch-zhao", params: { strength: 1024 }, ecc: { code: "repetition", factor: 15 } },
      {
        id: "dct-koch-zhao",
        params: {
          pair: [
            [7, 7],
            [0, 1],
          ],
        },
      },
      { id: "dwt-qim", params: { band: "HL", level: 6, step: 255 } },
      { id: "dwt-qim", params: { band: "LH", level: 1, step: 4.5 } },
    ]) {
      expect(() => createMethod(MethodSelection.parse(selection))).not.toThrow();
    }
  });

  test("the contract refuses what the engine refuses", () => {
    for (const selection of [
      { id: "dwt-qim", params: { level: 7, step: 255 } },
      { id: "dwt-qim", params: { level: 1, step: 4 } },
      {
        id: "dct-koch-zhao",
        params: {
          pair: [
            [1, 1],
            [1, 1],
          ],
        },
      },
      { id: "lsb", params: { bitsPerChannel: 0 } },
    ]) {
      expect(MethodSelection.safeParse(selection).success).toBe(false);
    }
  });
});

describe("experiment", () => {
  const lsbB = (scenarios: unknown[][], message = "hi") =>
    ({
      mode: "B",
      imageId: IMAGE_ID,
      message,
      method: MethodSelection.parse({ id: "lsb" }),
      scenarios,
    }) as Parameters<ReturnType<typeof setup>["service"]["experiment"]>[1];

  test("refuses more variants than allowed before looking at capacity", async () => {
    const { service, events } = setup({ maxVariants: 10 });
    const error = await service
      .experiment(USER, { mode: "A", imageId: IMAGE_ID, message: "hi" })
      .catch((e) => e);
    expect(error).toBeInstanceOf(TooManyVariantsError);
    expect(error).toMatchObject({ variants: 33, maxVariants: 10 });
    await expect(service.experiment(USER, lsbB([[], [], []]))).resolves.toBeDefined();
    expect(events).toContain("create");
  });

  test("refuses an image over the pixel limit and one that is not the user's", async () => {
    const big = { ...image, width: 1025, height: 1024 } as ImageRow;
    const { service } = setup();
    const huge = createOperationService({
      operations: {} as OperationRepository,
      images: { findOwned: async () => big },
      imageUrls: { get: async () => null },
      handoff: createMessageHandoff(createMemoryStore()),
      wake: { notify: async () => {} },
      kv: createMemoryStore(),
      progress: createProgressStore(createMemoryStore()),
      log: silent,
    });
    await expect(huge.experiment(USER, lsbB([[]]))).rejects.toThrow(ExperimentImageTooLargeError);
    await expect(service.experiment(OTHER, lsbB([[]]))).rejects.toThrow(SourceNotFoundError);
  });

  test("names the method that cannot hold the message and drops nothing in Redis", async () => {
    const kv = createMemoryStore();
    const { service, events } = setup({ kv });
    const error = await service
      .experiment(USER, { mode: "A", imageId: IMAGE_ID, message: "hi" })
      .catch((e) => e);
    // 64 x 64 holds an LSB frame, but not one in the DCT's 64 bits.
    expect(error).toBeInstanceOf(MessageTooLargeError);
    expect(error).toMatchObject({ needed: 2, available: 0, method: "dct-koch-zhao" });
    expect(events).toEqual([]);
  });

  test("stores the expanded lists, the method of mode B and no message", async () => {
    let stored: NewOperation | undefined;
    const spy = createOperationService({
      operations: {
        createWithJob: async (op: NewOperation) => {
          stored = op;
          return view({ id: op.id });
        },
      } as unknown as OperationRepository,
      images: { findOwned: async () => image },
      imageUrls: { get: async () => null },
      handoff: createMessageHandoff(createMemoryStore()),
      wake: { notify: async () => {} },
      kv: createMemoryStore(),
      progress: createProgressStore(createMemoryStore()),
      log: silent,
    });
    await spy.experiment(USER, lsbB([[], [{ type: "blur", sigma: 1 }]], "very secret"));
    expect(stored).toMatchObject({ type: "experiment", method: "lsb", sourceImageId: IMAGE_ID });
    expect(stored?.params).toEqual({
      mode: "B",
      methods: [{ id: "lsb", params: { bitsPerChannel: 1 } }],
      scenarios: [[], [{ type: "blur", sigma: 1 }]],
    });
    expect(JSON.stringify(stored)).not.toContain("secret");
  });

  describe("getExperiment", () => {
    const variantImage = (id: string) => ({ id, url: `https://files.test/${id}` }) as ImageDetail;
    const variantResult = (ids: (string | null)[]) => ({
      kind: "experiment",
      mode: "B",
      messageBytes: 2,
      methods: [],
      aggregates: [],
      variants: ids.map((imageId) => ({
        method: "lsb",
        ecc: null,
        scenario: [],
        label: "none",
        success: true,
        ber: 0,
        channelBer: null,
        psnr: 40,
        ssim: 1,
        timeMs: 1,
        imageId,
      })),
    });

    test("is null for another user's operation and for other types", async () => {
      const mine = view({ type: "experiment" });
      const decode = view({ type: "decode" });
      const { service } = setup({ rows: [mine, decode] });
      expect(await service.getExperiment(OTHER, mine.id)).toBeNull();
      expect(await service.getExperiment(USER, decode.id)).toBeNull();
      expect(await service.getExperiment(USER, crypto.randomUUID())).toBeNull();
      expect(await service.getExperiment(USER, mine.id)).toMatchObject({ id: mine.id });
    });

    test("shows progress only while queued or running", async () => {
      const kv = createMemoryStore();
      const running = view({ type: "experiment", status: "running" });
      const done = view({ type: "experiment", status: "succeeded" });
      const { service } = setup({ kv, rows: [running, done] });
      const progress = createProgressStore(kv);
      await progress.put(running.id, { done: 4, total: 33 });
      await progress.put(done.id, { done: 33, total: 33 });
      expect((await service.getExperiment(USER, running.id))?.progress).toEqual({
        done: 4,
        total: 33,
      });
      expect((await service.getExperiment(USER, done.id))?.progress).toBeNull();
    });

    test("presigns the variants that still exist and leaves out the rest", async () => {
      const [a, b, gone] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
      const row = view({
        type: "experiment",
        status: "succeeded",
        result: variantResult([a, b, gone, null, a]),
      });
      const { service } = setup({
        rows: [row],
        imageUrls: { get: async (_user, id) => (id === gone ? null : variantImage(id)) },
      });
      const experiment = await service.getExperiment(USER, row.id);
      expect(Object.keys(experiment?.variantImages ?? {}).sort()).toEqual([a, b].sort());
      expect(experiment?.variantImages[a]?.url).toBe(`https://files.test/${a}`);
      expect(experiment).not.toHaveProperty("resultImageId");
    });

    test("caches a finished experiment but presigns fresh URLs every time", async () => {
      const id = crypto.randomUUID();
      const row = view({
        type: "experiment",
        status: "succeeded",
        result: variantResult([id]),
      });
      let presigned = 0;
      const { service, lookups } = setup({
        rows: [row],
        imageUrls: {
          get: async (_user, imageId) => {
            presigned++;
            return variantImage(imageId);
          },
        },
      });
      await service.getExperiment(USER, row.id);
      await service.getExperiment(USER, row.id);
      expect(lookups()).toBe(1);
      expect(presigned).toBe(2);
    });
  });

  test("the history list leaves out variants and aggregates, keeping the rest of the result", async () => {
    const full = {
      kind: "experiment",
      mode: "A",
      messageBytes: 2,
      methods: [],
      aggregates: [
        {
          method: "lsb",
          ecc: null,
          attack: "none",
          strength: null,
          label: "none",
          successRate: 1,
          meanBer: 0,
          variants: 1,
        },
      ],
      variants: [
        {
          method: "lsb",
          ecc: null,
          scenario: [],
          label: "none",
          success: true,
          ber: 0,
          channelBer: null,
          psnr: 40,
          ssim: 1,
          timeMs: 1,
          imageId: null,
        },
      ],
    };
    const row = view({ type: "experiment", status: "succeeded", result: full });
    const { service } = setup({ listed: [row], rows: [row] });
    const page = await service.list(USER, { limit: 10 });
    expect(page.operations[0]?.result).toEqual({
      kind: "experiment",
      mode: "A",
      messageBytes: 2,
      methods: [],
    });
    // The experiment endpoint still has all of it.
    const experiment = await service.getExperiment(USER, row.id);
    expect(experiment?.result).toMatchObject({ variants: [{}], aggregates: [{}] });
  });

  test("refuses a variant as the source of an encode or an experiment, not of a decode", async () => {
    const variant = { ...image, kind: "variant" } as ImageRow;
    const { service } = setup({ source: variant });
    await expect(
      service.encode(USER, {
        imageId: IMAGE_ID,
        layers: [{ method: MethodSelection.parse({ id: "lsb" }), message: "hi" }],
      }),
    ).rejects.toThrow(SourceNotFoundError);
    await expect(service.experiment(USER, lsbB([[]]))).rejects.toThrow(SourceNotFoundError);
    await expect(
      service.decode(USER, { imageId: IMAGE_ID, method: "auto" }),
    ).resolves.toBeDefined();
  });

  test("refuses an expired variant even for a decode", async () => {
    const expiresAt = new Date("2026-11-20T12:00:00Z");
    const variant = { ...image, kind: "variant", expires_at: expiresAt } as ImageRow;
    const at = (ms: number) => setup({ source: variant, now: () => ms });
    const live = at(expiresAt.getTime() - 1);
    await expect(
      live.service.decode(USER, { imageId: IMAGE_ID, method: "auto" }),
    ).resolves.toBeDefined();
    const gone = at(expiresAt.getTime());
    await expect(gone.service.decode(USER, { imageId: IMAGE_ID, method: "auto" })).rejects.toThrow(
      SourceNotFoundError,
    );
  });

  test("refuses an image with a side under 11 pixels", async () => {
    const { service } = setup({ source: { ...image, width: 10, height: 64 } as ImageRow });
    await expect(service.experiment(USER, lsbB([[]]))).rejects.toThrow(
      ExperimentImageTooSmallError,
    );
  });
});
