import { parseArgs } from "node:util";
import { loadCovers } from "./covers.ts";
import { type BenchMethod, CODE_NAMES, METHOD_NAMES, parseMethod } from "./methods.ts";
import { PAYLOAD_NAMES, parsePayload } from "./payloads.ts";
import { presets } from "./presets.ts";
import type { BenchPlan } from "./run.ts";
import { type BenchScenario, parseScenario } from "./scenarios.ts";

export const USAGE = `Usage: bun run bench [options] <image or directory>...

Runs method x scenario x image and prints a summary table.

Options:
  --method <spec>     name[:key=value,...], repeatable. Default: every method with its defaults.
                      Methods: ${METHOD_NAMES.join(", ")}. Add ecc=<code> for error correction
                      (${CODE_NAMES.join(", ")}:<factor>), e.g. kochZhao:strength=50,ecc=hamming74
  --scenario <spec>   none, or attacks joined with +, repeatable. Default: none, jpeg90, jpeg75,
                      jpeg50, resize0.5, blur1. Attacks: jpegQ, resizeSCALE, blurSIGMA
  --payload <spec>    ${PAYLOAD_NAMES.join(", ")}: message[:bytes] (default 64), fill, bits[:count]
  --layered           hide every --method in the same image (one message each) and report per layer
  --preset <name>     a configuration from the ADRs; other options override its parts
  --csv <file>        write one row per run (image, method, params, attack, success, ber, psnr, ssim, time)
  --json <file>       the same rows as JSON
  --list              list the presets
  -h, --help          show this text
`;

export const DEFAULT_METHODS = METHOD_NAMES;
export const DEFAULT_SCENARIOS = ["none", "jpeg90", "jpeg75", "jpeg50", "resize0.5", "blur1"];
export const DEFAULT_PAYLOAD = "message";

export interface CliOptions {
  readonly images: readonly string[];
  readonly methods: readonly string[];
  readonly scenarios: readonly string[];
  readonly payload?: string;
  readonly preset?: string;
  readonly layered: boolean;
  readonly csv?: string;
  readonly json?: string;
  readonly list: boolean;
  readonly help: boolean;
}

/** Splits `argv` (without the runtime and script) into options. Throws `Error` on unknown flags. */
export function parseCli(argv: readonly string[]): CliOptions {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      method: { type: "string", multiple: true },
      scenario: { type: "string", multiple: true },
      payload: { type: "string" },
      preset: { type: "string" },
      layered: { type: "boolean", default: false },
      csv: { type: "string" },
      json: { type: "string" },
      list: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  return {
    images: positionals,
    methods: values.method ?? [],
    scenarios: values.scenario ?? [],
    payload: values.payload,
    preset: values.preset,
    layered: values.layered,
    csv: values.csv,
    json: values.json,
    list: values.list,
    help: values.help,
  };
}

/** Turns options into a plan: parses every spec and decodes the images. Throws `Error` on bad input. */
export async function resolvePlan(options: CliOptions): Promise<BenchPlan> {
  const preset = options.preset === undefined ? undefined : presets[options.preset];
  if (options.preset !== undefined && !preset) {
    throw new Error(
      `unknown preset "${options.preset}", expected one of ${Object.keys(presets).join(", ")}`,
    );
  }
  if (options.images.length === 0 && !preset) {
    throw new Error("give at least one image or directory, or --preset");
  }

  const pick = (given: readonly string[], fallback: readonly string[]) =>
    given.length > 0 ? given : fallback;
  const methods: BenchMethod[] = pick(options.methods, preset?.methods ?? DEFAULT_METHODS).map(
    parseMethod,
  );
  const scenarios: BenchScenario[] = pick(
    options.scenarios,
    preset?.scenarios ?? DEFAULT_SCENARIOS,
  ).map(parseScenario);
  const payload = parsePayload(options.payload ?? preset?.payload ?? DEFAULT_PAYLOAD);
  const covers =
    options.images.length > 0 ? await loadCovers(options.images) : await preset?.covers();
  const layered = options.layered || (preset?.layered ?? false);
  return { covers: covers ?? [], methods, scenarios, payload, layered };
}
