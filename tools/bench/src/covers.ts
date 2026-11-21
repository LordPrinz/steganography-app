import { existsSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import type { RgbaImage } from "@stego/engine";
import { decodeRgba } from "@stego/image-io";

export interface Cover {
  readonly name: string;
  readonly image: RgbaImage;
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

/** Decodes every image file in `paths`; a directory stands for the image files directly in it. */
export async function loadCovers(paths: readonly string[]): Promise<Cover[]> {
  for (const path of paths) {
    if (!existsSync(path)) throw new Error(`no such file or directory: ${path}`);
  }
  const files = paths.flatMap((path) =>
    statSync(path).isDirectory()
      ? readdirSync(path)
          .filter((name) => IMAGE_EXTENSIONS.has(extname(name).toLowerCase()))
          .sort()
          .map((name) => join(path, name))
      : [path],
  );
  return Promise.all(
    files.map(async (file) => ({
      name: file.split("/").at(-1) ?? file,
      image: await decodeRgba(await Bun.file(file).bytes()),
    })),
  );
}

const SIZE = 512;

function rng(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
}

/** Bilinear value noise summed over octaves; `lowest` is the grid spacing of the first octave. */
function noiseField(random: () => number, lowest: number, octaves: number): Float64Array {
  const field = new Float64Array(SIZE * SIZE);
  let amplitude = 1;
  let total = 0;
  for (let o = 0, spacing = lowest; o < octaves; o++, spacing /= 2, amplitude /= 2) {
    const cells = Math.ceil(SIZE / spacing) + 2;
    const grid = Float64Array.from({ length: cells * cells }, random);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const gx = x / spacing;
        const gy = y / spacing;
        const x0 = Math.floor(gx);
        const y0 = Math.floor(gy);
        const fx = gx - x0;
        const fy = gy - y0;
        const g = (i: number, j: number) => grid[(y0 + j) * cells + x0 + i] as number;
        const top = g(0, 0) * (1 - fx) + g(1, 0) * fx;
        const bottom = g(0, 1) * (1 - fx) + g(1, 1) * fx;
        field[y * SIZE + x] =
          (field[y * SIZE + x] as number) + amplitude * (top * (1 - fy) + bottom * fy);
      }
    }
    total += amplitude;
  }
  return field.map((v) => v / total);
}

function toImage(
  luma: (x: number, y: number) => number,
  tint: [number, number, number],
): RgbaImage {
  const data = new Uint8ClampedArray(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const v = luma(x, y);
      const i = (y * SIZE + x) * 4;
      data[i] = v * tint[0];
      data[i + 1] = v * tint[1];
      data[i + 2] = v * tint[2];
      data[i + 3] = 255;
    }
  }
  return { width: SIZE, height: SIZE, data };
}

/**
 * Smooth, textured and edge-heavy 512 x 512 scenes, generated from fixed seeds so there is nothing
 * to license (ADR 8).
 */
export function generatedCovers(): Cover[] {
  const smooth = noiseField(rng(1), 128, 3);
  const texture = noiseField(rng(2), 32, 6);
  const edges = noiseField(rng(3), 64, 4);
  return [
    {
      name: "smooth",
      image: toImage(
        (x, y) => 40 + 160 * (smooth[y * SIZE + x] as number) + (x + y) / 16,
        [1, 0.95, 0.85],
      ),
    },
    {
      name: "texture",
      image: toImage((x, y) => 20 + 215 * (texture[y * SIZE + x] as number), [0.9, 1, 0.9]),
    },
    {
      name: "edges",
      image: toImage(
        (x, y) => {
          const disc = (x - 180) ** 2 + (y - 200) ** 2 < 120 ** 2;
          const bar = x > 300 && x < 420 && y > 80 && y < 440;
          const base = 60 + 120 * (edges[y * SIZE + x] as number);
          return disc ? base + 70 : bar ? base - 40 : base;
        },
        [1, 1, 1],
      ),
    },
  ];
}
