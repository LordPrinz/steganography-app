import { describe, expect, test } from "bun:test";
import { capacity, hide, measure, reveal } from "../codec.ts";
import { lsb } from "../methods/lsb.ts";
import { FRAME_HEADER_BYTES, FRAME_OVERHEAD_BYTES } from "../payload/frame.ts";
import { noiseImage } from "../testing/images.ts";
import { type ErrorCorrectingCode, withErrorCorrection } from "./code.ts";
import { hamming74 } from "./hamming74.ts";
import { repetition } from "./repetition.ts";

interface CodeCase {
  readonly name: string;
  readonly code: ErrorCorrectingCode;
  /** Coded bits per codeword and data bits each one carries. */
  readonly block: number;
  readonly data: number;
  /** Flips per codeword the code always corrects. */
  readonly corrects: number;
}

const codeCases: readonly CodeCase[] = [
  { name: "repetition x3", code: repetition({ factor: 3 }), block: 3, data: 1, corrects: 1 },
  { name: "repetition x5", code: repetition({ factor: 5 }), block: 5, data: 1, corrects: 2 },
  { name: "repetition x7", code: repetition({ factor: 7 }), block: 7, data: 1, corrects: 3 },
  { name: "Hamming(7,4)", code: hamming74(), block: 7, data: 4, corrects: 1 },
];

/** Seeded xorshift32, so every injected error pattern is reproducible. */
function rng(seed: number): (bound: number) => number {
  let state = seed >>> 0 || 1;
  return (bound) => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state % bound;
  };
}

function randomBits(count: number, seed: number): Uint8Array {
  const next = rng(seed);
  return Uint8Array.from({ length: count }, () => next(2));
}

/** Flips `count` distinct bits of `bits` in `[start, start + length)`. */
function flipDistinct(
  bits: Uint8Array,
  start: number,
  length: number,
  count: number,
  next: (bound: number) => number,
) {
  const positions = new Set<number>();
  while (positions.size < count) positions.add(start + next(length));
  for (const p of positions) bits[p] = (bits[p] as number) ^ 1;
}

/** Flips a seeded number of bits, from 0 up to `perBlock`, in every codeword of the first `length` bits. */
function flipPerCodeword(
  bits: Uint8Array,
  length: number,
  block: number,
  perBlock: number,
  seed: number,
) {
  const next = rng(seed);
  for (let start = 0; start + block <= length; start += block) {
    flipDistinct(bits, start, block, next(perBlock + 1), next);
  }
}

describe.each(codeCases)("error-correcting code: $name", ({ code, block, data, corrects }) => {
  test.each([0, 1, 3, 4, 5, 64, 101])("round-trips %i bits", (count) => {
    const bits = randomBits(count, 7 + count);
    const encoded = code.encode(bits);
    expect(encoded.length).toBe(code.codeBits(count));
    expect(code.decode(encoded, count)).toEqual(bits);
  });

  test("codeBits and dataBits agree on whole codewords", () => {
    for (let codeBits = 0; codeBits < 50; codeBits++) {
      const fits = code.dataBits(codeBits);
      expect(fits % data).toBe(0);
      expect(code.codeBits(fits)).toBeLessThanOrEqual(codeBits);
      expect(code.codeBits(fits + 1)).toBeGreaterThan(codeBits);
    }
  });

  test("decoding a prefix of the code gives a prefix of the data", () => {
    const bits = randomBits(40, 11);
    const encoded = code.encode(bits);
    for (const n of [1, 5, 17]) {
      expect(code.decode(encoded.subarray(0, code.codeBits(n)), n)).toEqual(bits.subarray(0, n));
    }
  });

  test.each([1, 2, 3, 4])("corrects up to its limit of flips per codeword (seed %i)", (seed) => {
    const bits = randomBits(400, seed);
    const encoded = code.encode(bits);
    flipPerCodeword(encoded, encoded.length, block, corrects, seed);
    expect(code.decode(encoded, bits.length)).toEqual(bits);
  });

  test("one flip more than its limit changes the data of that codeword", () => {
    const bits = randomBits(data, 5);
    for (let seed = 1; seed <= 20; seed++) {
      const encoded = code.encode(bits);
      flipDistinct(encoded, 0, block, corrects + 1, rng(seed));
      expect(code.decode(encoded, data)).not.toEqual(bits);
    }
  });
});

describe("Hamming(7,4)", () => {
  test("corrects every single flip in every codeword", () => {
    const code = hamming74();
    for (let word = 0; word < 16; word++) {
      const bits = Uint8Array.from([3, 2, 1, 0], (shift) => (word >> shift) & 1);
      for (let position = 0; position < 7; position++) {
        const encoded = code.encode(bits);
        encoded[position] = (encoded[position] as number) ^ 1;
        expect(code.decode(encoded, 4)).toEqual(bits);
      }
    }
  });
});

describe("repetition", () => {
  test.each([1, 2, 4, 2.5, 0, -3, Number.NaN])("rejects factor %p", (factor) => {
    expect(() => repetition({ factor })).toThrow(RangeError);
  });
});

describe.each(codeCases)("stego codec with $name over LSB", ({ code, block, data, corrects }) => {
  const cover = noiseImage(64, 48);
  const inner = lsb({ bitsPerChannel: 1 });
  const method = withErrorCorrection(inner, code);
  const message = "Meet at noon by the old mill";
  const frameBits = (FRAME_OVERHEAD_BYTES + message.length) * 8;
  const codedBits = code.codeBits(frameBits);

  /** Hides `message`, then flips bits of the coded stream the way an attack on the image would. */
  function attacked(flip: (raw: Uint8Array) => void) {
    const stego = hide(cover, message, method);
    const raw = inner.extract(stego, inner.capacityBits(cover.width, cover.height));
    flip(raw);
    return inner.embed(cover, raw);
  }

  test("capacity counts message bytes after the code rate and the frame", () => {
    const rawBits = inner.capacityBits(cover.width, cover.height);
    expect(capacity(cover.width, cover.height, method)).toBe(
      Math.floor(code.dataBits(rawBits) / 8) - FRAME_OVERHEAD_BYTES,
    );
  });

  test.each([1, 2, 3, 4, 5])(
    "recovers the exact message from correctable errors (seed %i)",
    (seed) => {
      const stego = attacked((raw) => flipPerCodeword(raw, codedBits, block, corrects, seed));
      expect(reveal(stego, method)).toEqual({ ok: true, message });
      expect(measure(stego, message, method)).toEqual({ ok: true, ber: 0 });
    },
  );

  test("errors beyond the limit in one payload codeword fail the CRC", () => {
    const payloadBit = FRAME_HEADER_BYTES * 8 + 8;
    const start = Math.floor(payloadBit / data) * block;
    const stego = attacked((raw) => flipDistinct(raw, start, block, corrects + 1, rng(9)));
    expect(reveal(stego, method)).toEqual({ ok: false, error: "corrupted" });
  });

  test.each([1, 2, 3, 4, 5])("heavy random errors never decode to a message (seed %i)", (seed) => {
    const next = rng(seed);
    const stego = attacked((raw) => {
      for (let i = 0; i < codedBits; i++) if (next(4) === 0) raw[i] = (raw[i] as number) ^ 1;
    });
    expect(reveal(stego, method).ok).toBe(false);
  });

  test("a clean image has no message", () => {
    expect(reveal(cover, method)).toEqual({ ok: false, error: "no-message" });
  });

  test("an image hidden without the code does not reveal with it", () => {
    expect(reveal(hide(cover, message, inner), method).ok).toBe(false);
  });
});
