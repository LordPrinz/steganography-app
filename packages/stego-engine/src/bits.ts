/** Expands bytes into bits (MSB first), one bit per array element. */
export function toBits(bytes: Uint8Array): Uint8Array {
  const bits = new Uint8Array(bytes.length * 8);
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i] as number;
    for (let b = 0; b < 8; b++) bits[i * 8 + b] = (byte >> (7 - b)) & 1;
  }
  return bits;
}

/** Packs bits (MSB first) into bytes. Trailing bits that do not fill a byte are dropped. */
export function fromBits(bits: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < bytes.length; i++) {
    let byte = 0;
    for (let b = 0; b < 8; b++) byte = (byte << 1) | ((bits[i * 8 + b] as number) & 1);
    bytes[i] = byte;
  }
  return bytes;
}
