import { describe, expect, test } from "bun:test";
import { StegoMethod } from "./methods.ts";
import {
  AUTO_SELECTIONS,
  DecodeRequest,
  EncodeRequest,
  EncodeResult,
  MethodSelection,
} from "./operations.ts";

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
  test("encode takes exactly one layer and a non-empty message", () => {
    const ok = { imageId, message: "hi", layers: [{ id: "lsb" }] };
    expect(EncodeRequest.safeParse(ok).success).toBe(true);
    expect(EncodeRequest.safeParse({ ...ok, layers: [] }).success).toBe(false);
    expect(EncodeRequest.safeParse({ ...ok, message: "" }).success).toBe(false);
    expect(EncodeRequest.safeParse({ ...ok, extra: 1 }).success).toBe(false);
  });

  test("decode takes one method or auto", () => {
    expect(DecodeRequest.safeParse({ imageId, method: "auto" }).success).toBe(true);
    expect(DecodeRequest.safeParse({ imageId, method: { id: "dwt-qim" } }).success).toBe(true);
    expect(DecodeRequest.safeParse({ imageId, method: "lsb" }).success).toBe(false);
  });
});

describe("results", () => {
  test("a PSNR of null (identical images) survives JSON", () => {
    const result = { kind: "encode", messageBytes: 3, capacityBytes: 10, psnr: null, encodeMs: 4 };
    expect(EncodeResult.parse(JSON.parse(JSON.stringify(result)))).toEqual(result as never);
    expect(JSON.parse(JSON.stringify({ psnr: Number.POSITIVE_INFINITY })).psnr).toBeNull();
  });
});
