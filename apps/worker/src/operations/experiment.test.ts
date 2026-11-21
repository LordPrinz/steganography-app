import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SCENARIOS,
  type ExperimentParams,
  type ExperimentResult,
  MethodSelection,
  StegoMethod,
} from "@stego/contracts";
import { type ClaimedJob, JobError } from "@stego/db";
import { createMemoryImageRepository } from "@stego/db/testing";
import { decodePng, encodePng } from "@stego/image-io";
import { createMemoryObjectStore, newImageKey } from "@stego/storage";
import type { JobContext } from "../handlers.ts";
import { createExperimentHandler } from "./experiment.ts";

const USER = crypto.randomUUID();
const SECRET = "attack at dawn";
const silent = { error: () => {} };

/** Smooth gradients with a little noise: closer to a photo than white noise, and JPEG-friendly. */
function natural(width: number, height: number) {
  const data = new Uint8ClampedArray(width * height * 4);
  let state = 0x2545f491;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      const i = (y * width + x) * 4;
      data[i] = 40 + (x * 150) / width + (state & 7);
      data[i + 1] = 60 + (y * 130) / height + ((state >>> 3) & 7);
      data[i + 2] = 90 + ((x + y) * 70) / (width + height) + ((state >>> 6) & 7);
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

function fixture() {
  const images = createMemoryImageRepository();
  const storage = createMemoryObjectStore();
  const reports: { done: number; total: number }[] = [];
  const progress = {
    put: async (_id: string, p: { done: number; total: number }) => void reports.push(p),
  };

  async function addImage(pixels = natural(128, 128)) {
    const png = await encodePng(pixels);
    const key = newImageKey(USER);
    await storage.put(key, png);
    const row = await images.create(
      {
        userId: USER,
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

  function job(sourceImageId: string | null, params: Record<string, unknown>): ClaimedJob {
    const id = crypto.randomUUID();
    return {
      id: crypto.randomUUID(),
      operation_id: id,
      status: "running",
      attempts: 1,
      error: null,
      failure_layer: null,
      run_after: new Date(),
      locked_at: new Date(),
      finished_at: null,
      created_at: new Date(),
      operation: {
        id,
        user_id: USER,
        type: "experiment",
        method: null,
        source_image_id: sourceImageId,
        params,
      },
    };
  }

  function context(
    message: string | string[] | null = SECRET,
    signal = new AbortController().signal,
  ): JobContext {
    return {
      signal,
      messages: async () => {
        if (message === null) throw new JobError("message_expired");
        return Array.isArray(message) ? message : [message];
      },
      reveal: async () => {},
    };
  }

  return { images, storage, progress, reports, addImage, job, context };
}

const modeA: ExperimentParams = {
  mode: "A",
  methods: StegoMethod.options.map((id) => MethodSelection.parse({ id })),
  scenarios: [...DEFAULT_SCENARIOS],
};

async function code(promise: Promise<unknown>): Promise<string | undefined> {
  return promise.then(
    () => undefined,
    (error) => (error instanceof JobError ? error.code : String(error)),
  );
}

describe("experiment handler", () => {
  test("mode A runs every method against every scenario and stores each attacked image", async () => {
    const f = fixture();
    const source = await f.addImage();
    const handler = createExperimentHandler({ ...f, log: silent });
    const result = (await handler(f.job(source.id, modeA), f.context())) as ExperimentResult;

    expect(result).toMatchObject({
      kind: "experiment",
      mode: "A",
      messageBytes: SECRET.length,
    });
    expect(result.methods.map((m) => m.method)).toEqual([...StegoMethod.options]);
    expect(result.variants).toHaveLength(3 * 11);
    expect(result.aggregates).toHaveLength(3 * 11);

    const lsb = (label: string) =>
      result.variants.find((v) => v.method === "lsb" && v.label === label);
    expect(lsb("none")).toMatchObject({ success: true, ber: 0, channelBer: null });
    expect(lsb("jpeg50")?.success).toBe(false);
    expect(lsb("jpeg50")?.ber).toBeGreaterThan(0.2);
    for (const variant of result.variants.filter((v) => v.label === "none")) {
      expect(variant.success).toBe(true);
    }

    const ids = result.variants.map((v) => v.imageId);
    expect(ids.every((id) => id !== null)).toBe(true);
    expect(new Set(ids).size).toBe(33);
    for (const id of ids) {
      const row = await f.images.findOwned(USER, id as string);
      expect(row).toMatchObject({ kind: "variant", width: 128, height: 128 });
      expect(row?.expires_at).toBeInstanceOf(Date);
      const bytes = await f.storage.get((row as NonNullable<typeof row>).storage_key);
      expect((await decodePng(bytes as Uint8Array)).width).toBe(128);
    }
    // Variants are not counted: only the source is.
    expect((await f.images.usage(USER)).count).toBe(1);
  });

  test("keeps the message out of the result", async () => {
    const f = fixture();
    const source = await f.addImage();
    const result = await createExperimentHandler({ ...f, log: silent })(
      f.job(source.id, modeA),
      f.context(),
    );
    expect(JSON.stringify(result)).not.toContain("dawn");
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  test("mode B reports the channel BER for a method with a code", async () => {
    const f = fixture();
    const source = await f.addImage();
    const params: ExperimentParams = {
      mode: "B",
      methods: [MethodSelection.parse({ id: "lsb", ecc: { code: "repetition", factor: 3 } })],
      scenarios: [[], [{ type: "jpeg", quality: 90 }]],
    };
    const result = (await createExperimentHandler({ ...f, log: silent })(
      f.job(source.id, params),
      f.context(),
    )) as ExperimentResult;
    expect(result.variants).toHaveLength(2);
    expect(result.variants[0]).toMatchObject({ ecc: "repetition", channelBer: 0 });
    expect(result.variants[1]?.channelBer).toBeGreaterThan(0);
    expect(result.methods[0]?.ecc).toBe("repetition");
  });

  describe("layered mode", () => {
    const layered: ExperimentParams = {
      mode: "layered",
      methods: [
        MethodSelection.parse({ id: "lsb" }),
        MethodSelection.parse({ id: "dwt-qim", params: { level: 2, step: 64 } }),
        MethodSelection.parse({ id: "dct-koch-zhao" }),
      ],
      scenarios: [[], [{ type: "jpeg", quality: 50 }], [{ type: "blur", sigma: 1 }]],
    };
    const messages = ["m-lsb", "m-dwt-longer", "m-dct"];

    test("hides every layer once and reports each layer per scenario, one image per scenario", async () => {
      const f = fixture();
      const source = await f.addImage();
      const result = (await createExperimentHandler({ ...f, log: silent })(
        f.job(source.id, layered),
        f.context(messages),
      )) as ExperimentResult;

      expect(result.mode).toBe("layered");
      expect(result.messageBytes).toBe(messages.join("").length);
      expect(result.methods.map((m) => m.method)).toEqual(["lsb", "dwt-qim", "dct-koch-zhao"]);
      // PSNR, SSIM and time are those of the whole image.
      expect(new Set(result.methods.map((m) => m.stegoPsnr)).size).toBe(1);
      expect(result.variants).toHaveLength(9);
      expect(result.aggregates).toHaveLength(9);

      const clean = result.variants.filter((v) => v.label === "none");
      expect(clean.map((v) => v.success)).toEqual([true, true, true]);
      const jpeg = result.variants.filter((v) => v.label === "jpeg50");
      expect(jpeg.find((v) => v.method === "lsb")?.success).toBe(false);

      const ids = new Set(result.variants.map((v) => v.imageId));
      expect(ids.size).toBe(3);
      for (const label of ["none", "jpeg50", "blur1"]) {
        const shared = new Set(
          result.variants.filter((v) => v.label === label).map((v) => v.imageId),
        );
        expect(shared.size).toBe(1);
      }
      expect(f.reports.at(-1)).toEqual({ done: 9, total: 9 });
      expect(await f.images.listExpired(new Date(Date.now() + 1e9), 100)).toHaveLength(3);
      for (const message of messages) expect(JSON.stringify(result)).not.toContain(message);
    });

    test("names the layer that does not fit, and rejects a wrong number of messages", async () => {
      const f = fixture();
      const source = await f.addImage(natural(32, 32));
      const handler = createExperimentHandler({ ...f, log: silent });
      const failed = await handler(f.job(source.id, layered), f.context(messages)).catch((e) => e);
      expect(failed).toMatchObject({ code: "capacity_exceeded", layer: 2 });
      expect(await code(handler(f.job(source.id, layered), f.context("only one")))).toBe(
        "invalid_params",
      );
    });
  });

  test("reports progress from 0 to the total", async () => {
    const f = fixture();
    const source = await f.addImage();
    const params: ExperimentParams = {
      mode: "B",
      methods: [MethodSelection.parse({ id: "lsb" })],
      scenarios: [[], [{ type: "blur", sigma: 1 }]],
    };
    await createExperimentHandler({ ...f, log: silent })(f.job(source.id, params), f.context());
    expect(f.reports).toEqual([
      { done: 0, total: 2 },
      { done: 1, total: 2 },
      { done: 2, total: 2 },
    ]);
  });

  test("a failing progress store does not fail the job", async () => {
    const f = fixture();
    const source = await f.addImage();
    const params: ExperimentParams = {
      ...modeA,
      methods: [modeA.methods[0] as MethodSelection],
      scenarios: [[]],
    };
    const handler = createExperimentHandler({
      ...f,
      progress: {
        put: async () => {
          throw new Error("redis down");
        },
      },
      log: silent,
    });
    const result = (await handler(f.job(source.id, params), f.context())) as ExperimentResult;
    expect(result.variants).toHaveLength(1);
  });

  test("fails for good, with a public code", async () => {
    const f = fixture();
    const handler = createExperimentHandler({ ...f, log: silent });
    const source = await f.addImage();
    const big = await f.addImage(natural(1100, 1000));
    const small = await f.addImage(natural(16, 16));
    const tiny = await f.addImage(natural(8, 8));

    expect(await code(handler(f.job(source.id, {}), f.context()))).toBe("invalid_params");
    expect(await code(handler(f.job(source.id, { ...modeA, scenarios: [] }), f.context()))).toBe(
      "invalid_params",
    );
    expect(await code(handler(f.job(source.id, modeA), f.context(null)))).toBe("message_expired");
    expect(await code(handler(f.job(null, modeA), f.context()))).toBe("source_missing");
    expect(await code(handler(f.job(big.id, modeA), f.context()))).toBe("image_too_large");
    expect(await code(handler(f.job(tiny.id, modeA), f.context()))).toBe("image_too_small");
    // Mode A hides one message with one method: the failure names no layer.
    const failed = await handler(f.job(small.id, modeA), f.context("x".repeat(100))).catch(
      (e) => e,
    );
    expect(failed).toMatchObject({ code: "capacity_exceeded" });
    expect(failed.layer).toBeUndefined();
  });

  test("stops and writes nothing more once aborted", async () => {
    const f = fixture();
    const source = await f.addImage();
    const abort = new AbortController();
    const handler = createExperimentHandler({
      ...f,
      // Aborts right after the first variant was stored and reported.
      progress: {
        put: async (_id, p) => {
          if (p.done === 1) abort.abort(new JobError("timeout"));
        },
      },
      log: silent,
    });
    await expect(
      handler(f.job(source.id, modeA), f.context(SECRET, abort.signal)),
    ).rejects.toBeDefined();
    const stored = await f.images.listExpired(new Date(Date.now() + 1e9), 100);
    expect(stored).toHaveLength(1);
  });

  test("does not read a variant as the cover", async () => {
    const f = fixture();
    const source = await f.addImage();
    const stored = await createExperimentHandler({ ...f, log: silent })(
      f.job(source.id, { ...modeA, scenarios: [[]] }),
      f.context(),
    );
    const [variant] = (stored as ExperimentResult).variants;
    expect(
      await code(
        createExperimentHandler({ ...f, log: silent })(
          f.job(variant?.imageId ?? null, modeA),
          f.context(),
        ),
      ),
    ).toBe("source_missing");
  });

  test("goes on without a stored image when the user is over the variant cap", async () => {
    const f = fixture();
    const source = await f.addImage();
    const removed: string[] = [];
    let calls = 0;
    const handler = createExperimentHandler({
      ...f,
      storage: {
        get: f.storage.get,
        put: f.storage.put,
        delete: async (key) => {
          removed.push(key);
          await f.storage.delete(key);
        },
      },
      images: {
        findOwned: f.images.findOwned,
        // The second image does not fit the cap.
        createVariant: async (image, options) =>
          ++calls === 2 ? null : f.images.createVariant(image, options),
      },
      log: silent,
    });
    const params: ExperimentParams = {
      mode: "B",
      methods: [MethodSelection.parse({ id: "lsb" })],
      scenarios: [[], [{ type: "blur", sigma: 1 }], [{ type: "jpeg", quality: 75 }]],
    };
    const result = (await handler(f.job(source.id, params), f.context())) as ExperimentResult;
    expect(result.variants.map((v) => v.imageId === null)).toEqual([false, true, false]);
    expect(result.variants.every((v) => typeof v.success === "boolean")).toBe(true);
    expect(removed).toHaveLength(1);
  });

  test("removes the stored object when its row cannot be written", async () => {
    const f = fixture();
    const source = await f.addImage();
    const stored: string[] = [];
    const removed: string[] = [];
    const handler = createExperimentHandler({
      ...f,
      storage: {
        get: f.storage.get,
        put: async (key, bytes) => {
          stored.push(key);
          await f.storage.put(key, bytes);
        },
        delete: async (key) => {
          removed.push(key);
          await f.storage.delete(key);
        },
      },
      images: {
        ...f.images,
        findOwned: f.images.findOwned,
        createVariant: async () => {
          throw new Error("database down");
        },
      },
      log: silent,
    });
    const params: ExperimentParams = { ...modeA, scenarios: [[]] };
    await expect(handler(f.job(source.id, params), f.context())).rejects.toThrow("database down");
    expect(stored).toHaveLength(1);
    expect(removed).toEqual(stored);
  });
});
