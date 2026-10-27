import { MethodId } from "../types.ts";

/**
 * Frame layout (big-endian):
 *
 *   magic "SG" (2) | version (1) | method (1) | payload length (4) | payload (n) | CRC32 (4)
 *
 * The CRC covers everything before it, so a decoder can tell a real message apart
 * from noise read out of a clean image.
 */
const MAGIC = [0x53, 0x47] as const;
export const FRAME_VERSION = 1;
export const FRAME_HEADER_BYTES = 8;
export const FRAME_OVERHEAD_BYTES = FRAME_HEADER_BYTES + 4;

const KNOWN_METHODS = new Set<number>(Object.values(MethodId));

export type FrameError =
  | "too-short"
  | "bad-magic"
  | "unsupported-version"
  | "unknown-method"
  | "truncated"
  | "crc-mismatch";

export type FrameResult =
  | { ok: true; method: MethodId; payload: Uint8Array }
  | { ok: false; error: FrameError };

export function encodeFrame(method: MethodId, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(FRAME_OVERHEAD_BYTES + payload.length);
  const view = new DataView(frame.buffer);
  frame[0] = MAGIC[0];
  frame[1] = MAGIC[1];
  frame[2] = FRAME_VERSION;
  frame[3] = method;
  view.setUint32(4, payload.length);
  frame.set(payload, FRAME_HEADER_BYTES);
  const crcOffset = FRAME_HEADER_BYTES + payload.length;
  view.setUint32(crcOffset, Bun.hash.crc32(frame.subarray(0, crcOffset)));
  return frame;
}

/** Parses a frame from the start of `bytes`; extra trailing bytes are ignored. */
export function decodeFrame(bytes: Uint8Array): FrameResult {
  if (bytes.length < FRAME_OVERHEAD_BYTES) return { ok: false, error: "too-short" };
  if (bytes[0] !== MAGIC[0] || bytes[1] !== MAGIC[1]) return { ok: false, error: "bad-magic" };
  if (bytes[2] !== FRAME_VERSION) return { ok: false, error: "unsupported-version" };

  const method = bytes[3] as number;
  if (!KNOWN_METHODS.has(method)) return { ok: false, error: "unknown-method" };

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(4);
  const crcOffset = FRAME_HEADER_BYTES + length;
  if (bytes.length < crcOffset + 4) return { ok: false, error: "truncated" };

  const expected = view.getUint32(crcOffset);
  if (Bun.hash.crc32(bytes.subarray(0, crcOffset)) !== expected) {
    return { ok: false, error: "crc-mismatch" };
  }
  return {
    ok: true,
    method: method as MethodId,
    payload: bytes.slice(FRAME_HEADER_BYTES, crcOffset),
  };
}
