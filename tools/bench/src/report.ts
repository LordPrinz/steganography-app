import type { BenchRow } from "./run.ts";

export const CSV_HEADER = "image,method,params,attack,success,ber,psnr,ssim,time_ms";

function field(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** One line per row, after `CSV_HEADER`. PSNR is `Infinity` for an unchanged image. */
export function toCsv(rows: readonly BenchRow[]): string {
  const lines = rows.map((r) =>
    [
      field(r.image),
      r.method,
      field(r.params),
      field(r.attack),
      r.success,
      r.ber.toFixed(6),
      r.psnr.toFixed(2),
      r.ssim.toFixed(4),
      r.timeMs.toFixed(1),
    ].join(","),
  );
  return `${[CSV_HEADER, ...lines].join("\n")}\n`;
}

const mean = (values: readonly number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;

/**
 * A Markdown table with one line per method and parameters: mean PSNR and SSIM over the images,
 * mean BER per attack, and how many runs revealed cleanly.
 */
export function summaryTable(rows: readonly BenchRow[]): string {
  const attacks = [...new Set(rows.map((r) => r.attack))];
  const groups = Map.groupBy(rows, (r) => `${r.method} ${r.params}`);
  const header = ["method", "PSNR dB", "SSIM", ...attacks.map((a) => `BER ${a}`), "ok"];
  const lines = [...groups].map(([label, group]) => {
    const berOf = (attack: string) =>
      mean(group.filter((r) => r.attack === attack).map((r) => r.ber)).toFixed(4);
    const clean = group.filter((r) => r.success).length;
    return [
      label,
      mean(group.map((r) => r.psnr)).toFixed(2),
      mean(group.map((r) => r.ssim)).toFixed(4),
      ...attacks.map(berOf),
      `${clean}/${group.length}`,
    ];
  });
  const row = (cells: readonly string[]) => `| ${cells.join(" | ")} |`;
  return [row(header), row(header.map(() => "---")), ...lines.map(row)].join("\n");
}
