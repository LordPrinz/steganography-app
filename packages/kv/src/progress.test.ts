import { describe, expect, test } from "bun:test";
import { createMemoryStore } from "./memory.ts";
import { createProgressStore } from "./progress.ts";

describe("progress store", () => {
  test("a report round-trips under op:{id}:progress", async () => {
    const kv = createMemoryStore();
    const progress = createProgressStore(kv);
    await progress.put("op1", { done: 3, total: 33 });
    expect(await progress.get("op1")).toEqual({ done: 3, total: 33 });
    expect(JSON.parse((await kv.get("op:op1:progress")) as string)).toEqual({ done: 3, total: 33 });
  });

  test("nothing reported, an expired report and a damaged value read as null", async () => {
    let now = 0;
    const kv = createMemoryStore(() => now);
    const progress = createProgressStore(kv);
    expect(await progress.get("none")).toBeNull();

    await progress.put("op1", { done: 1, total: 2 }, 1_000);
    now = 1_001;
    expect(await progress.get("op1")).toBeNull();

    for (const raw of ["not json", '{"done":-1,"total":2}', '{"done":1}', '{"done":1,"total":0}']) {
      await kv.set("op:bad:progress", raw, 1_000);
      expect(await progress.get("bad")).toBeNull();
    }
  });
});
