import { MAX_MESSAGE_BYTES } from "@stego/engine";
import type { KeyValueStore } from "./store.ts";

/** How long a message to hide waits for the worker. */
export const MESSAGE_TTL_MS = 15 * 60_000;
/** How long a revealed message stays readable after a decode finishes. */
export const REVEALED_TTL_MS = 5 * 60_000;

/** Most messages one operation hands over: one per layer of a layered embedding. */
export const MAX_HANDOFF_MESSAGES = 3;

/** What a decode found, by method id. */
export type RevealedMessages = Readonly<Record<string, string>>;

/**
 * The hidden messages cross between API and worker through Redis only, never through Postgres or the
 * logs (ADR 3). One entry holds all the messages of an operation (one per layer, in request order) as
 * a JSON array. Keys are built from the operation id alone, so no user input reaches a key name.
 */
export interface MessageHandoff {
  /**
   * API, inbound: leaves the messages for the worker. Rejects none or more than `MAX_HANDOFF_MESSAGES`,
   * and any one over `MAX_MESSAGE_BYTES`. The caller must first check that the operation belongs to the
   * current user; the id is no authorisation.
   */
  putMessages(operationId: string, messages: readonly string[], ttlMs?: number): Promise<void>;
  /** Worker, inbound: null once the messages expired or were deleted. */
  getMessages(operationId: string): Promise<string[] | null>;
  /** Worker: drops the messages once the job is in a final state. */
  deleteMessage(operationId: string): Promise<void>;
  /** Worker, outbound: leaves what a decode found, by method id, for the user to fetch. */
  putRevealed(operationId: string, revealed: RevealedMessages, ttlMs?: number): Promise<void>;
  /**
   * API, outbound: null once the revealed messages expired. The caller must first check that the
   * operation belongs to the current user; the id is unguessable but no authorisation check.
   */
  getRevealed(operationId: string): Promise<RevealedMessages | null>;
  /** API: drops revealed messages at once, e.g. when their operation is deleted. */
  deleteRevealed(operationId: string): Promise<void>;
}

function assertSize(message: string): void {
  // Redis stores UTF-8, so count encoded bytes the way the codec does.
  if (new TextEncoder().encode(message).byteLength > MAX_MESSAGE_BYTES) {
    throw new RangeError(`Message is longer than ${MAX_MESSAGE_BYTES} bytes`);
  }
}

/** The shape `putMessages` writes: 1 to `MAX_HANDOFF_MESSAGES` strings, each within the byte limit. */
const isMessages = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length >= 1 &&
  value.length <= MAX_HANDOFF_MESSAGES &&
  value.every(
    (item) =>
      typeof item === "string" && new TextEncoder().encode(item).byteLength <= MAX_MESSAGE_BYTES,
  );

const isStringRecord = (value: unknown): value is Record<string, string> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every((item) => typeof item === "string");

/** A damaged or foreign value reads as absent, like an expired one. */
function parse<T>(raw: string | null, valid: (value: unknown) => value is T): T | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return valid(value) ? value : null;
  } catch {
    return null;
  }
}

export function createMessageHandoff(kv: KeyValueStore): MessageHandoff {
  const messageKey = (id: string) => `op:${id}:message`;
  const revealedKey = (id: string) => `op:${id}:revealed`;

  return {
    async putMessages(operationId, messages, ttlMs = MESSAGE_TTL_MS) {
      if (messages.length < 1 || messages.length > MAX_HANDOFF_MESSAGES) {
        throw new RangeError(`Expected 1 to ${MAX_HANDOFF_MESSAGES} messages`);
      }
      for (const message of messages) assertSize(message);
      await kv.set(messageKey(operationId), JSON.stringify(messages), ttlMs);
    },
    async getMessages(operationId) {
      return parse(await kv.get(messageKey(operationId)), isMessages);
    },
    deleteMessage: (operationId) => kv.del(messageKey(operationId)),
    async putRevealed(operationId, revealed, ttlMs = REVEALED_TTL_MS) {
      for (const message of Object.values(revealed)) assertSize(message);
      await kv.set(revealedKey(operationId), JSON.stringify(revealed), ttlMs);
    },
    async getRevealed(operationId) {
      return parse(await kv.get(revealedKey(operationId)), isStringRecord);
    },
    deleteRevealed: (operationId) => kv.del(revealedKey(operationId)),
  };
}
