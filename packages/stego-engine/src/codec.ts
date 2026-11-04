import { fromBits, toBits } from "./bits.ts";
import {
  decodeFrameHeader,
  encodeFrame,
  FRAME_HEADER_BYTES,
  FRAME_OVERHEAD_BYTES,
  frameCrcMatches,
} from "./payload/frame.ts";
import type { ConfiguredMethod, RgbaImage } from "./types.ts";

export type RevealError = "no-message" | "corrupted" | "method-mismatch";

export type RevealResult =
  | { readonly ok: true; readonly message: string }
  | { readonly ok: false; readonly error: RevealError };

/**
 * Reveal outcome plus the bit error rate over the payload bits of the expected message. It never
 * carries the revealed message, so a lab result can be stored as is.
 */
export type MeasureResult =
  | { readonly ok: true; readonly ber: number }
  | { readonly ok: false; readonly error: RevealError; readonly ber: number };

/** The message does not fit; sizes are UTF-8 message bytes, as returned by `capacity`. */
export class CapacityExceededError extends Error {
  readonly needed: number;
  readonly available: number;

  constructor(needed: number, available: number) {
    super(`Message needs ${needed} bytes, the image holds ${available}`);
    this.name = "CapacityExceededError";
    this.needed = needed;
    this.available = available;
  }
}

const utf8Encoder = new TextEncoder();
// fatal: invalid UTF-8 means the payload was damaged. ignoreBOM: a leading U+FEFF is message text.
const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const HEADER_BITS = FRAME_HEADER_BYTES * 8;
const CRC_BITS = (FRAME_OVERHEAD_BYTES - FRAME_HEADER_BYTES) * 8;

/** Signed: negative when not even an empty frame fits. */
function messageBytesAvailable(width: number, height: number, method: ConfiguredMethod): number {
  return Math.floor(method.capacityBits(width, height) / 8) - FRAME_OVERHEAD_BYTES;
}

/** UTF-8 message bytes `method` can hide in an image of the given size, after frame overhead. */
export function capacity(width: number, height: number, method: ConfiguredMethod): number {
  return Math.max(0, messageBytesAvailable(width, height, method));
}

function frameFor(width: number, height: number, message: string, method: ConfiguredMethod) {
  const payload = utf8Encoder.encode(message);
  const available = messageBytesAvailable(width, height, method);
  if (payload.length > available) {
    throw new CapacityExceededError(payload.length, Math.max(0, available));
  }
  return encodeFrame(method.id, payload);
}

/** Returns a new image with `message` hidden in it. Throws `CapacityExceededError` if it does not fit. */
export function hide(image: RgbaImage, message: string, method: ConfiguredMethod): RgbaImage {
  const frame = frameFor(image.width, image.height, message, method);
  return method.embed(image, toBits(frame));
}

export function reveal(image: RgbaImage, method: ConfiguredMethod): RevealResult {
  const available = messageBytesAvailable(image.width, image.height, method);
  if (available < 0) return { ok: false, error: "no-message" };

  const header = decodeFrameHeader(fromBits(method.extract(image, HEADER_BITS)));
  if (!header.ok) return { ok: false, error: "no-message" };
  if (header.payloadLength > available) return { ok: false, error: "corrupted" };

  const frameBits = (FRAME_OVERHEAD_BYTES + header.payloadLength) * 8;
  const frame = fromBits(method.extract(image, frameBits));
  if (!frameCrcMatches(frame)) return { ok: false, error: "corrupted" };
  if (header.method !== method.id) return { ok: false, error: "method-mismatch" };

  const payload = frame.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + header.payloadLength);
  try {
    return { ok: true, message: utf8Decoder.decode(payload) };
  } catch {
    return { ok: false, error: "corrupted" };
  }
}

/**
 * Reveals `attacked` and compares its payload bits with where the frame for `expectedMessage`
 * put them. BER is defined even when the frame fails its CRC; it is 0 for an empty message.
 * Throws `CapacityExceededError` if `expectedMessage` could never have fit.
 */
export function measure(
  attacked: RgbaImage,
  expectedMessage: string,
  method: ConfiguredMethod,
): MeasureResult {
  const expected = toBits(frameFor(attacked.width, attacked.height, expectedMessage, method));
  const actual = method.extract(attacked, expected.length);
  const payloadEnd = expected.length - CRC_BITS;

  let errors = 0;
  for (let i = HEADER_BITS; i < payloadEnd; i++) {
    if (actual[i] !== expected[i]) errors++;
  }
  const payloadBits = payloadEnd - HEADER_BITS;
  const ber = payloadBits === 0 ? 0 : errors / payloadBits;
  const revealed = reveal(attacked, method);
  return revealed.ok ? { ok: true, ber } : { ok: false, error: revealed.error, ber };
}
