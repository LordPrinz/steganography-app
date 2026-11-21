import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { HttpError, MAX_JSON_BYTES, parseBody, readBody } from "./http.ts";

function chunked(...parts: string[]): Request {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
  return new Request("http://localhost/", { method: "POST", body, duplex: "half" } as RequestInit);
}

async function status(promise: Promise<unknown>): Promise<number | undefined> {
  return promise.then(
    () => undefined,
    (error) => (error instanceof HttpError ? error.status : -1),
  );
}

describe("readBody", () => {
  test("returns a body within the cap", async () => {
    expect(new TextDecoder().decode(await readBody(chunked("ab", "cd"), 4))).toBe("abcd");
  });

  test("refuses a declared length over the cap without reading", async () => {
    const req = new Request("http://localhost/", {
      method: "POST",
      body: "x".repeat(10),
    });
    expect(await status(readBody(req, 9))).toBe(413);
  });

  test("stops a chunked body that grows past the cap", async () => {
    expect(await status(readBody(chunked("abc", "de"), 4))).toBe(413);
  });
});

describe("parseBody", () => {
  const schema = z.object({ name: z.string() });

  test("holds JSON to 64 KiB", async () => {
    const big = JSON.stringify({ name: "x".repeat(MAX_JSON_BYTES) });
    expect(await status(parseBody(chunked(big), schema))).toBe(413);
  });

  test("parses and validates", async () => {
    expect(await parseBody(chunked('{"name":"ann"}'), schema)).toEqual({ name: "ann" });
    expect(await status(parseBody(chunked("{"), schema))).toBe(400);
    expect(await status(parseBody(chunked("{}"), schema))).toBe(400);
  });
});
