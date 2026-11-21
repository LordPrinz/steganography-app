import { MAX_MESSAGE_BYTES } from "@stego/engine";
import type { KeyValueStore } from "./store.ts";

/** How long a message to hide waits for the worker. */
export const MESSAGE_TTL_MS = 15 * 60_000;
/** How long a revealed message stays readable after a decode finishes. */
export const REVEALED_TTL_MS = 5 * 60_000;

/**
 * The hidden message crosses between API and worker through Redis only, never through Postgres or the
 * logs (ADR 3). Keys are built from the operation id alone, so no user input reaches a key name.
 */
export interface MessageHandoff {
  /** API, inbound: leaves the message for the worker. Rejects one over `MAX_MESSAGE_BYTES`. */
  putMessage(operationId: string, message: string, ttlMs?: number): Promise<void>;
  /** Worker, inbound: null once the message expired or was deleted. */
  getMessage(operationId: string): Promise<string | null>;
  /** Worker: drops the message once the job is in a final state. */
  deleteMessage(operationId: string): Promise<void>;
  /** Worker, outbound: leaves a decoded message for the user to fetch. */
  putRevealed(operationId: string, message: string, ttlMs?: number): Promise<void>;
  /** API, outbound: null once the revealed message expired. */
  getRevealed(operationId: string): Promise<string | null>;
}

function assertSize(message: string): void {
  // Redis stores UTF-8, so count encoded bytes the way the codec does.
  if (new TextEncoder().encode(message).byteLength > MAX_MESSAGE_BYTES) {
    throw new RangeError(`Message is longer than ${MAX_MESSAGE_BYTES} bytes`);
  }
}

export function createMessageHandoff(kv: KeyValueStore): MessageHandoff {
  const messageKey = (id: string) => `op:${id}:message`;
  const revealedKey = (id: string) => `op:${id}:revealed`;

  return {
    async putMessage(operationId, message, ttlMs = MESSAGE_TTL_MS) {
      assertSize(message);
      await kv.set(messageKey(operationId), message, ttlMs);
    },
    getMessage: (operationId) => kv.get(messageKey(operationId)),
    deleteMessage: (operationId) => kv.del(messageKey(operationId)),
    async putRevealed(operationId, message, ttlMs = REVEALED_TTL_MS) {
      assertSize(message);
      await kv.set(revealedKey(operationId), message, ttlMs);
    },
    getRevealed: (operationId) => kv.get(revealedKey(operationId)),
  };
}
