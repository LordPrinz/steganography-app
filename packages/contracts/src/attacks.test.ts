import { describe, expect, test } from "bun:test";
import { Scenario } from "./attacks.ts";

describe("Scenario", () => {
  test("survives a JSON round trip", () => {
    const scenario: Scenario = [
      { type: "resize", scale: 0.5 },
      { type: "jpeg", quality: 75 },
      { type: "blur", sigma: 1.2 },
    ];
    expect(Scenario.parse(JSON.parse(JSON.stringify(scenario)))).toEqual(scenario);
  });

  test("accepts the empty baseline", () => {
    expect(Scenario.parse([])).toEqual([]);
  });

  test.each([
    { type: "jpeg", quality: 0 },
    { type: "jpeg", quality: 75.5 },
    { type: "resize", scale: 0.05 },
    { type: "resize", scale: 1.5 },
    { type: "blur", sigma: 0 },
    { type: "blur", sigma: 11 },
    { type: "rotate", degrees: 90 },
  ])("rejects %p", (attack) => {
    expect(Scenario.safeParse([attack]).success).toBe(false);
  });

  test("rejects more than 8 attacks", () => {
    expect(Scenario.safeParse(Array(9).fill({ type: "blur", sigma: 1 })).success).toBe(false);
  });
});
