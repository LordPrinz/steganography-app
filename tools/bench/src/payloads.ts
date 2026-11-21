import {
  ber,
  type ConfiguredMethod,
  hide,
  hideLayered,
  measure,
  type RgbaImage,
} from "@stego/engine";

/** The embedded image of one cover and method, and how to score an attacked copy of it. */
export interface Embedded {
  readonly stego: RgbaImage;
  evaluate(attacked: RgbaImage): { success: boolean; ber: number };
}

/** One image holding a message per method, and how to score an attacked copy of it per layer. */
export interface EmbeddedLayers {
  readonly stego: RgbaImage;
  /** One result per method, in the order the methods were given. */
  evaluate(attacked: RgbaImage): { success: boolean; ber: number }[];
}

export interface Payload {
  /** Throws `CapacityExceededError` when the payload does not fit `cover`. */
  embed(cover: RgbaImage, method: ConfiguredMethod): Embedded;
  /** Only the framed `message` payload can be layered: raw bits carry no frame to reveal. */
  embedLayers?(cover: RgbaImage, methods: readonly ConfiguredMethod[]): EmbeddedLayers;
}

/** Printable ASCII text of `bytes` bytes, the same for every run; `shift` makes another text. */
function text(bytes: number, shift = 0): string {
  return Array.from({ length: bytes }, (_, i) =>
    String.fromCharCode(97 + ((i * 7 + (i >> 3) + shift) % 26)),
  ).join("");
}

/**
 * A framed text message, hidden and revealed through the codec like the worker does. Success is a
 * clean reveal; BER is measured over the payload bits.
 */
function message(bytes: number): Payload {
  const secret = text(bytes);
  return {
    embed(cover, method) {
      return {
        stego: hide(cover, secret, method),
        evaluate(attacked) {
          const result = measure(attacked, secret, method);
          return { success: result.ok, ber: result.ber };
        },
      };
    },
    embedLayers(cover, methods) {
      const secrets = methods.map((_, layer) => text(bytes, layer));
      const layers = methods.map((method, layer) => ({ method, message: secrets[layer] ?? "" }));
      return {
        stego: hideLayered(cover, layers),
        evaluate(attacked) {
          return layers.map(({ method, message }) => {
            const result = measure(attacked, message, method);
            return { success: result.ok, ber: result.ber };
          });
        },
      };
    },
  };
}

/** Raw bits straight into the method, without a frame; success means no bit flipped. */
function rawBits(bitsFor: (method: ConfiguredMethod, cover: RgbaImage) => Uint8Array): Payload {
  return {
    embed(cover, method) {
      const bits = bitsFor(method, cover);
      return {
        stego: method.embed(cover, bits),
        evaluate(attacked) {
          const flipped = ber(bits, method.extract(attacked, bits.length));
          return { success: flipped === 0, ber: flipped };
        },
      };
    },
  };
}

/** xorshift32 bits, the payload of the Koch-Zhao experiment (ADR 7). */
function randomBits(count: number): Uint8Array {
  let state = 0x2545f491;
  return Uint8Array.from({ length: count }, () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state & 1;
  });
}

/** A hashed bit pattern, the payload of the Haar DWT experiment (ADR 8). */
function patternBits(count: number): Uint8Array {
  return Uint8Array.from({ length: count }, (_, i) =>
    Number((((i * 2654435761) >>> 7) ^ (i >>> 3)) & 1),
  );
}

/** Both raw payloads exist to reproduce the ADR tables; `message` is the everyday one. */
const payloads: Record<string, (arg: number | undefined) => Payload> = {
  message: (bytes = 64) => message(bytes),
  fill: () =>
    rawBits((method, cover) => randomBits(method.capacityBits(cover.width, cover.height))),
  bits: (count = 4096) => rawBits(() => patternBits(count)),
};

export const PAYLOAD_NAMES = Object.keys(payloads);

/**
 * Parses `message[:bytes]` (default 64), `fill` (random bits up to capacity, no frame) or
 * `bits[:count]` (a fixed pattern of `count` bits, no frame, default 4096).
 */
export function parsePayload(spec: string): Payload {
  const [name = "", arg] = spec.split(":");
  const create = Object.hasOwn(payloads, name) ? payloads[name] : undefined;
  if (!create) {
    throw new Error(`unknown payload "${name}", expected one of ${PAYLOAD_NAMES.join(", ")}`);
  }
  const value = arg === undefined ? undefined : Number(arg);
  if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
    throw new Error(`payload size must be a positive integer, got "${arg}"`);
  }
  return create(value);
}
