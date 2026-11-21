import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodePng } from "@stego/image-io";
import { parseCli, resolvePlan } from "../src/args.ts";
import { CSV_HEADER, summaryTable, toCsv } from "../src/report.ts";
import { runBench } from "../src/run.ts";

const dir = mkdtempSync(join(tmpdir(), "bench-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A 128 x 128 image with a gradient and some texture, small enough to run in milliseconds. */
async function writeImage(name: string): Promise<string> {
  const data = new Uint8ClampedArray(128 * 128 * 4);
  for (let i = 0; i < 128 * 128; i++) {
    const x = i % 128;
    const y = Math.floor(i / 128);
    data[i * 4] = x * 2;
    data[i * 4 + 1] = y * 2;
    data[i * 4 + 2] = (x * y) % 256;
    data[i * 4 + 3] = 255;
  }
  const path = join(dir, name);
  await Bun.write(path, await encodePng({ width: 128, height: 128, data }));
  return path;
}

describe("bench end to end", () => {
  test("runs the matrix on a small image and writes the CSV", async () => {
    const image = await writeImage("small.png");
    const csv = join(dir, "out.csv");
    const plan = await resolvePlan(
      parseCli([
        image,
        "--method",
        "lsb",
        "--method",
        "kochZhao",
        "--scenario",
        "none",
        "--scenario",
        "jpeg75",
        "--payload",
        "message:4",
      ]),
    );
    const skipped: string[] = [];
    const rows = await runBench(plan, (message) => skipped.push(message));

    expect(skipped).toEqual([]);
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => `${r.method} ${r.attack}`)).toEqual([
      "lsb none",
      "lsb jpeg75",
      "kochZhao none",
      "kochZhao jpeg75",
    ]);
    for (const row of rows.filter((r) => r.attack === "none")) {
      expect(row).toMatchObject({ image: "small.png", success: true, ber: 0 });
    }
    expect(rows[1]?.success).toBe(false);

    await Bun.write(csv, toCsv(rows));
    const lines = readFileSync(csv, "utf8").trim().split("\n");
    expect(lines[0]).toBe(CSV_HEADER);
    expect(lines).toHaveLength(5);
    expect(lines[1]?.split(",").slice(0, 5)).toEqual([
      "small.png",
      "lsb",
      "bits=1",
      "none",
      "true",
    ]);
    expect(summaryTable(rows)).toContain("| lsb bits=1 |");
  });

  test("skips a method whose capacity is too small for the message", async () => {
    const image = await writeImage("tiny.png");
    const plan = await resolvePlan(
      parseCli([image, "--method", "kochZhao", "--scenario", "none", "--payload", "message:200"]),
    );
    const skipped: string[] = [];
    expect(await runBench(plan, (message) => skipped.push(message))).toEqual([]);
    expect(skipped).toHaveLength(1);
  });
});
