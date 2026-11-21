import { Attack, Scenario } from "@stego/contracts";

export interface BenchScenario {
  /** The spec the scenario was parsed from, e.g. `resize0.5+jpeg75`; `none` for no attack. */
  readonly label: string;
  readonly attacks: Scenario;
}

/** Spec prefix to the attack it names; the number after the prefix is the one parameter. */
const attackSpecs: Record<string, (value: number) => unknown> = {
  jpeg: (quality) => ({ type: "jpeg", quality }),
  resize: (scale) => ({ type: "resize", scale }),
  blur: (sigma) => ({ type: "blur", sigma }),
};

/**
 * Parses `none` or attacks joined with `+`, applied left to right: `jpeg75`, `resize0.5`,
 * `blur1.5`, `resize0.5+jpeg75`. Values are checked with the `Scenario` schema of the contracts.
 */
export function parseScenario(spec: string): BenchScenario {
  if (spec === "none") return { label: spec, attacks: [] };
  const attacks = spec.split("+").map((part) => {
    const match = /^([a-z]+)(\d+(?:\.\d+)?)$/.exec(part);
    const make =
      match?.[1] && Object.hasOwn(attackSpecs, match[1]) ? attackSpecs[match[1]] : undefined;
    if (!match || !make) {
      throw new Error(
        `bad scenario "${spec}": "${part}" is not none or one of ${Object.keys(attackSpecs).join(", ")} followed by a number`,
      );
    }
    const attack = Attack.safeParse(make(Number(match[2])));
    if (!attack.success)
      throw new Error(`bad scenario "${spec}": ${attack.error.issues[0]?.message}`);
    return attack.data;
  });
  return { label: spec, attacks: Scenario.parse(attacks) };
}
