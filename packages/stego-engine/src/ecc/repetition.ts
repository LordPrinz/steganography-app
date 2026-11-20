import type { ErrorCorrectingCode } from "./code.ts";

export interface RepetitionParams {
  /** Copies of each bit: an odd number, at least 3. Corrects up to `(factor - 1) / 2` flips per bit. */
  readonly factor: number;
}

/** Repeats each bit `factor` times in a row and decodes by majority vote. */
export function repetition({ factor }: RepetitionParams): ErrorCorrectingCode {
  if (!Number.isInteger(factor) || factor < 3 || factor % 2 === 0) {
    throw new RangeError(`Repetition factor must be an odd integer of at least 3, got ${factor}`);
  }
  const majority = (factor + 1) / 2;
  return {
    codeBits: (dataBits) => dataBits * factor,
    dataBits: (codeBits) => Math.floor(codeBits / factor),
    encode: (bits) => {
      const code = new Uint8Array(bits.length * factor);
      for (let i = 0; i < bits.length; i++) {
        code.fill((bits[i] as number) & 1, i * factor, (i + 1) * factor);
      }
      return code;
    },
    decode: (code, dataBits) => {
      if (code.length < dataBits * factor) {
        throw new RangeError(`${dataBits} data bits need ${dataBits * factor} coded bits`);
      }
      const bits = new Uint8Array(dataBits);
      for (let i = 0; i < dataBits; i++) {
        let ones = 0;
        for (let k = i * factor; k < (i + 1) * factor; k++) ones += (code[k] as number) & 1;
        bits[i] = ones >= majority ? 1 : 0;
      }
      return bits;
    },
  };
}
