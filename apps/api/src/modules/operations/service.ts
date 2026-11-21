import {
  type DecodeRequest,
  type EncodeRequest,
  type ListOperationsQuery,
  MAX_ACTIVE_OPERATIONS_PER_USER,
  type MethodSelection,
  type Operation,
  type OperationAccepted,
  type OperationPage,
  OperationResult,
  OperationSummary,
  OperationType,
} from "@stego/contracts";
import type {
  ImageRepository,
  KeysetCursor,
  NewOperation,
  OperationRepository,
  OperationView,
} from "@stego/db";
import { capacity, createMethod, MAX_MESSAGE_BYTES } from "@stego/engine";
import type { KeyValueStore, MessageHandoff, WakePublisher } from "@stego/kv";
import { z } from "zod";
import { encodeCursor } from "../../lib/cursor.ts";
import type { ImageService } from "../images/service.ts";

/** The source image does not exist or belongs to someone else. */
export class SourceNotFoundError extends Error {
  override readonly name = "SourceNotFoundError";
}

/** The method rejects its parameters (a combination the contract schema cannot express). */
export class InvalidMethodError extends Error {
  override readonly name = "InvalidMethodError";
}

/** The message does not fit the image. The sizes are UTF-8 bytes; neither one is the message. */
export class MessageTooLargeError extends Error {
  override readonly name = "MessageTooLargeError";

  constructor(
    readonly needed: number,
    readonly available: number,
  ) {
    super("Message does not fit in the image");
  }
}

/** The user already has as many queued or running operations as allowed. */
export class TooManyActiveOperationsError extends Error {
  override readonly name = "TooManyActiveOperationsError";
}

/** The operation is still queued or running; only a finished one can be deleted. */
export class OperationActiveError extends Error {
  override readonly name = "OperationActiveError";
}

export interface OperationService {
  /** Throws `SourceNotFoundError`, `InvalidMethodError`, `MessageTooLargeError` or `TooManyActiveOperationsError`. */
  encode(userId: string, request: EncodeRequest): Promise<OperationAccepted>;
  /** Throws `SourceNotFoundError`, `InvalidMethodError` or `TooManyActiveOperationsError`. */
  decode(userId: string, request: DecodeRequest): Promise<OperationAccepted>;
  /** Null when the operation does not exist or belongs to someone else. */
  get(userId: string, id: string): Promise<Operation | null>;
  /** Newest first, with no URLs and no revealed message. */
  list(
    userId: string,
    options: Pick<ListOperationsQuery, "limit" | "type" | "status" | "method"> & {
      after?: KeysetCursor;
    },
  ): Promise<OperationPage>;
  /** Removes the entry, not its images. False when it does not exist or belongs to someone else; throws `OperationActiveError` while it is queued or running. */
  remove(userId: string, id: string): Promise<boolean>;
}

export interface OperationServiceDeps {
  operations: OperationRepository;
  images: Pick<ImageRepository, "findOwned">;
  /** Presigns the result image after checking the user owns it. */
  imageUrls: Pick<ImageService, "get">;
  handoff: Pick<MessageHandoff, "putMessage" | "deleteMessage" | "getRevealed">;
  /** Told after each new job committed, so an idle worker picks it up without waiting for its poll. */
  wake: WakePublisher;
  /** Caches finished operations for polling. */
  kv: Pick<KeyValueStore, "get" | "set" | "del">;
  maxActive?: number;
  cacheTtlMs?: number;
  log?: Pick<Console, "error">;
}

const DEFAULT_CACHE_TTL_MS = 10 * 60_000;

/** What a finished operation shows apart from the parts that must stay fresh: URL and revealed message. */
const CachedOperation = OperationSummary.extend({ userId: z.string() });
type CachedOperation = z.infer<typeof CachedOperation>;

const cacheKey = (id: string) => `op:${id}:view`;

function toSummary(row: OperationView): OperationSummary {
  return {
    id: row.id,
    type: OperationType.parse(row.type),
    status: row.status,
    method: row.method ?? "auto",
    sourceImageId: row.source_image_id,
    resultImageId: row.result_image_id,
    params: row.params,
    result: OperationResult.safeParse(row.result).data ?? null,
    // Only a failed job's code is a result; a retrying job still carries its last attempt's code.
    error: row.status === "failed" ? row.error : null,
    createdAt: row.created_at.toISOString(),
  };
}

/** Succeeded and failed operations never change again. */
const isFinished = ({ status }: CachedOperation) => status === "succeeded" || status === "failed";

/** Returns the selection's method, or throws `InvalidMethodError`. */
function buildMethod(selection: MethodSelection) {
  try {
    return createMethod(selection);
  } catch (error) {
    if (error instanceof RangeError) throw new InvalidMethodError(error.message);
    throw error;
  }
}

export function createOperationService({
  operations,
  images,
  imageUrls,
  handoff,
  wake,
  kv,
  maxActive = MAX_ACTIVE_OPERATIONS_PER_USER,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  log = console,
}: OperationServiceDeps): OperationService {
  async function ownedImage(userId: string, id: string) {
    const image = await images.findOwned(userId, id);
    if (!image) throw new SourceNotFoundError();
    return image;
  }

  // The message goes to Redis first, so a worker that claims the job right away finds it. If the
  // operation is not created after all, the message is dropped at once instead of waiting for its TTL.
  async function enqueue(
    operation: Omit<NewOperation, "id">,
    message?: string,
  ): Promise<OperationAccepted> {
    const id = crypto.randomUUID();
    if (message !== undefined) await handoff.putMessage(id, message);
    const discard = () =>
      message === undefined
        ? Promise.resolve()
        : handoff.deleteMessage(id).catch((error) => {
            log.error("Could not drop the message of an operation that was not created", error);
          });
    try {
      const row = await operations.createWithJob({ ...operation, id }, { maxActive });
      if (!row) {
        await discard();
        throw new TooManyActiveOperationsError();
      }
      // After the commit, never inside it: a worker woken early would find no job.
      await wake.notify();
      return { id, status: row.status };
    } catch (error) {
      if (!(error instanceof TooManyActiveOperationsError)) await discard();
      throw error;
    }
  }

  async function readCache(id: string): Promise<CachedOperation | null> {
    try {
      const raw = await kv.get(cacheKey(id));
      if (raw === null) return null;
      const parsed = CachedOperation.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch (error) {
      log.error("Operation cache unavailable; reading from the database", error);
      return null;
    }
  }

  async function writeCache(cached: CachedOperation): Promise<void> {
    try {
      await kv.set(cacheKey(cached.id), JSON.stringify(cached), cacheTtlMs);
    } catch (error) {
      log.error("Could not cache an operation", error);
    }
  }

  async function readRevealed(id: string): Promise<string | null> {
    try {
      return await handoff.getRevealed(id);
    } catch (error) {
      log.error("Could not read a revealed message", error);
      return null;
    }
  }

  return {
    async encode(userId, { imageId, message, layers: [selection] }) {
      const image = await ownedImage(userId, imageId);
      const method = buildMethod(selection);
      const needed = new TextEncoder().encode(message).byteLength;
      const available = Math.min(capacity(image.width, image.height, method), MAX_MESSAGE_BYTES);
      if (needed > available) throw new MessageTooLargeError(needed, available);
      return enqueue(
        {
          userId,
          type: "encode",
          method: selection.id,
          sourceImageId: image.id,
          params: { layers: [selection] },
        },
        message,
      );
    },

    async decode(userId, { imageId, method }) {
      const image = await ownedImage(userId, imageId);
      if (method !== "auto") buildMethod(method);
      return enqueue({
        userId,
        type: "decode",
        method: method === "auto" ? null : method.id,
        sourceImageId: image.id,
        params: { method },
      });
    },

    async get(userId, id) {
      let cached = await readCache(id);
      // A cached entry of someone else's operation is as good as a miss: no second lookup.
      if (cached && cached.userId !== userId) return null;
      if (!cached) {
        const row = await operations.findOwned(userId, id);
        if (!row) return null;
        cached = { ...toSummary(row), userId: row.user_id };
        if (isFinished(cached)) await writeCache(cached);
      }
      const resultImage = cached.resultImageId
        ? await imageUrls.get(userId, cached.resultImageId)
        : null;
      const revealed =
        cached.type === "decode" && cached.status === "succeeded" ? await readRevealed(id) : null;
      const { userId: _, resultImageId: __, ...summary } = cached;
      return { ...summary, resultImage, revealed };
    },

    async list(userId, { limit, after, type, status, method }) {
      const page = await operations.listPage(userId, {
        limit,
        after,
        filter: { type, status, method: method === "auto" ? null : method },
      });
      return {
        operations: page.operations.map(toSummary),
        nextCursor: page.next && encodeCursor(page.next),
      };
    },

    async remove(userId, id) {
      const row = await operations.findOwned(userId, id);
      if (!row) return false;
      if (!(await operations.deleteFinishedOwned(userId, id))) throw new OperationActiveError();
      // A cached view would keep answering for the owner after the row is gone.
      await kv.del(cacheKey(id)).catch((error) => {
        log.error("Could not drop a deleted operation from the cache", error);
      });
      return true;
    },
  };
}
