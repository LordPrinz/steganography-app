import { describe, expect, test } from "bun:test";
import { MethodId } from "../types.ts";
import { decodeFrame, encodeFrame, FRAME_OVERHEAD_BYTES } from "./frame.ts";

const utf8 = new TextEncoder();

describe("frame", () => {
  test("round-trips a UTF-8 payload", () => {
    const payload = utf8.encode("Zażółć gęślą jaźń 🔒");
    const frame = encodeFrame(MethodId.DwtQim, payload);

    expect(frame.length).toBe(payload.length + FRAME_OVERHEAD_BYTES);
    expect(decodeFrame(frame)).toEqual({ ok: true, method: MethodId.DwtQim, payload });
  });

  test("accepts an empty payload", () => {
    const result = decodeFrame(encodeFrame(MethodId.Lsb, new Uint8Array()));
    expect(result).toEqual({ ok: true, method: MethodId.Lsb, payload: new Uint8Array() });
  });

  test("ignores trailing bytes after the frame", () => {
    const frame = encodeFrame(MethodId.Lsb, utf8.encode("hi"));
    const padded = new Uint8Array(frame.length + 16);
    padded.set(frame);
    expect(decodeFrame(padded).ok).toBe(true);
  });

  test("detects a flipped payload bit", () => {
    const frame = encodeFrame(MethodId.DctKochZhao, utf8.encode("secret"));
    frame[10] = (frame[10] as number) ^ 0b100;
    expect(decodeFrame(frame)).toEqual({ ok: false, error: "crc-mismatch" });
  });

  test("rejects random noise", () => {
    const noise = crypto.getRandomValues(new Uint8Array(256));
    noise[0] = 0;
    expect(decodeFrame(noise)).toEqual({ ok: false, error: "bad-magic" });
  });

  test("rejects a frame cut short", () => {
    const frame = encodeFrame(MethodId.Lsb, utf8.encode("message"));
    expect(decodeFrame(frame.subarray(0, frame.length - 2))).toEqual({
      ok: false,
      error: "truncated",
    });
  });

  test("rejects an unknown method id", () => {
    const frame = encodeFrame(MethodId.Lsb, utf8.encode("x"));
    frame[3] = 99;
    expect(decodeFrame(frame)).toEqual({ ok: false, error: "unknown-method" });
  });
});
