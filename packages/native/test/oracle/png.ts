/**
 * Reference PNG filters written straight from the spec (section 9), one pixel byte at a time.
 * Test-only; never used at runtime.
 */
import type { RgbaPixels } from "../../src/image.ts";

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Predictor for byte `i` of a row with `bpp` bytes per pixel; `prev` is undefined on the first row. */
function predict(
  filter: number,
  row: ArrayLike<number>,
  prev: ArrayLike<number> | undefined,
  i: number,
  bpp: number,
): number {
  const a = i >= bpp ? (row[i - bpp] as number) : 0;
  const b = prev ? (prev[i] as number) : 0;
  const c = prev && i >= bpp ? (prev[i - bpp] as number) : 0;
  return [0, a, b, (a + b) >> 1, paeth(a, b, c)][filter] as number;
}

function filterRow(filter: number, row: Uint8Array, prev: Uint8Array | undefined): Uint8Array {
  return row.map((value, i) => (value - predict(filter, row, prev, i, 4)) & 0xff);
}

/** Sum of the filtered bytes read as signed values. */
function cost(filtered: Uint8Array): number {
  return filtered.reduce((sum, v) => sum + (v < 128 ? v : 256 - v), 0);
}

export function pngFilterOracle({ width, height, data }: RgbaPixels, filter: number): Uint8Array {
  const stride = width * 4;
  const out = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = Uint8Array.from(data.subarray(y * stride, (y + 1) * stride));
    const prev = y > 0 ? Uint8Array.from(data.subarray((y - 1) * stride, y * stride)) : undefined;
    let chosen = filter;
    let filtered = filterRow(filter, row, prev);
    if (filter === 5) {
      const candidates = [0, 1, 2, 3, 4].map((f) => filterRow(f, row, prev));
      const costs = candidates.map(cost);
      chosen = costs.indexOf(Math.min(...costs));
      filtered = candidates[chosen] as Uint8Array;
    }
    out[y * (stride + 1)] = chosen;
    out.set(filtered, y * (stride + 1) + 1);
  }
  return out;
}

export function pngUnfilterOracle(
  scanlines: Uint8Array,
  width: number,
  height: number,
  channels: 3 | 4,
): Uint8ClampedArray {
  const stride = width * channels;
  const rows: Uint8Array[] = [];
  for (let y = 0; y < height; y++) {
    const filter = scanlines[y * (stride + 1)] as number;
    const row = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const raw = scanlines[y * (stride + 1) + 1 + i] as number;
      row[i] = (raw + predict(filter, row, rows[y - 1], i, channels)) & 0xff;
    }
    rows.push(row);
  }
  const out = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const row = rows[Math.floor(p / width)] as Uint8Array;
    const x = p % width;
    for (let c = 0; c < 4; c++) {
      out[p * 4 + c] = c < channels ? (row[x * channels + c] as number) : 255;
    }
  }
  return out;
}
