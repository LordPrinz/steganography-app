import { describe, expect, test } from "bun:test";
import { CapacityExceededError, capacity, reveal } from "./codec.ts";
import { capacityLayered, hideLayered, type Layer, LayerConflictError } from "./layered.ts";
import { dwtQim } from "./methods/dwt-qim.ts";
import { kochZhao } from "./methods/koch-zhao.ts";
import { lsb } from "./methods/lsb.ts";
import { noiseImage } from "./testing/images.ts";
import { type ConfiguredMethod, MethodId } from "./types.ts";

const dct = kochZhao();
const dwt = dwtQim({ band: "LL", level: 2, step: 64 });
const bits = lsb({ bitsPerChannel: 1 });
const cover = noiseImage(256, 192);

const layers: Layer[] = [
  { method: bits, message: "hidden in the low bits" },
  { method: dct, message: "hidden in DCT blocks" },
  { method: dwt, message: "zażółć gęślą 🔒" },
];

function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
}

describe("hideLayered", () => {
  test("every layer reveals its own message", () => {
    const stego = hideLayered(cover, layers);
    for (const { method, message } of layers) {
      expect(reveal(stego, method)).toEqual({ ok: true, message });
    }
  });

  test("layers are embedded in a fixed order, whatever order they are given in", () => {
    const forward = hideLayered(cover, layers);
    const backward = hideLayered(cover, [...layers].reverse());
    expect(backward.data).toEqual(forward.data);
  });

  test("works with a subset of the methods", () => {
    const pair = layers.slice(1);
    const stego = hideLayered(cover, pair);
    for (const { method, message } of pair) {
      expect(reveal(stego, method)).toEqual({ ok: true, message });
    }
    expect(reveal(stego, bits).ok).toBe(false);
  });

  test("does not mutate the cover", () => {
    const before = new Uint8ClampedArray(cover.data);
    hideLayered(cover, layers);
    expect(cover.data).toEqual(before);
  });

  test("a message that does not fit throws CapacityExceededError naming the layer", () => {
    const available = capacity(cover.width, cover.height, dct);
    const error = thrownBy(() =>
      hideLayered(cover, [
        { method: bits, message: "ok" },
        { method: dct, message: "x".repeat(available + 1) },
      ]),
    );
    expect(error).toBeInstanceOf(CapacityExceededError);
    expect((error as CapacityExceededError).layer).toBe(1);
    expect((error as CapacityExceededError).available).toBe(available);
  });

  test("two layers with the same method are rejected", () => {
    expect(() =>
      hideLayered(cover, [
        { method: bits, message: "a" },
        { method: lsb({ bitsPerChannel: 2 }), message: "b" },
      ]),
    ).toThrow(RangeError);
  });

  test("layers that overwrite each other throw LayerConflictError naming the layer", () => {
    // Embeds like LSB but claims the DWT id, so it runs first and the real LSB layer wipes it.
    const disguised: ConfiguredMethod = { ...bits, id: MethodId.DwtQim };
    const error = thrownBy(() =>
      hideLayered(cover, [
        { method: bits, message: "last" },
        { method: disguised, message: "first" },
      ]),
    );
    expect(error).toBeInstanceOf(LayerConflictError);
    expect((error as LayerConflictError).layer).toBe(1);
  });

  test("every layer filled to its capacity still reveals", () => {
    const filled = [dct, dwt, bits].map((method) => ({
      method,
      message: "y".repeat(capacity(cover.width, cover.height, method)),
    }));
    const stego = hideLayered(cover, filled);
    for (const { method, message } of filled) {
      expect(reveal(stego, method)).toEqual({ ok: true, message });
    }
  });
});

describe("capacityLayered", () => {
  test("reports each method's own capacity in the given order", () => {
    expect(capacityLayered(cover.width, cover.height, [dwt, bits, dct])).toEqual([
      capacity(cover.width, cover.height, dwt),
      capacity(cover.width, cover.height, bits),
      capacity(cover.width, cover.height, dct),
    ]);
  });
});
