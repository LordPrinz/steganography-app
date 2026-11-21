import {
  AUTO_SELECTIONS,
  type DecodeAttempt,
  DecodeParams,
  type DecodeResult,
  type MethodSelection,
} from "@stego/contracts";
import { type ImageRepository, JobError } from "@stego/db";
import { capacity, createMethod, MAX_MESSAGE_BYTES, reveal } from "@stego/engine";
import type { ObjectStore } from "@stego/storage";
import type { JobHandler } from "../handlers.ts";
import { loadSource } from "./source.ts";

export interface DecodeDeps {
  images: Pick<ImageRepository, "findOwned">;
  storage: Pick<ObjectStore, "get">;
}

/**
 * Tries the chosen method, or every method with its defaults for "auto", and records what each one made
 * of the image. The first message found goes to the user through Redis; the result keeps only outcomes.
 */
export function createDecodeHandler(deps: DecodeDeps): JobHandler {
  return async ({ operation }, context) => {
    const params = DecodeParams.safeParse(operation.params);
    if (!params.success) throw new JobError("invalid_params");
    const selections: readonly MethodSelection[] =
      params.data.method === "auto" ? AUTO_SELECTIONS : [params.data.method];

    const source = await loadSource(deps, operation);
    const attempts: DecodeAttempt[] = [];
    let found: string | null = null;
    for (const selection of selections) {
      context.signal.throwIfAborted();
      let method: ReturnType<typeof createMethod>;
      try {
        method = createMethod(selection);
      } catch (error) {
        if (error instanceof RangeError) throw new JobError("invalid_params", { cause: error });
        throw error;
      }
      // The codec reads the header first and the rest only for a plausible frame; count what it asked for.
      let bitsRead = 0;
      const counting: typeof method = {
        ...method,
        extract: (image, bitCount) => {
          bitsRead = Math.max(bitsRead, bitCount);
          return method.extract(image, bitCount);
        },
      };
      const started = performance.now();
      const revealed = reveal(source, counting);
      const decodeMs = Math.round(performance.now() - started);
      const messageBytes = revealed.ok
        ? new TextEncoder().encode(revealed.message).byteLength
        : null;
      attempts.push({
        method: selection.id,
        outcome: revealed.ok ? "found" : revealed.error,
        messageBytes,
        bitsRead,
        capacityBytes: Math.min(capacity(source.width, source.height, method), MAX_MESSAGE_BYTES),
        decodeMs,
      });
      if (revealed.ok && found === null) found = revealed.message;
    }

    context.signal.throwIfAborted();
    if (found !== null) await context.reveal(found);
    const result: DecodeResult = {
      kind: "decode",
      attempts,
      detected: attempts.find(({ outcome }) => outcome === "found")?.method ?? null,
    };
    return result;
  };
}
