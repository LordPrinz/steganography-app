/**
 * Haar DWT + QIM: step vs PSNR vs BER, without an attack and after JPEG at quality 90, 75 and 50,
 * for every band at levels 1 and 2. Run with `bun run engine:bench:dwt`; the table goes into
 * docs/adr/0008.
 *
 * The cover images are generated here (smooth, textured and edge-heavy 512 x 512 scenes), so there
 * is nothing to license. Every run embeds the same 4096 random bits; PSNR and BER are averaged over
 * the three images.
 */
import { dwtQimEmbed, dwtQimExtract } from "@stego/native";
import { applyAttack } from "../../image-io/src/index.ts";
import { ber, psnr } from "../src/index.ts";
import type { RgbaImage } from "../src/types.ts";

const SIZE = 512;
const BITS = 4096;
const STEPS = [12, 16, 24, 32, 48, 64, 96];
const QUALITIES = [90, 75, 50];
const BANDS = ["LL", "HL", "LH"] as const;
const LEVELS = [1, 2];

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

function coverImages(): [string, RgbaImage][] {
  const smooth = noiseField(rng(1), 128, 3);
  const texture = noiseField(rng(2), 32, 6);
  const edges = noiseField(rng(3), 64, 4);
  return [
    [
      "smooth",
      toImage(
        (x, y) => 40 + 160 * (smooth[y * SIZE + x] as number) + (x + y) / 16,
        [1, 0.95, 0.85],
      ),
    ],
    ["texture", toImage((x, y) => 20 + 215 * (texture[y * SIZE + x] as number), [0.9, 1, 0.9])],
    [
      "edges",
      toImage(
        (x, y) => {
          const disc = (x - 180) ** 2 + (y - 200) ** 2 < 120 ** 2;
          const bar = x > 300 && x < 420 && y > 80 && y < 440;
          const base = 60 + 120 * (edges[y * SIZE + x] as number);
          return disc ? base + 70 : bar ? base - 40 : base;
        },
        [1, 1, 1],
      ),
    ],
  ];
}

const bits = Uint8Array.from({ length: BITS }, (_, i) =>
  Number((((i * 2654435761) >>> 7) ^ (i >>> 3)) & 1),
);
const covers = coverImages();

const header = [
  "band",
  "level",
  "step",
  "PSNR dB",
  "no attack",
  ...QUALITIES.map((q) => `JPEG ${q}`),
  "unembeddable",
];
console.info(`| ${header.join(" | ")} |`);
console.info(`|${header.map(() => " --- ").join("|")}|`);

for (const level of LEVELS) {
  for (const band of BANDS) {
    for (const step of STEPS) {
      const params = { band, level, step };
      let psnrSum = 0;
      let failedSum = 0;
      const berSums = [0, ...QUALITIES.map(() => 0)];
      for (const [, cover] of covers) {
        const { image: stego, failed } = dwtQimEmbed(cover, params, bits);
        failedSum += failed;
        psnrSum += psnr(cover, stego);
        const attacked = [stego];
        for (const quality of QUALITIES)
          attacked.push(await applyAttack(stego, { type: "jpeg", quality }));
        attacked.forEach((image, i) => {
          berSums[i] = (berSums[i] as number) + ber(bits, dwtQimExtract(image, params, BITS));
        });
      }
      const n = covers.length;
      const cells = [
        band,
        level,
        step,
        (psnrSum / n).toFixed(2),
        ...berSums.map((sum) => (sum / n).toFixed(4)),
        failedSum,
      ];
      console.info(`| ${cells.join(" | ")} |`);
    }
  }
}
