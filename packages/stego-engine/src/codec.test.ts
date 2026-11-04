import { describe, expect, test } from "bun:test";
import { fromBits, toBits } from "./bits.ts";
import { CapacityExceededError, capacity, hide, measure, reveal } from "./codec.ts";
import { encodeFrame, FRAME_HEADER_BYTES, FRAME_OVERHEAD_BYTES } from "./payload/frame.ts";
import { withId } from "./testing/fake-method.ts";
import { noiseImage } from "./testing/images.ts";
import { methodCases } from "./testing/methods.ts";
import { type ConfiguredMethod, MethodId, type RgbaImage } from "./types.ts";

const HEADER_BITS = FRAME_HEADER_BYTES * 8;

/** Flips one frame bit of an image produced by `hide`, using only the method interface. */
function flipFrameBit(cover: RgbaImage, stego: RgbaImage, method: ConfiguredMethod, bit: number) {
  const bits = method.extract(stego, method.capacityBits(stego.width, stego.height));
  bits[bit] = (bits[bit] as number) ^ 1;
  return method.embed(cover, bits);
}

function otherId(method: ConfiguredMethod): MethodId {
  return method.id === MethodId.Lsb ? MethodId.DwtQim : MethodId.Lsb;
}

describe.each(methodCases)("stego codec: $name", ({ method }) => {
  const cover = noiseImage(64, 48);

  describe("hide and reveal", () => {
    test.each([
      ["ASCII", "Meet at noon"],
      ["empty", ""],
      ["non-ASCII", "Zażółć gęślą jaźń 🔒"],
      ["leading BOM", "﻿text"],
    ])("round-trips a %s message", (_, message) => {
      expect(reveal(hide(cover, message, method), method)).toEqual({ ok: true, message });
    });

    test("round-trips a message of exactly the capacity", () => {
      const message = "x".repeat(capacity(cover.width, cover.height, method));
      expect(reveal(hide(cover, message, method), method)).toEqual({ ok: true, message });
    });

    test("does not mutate the cover and keeps its dimensions", () => {
      const before = new Uint8ClampedArray(cover.data);
      const stego = hide(cover, "hello", method);
      expect(cover.data).toEqual(before);
      expect([stego.width, stego.height]).toEqual([cover.width, cover.height]);
    });

    test("embeds the documented frame layout, MSB first", () => {
      const stego = hide(cover, "hi", method);
      const frame = fromBits(method.extract(stego, (FRAME_OVERHEAD_BYTES + 2) * 8));
      expect(Array.from(frame.subarray(0, FRAME_HEADER_BYTES + 2))).toEqual([
        0x53,
        0x47,
        1,
        method.id,
        0,
        0,
        0,
        2,
        0x68,
        0x69,
      ]);
    });
  });

  describe("reveal failures", () => {
    test("a clean image has no message", () => {
      expect(reveal(cover, method)).toEqual({ ok: false, error: "no-message" });
    });

    test("an image too small for a frame header has no message", () => {
      expect(reveal(noiseImage(1, 1), method)).toEqual({ ok: false, error: "no-message" });
    });

    test("a destroyed header means no message", () => {
      const stego = hide(cover, "secret", method);
      expect(reveal(flipFrameBit(cover, stego, method, 0), method)).toEqual({
        ok: false,
        error: "no-message",
      });
    });

    test("a header with an unknown method id means no message", () => {
      const frame = encodeFrame(method.id, new TextEncoder().encode("x"));
      frame[3] = 99;
      expect(reveal(method.embed(cover, toBits(frame)), method)).toEqual({
        ok: false,
        error: "no-message",
      });
    });

    test("a header with an unsupported version means no message", () => {
      const frame = encodeFrame(method.id, new TextEncoder().encode("x"));
      frame[2] = 2;
      expect(reveal(method.embed(cover, toBits(frame)), method)).toEqual({
        ok: false,
        error: "no-message",
      });
    });

    test("a flipped payload bit corrupts the message", () => {
      const stego = hide(cover, "secret", method);
      expect(reveal(flipFrameBit(cover, stego, method, HEADER_BITS + 3), method)).toEqual({
        ok: false,
        error: "corrupted",
      });
    });

    test("a length beyond the capacity corrupts the message", () => {
      const frame = encodeFrame(method.id, new Uint8Array());
      new DataView(frame.buffer).setUint32(4, 0xffff_ffff);
      expect(reveal(method.embed(cover, toBits(frame)), method)).toEqual({
        ok: false,
        error: "corrupted",
      });
    });

    test("a payload that is not UTF-8 corrupts the message", () => {
      const frame = encodeFrame(method.id, Uint8Array.of(0xc3, 0x28));
      expect(reveal(method.embed(cover, toBits(frame)), method)).toEqual({
        ok: false,
        error: "corrupted",
      });
    });

    test("a frame written by another method is a method mismatch", () => {
      const stego = hide(cover, "secret", withId(method, otherId(method)));
      expect(reveal(stego, method)).toEqual({ ok: false, error: "method-mismatch" });
    });
  });

  describe("capacity", () => {
    test("counts message bytes after the frame overhead", () => {
      const bits = method.capacityBits(cover.width, cover.height);
      expect(capacity(cover.width, cover.height, method)).toBe(
        Math.floor(bits / 8) - FRAME_OVERHEAD_BYTES,
      );
    });

    test("is zero when not even a frame fits", () => {
      expect(capacity(1, 1, method)).toBe(0);
    });

    test("counts UTF-8 bytes, not characters", () => {
      const available = capacity(cover.width, cover.height, method);
      const message = "ż".repeat(Math.floor(available / 2) + 1);
      expect(() => hide(cover, message, method)).toThrow(CapacityExceededError);
    });

    test("a message one byte too long throws CapacityExceededError with the sizes", () => {
      const available = capacity(cover.width, cover.height, method);
      let error: unknown;
      try {
        hide(cover, "x".repeat(available + 1), method);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(CapacityExceededError);
      expect(error).toMatchObject({ needed: available + 1, available });
    });

    test("an image too small for any frame rejects even an empty message", () => {
      expect(() => hide(noiseImage(1, 1), "", method)).toThrow(CapacityExceededError);
    });
  });

  describe("measure", () => {
    test("gives BER 0 without an attack", () => {
      const stego = hide(cover, "secret", method);
      expect(measure(stego, "secret", method)).toEqual({ ok: true, ber: 0 });
    });

    test("counts flipped payload bits even when the CRC fails", () => {
      const message = "secret";
      let stego = hide(cover, message, method);
      stego = flipFrameBit(cover, stego, method, HEADER_BITS + 1);
      stego = flipFrameBit(cover, stego, method, HEADER_BITS + 20);
      expect(measure(stego, message, method)).toEqual({
        ok: false,
        error: "corrupted",
        ber: 2 / (message.length * 8),
      });
    });

    test("ignores errors in the header and the CRC", () => {
      const message = "secret";
      let stego = hide(cover, message, method);
      const crcBit = (FRAME_HEADER_BYTES + message.length) * 8;
      const crcDamaged = flipFrameBit(cover, stego, method, crcBit);
      expect(measure(crcDamaged, message, method)).toMatchObject({ error: "corrupted", ber: 0 });

      // MSB of the method id byte: ids 1-3 become 0x81-0x83, which are unknown.
      const methodIdBit = 3 * 8;
      stego = flipFrameBit(cover, stego, method, methodIdBit);
      expect(measure(stego, message, method)).toMatchObject({ error: "no-message", ber: 0 });
    });

    test("throws CapacityExceededError when the expected message could never fit", () => {
      expect(() => measure(noiseImage(1, 1), "x", method)).toThrow(CapacityExceededError);
    });

    test("gives BER 0 for an empty expected message", () => {
      expect(measure(cover, "", method)).toEqual({ ok: false, error: "no-message", ber: 0 });
    });

    test("is about 0.5 on a clean image", () => {
      const { ber } = measure(cover, "a fairly long expected message", method);
      expect(ber).toBeGreaterThan(0.3);
      expect(ber).toBeLessThan(0.7);
    });
  });
});
