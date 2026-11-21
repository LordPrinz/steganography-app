import { describe, expect, test } from "bun:test";
import { BusyError, createConcurrencyLimit } from "./concurrency-limit.ts";

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

describe("createConcurrencyLimit", () => {
  test("runs tasks up to the slot count and rejects the rest at once", async () => {
    const limit = createConcurrencyLimit(2);
    const held = [gate(), gate()];
    const running = held.map((g) => limit.run(() => g.opened));

    await expect(limit.run(async () => "third")).rejects.toBeInstanceOf(BusyError);

    for (const g of held) g.open();
    await Promise.all(running);
  });

  test("frees a slot when a task finishes or throws", async () => {
    const limit = createConcurrencyLimit(1);
    await expect(
      limit.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await limit.run(async () => "ok")).toBe("ok");
  });

  test("returns the task's result", async () => {
    expect(await createConcurrencyLimit(1).run(async () => 42)).toBe(42);
  });

  test("rejects a slot count that is not a positive integer", () => {
    for (const slots of [0, -1, 1.5, Number.NaN]) {
      expect(() => createConcurrencyLimit(slots)).toThrow(RangeError);
    }
  });
});
