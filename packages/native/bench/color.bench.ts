/**
 * RGB <-> YCbCr on a 12 MP image (4000 x 3000): TS oracle vs TinyCC (`bun:ffi` cc) vs the -O3
 * library. Run with `bun run native:bench`; numbers go into docs/adr/0004.
 */
import { cc } from "bun:ffi";
import { join } from "node:path";
import { rgbaToYcbcr, ycbcrToRgba } from "../src/index.ts";
import { rgbaToYcbcrOracle, ycbcrToRgbaOracle } from "../test/oracle/color.ts";
import { randomBytes } from "../test/random.ts";

const WIDTH = 4000;
const HEIGHT = 3000;
const RUNS = 5;

const n = WIDTH * HEIGHT;
const image = { width: WIDTH, height: HEIGHT, data: randomBytes(n * 4) };

// TinyCC cannot take `buffer_length`, so lengths are passed as plain u64.
const forwardArgs = ["buffer", "u64", "u32", "u32", ...Array(4).fill(["buffer", "u64"]).flat()];
const tcc = cc({
  source: join(import.meta.dir, "..", "c", "color.c"),
  include: [join(import.meta.dir, "..", "c")],
  symbols: {
    stego_rgba_to_ycbcr: { args: forwardArgs, returns: "i32" },
    stego_ycbcr_to_rgba: {
      args: [...Array(4).fill(["buffer", "u64"]).flat(), "u32", "u32", "buffer", "u64"],
      returns: "i32",
    },
  },
}).symbols;

function tccRoundTrip(): void {
  const { data } = image;
  const [y, cb, cr] = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  const alpha = new Uint8Array(n);
  const out = new Uint8Array(n * 4);
  const bytes = n * 4; // RGBA and float planes both take 4 bytes per pixel
  tcc.stego_rgba_to_ycbcr(data, bytes, WIDTH, HEIGHT, y, bytes, cb, bytes, cr, bytes, alpha, n);
  tcc.stego_ycbcr_to_rgba(y, bytes, cb, bytes, cr, bytes, alpha, n, WIDTH, HEIGHT, out, bytes);
}

const cases: [string, () => void][] = [
  ["TS (JIT)", () => ycbcrToRgbaOracle(rgbaToYcbcrOracle(image))],
  ["C, TinyCC", tccRoundTrip],
  ["C, cc -O3", () => ycbcrToRgba(rgbaToYcbcr(image))],
];

console.info(`RGBA -> YCbCr -> RGBA, ${WIDTH}x${HEIGHT}, median of ${RUNS} runs after warm-up`);
for (const [name, run] of cases) {
  run();
  const times: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const start = Bun.nanoseconds();
    run();
    times.push((Bun.nanoseconds() - start) / 1e6);
  }
  times.sort((a, b) => a - b);
  console.info(`${name.padEnd(12)} ${(times[RUNS >> 1] as number).toFixed(1).padStart(8)} ms`);
}
