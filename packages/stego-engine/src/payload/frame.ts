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
const FRAME_VERSION = 1;
export const FRAME_HEADER_BYTES = 8;
export const FRAME_OVERHEAD_BYTES = FRAME_HEADER_BYTES + 4;

const KNOWN_METHODS = new Set<number>(Object.values(MethodId));

type HeaderError = "too-short" | "bad-magic" | "unsupported-version" | "unknown-method";

type HeaderResult =
  | { ok: true; method: MethodId; payloadLength: number }
  | { ok: false; error: HeaderError };

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

/** Parses the fixed-size header at the start of `bytes`, without looking at payload or CRC. */
export function decodeFrameHeader(bytes: Uint8Array): HeaderResult {
  if (bytes.length < FRAME_HEADER_BYTES) return { ok: false, error: "too-short" };
  if (bytes[0] !== MAGIC[0] || bytes[1] !== MAGIC[1]) return { ok: false, error: "bad-magic" };
  if (bytes[2] !== FRAME_VERSION) return { ok: false, error: "unsupported-version" };

  const method = bytes[3] as number;
  if (!KNOWN_METHODS.has(method)) return { ok: false, error: "unknown-method" };

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { ok: true, method: method as MethodId, payloadLength: view.getUint32(4) };
}

/** True when `frame` (exactly header + payload + CRC, as sized by its header) ends with a matching CRC32. */
export function frameCrcMatches(frame: Uint8Array): boolean {
  const crcOffset = frame.length - 4;
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  return Bun.hash.crc32(frame.subarray(0, crcOffset)) === view.getUint32(crcOffset);
}
