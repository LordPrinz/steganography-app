import { describe, expect, test } from "bun:test";
import { fromBits, toBits } from "./bits.ts";

describe("bits", () => {
  test("round-trips bytes through bits", () => {
    const bytes = Uint8Array.from([0, 1, 127, 128, 255, 0xa5]);
    expect(fromBits(toBits(bytes))).toEqual(bytes);
  });

  test("expands MSB first", () => {
    expect(Array.from(toBits(Uint8Array.of(0b1010_0001)))).toEqual([1, 0, 1, 0, 0, 0, 0, 1]);
  });

  test("drops incomplete trailing byte", () => {
    expect(fromBits(Uint8Array.of(1, 1, 1, 1, 1, 1, 1, 1, 1, 0))).toEqual(Uint8Array.of(255));
  });
});
