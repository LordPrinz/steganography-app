import { describe, expect, test } from "bun:test";
import { MAX_MESSAGE_BYTES } from "@stego/engine";
import { createMessageHandoff, MAX_HANDOFF_MESSAGES } from "./handoff.ts";
import { createMemoryStore } from "./memory.ts";

describe("message handoff", () => {
  test("messages round-trip in order as JSON under op:{id}:message", async () => {
    const kv = createMemoryStore();
    const handoff = createMessageHandoff(kv);
    await handoff.putMessages("op1", ["secret zażółć", "second"]);
    expect(await handoff.getMessages("op1")).toEqual(["secret zażółć", "second"]);
    expect(JSON.parse((await kv.get("op:op1:message")) as string)).toEqual([
      "secret zażółć",
      "second",
    ]);
  });

  test("delete removes the messages", async () => {
    const handoff = createMessageHandoff(createMemoryStore());
    await handoff.putMessages("op1", ["x"]);
    await handoff.deleteMessage("op1");
    expect(await handoff.getMessages("op1")).toBeNull();
  });

  test("expired messages read as null", async () => {
    let now = 0;
    const handoff = createMessageHandoff(createMemoryStore(() => now));
    await handoff.putMessages("op1", ["x"], 1_000);
    now = 1_001;
    expect(await handoff.getMessages("op1")).toBeNull();
  });

  test("a damaged or foreign value reads as absent", async () => {
    const kv = createMemoryStore();
    const handoff = createMessageHandoff(kv);
    const tooMany = JSON.stringify(Array.from({ length: MAX_HANDOFF_MESSAGES + 1 }, () => "x"));
    const tooLong = JSON.stringify(["x".repeat(MAX_MESSAGE_BYTES + 1)]);
    // "plain text" is the format before messages became a list: in flight at a deploy, it reads as expired.
    for (const raw of ["not json", "{}", "[1]", "[]", '"text"', "plain text", tooMany, tooLong]) {
      await kv.set("op:bad:message", raw, 1_000);
      expect(await handoff.getMessages("bad")).toBeNull();
    }
  });

  test("revealed messages live under their own key, by method, and expire", async () => {
    let now = 0;
    const handoff = createMessageHandoff(createMemoryStore(() => now));
    await handoff.putRevealed("op1", { lsb: "hello", "dwt-qim": "hi" }, 1_000);
    expect(await handoff.getRevealed("op1")).toEqual({ lsb: "hello", "dwt-qim": "hi" });
    expect(await handoff.getMessages("op1")).toBeNull();
    now = 1_001;
    expect(await handoff.getRevealed("op1")).toBeNull();
  });

  test("revealed messages can be dropped at once", async () => {
    const handoff = createMessageHandoff(createMemoryStore());
    await handoff.putRevealed("op1", { lsb: "hello" });
    await handoff.deleteRevealed("op1");
    expect(await handoff.getRevealed("op1")).toBeNull();
  });

  test("rejects a message over the engine limit, counted in bytes", async () => {
    const handoff = createMessageHandoff(createMemoryStore());
    await handoff.putMessages("op1", ["x".repeat(MAX_MESSAGE_BYTES)]);
    await expect(
      handoff.putMessages("op2", ["x", "x".repeat(MAX_MESSAGE_BYTES + 1)]),
    ).rejects.toThrow(RangeError);
    await expect(
      handoff.putMessages("op3", ["ż".repeat(MAX_MESSAGE_BYTES / 2 + 1)]),
    ).rejects.toThrow(RangeError);
    await expect(
      handoff.putRevealed("op4", { lsb: "x".repeat(MAX_MESSAGE_BYTES + 1) }),
    ).rejects.toThrow(RangeError);
  });

  test("rejects no messages and more than the layer limit", async () => {
    const handoff = createMessageHandoff(createMemoryStore());
    await expect(handoff.putMessages("op1", [])).rejects.toThrow(RangeError);
    await expect(
      handoff.putMessages(
        "op2",
        Array.from({ length: MAX_HANDOFF_MESSAGES + 1 }, () => "x"),
      ),
    ).rejects.toThrow(RangeError);
    await handoff.putMessages(
      "op3",
      Array.from({ length: MAX_HANDOFF_MESSAGES }, () => "x"),
    );
  });
});
