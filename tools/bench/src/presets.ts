import { join } from "node:path";
import { type Cover, generatedCovers, loadCovers } from "./covers.ts";

export interface Preset {
  readonly description: string;
  covers(): Promise<Cover[]> | Cover[];
  readonly methods: readonly string[];
  readonly scenarios: readonly string[];
  readonly payload: string;
}

export const FIXTURES = join(import.meta.dir, "..", "images");

const JPEG = ["jpeg90", "jpeg75", "jpeg50"];

/** Every combination of the lists, in order, as method specs. */
function grid(name: string, axes: Record<string, readonly (string | number)[]>): string[] {
  return Object.entries(axes).reduce<string[]>(
    (specs, [key, values]) =>
      specs.flatMap((spec) =>
        values.map((v) => `${spec}${spec.endsWith(":") ? "" : ","}${key}=${v}`),
      ),
    [`${name}:`],
  );
}

/**
 * The configurations behind the numbers in the ADRs. They keep the payloads and image sets of the
 * original experiments, so a run reproduces the tables.
 */
export const presets: Record<string, Preset> = {
  "koch-zhao": {
    description:
      "ADR 7: coefficient pair and strength, JPEG 90/75/50, natural images, full capacity",
    covers: () => loadCovers([FIXTURES]),
    methods: grid("kochZhao", {
      pair: ["4334", "3223", "2112", "4114"],
      strength: [10, 20, 30, 40, 50, 60],
    }),
    scenarios: JPEG,
    payload: "fill",
  },
  "dwt-qim": {
    description: "ADR 8: band, level and step, no attack and JPEG 90/75/50, generated images",
    covers: generatedCovers,
    methods: grid("dwtQim", {
      level: [1, 2],
      band: ["LL", "HL", "LH"],
      step: [12, 16, 24, 32, 48, 64, 96],
    }),
    scenarios: ["none", ...JPEG],
    payload: "bits:4096",
  },
};
