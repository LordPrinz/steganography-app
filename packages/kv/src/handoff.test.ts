import { describe, expect, test } from "bun:test";
import { MAX_MESSAGE_BYTES } from "@stego/engine";
import { createMessageHandoff } from "./handoff.ts";
import { createMemoryStore } from "./memory.ts";

describe("message handoff", () => {
  test("a message round-trips under op:{id}:message", async () => {
    const kv = createMemoryStore();
    const handoff = createMessageHandoff(kv);
    await handoff.putMessage("op1", "secret zażółć");
    expect(await handoff.getMessage("op1")).toBe("secret zażółć");
    expect(await kv.get("op:op1:message")).toBe("secret zażółć");
  });

  test("delete removes the message", async () => {
    const handoff = createMessageHandoff(createMemoryStore());
    await handoff.putMessage("op1", "x");
    await handoff.deleteMessage("op1");
    expect(await handoff.getMessage("op1")).toBeNull();
  });

  test("an expired message reads as null", async () => {
    let now = 0;
    const handoff = createMessageHandoff(createMemoryStore(() => now));
    await handoff.putMessage("op1", "x", 1_000);
    now = 1_001;
    expect(await handoff.getMessage("op1")).toBeNull();
  });

  test("a revealed message lives under its own key and expires", async () => {
    let now = 0;
    const handoff = createMessageHandoff(createMemoryStore(() => now));
    await handoff.putRevealed("op1", "hello", 1_000);
    expect(await handoff.getRevealed("op1")).toBe("hello");
    expect(await handoff.getMessage("op1")).toBeNull();
    now = 1_001;
    expect(await handoff.getRevealed("op1")).toBeNull();
  });

  test("rejects a message over the engine limit, counted in bytes", async () => {
    const handoff = createMessageHandoff(createMemoryStore());
    await handoff.putMessage("op1", "x".repeat(MAX_MESSAGE_BYTES));
    await expect(handoff.putMessage("op2", "x".repeat(MAX_MESSAGE_BYTES + 1))).rejects.toThrow(
      RangeError,
    );
    await expect(handoff.putMessage("op3", "ż".repeat(MAX_MESSAGE_BYTES / 2 + 1))).rejects.toThrow(
      RangeError,
    );
    await expect(handoff.putRevealed("op4", "x".repeat(MAX_MESSAGE_BYTES + 1))).rejects.toThrow(
      RangeError,
    );
  });
});
