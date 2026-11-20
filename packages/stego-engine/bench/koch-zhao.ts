/**
 * Koch–Zhao spike (ADR 7): compares coefficient pairs and strengths P on natural images.
 *
 *   bun run bench:koch-zhao
 *
 * Every image is filled to capacity with one fixed random payload. The table gives the mean over
 * the images of PSNR after embedding and of the raw bit error rate after JPEG at three qualities.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { applyAttack, decodeRgba } from "@stego/image-io";
import type { DctPair } from "@stego/native";
import { kochZhao } from "../src/methods/koch-zhao.ts";
import { ber, psnr } from "../src/metrics.ts";
import type { RgbaImage } from "../src/types.ts";

const PAIRS: readonly DctPair[] = [
  [
    [4, 3],
    [3, 4],
  ],
  [
    [3, 2],
    [2, 3],
  ],
  [
    [2, 1],
    [1, 2],
  ],
  [
    [4, 1],
    [1, 4],
  ],
];
const STRENGTHS = [10, 20, 30, 40, 50, 60];
const QUALITIES = [90, 75, 50];

const IMAGES = join(import.meta.dir, "images");

async function loadImages(): Promise<RgbaImage[]> {
  const files = readdirSync(IMAGES).filter((name) => name.endsWith(".png"));
  return Promise.all(
    files.map(async (name) => decodeRgba(await Bun.file(join(IMAGES, name)).bytes())),
  );
}

function payload(bits: number): Uint8Array {
  let state = 0x2545f491;
  return Uint8Array.from({ length: bits }, () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state & 1;
  });
}

const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;

const images = await loadImages();
const label = ([[u1, v1], [u2, v2]]: DctPair) => `(${u1},${v1}) vs (${u2},${v2})`;

console.info(
  `| pair | P | PSNR (dB) | ${QUALITIES.map((q) => `BER q${q}`).join(" | ")} |\n|---|---|---|${QUALITIES.map(() => "---").join("|")}|`,
);
for (const pair of PAIRS) {
  for (const strength of STRENGTHS) {
    const method = kochZhao({ pair, strength });
    const psnrs: number[] = [];
    const bers = QUALITIES.map(() => [] as number[]);
    for (const cover of images) {
      const bits = payload(method.capacityBits(cover.width, cover.height));
      const stego = method.embed(cover, bits);
      psnrs.push(psnr(cover, stego));
      for (const [i, quality] of QUALITIES.entries()) {
        const attacked = await applyAttack(stego, { type: "jpeg", quality });
        bers[i]?.push(ber(bits, method.extract(attacked, bits.length)));
      }
    }
    const cells = bers.map((values) => (mean(values) * 100).toFixed(2) + "%");
    console.info(
      `| ${label(pair)} | ${strength} | ${mean(psnrs).toFixed(2)} | ${cells.join(" | ")} |`,
    );
  }
}
