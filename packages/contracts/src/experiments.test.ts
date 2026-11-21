import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SCENARIOS,
  EXPERIMENT_MAX_PIXELS,
  ExperimentParams,
  ExperimentRequest,
  MAX_EXPERIMENT_VARIANTS,
  MAX_MODE_B_SCENARIOS,
  scenarioLabel,
} from "./experiments.ts";
import { StegoMethod } from "./methods.ts";
import { OperationResult, OperationType } from "./operations.ts";
import { AUTO_SELECTIONS } from "./selections.ts";

const imageId = crypto.randomUUID();

describe("scenario labels", () => {
  test("spell none, single and combined attacks like the bench", () => {
    expect(scenarioLabel([])).toBe("none");
    expect(scenarioLabel([{ type: "jpeg", quality: 75 }])).toBe("jpeg75");
    expect(scenarioLabel([{ type: "blur", sigma: 1.5 }])).toBe("blur1.5");
    expect(
      scenarioLabel([
        { type: "resize", scale: 0.5 },
        { type: "jpeg", quality: 75 },
      ]),
    ).toBe("resize0.5+jpeg75");
  });

  test("the defaults have distinct labels and fill mode A within the variant cap", () => {
    const labels = DEFAULT_SCENARIOS.map(scenarioLabel);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toHaveLength(11);
    expect(labels.length * StegoMethod.options.length).toBeLessThanOrEqual(MAX_EXPERIMENT_VARIANTS);
    expect(AUTO_SELECTIONS.length * DEFAULT_SCENARIOS.length).toBeLessThanOrEqual(
      MAX_EXPERIMENT_VARIANTS,
    );
  });

  test("limits", () => {
    expect(EXPERIMENT_MAX_PIXELS).toBe(1024 * 1024);
  });
});

describe("experiment request", () => {
  test("mode A takes only an image and a message", () => {
    expect(ExperimentRequest.parse({ mode: "A", imageId, message: "hi" }).mode).toBe("A");
    expect(
      ExperimentRequest.safeParse({ mode: "A", imageId, message: "hi", method: { id: "lsb" } })
        .success,
    ).toBe(false);
  });

  test("mode B fills in method defaults and keeps the code next to the method", () => {
    const request = ExperimentRequest.parse({
      mode: "B",
      imageId,
      message: "hi",
      method: { id: "lsb", ecc: { code: "hamming74" } },
      scenarios: [[], [{ type: "jpeg", quality: 60 }]],
    });
    expect(request).toMatchObject({
      method: { id: "lsb", params: { bitsPerChannel: 1 }, ecc: { code: "hamming74" } },
    });
  });

  test("rejects a bad mode, an empty message and bad scenario lists", () => {
    const base = { imageId, message: "hi", method: { id: "lsb" }, scenarios: [[]] };
    for (const body of [
      { ...base, mode: "C" },
      { ...base, mode: "B", message: "" },
      { ...base, mode: "B", scenarios: [] },
      { ...base, mode: "B", scenarios: Array.from({ length: MAX_MODE_B_SCENARIOS + 1 }, () => []) },
      { ...base, mode: "B", scenarios: [[{ type: "jpeg", quality: 0 }]] },
      {
        ...base,
        mode: "B",
        scenarios: Array.from({ length: 7 }, () =>
          Array.from({ length: 8 }, () => ({ type: "blur", sigma: 1 })),
        ),
      },
      { ...base, mode: "B", method: undefined },
      { mode: "A", imageId: "nope", message: "hi" },
    ]) {
      expect(ExperimentRequest.safeParse(body).success).toBe(false);
    }
  });
});

describe("experiment params and result", () => {
  test("params hold no message", () => {
    const params = ExperimentParams.parse({
      mode: "A",
      methods: [{ id: "lsb" }],
      scenarios: [[]],
      message: "leaked",
    });
    expect(JSON.stringify(params)).not.toContain("leaked");
  });

  test("an experiment is an operation type and result kind", () => {
    expect(OperationType.parse("experiment")).toBe("experiment");
    expect(
      OperationResult.parse({
        kind: "experiment",
        mode: "A",
        messageBytes: 2,
        methods: [],
        variants: [],
        aggregates: [],
      }).kind,
    ).toBe("experiment");
  });
});
