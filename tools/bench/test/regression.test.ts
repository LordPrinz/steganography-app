import { describe, expect, test } from "bun:test";
import { parseCli, resolvePlan } from "../src/args.ts";
import { type BenchRow, runBench } from "../src/run.ts";

/** Mean BER over the images of the one method/attack pair in `rows`. */
function meanBer(rows: readonly BenchRow[], params: string, attack: string): number {
  const own = rows.filter((r) => r.params === params && r.attack === attack);
  return own.reduce((sum, r) => sum + r.ber, 0) / own.length;
}

async function run(args: string[]): Promise<BenchRow[]> {
  return runBench(await resolvePlan(parseCli(args)));
}

// Thresholds from the ADR tables. A change that breaks one has changed what a method survives.
describe("Koch-Zhao on natural images (ADR 7)", () => {
  test("the defaults carry a message through JPEG 75 without a flipped bit", async () => {
    const rows = await run([
      "--preset",
      "koch-zhao",
      "--method",
      "kochZhao",
      "--scenario",
      "none",
      "--scenario",
      "jpeg75",
      "--payload",
      "message:32",
    ]);
    expect(rows).toHaveLength(8);
    expect(rows.every((r) => r.success && r.ber === 0)).toBe(true);
  });

  test("with Hamming(7,4) the defaults survive JPEG 50", async () => {
    const rows = await run([
      "--preset",
      "koch-zhao",
      "--method",
      "kochZhao:ecc=hamming74",
      "--scenario",
      "jpeg50",
      "--payload",
      "message:32",
    ]);
    expect(rows.every((r) => r.success)).toBe(true);
  });

  test("the strength decides survival: P = 10 loses clearly more bits than the default", async () => {
    const rows = await run([
      "--preset",
      "koch-zhao",
      "--method",
      "kochZhao:strength=10",
      "--method",
      "kochZhao",
      "--scenario",
      "jpeg75",
      "--payload",
      "fill",
    ]);
    const weak = meanBer(rows, "(3,2) vs (2,3) P=10", "jpeg75");
    const strong = meanBer(rows, "(3,2) vs (2,3) P=40", "jpeg75");
    expect(weak).toBeGreaterThan(strong + 0.01);
  });
});

describe("Haar DWT + QIM on generated images (ADR 8)", () => {
  test("LL level 1 step 32 is exact without an attack and after JPEG 90", async () => {
    const rows = await run([
      "--preset",
      "dwt-qim",
      "--method",
      "dwtQim:level=1,step=32",
      "--scenario",
      "none",
      "--scenario",
      "jpeg90",
    ]);
    expect(meanBer(rows, "LL L1 step=32", "none")).toBe(0);
    expect(meanBer(rows, "LL L1 step=32", "jpeg90")).toBeLessThan(0.001);
  });

  test("a larger step survives JPEG 75 better", async () => {
    const rows = await run([
      "--preset",
      "dwt-qim",
      "--method",
      "dwtQim:level=1,step=16",
      "--method",
      "dwtQim:level=1,step=64",
      "--scenario",
      "jpeg75",
    ]);
    expect(meanBer(rows, "LL L1 step=64", "jpeg75")).toBeLessThan(
      meanBer(rows, "LL L1 step=16", "jpeg75"),
    );
  });
});

describe("LSB (ADR 5)", () => {
  test("reveals cleanly without an attack and does not survive JPEG 90", async () => {
    const rows = await run([
      "--preset",
      "koch-zhao",
      "--method",
      "lsb",
      "--scenario",
      "none",
      "--scenario",
      "jpeg90",
      "--payload",
      "message:32",
    ]);
    expect(rows.filter((r) => r.attack === "none").every((r) => r.success)).toBe(true);
    expect(rows.filter((r) => r.attack === "jpeg90").every((r) => !r.success)).toBe(true);
  });
});
