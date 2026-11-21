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
}

/**
 * Runs every cover x method x scenario with the same engine and image-io code as the worker. A
 * cover the payload does not fit is skipped and reported to `onSkip`.
 */
export async function runBench(
  { covers, methods, scenarios, payload }: BenchPlan,
  onSkip: (message: string) => void = () => {},
): Promise<BenchRow[]> {
  const rows: BenchRow[] = [];
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
