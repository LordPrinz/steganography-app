import { describe, expect, test } from "bun:test";
import { StegoMethod } from "./methods.ts";
import { DecodeRequest, EncodeRequest, EncodeResult } from "./operations.ts";
import { AUTO_SELECTIONS, MethodSelection } from "./selections.ts";

const imageId = crypto.randomUUID();

describe("method selection", () => {
  test("fills in the documented defaults", () => {
    expect(MethodSelection.parse({ id: "lsb" })).toEqual({
      id: "lsb",
      params: { bitsPerChannel: 1 },
    });
    expect(MethodSelection.parse({ id: "dwt-qim" }).params).toEqual({
      band: "LL",
      level: 2,
      step: 32,
    });
    expect(MethodSelection.parse({ id: "dct-koch-zhao" }).params).toEqual({
      pair: [
        [3, 2],
        [2, 3],
      ],
      strength: 40,
    });
  });

  test("auto covers every method once", () => {
    expect(AUTO_SELECTIONS.map((selection) => selection.id)).toEqual([...StegoMethod.options]);
  });

  test("rejects out-of-range and unknown parameters", () => {
    for (const bad of [
      { id: "lsb", params: { bitsPerChannel: 9 } },
      { id: "lsb", params: { bitsPerChannel: 1.5 } },
      { id: "lsb", params: { depth: 1 } },
      { id: "dct-koch-zhao", params: { strength: 0 } },
      { id: "dct-koch-zhao", params: { strength: 1025 } },
      {
        id: "dct-koch-zhao",
        params: {
          pair: [
            [3, 8],
            [2, 3],
          ],
        },
      },
      { id: "dwt-qim", params: { band: "HH" } },
      { id: "dwt-qim", params: { level: 9 } },
      { id: "dwt-qim", params: { step: 256 } },
      { id: "lsb", ecc: { code: "repetition", factor: 2 } },
      { id: "lsb", ecc: { code: "repetition", factor: 17 } },
      { id: "lsb", ecc: { code: "hamming74", factor: 3 } },
      { id: "lsb", ecc: { code: "turbo" } },
    ]) {
      expect(MethodSelection.safeParse(bad).success).toBe(false);
    }
  });
});

describe("requests", () => {
  const layer = (id: string, message = "hi") => ({ method: { id }, message });

  test("encode takes one to three layers, each with its own method and a non-empty message", () => {
    const ok = { imageId, layers: [layer("lsb")] };
    expect(EncodeRequest.safeParse(ok).success).toBe(true);
    const three = [layer("lsb", "a"), layer("dwt-qim", "b"), layer("dct-koch-zhao", "c")];
    expect(EncodeRequest.parse({ imageId, layers: three }).layers.map((l) => l.message)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(EncodeRequest.safeParse({ ...ok, layers: [] }).success).toBe(false);
    expect(EncodeRequest.safeParse({ ...ok, layers: [layer("lsb", "")] }).success).toBe(false);
    expect(EncodeRequest.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    // The message moved into the layers.
    expect(EncodeRequest.safeParse({ ...ok, message: "hi" }).success).toBe(false);
    expect(EncodeRequest.safeParse({ imageId, layers: [{ id: "lsb" }] }).success).toBe(false);
  });

  test("layers must use different methods, an error-correcting code does not make one different", () => {
    expect(
      EncodeRequest.safeParse({ imageId, layers: [layer("lsb"), layer("lsb", "x")] }).success,
    ).toBe(false);
    const withCode = { method: { id: "lsb", ecc: { code: "hamming74" } }, message: "x" };
    expect(EncodeRequest.safeParse({ imageId, layers: [layer("lsb"), withCode] }).success).toBe(
      false,
    );
    expect(
      EncodeRequest.safeParse({
        imageId,
        layers: [...three4(), layer("lsb", "d")],
      }).success,
    ).toBe(false);
  });

  function three4() {
    return [layer("lsb"), layer("dwt-qim"), layer("dct-koch-zhao")];
  }

  test("decode takes a list of up to three methods with different ids", () => {
    const sel = (id: string) => ({ id });
    expect(DecodeRequest.safeParse({ imageId, method: [sel("lsb")] }).success).toBe(true);
    expect(
      DecodeRequest.safeParse({
        imageId,
        method: [sel("lsb"), { id: "dwt-qim", ecc: { code: "hamming74" } }, sel("dct-koch-zhao")],
      }).success,
    ).toBe(true);
    for (const method of [
      [],
      [sel("lsb"), { id: "lsb", ecc: { code: "hamming74" } }],
      [sel("lsb"), sel("dwt-qim"), sel("dct-koch-zhao"), sel("lsb")],
      ["auto"],
    ]) {
      expect(DecodeRequest.safeParse({ imageId, method }).success).toBe(false);
    }
  });

  test("decode takes one method or auto", () => {
    expect(DecodeRequest.safeParse({ imageId, method: "auto" }).success).toBe(true);
    expect(DecodeRequest.safeParse({ imageId, method: { id: "dwt-qim" } }).success).toBe(true);
    expect(DecodeRequest.safeParse({ imageId, method: "lsb" }).success).toBe(false);
  });
});

describe("results", () => {
  test("a PSNR of null (identical images) survives JSON", () => {
    const result = {
      kind: "encode",
      layers: [{ method: "lsb", messageBytes: 3, capacityBytes: 10 }],
      psnr: null,
      ssim: null,
      encodeMs: 4,
    };
    expect(EncodeResult.parse(JSON.parse(JSON.stringify(result)))).toEqual(result as never);
    expect(JSON.parse(JSON.stringify({ psnr: Number.POSITIVE_INFINITY })).psnr).toBeNull();
  });
});
