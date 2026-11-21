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
  type ConfiguredMethod,
  capacityLayered,
  MAX_MESSAGE_BYTES,
  measure,
  psnr,
  ssim,
} from "@stego/engine";
import { applyScenario, encodePng } from "@stego/image-io";
import type { ProgressStore } from "@stego/kv";
import { newImageKey, type ObjectStore } from "@stego/storage";
import type { JobHandler } from "../handlers.ts";
import { aggregateVariants } from "./aggregate.ts";
import { buildMethods, hideAll } from "./layers.ts";
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
    const built = buildMethods(selections);

    const messages = await context.messages();
    // Modes A and B hide the one message with each method; layered hides one message per layer.
    if (messages.length !== (mode === "layered" ? built.length : 1)) {
      throw new JobError("invalid_params");
    }
    const cover = await loadSource({ images, storage }, operation);
    if (cover.width * cover.height > EXPERIMENT_MAX_PIXELS) throw new JobError("image_too_large");
    if (Math.min(cover.width, cover.height) < EXPERIMENT_MIN_SIDE)
      throw new JobError("image_too_small");

    // Each group is embedded once and attacked per scenario: one method for A and B, all layers together
    // for layered.
    const layers = selections.map((selection, index) => ({
      selection,
      method: built[index] as ConfiguredMethod,
      message: messages[mode === "layered" ? index : 0] as string,
    }));
    const groups = mode === "layered" ? [layers] : layers.map((layer) => [layer]);

    const total = layers.length * scenarios.length;
    let done = 0;
    await report(operation.id, done, total);

    const summaries: ExperimentMethodSummary[] = [];
    const variants: ExperimentVariant[] = [];
    for (const group of groups) {
      context.signal.throwIfAborted();
      const embedStarted = performance.now();
      const stego = hideAll(
        cover,
        group.map(({ method }) => method),
        group.map(({ message }) => message),
        // Modes A and B hide one message with one method: there is no layer to name.
        { reportLayer: mode === "layered" },
      );
      const wholeImage = {
        stegoPsnr: finiteOrNull(psnr(cover, stego)),
        stegoSsim: ssim(cover, stego),
        encodeMs: Math.round(performance.now() - embedStarted),
      };
      const capacities = capacityLayered(
        cover.width,
        cover.height,
        group.map(({ method }) => method),
      );
      group.forEach(({ selection }, index) => {
        summaries.push({
          method: selection.id,
          ecc: selection.ecc?.code ?? null,
          capacityBytes: Math.min(capacities[index] as number, MAX_MESSAGE_BYTES),
          ...wholeImage,
        });
      });

      for (const scenario of scenarios) {
        // Nothing is written once the job was aborted: the worker has moved on.
        context.signal.throwIfAborted();
        const attackStarted = performance.now();
        const attacked = await applyScenario(stego, scenario);
        const attackMs = performance.now() - attackStarted;
        const png = await encodePng(attacked);
        context.signal.throwIfAborted();
        // One stored image per scenario, shared by every layer.
        const imageId =
          png.byteLength > MAX_PNG_BYTES
            ? null
            : await storeVariant(operation.user_id, attacked, png);
        const attackedPsnr = finiteOrNull(psnr(cover, attacked));
        const attackedSsim = ssim(cover, attacked);
        for (const { selection, method, message } of group) {
          const measureStarted = performance.now();
          const measured = measure(attacked, message, method);
          variants.push({
            method: selection.id,
            ecc: selection.ecc?.code ?? null,
            scenario,
            label: scenarioLabel(scenario),
            success: measured.ok,
            ber: measured.ber,
            channelBer: measured.channelBer ?? null,
            psnr: attackedPsnr,
            ssim: attackedSsim,
            timeMs: Math.round(attackMs + performance.now() - measureStarted),
            imageId,
          });
          await report(operation.id, ++done, total);
        }
      }
    }

    const result: ExperimentResult = {
      kind: "experiment",
      mode,
      messageBytes: messages.reduce(
        (sum, message) => sum + new TextEncoder().encode(message).byteLength,
        0,
      ),
      methods: summaries,
      variants,
      aggregates: aggregateVariants(variants),
    };
    return result;
  };
}
