import { CapacityExceededError, psnr, ssim } from "@stego/engine";
import { applyScenario } from "@stego/image-io";
import type { Cover } from "./covers.ts";
import type { BenchMethod } from "./methods.ts";
import type { Payload } from "./payloads.ts";
import type { BenchScenario } from "./scenarios.ts";

export interface BenchRow {
  readonly image: string;
  /** Spec of the method, to select rows without relying on the display label. */
  readonly spec: string;
  readonly method: string;
  readonly params: string;
  readonly attack: string;
  readonly success: boolean;
  readonly ber: number;
  /** Quality of the stego image against the cover, before any attack. */
  readonly psnr: number;
  readonly ssim: number;
  /** Milliseconds to embed, attack and decode this row. */
  readonly timeMs: number;
}

export interface BenchPlan {
  readonly covers: readonly Cover[];
  readonly methods: readonly BenchMethod[];
  readonly scenarios: readonly BenchScenario[];
  readonly payload: Payload;
  /** Hide one message per method in the same image, instead of one image per method. */
  readonly layered?: boolean;
}

/**
 * Runs every cover x method x scenario with the same engine and image-io code as the worker. A
 * cover the payload does not fit is skipped and reported to `onSkip`. A layered plan hides all
 * methods in one image per cover and gives one row per layer and scenario.
 */
export async function runBench(
  { covers, methods, scenarios, payload, layered }: BenchPlan,
  onSkip: (message: string) => void = () => {},
): Promise<BenchRow[]> {
  const rows: BenchRow[] = [];
  if (layered) {
    if (!payload.embedLayers) throw new Error("layered runs need a message payload");
    for (const cover of covers) {
      const started = performance.now();
      let embedded: ReturnType<NonNullable<Payload["embedLayers"]>>;
      try {
        embedded = payload.embedLayers(
          cover.image,
          methods.map((m) => m.method),
        );
      } catch (error) {
        if (!(error instanceof CapacityExceededError)) throw error;
        const layer = methods[error.layer ?? 0];
        onSkip(`${cover.name}: ${layer?.name} ${layer?.params} skipped, the message does not fit`);
        continue;
      }
      const embedMs = performance.now() - started;
      const quality = {
        psnr: psnr(cover.image, embedded.stego),
        ssim: ssim(cover.image, embedded.stego),
      };
      for (const scenario of scenarios) {
        const attackStarted = performance.now();
        const attacked = await applyScenario(embedded.stego, scenario.attacks);
        const results = embedded.evaluate(attacked);
        const timeMs = embedMs + performance.now() - attackStarted;
        methods.forEach(({ spec, name, params }, layer) => {
          rows.push({
            image: cover.name,
            spec,
            method: name,
            params,
            attack: scenario.label,
            success: results[layer]?.success ?? false,
            ber: results[layer]?.ber ?? 1,
            ...quality,
            timeMs,
          });
        });
      }
    }
    return rows;
  }
  for (const cover of covers) {
    for (const { spec, name, params, method } of methods) {
      const started = performance.now();
      let embedded: ReturnType<Payload["embed"]>;
      try {
        embedded = payload.embed(cover.image, method);
      } catch (error) {
        if (!(error instanceof CapacityExceededError)) throw error;
        onSkip(`${cover.name}: ${name} ${params} skipped, the message does not fit`);
        continue;
      }
      const embedMs = performance.now() - started;
      const quality = {
        psnr: psnr(cover.image, embedded.stego),
        ssim: ssim(cover.image, embedded.stego),
      };
      for (const scenario of scenarios) {
        const attackStarted = performance.now();
        const attacked = await applyScenario(embedded.stego, scenario.attacks);
        const { success, ber } = embedded.evaluate(attacked);
        rows.push({
          image: cover.name,
          spec,
          method: name,
          params,
          attack: scenario.label,
          success,
          ber,
          ...quality,
          timeMs: embedMs + performance.now() - attackStarted,
        });
      }
    }
  }
  return rows;
}
