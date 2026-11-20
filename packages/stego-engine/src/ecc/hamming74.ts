import type { ErrorCorrectingCode } from "./code.ts";

const DATA_BITS = 4;
const BLOCK_BITS = 7;
// Codeword positions 1–7 hold p1 p2 d1 p3 d2 d3 d4; these are the 0-based indices of d1–d4.
const DATA_POSITIONS = [2, 4, 5, 6] as const;

/**
 * Hamming(7,4). The parity bit at position 2^k covers every position with bit k set, so the
 * syndrome of a received word is the position of a single flipped bit. Corrects one flip per
 * codeword; data is padded with zeros to whole codewords.
 */
export function hamming74(): ErrorCorrectingCode {
  return {
    codeBits: (dataBits) => Math.ceil(dataBits / DATA_BITS) * BLOCK_BITS,
    dataBits: (codeBits) => Math.floor(codeBits / BLOCK_BITS) * DATA_BITS,
    encode: (bits) => {
      const blocks = Math.ceil(bits.length / DATA_BITS);
      const code = new Uint8Array(blocks * BLOCK_BITS);
      for (let b = 0; b < blocks; b++) {
        const d = (i: number) => (bits[b * DATA_BITS + i] ?? 0) & 1;
        const [d1, d2, d3, d4] = [d(0), d(1), d(2), d(3)];
        code.set([d1 ^ d2 ^ d4, d1 ^ d3 ^ d4, d1, d2 ^ d3 ^ d4, d2, d3, d4], b * BLOCK_BITS);
      }
      return code;
    },
    decode: (code, dataBits) => {
      const blocks = Math.ceil(dataBits / DATA_BITS);
      if (code.length < blocks * BLOCK_BITS) {
        throw new RangeError(`${dataBits} data bits need ${blocks * BLOCK_BITS} coded bits`);
      }
      const data = new Uint8Array(blocks * DATA_BITS);
      const word = new Uint8Array(BLOCK_BITS);
      for (let b = 0; b < blocks; b++) {
        let syndrome = 0;
        for (let i = 0; i < BLOCK_BITS; i++) {
          const bit = (code[b * BLOCK_BITS + i] as number) & 1;
          word[i] = bit;
          if (bit) syndrome ^= i + 1;
        }
        if (syndrome !== 0) word[syndrome - 1] = (word[syndrome - 1] as number) ^ 1;
        for (let i = 0; i < DATA_BITS; i++) {
          data[b * DATA_BITS + i] = word[DATA_POSITIONS[i] as number] as number;
        }
      }
      return data.slice(0, dataBits);
    },
  };
}
