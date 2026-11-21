import { describe, expect, test } from "bun:test";
import { parseCli, resolvePlan } from "../src/args.ts";
import { parseMethod } from "../src/methods.ts";
import { parsePayload } from "../src/payloads.ts";
import { parseScenario } from "../src/scenarios.ts";

describe("parseCli", () => {
  test("separates images from repeated options", () => {
    const options = parseCli([
      "a.png",
      "--method",
      "lsb",
      "--method",
      "dwtQim:step=48",
      "dir",
      "--scenario=jpeg75",
      "--csv",
      "out.csv",
    ]);
    expect(options.images).toEqual(["a.png", "dir"]);
    expect(options.methods).toEqual(["lsb", "dwtQim:step=48"]);
    expect(options.scenarios).toEqual(["jpeg75"]);
    expect(options.csv).toBe("out.csv");
    expect(options.help).toBe(false);
  });

  test("rejects an unknown flag", () => {
    expect(() => parseCli(["--nope"])).toThrow();
  });
});

describe("parseMethod", () => {
  test("fills in the defaults and labels the parameters", () => {
    expect(parseMethod("lsb").params).toBe("bits=1");
    expect(parseMethod("kochZhao").params).toBe("(3,2) vs (2,3) P=40");
    expect(parseMethod("dwtQim").params).toBe("LL L2 step=32");
  });

  test("reads key=value pairs and the error-correcting code", () => {
    expect(parseMethod("lsb:bitsPerChannel=3").params).toBe("bits=3");
    expect(parseMethod("kochZhao:pair=4334,strength=50").params).toBe("(4,3) vs (3,4) P=50");
    const coded = parseMethod("lsb:ecc=repetition:3");
    expect(coded.params).toBe("bits=1, ecc=repetition:3");
    expect(coded.method.capacityBits(10, 10)).toBe(Math.floor(300 / 3));
  });

  test.each([
    "nope",
    "lsb:bitsPerChannel=9",
    "lsb:colour=red",
    "lsb:bitsPerChannel",
    "kochZhao:pair=99",
    "dwtQim:band=HH",
    "lsb:ecc=nope",
  ])("rejects %p", (spec) => {
    expect(() => parseMethod(spec)).toThrow();
  });
});

describe("parseScenario", () => {
  test("parses none, single attacks and combinations in order", () => {
    expect(parseScenario("none").attacks).toEqual([]);
    expect(parseScenario("jpeg75").attacks).toEqual([{ type: "jpeg", quality: 75 }]);
    expect(parseScenario("resize0.5+blur1.5+jpeg50").attacks).toEqual([
      { type: "resize", scale: 0.5 },
      { type: "blur", sigma: 1.5 },
      { type: "jpeg", quality: 50 },
    ]);
  });

  test.each(["", "jpeg", "rotate90", "jpeg101", "resize2", "jpeg75+"])("rejects %p", (spec) => {
    expect(() => parseScenario(spec)).toThrow();
  });
});

describe("parsePayload", () => {
  test("accepts the three kinds and rejects the rest", () => {
    for (const spec of ["message", "message:10", "fill", "bits:128"]) {
      expect(() => parsePayload(spec)).not.toThrow();
    }
    for (const spec of ["nope", "message:0", "message:x"]) {
      expect(() => parsePayload(spec)).toThrow();
    }
  });
});

describe("resolvePlan", () => {
  test("needs images or a preset", async () => {
    await expect(resolvePlan(parseCli([]))).rejects.toThrow("at least one image");
    await expect(resolvePlan(parseCli(["--preset", "nope"]))).rejects.toThrow("unknown preset");
  });

  test("a preset supplies what the options leave out", async () => {
    const plan = await resolvePlan(parseCli(["--preset", "koch-zhao", "--method", "lsb"]));
    expect(plan.methods.map((m) => m.name)).toEqual(["lsb"]);
    expect(plan.scenarios.map((s) => s.label)).toEqual(["jpeg90", "jpeg75", "jpeg50"]);
    expect(plan.covers.length).toBe(4);
  });
});
