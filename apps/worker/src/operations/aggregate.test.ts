import { describe, expect, test } from "bun:test";
import { type ExperimentVariant, scenarioLabel } from "@stego/contracts";
import { aggregateVariants } from "./aggregate.ts";

function variant(overrides: Partial<ExperimentVariant>): ExperimentVariant {
  const scenario = overrides.scenario ?? [];
  return {
    method: "lsb",
    ecc: null,
    scenario,
    label: scenarioLabel(scenario),
    success: true,
    ber: 0,
    channelBer: null,
    psnr: 40,
    ssim: 0.99,
    timeMs: 1,
    imageId: null,
    ...overrides,
  };
}

describe("aggregateVariants", () => {
  test("describes none, single and combined attacks", () => {
    const rows = aggregateVariants([
      variant({ scenario: [] }),
      variant({ scenario: [{ type: "jpeg", quality: 75 }] }),
      variant({ scenario: [{ type: "resize", scale: 0.5 }] }),
      variant({ scenario: [{ type: "blur", sigma: 2 }] }),
      variant({
        scenario: [
          { type: "resize", scale: 0.5 },
          { type: "jpeg", quality: 75 },
        ],
      }),
    ]);
    expect(rows.map(({ attack, strength, label }) => [attack, strength, label])).toEqual([
      ["none", null, "none"],
      ["jpeg", 75, "jpeg75"],
      ["resize", 0.5, "resize0.5"],
      ["blur", 2, "blur2"],
      ["combined", null, "resize0.5+jpeg75"],
    ]);
  });

  test("keeps methods and codes apart and preserves order", () => {
    const rows = aggregateVariants([
      variant({ method: "lsb", success: false, ber: 0.4 }),
      variant({ method: "dwt-qim" }),
      variant({ method: "lsb", ecc: "hamming74" }),
    ]);
    expect(rows.map(({ method, ecc }) => [method, ecc])).toEqual([
      ["lsb", null],
      ["dwt-qim", null],
      ["lsb", "hamming74"],
    ]);
    expect(rows[0]).toMatchObject({ successRate: 0, meanBer: 0.4, variants: 1 });
  });

  test("merges a repeated scenario into success rate and mean BER", () => {
    const jpeg = [{ type: "jpeg", quality: 50 }] as const;
    const [row, ...rest] = aggregateVariants([
      variant({ scenario: [...jpeg], success: true, ber: 0 }),
      variant({ scenario: [...jpeg], success: false, ber: 0.5 }),
    ]);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({ variants: 2, successRate: 0.5, meanBer: 0.25 });
  });

  test("returns nothing for no variants", () => {
    expect(aggregateVariants([])).toEqual([]);
  });
});
