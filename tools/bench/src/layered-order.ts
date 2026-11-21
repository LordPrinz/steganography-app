import {
  type ConfiguredMethod,
  capacity,
  dwtQim,
  hide,
  kochZhao,
  lsb,
  measure,
  psnr,
} from "@stego/engine";
import { applyScenario } from "@stego/image-io";
import { generatedCovers, loadCovers } from "./covers.ts";
import { FIXTURES } from "./presets.ts";
import { parseScenario } from "./scenarios.ts";

/**
 * The embedding-order experiment behind ADR 9: every order of DCT, DWT and LSB with plain `hide`
 * calls (not `hideLayered`, which fixes the order), on the four natural fixtures plus one generated
 * image. Usage: `bun run bench:layered-order [load]`, where `load` is the fraction of each layer's
 * capacity to fill, capped at 4000 bytes (default: 64-byte messages).
 */
const LOAD = Number(Bun.argv[2] ?? "0");
const SCENARIOS = ["none", "jpeg90", "jpeg75"].map(parseScenario);

const dct = kochZhao();
const bits = lsb({ bitsPerChannel: 1 });
const dwts: Record<string, ConfiguredMethod> = {
  "LL L2 step 32": dwtQim({ band: "LL", level: 2, step: 32 }),
  "LL L2 step 64": dwtQim({ band: "LL", level: 2, step: 64 }),
  "LL L1 step 32": dwtQim({ band: "LL", level: 1, step: 32 }),
};
const ORDERS = [
  ["dwt", "dct", "lsb"],
  ["dct", "dwt", "lsb"],
  ["lsb", "dct", "dwt"],
  ["dct", "lsb", "dwt"],
  ["dwt", "lsb", "dct"],
  ["lsb", "dwt", "dct"],
] as const;

function text(bytes: number, shift: number): string {
  return Array.from({ length: bytes }, (_, i) =>
    String.fromCharCode(97 + ((i * 7 + (i >> 3) + shift) % 26)),
  ).join("");
}

const covers = [...(await loadCovers([FIXTURES])), ...generatedCovers().slice(0, 1)];
const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;

console.info(
  `| DWT | order | PSNR dB | layer | ${SCENARIOS.map((s) => `BER ${s.label} (exact)`).join(" | ")} |`,
);
console.info(`| --- | --- | --- | --- | ${SCENARIOS.map(() => "---").join(" | ")} |`);
for (const [dwtLabel, dwt] of Object.entries(dwts)) {
  const methods: Record<string, ConfiguredMethod> = { dct, dwt, lsb: bits };
  for (const order of ORDERS) {
    const psnrs: number[] = [];
    const ber: Record<string, number[]> = {};
    const exact: Record<string, number> = {};
    for (const { image } of covers) {
      const messages = Object.fromEntries(
        order.map((key, i) => {
          const method = methods[key] as ConfiguredMethod;
          const size =
            LOAD > 0
              ? Math.min(Math.floor(capacity(image.width, image.height, method) * LOAD), 4000)
              : 64;
          return [key, text(size, i)];
        }),
      );
      let stego = image;
      for (const key of order)
        stego = hide(stego, messages[key] as string, methods[key] as ConfiguredMethod);
      psnrs.push(psnr(image, stego));
      for (const scenario of SCENARIOS) {
        const attacked = await applyScenario(stego, scenario.attacks);
        for (const key of order) {
          const result = measure(
            attacked,
            messages[key] as string,
            methods[key] as ConfiguredMethod,
          );
          const slot = `${key}/${scenario.label}`;
          ber[slot] = [...(ber[slot] ?? []), result.ber];
          exact[slot] = (exact[slot] ?? 0) + (result.ok ? 1 : 0);
        }
      }
    }
    for (const key of order) {
      const cells = SCENARIOS.map((s) => {
        const slot = `${key}/${s.label}`;
        return `${mean(ber[slot] ?? []).toFixed(4)} (${exact[slot]}/${covers.length})`;
      });
      console.info(
        `| ${dwtLabel} | ${order.join(" > ")} | ${mean(psnrs).toFixed(2)} | ${key} | ${cells.join(" | ")} |`,
      );
    }
  }
}
