import type {
  AttackGroup,
  ExperimentAggregate,
  ExperimentVariant,
  Scenario,
} from "@stego/contracts";

/** The attack group of a scenario, and the strength of its one attack. */
function describeScenario(scenario: Scenario): { attack: AttackGroup; strength: number | null } {
  const [only] = scenario;
  if (!only) return { attack: "none", strength: null };
  if (scenario.length > 1) return { attack: "combined", strength: null };
  if (only.type === "jpeg") return { attack: "jpeg", strength: only.quality };
  if (only.type === "resize") return { attack: "resize", strength: only.scale };
  return { attack: "blur", strength: only.sigma };
}

/**
 * One row per method (with its code) and scenario: the share of runs that read the message back and
 * the mean BER. A scenario listed twice in a request merges into one row with `variants: 2`.
 * Rows keep the order in which their group first appeared.
 */
export function aggregateVariants(variants: readonly ExperimentVariant[]): ExperimentAggregate[] {
  const groups = new Map<string, ExperimentVariant[]>();
  for (const variant of variants) {
    const key = `${variant.method}|${variant.ecc ?? ""}|${variant.label}`;
    const group = groups.get(key);
    if (group) group.push(variant);
    else groups.set(key, [variant]);
  }
  return [...groups.values()].map((group) => {
    const [first] = group as [ExperimentVariant, ...ExperimentVariant[]];
    return {
      method: first.method,
      ecc: first.ecc,
      ...describeScenario(first.scenario),
      label: first.label,
      successRate: group.filter(({ success }) => success).length / group.length,
      meanBer: group.reduce((sum, { ber }) => sum + ber, 0) / group.length,
      variants: group.length,
    };
  });
}
