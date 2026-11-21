import { parseCli, resolvePlan, USAGE } from "./args.ts";
import { presets } from "./presets.ts";
import { summaryTable, toCsv } from "./report.ts";
import { runBench } from "./run.ts";

async function main(): Promise<void> {
  const options = parseCli(Bun.argv.slice(2));
  if (options.help) {
    console.info(USAGE);
    return;
  }
  if (options.list) {
    for (const [name, preset] of Object.entries(presets))
      console.info(`${name}: ${preset.description}`);
    return;
  }

  const plan = await resolvePlan(options);
  const rows = await runBench(plan, (message) => console.error(message));
  console.info(summaryTable(rows));
  if (options.csv) await Bun.write(options.csv, toCsv(rows));
  if (options.json) await Bun.write(options.json, `${JSON.stringify(rows, null, 2)}\n`);
}

try {
  await main();
} catch (error) {
  console.error(`${(error as Error).message}\n\n${USAGE}`);
  process.exit(1);
}
