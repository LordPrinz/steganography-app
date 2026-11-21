import { describe, expect, test } from "bun:test";
import { AUTO_SELECTIONS, MethodSelection } from "@stego/contracts";
import type { ImageRow, OperationRepository, OperationRow, OperationView } from "@stego/db";
import { createMethod } from "@stego/engine";
import { createMemoryStore, createMessageHandoff, type KeyValueStore } from "@stego/kv";
import { createOperationService, TooManyActiveOperationsError } from "./service.ts";

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
    ...overrides,
  };
}

function setup({
  rows = [] as OperationView[],
  create = async (): Promise<OperationRow | null> => view(),
  kv = createMemoryStore() as KeyValueStore,
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
    async attachResultImage() {},
  };
  const service = createOperationService({
    operations,
    images: {
      findOwned: async (userId, id) => (userId === USER && id === IMAGE_ID ? image : null),
    },
    imageUrls: { get: async () => null },
    handoff: createMessageHandoff(kv),
    wake: { notify: async () => void events.push("notify") },
    kv,
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
        message: "hello",
        layers: [MethodSelection.parse({ id: "lsb" })] as [MethodSelection],
      }),
    ).rejects.toThrow("database down");
    const [key] = keys;
    expect(key).toMatch(/^op:[0-9a-f-]{36}:message$/);
    expect(await handoff.getMessage((key as string).split(":")[1] as string)).toBeNull();
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
    await handoff.putRevealed(row.id, "hidden text");
    expect(await service.get(USER, row.id)).toMatchObject({ revealed: "hidden text" });
    expect(await service.get(OTHER, row.id)).toBeNull();
  });

  test("shows a revealed message only for a succeeded decode", async () => {
    const row = view({ type: "encode", status: "succeeded" });
    const { service, handoff } = setup({ rows: [row] });
    await handoff.putRevealed(row.id, "hidden text");
    expect(await service.get(USER, row.id)).toMatchObject({ revealed: null });
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
