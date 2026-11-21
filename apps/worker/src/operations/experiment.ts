import {
  EXPERIMENT_MAX_PIXELS,
  EXPERIMENT_MIN_SIDE,
  type ExperimentMethodSummary,
  ExperimentParams,
  type ExperimentResult,
  type ExperimentVariant,
  MAX_PNG_BYTES,
  MAX_USER_VARIANT_BYTES,
  scenarioLabel,
} from "@stego/contracts";
import { type ImageRepository, JobError } from "@stego/db";
import {
  CapacityExceededError,
  capacity,
  createMethod,
  hide,
  MAX_MESSAGE_BYTES,
  measure,
  psnr,
  ssim,
} from "@stego/engine";
import { applyScenario, encodePng, type RgbaImage } from "@stego/image-io";
import type { ProgressStore } from "@stego/kv";
import { newImageKey, type ObjectStore } from "@stego/storage";
import type { JobHandler } from "../handlers.ts";
import { aggregateVariants } from "./aggregate.ts";
import { loadSource } from "./source.ts";

/** How long an attacked image stays available after the experiment. */
export const VARIANT_TTL_MS = 24 * 60 * 60_000;

export interface ExperimentDeps {
  images: Pick<ImageRepository, "findOwned" | "createVariant">;
  storage: Pick<ObjectStore, "get" | "put" | "delete">;
  progress: Pick<ProgressStore, "put">;
  variantTtlMs?: number;
  log?: Pick<Console, "error">;
}

/** A finite dB value, or null where PSNR is infinite (JSON has no Infinity). */
const finiteOrNull = (value: number) => (Number.isFinite(value) ? value : null);

/**
 * Hides the message with each method, attacks the stego image with each scenario, and records whether
 * and how well it reads back. Every attacked image is stored as an expiring `variant` of the owner.
 * The result keeps metrics only; the message stays out of it.
 */
export function createExperimentHandler({
  images,
  storage,
  progress,
  variantTtlMs = VARIANT_TTL_MS,
  log = console,
}: ExperimentDeps): JobHandler {
  /**
   * Stores the PNG and its row; undoes the object when the row cannot be written. Null when the user's
   * live variants would pass the cap: the experiment goes on without that image.
   */
  async function storeVariant(
    userId: string,
    attacked: { width: number; height: number },
    png: Uint8Array,
  ): Promise<string | null> {
    const key = newImageKey(userId);
    await storage.put(key, png);
    try {
      const row = await images.createVariant(
        {
          userId,
          storageKey: key,
          format: "png",
          width: attacked.width,
          height: attacked.height,
          sizeBytes: png.byteLength,
          sha256: new Bun.CryptoHasher("sha256").update(png).digest("hex"),
        },
        { ttlMs: variantTtlMs, maxBytes: MAX_USER_VARIANT_BYTES },
      );
      if (!row) {
        await discard(key);
        return null;
      }
      return row.id;
    } catch (error) {
      await discard(key);
      throw error;
    }
  }

  async function discard(key: string) {
    await storage.delete(key).catch((cleanup) => {
      log.error("Could not remove an object whose row was not saved", key, cleanup);
    });
  }

  async function report(operationId: string, done: number, total: number) {
    // The report is a convenience: a Redis hiccup must not fail the job.
    await progress.put(operationId, { done, total }).catch((error) => {
      log.error("Could not report experiment progress", error);
    });
  }

  return async ({ operation }, context) => {
    const params = ExperimentParams.safeParse(operation.params);
    if (!params.success) throw new JobError("invalid_params");
    const { mode, methods: selections, scenarios } = params.data;
    const methods = selections.map((selection) => {
      try {
        return { selection, method: createMethod(selection) };
      } catch (error) {
        if (error instanceof RangeError) throw new JobError("invalid_params", { cause: error });
        throw error;
      }
    });

    const message = await context.message();
    const cover = await loadSource({ images, storage }, operation);
    if (cover.width * cover.height > EXPERIMENT_MAX_PIXELS) throw new JobError("image_too_large");
    if (Math.min(cover.width, cover.height) < EXPERIMENT_MIN_SIDE)
      throw new JobError("image_too_small");

    const total = methods.length * scenarios.length;
    let done = 0;
    await report(operation.id, done, total);

    const summaries: ExperimentMethodSummary[] = [];
    const variants: ExperimentVariant[] = [];
    for (const { selection, method } of methods) {
      context.signal.throwIfAborted();
      const ecc = selection.ecc?.code ?? null;
      const embedStarted = performance.now();
      let stego: RgbaImage;
      try {
        stego = hide(cover, message, method);
      } catch (error) {
        if (error instanceof CapacityExceededError) throw new JobError("capacity_exceeded");
        throw error;
      }
      summaries.push({
        method: selection.id,
        ecc,
        capacityBytes: Math.min(capacity(cover.width, cover.height, method), MAX_MESSAGE_BYTES),
        stegoPsnr: finiteOrNull(psnr(cover, stego)),
        stegoSsim: ssim(cover, stego),
        encodeMs: Math.round(performance.now() - embedStarted),
      });

      for (const scenario of scenarios) {
        // Nothing is written once the job was aborted: the worker has moved on.
        context.signal.throwIfAborted();
        const started = performance.now();
        const attacked = await applyScenario(stego, scenario);
        const measured = measure(attacked, message, method);
        const timeMs = Math.round(performance.now() - started);
        const png = await encodePng(attacked);
        context.signal.throwIfAborted();
        const imageId =
          png.byteLength > MAX_PNG_BYTES
            ? null
            : await storeVariant(operation.user_id, attacked, png);
        variants.push({
          method: selection.id,
          ecc,
          scenario,
          label: scenarioLabel(scenario),
          success: measured.ok,
          ber: measured.ber,
          channelBer: measured.channelBer ?? null,
          psnr: finiteOrNull(psnr(cover, attacked)),
          ssim: ssim(cover, attacked),
          timeMs,
          imageId,
        });
        await report(operation.id, ++done, total);
      }
    }

    const result: ExperimentResult = {
      kind: "experiment",
      mode,
      messageBytes: new TextEncoder().encode(message).byteLength,
      methods: summaries,
      variants,
      aggregates: aggregateVariants(variants),
    };
    return result;
  };
}
