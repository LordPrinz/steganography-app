import { describe, expect, test } from "bun:test";
import { AUTO_SELECTIONS, type DecodeResult, type EncodeResult } from "@stego/contracts";
import { type ClaimedJob, JobError, type OperationType } from "@stego/db";
import { createMemoryImageRepository } from "@stego/db/testing";
import { decodePng, encodePng } from "@stego/image-io";
import { createMemoryObjectStore, newImageKey, type ObjectStore } from "@stego/storage";
import type { JobContext, JobHandler } from "../handlers.ts";
import { createDecodeHandler } from "./decode.ts";
import { createEncodeHandler } from "./encode.ts";

const USER = crypto.randomUUID();
const SECRET = "attack at dawn: ünïcödé ✓";

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

function fixture() {
  const images = createMemoryImageRepository();
  const base = createMemoryObjectStore();
  const puts: string[] = [];
  const deletes: string[] = [];
  const storage: ObjectStore = {
    ...base,
    put: (key, bytes) => {
      puts.push(key);
      return base.put(key, bytes);
    },
    delete: (key) => {
      deletes.push(key);
      return base.delete(key);
    },
  };
  const attached: [string, string][] = [];
  const operations = {
    attachResultImage: async (op: string, image: string) => void attached.push([op, image]),
  };

  async function addImage(pixels = noise(128, 128), userId = USER) {
    const png = await encodePng(pixels);
    const key = newImageKey(userId);
    await storage.put(key, png);
    const row = await images.create(
      {
        userId,
        kind: "original",
        storageKey: key,
        format: "png",
        width: pixels.width,
        height: pixels.height,
        sizeBytes: png.byteLength,
        sha256: "0".repeat(64),
      },
      { maxImages: 100, maxBytes: 1e9 },
    );
    return row as NonNullable<typeof row>;
  }

  function job(
    type: OperationType,
    sourceImageId: string | null,
    params: Record<string, unknown>,
  ): ClaimedJob {
    const id = crypto.randomUUID();
    return {
      id: crypto.randomUUID(),
      operation_id: id,
      status: "running",
      attempts: 1,
      error: null,
      run_after: new Date(),
      locked_at: new Date(),
      finished_at: null,
      created_at: new Date(),
      operation: {
        id,
        user_id: USER,
        type,
        method: null,
        source_image_id: sourceImageId,
        params,
      },
    };
  }

  const revealed: string[] = [];
  function context(message: string | null = SECRET): JobContext {
    return {
      signal: new AbortController().signal,
      message: async () => {
        if (message === null) throw new JobError("message_expired");
        return message;
      },
      reveal: async (text) => void revealed.push(text),
    };
  }

  return { images, storage, puts, deletes, attached, operations, addImage, job, context, revealed };
}

const lsb = { id: "lsb", params: { bitsPerChannel: 1 } };

async function code(promise: Promise<unknown>): Promise<string | undefined> {
  return promise.then(
    () => undefined,
    (error) => (error instanceof JobError ? error.code : String(error)),
  );
}

describe("encode handler", () => {
  test("stores a stego PNG as a new image of the owner and records the metrics", async () => {
    const f = fixture();
    const source = await f.addImage();
    const handler: JobHandler = createEncodeHandler(f);
    const job = f.job("encode", source.id, { layers: [lsb] });
    const result = (await handler(job, f.context())) as EncodeResult;

    expect(result).toMatchObject({
      kind: "encode",
      messageBytes: new TextEncoder().encode(SECRET).length,
    });
    expect(result.psnr).toBeGreaterThan(30);
    expect(result.capacityBytes).toBeGreaterThan(result.messageBytes);
    expect(JSON.stringify(result)).not.toContain("attack");

    const [[operationId, imageId]] = f.attached as [[string, string]];
    expect(operationId).toBe(job.operation_id);
    const row = await f.images.findOwned(USER, imageId);
    expect(row).toMatchObject({ kind: "stego", format: "png", width: 128, height: 128 });
    const stored = await f.storage.get((row as NonNullable<typeof row>).storage_key);
    expect(stored?.byteLength).toBe(row?.size_bytes);
    expect((await decodePng(stored as Uint8Array)).width).toBe(128);
  });

  test("reports a null PSNR for an identical image", async () => {
    const f = fixture();
    // Embedding the same message into the stego image again changes nothing.
    const source = await f.addImage();
    const handler = createEncodeHandler(f);
    const first = (await handler(
      f.job("encode", source.id, { layers: [lsb] }),
      f.context(),
    )) as EncodeResult;
    const [, stegoId] = f.attached[0] as [string, string];
    const again = (await handler(
      f.job("encode", stegoId, { layers: [lsb] }),
      f.context(),
    )) as EncodeResult;
    expect(first.psnr).not.toBeNull();
    expect(again.psnr).toBeNull();
    expect(JSON.parse(JSON.stringify(again)).psnr).toBeNull();
  });

  test("fails for good, with a public code, when it cannot encode", async () => {
    const f = fixture();
    const handler = createEncodeHandler(f);
    const small = await f.addImage(noise(16, 16));
    const big = await f.addImage();

    expect(
      await code(handler(f.job("encode", small.id, { layers: [lsb] }), f.context("x".repeat(500)))),
    ).toBe("capacity_exceeded");
    expect(await code(handler(f.job("encode", big.id, { layers: [lsb] }), f.context(null)))).toBe(
      "message_expired",
    );
    expect(
      await code(handler(f.job("encode", crypto.randomUUID(), { layers: [lsb] }), f.context())),
    ).toBe("source_missing");
    expect(await code(handler(f.job("encode", null, { layers: [lsb] }), f.context()))).toBe(
      "source_missing",
    );
    expect(await code(handler(f.job("encode", big.id, { layers: [] }), f.context()))).toBe(
      "invalid_params",
    );
    expect(await code(handler(f.job("encode", big.id, {}), f.context()))).toBe("invalid_params");
    expect(f.attached).toEqual([]);
  });

  test("does not read another user's image", async () => {
    const f = fixture();
    const theirs = await f.addImage(noise(128, 128), crypto.randomUUID());
    const handler = createEncodeHandler(f);
    expect(await code(handler(f.job("encode", theirs.id, { layers: [lsb] }), f.context()))).toBe(
      "source_missing",
    );
  });

  test("removes the object and fails for good when the quota is full", async () => {
    const f = fixture();
    const source = await f.addImage();
    const handler = createEncodeHandler({
      ...f,
      images: { findOwned: f.images.findOwned, create: async () => null },
    });
    f.puts.length = 0;
    expect(await code(handler(f.job("encode", source.id, { layers: [lsb] }), f.context()))).toBe(
      "quota_exceeded",
    );
    expect(f.puts).toHaveLength(1);
    expect(f.deletes).toEqual(f.puts);
    expect(f.attached).toEqual([]);
  });

  test("writes nothing once aborted", async () => {
    const f = fixture();
    const source = await f.addImage();
    f.puts.length = 0;
    const abort = new AbortController();
    abort.abort(new JobError("timeout"));
    const handler = createEncodeHandler(f);
    expect(
      await code(
        handler(f.job("encode", source.id, { layers: [lsb] }), {
          ...f.context(),
          signal: abort.signal,
        }),
      ),
    ).toBe("timeout");
    expect(f.puts).toEqual([]);
  });
});

describe("decode handler", () => {
  async function stegoImage(
    f: ReturnType<typeof fixture>,
    layer: Record<string, unknown>,
    message = SECRET,
  ) {
    const source = await f.addImage();
    await createEncodeHandler(f)(
      f.job("encode", source.id, { layers: [layer] }),
      f.context(message),
    );
    const [, id] = f.attached.at(-1) as [string, string];
    return id;
  }

  test("reveals the message of the chosen method and keeps it out of the result", async () => {
    const f = fixture();
    const id = await stegoImage(f, lsb);
    const result = (await createDecodeHandler(f)(
      f.job("decode", id, { method: lsb }),
      f.context(),
    )) as DecodeResult;
    expect(f.revealed).toEqual([SECRET]);
    expect(result).toMatchObject({
      kind: "decode",
      detected: "lsb",
      attempts: [
        { method: "lsb", outcome: "found", messageBytes: new TextEncoder().encode(SECRET).length },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("attack");
  });

  test("a wrong method finds nothing", async () => {
    const f = fixture();
    const id = await stegoImage(f, lsb);
    const result = (await createDecodeHandler(f)(
      f.job("decode", id, { method: { id: "dct-koch-zhao", params: {} } }),
      f.context(),
    )) as DecodeResult;
    expect(result.detected).toBeNull();
    expect(result.attempts[0]?.outcome).toBe("no-message");
    expect(f.revealed).toEqual([]);
  });

  test("auto tries every method and finds the one that was used", async () => {
    const f = fixture();
    const id = await stegoImage(f, { id: "dwt-qim", params: { band: "LL", level: 2, step: 32 } });
    const result = (await createDecodeHandler(f)(
      f.job("decode", id, { method: "auto" }),
      f.context(),
    )) as DecodeResult;
    expect(result.attempts.map((a) => a.method)).toEqual(AUTO_SELECTIONS.map((s) => s.id));
    expect(result.detected).toBe("dwt-qim");
    expect(result.attempts.find((a) => a.method === "dwt-qim")?.outcome).toBe("found");
    expect(f.revealed).toEqual([SECRET]);
  });

  test("auto on a clean image finds no message with any method", async () => {
    const f = fixture();
    const clean = await f.addImage();
    const result = (await createDecodeHandler(f)(
      f.job("decode", clean.id, { method: "auto" }),
      f.context(),
    )) as DecodeResult;
    expect(result.detected).toBeNull();
    expect(result.attempts).toHaveLength(AUTO_SELECTIONS.length);
    for (const attempt of result.attempts) {
      expect(attempt).toMatchObject({ outcome: "no-message", messageBytes: null });
      expect(attempt.capacityBytes).toBeGreaterThan(0);
    }
    expect(f.revealed).toEqual([]);
  });

  test("fails for good on a missing source or bad parameters", async () => {
    const f = fixture();
    const handler = createDecodeHandler(f);
    expect(
      await code(handler(f.job("decode", crypto.randomUUID(), { method: "auto" }), f.context())),
    ).toBe("source_missing");
    const clean = await f.addImage();
    expect(await code(handler(f.job("decode", clean.id, { method: "all" }), f.context()))).toBe(
      "invalid_params",
    );
  });
});
