import { z } from "zod";
import { ExperimentProgress, ExperimentResult, ExperimentResultSummary } from "./experiments.ts";
import { ImageDetail, MAX_PAGE_SIZE } from "./images.ts";
import { JobStatus } from "./jobs.ts";
import { StegoMethod } from "./methods.ts";
import { LayerList, MAX_LAYERS, MethodSelection, MethodSelectionList } from "./selections.ts";

/** Operations a user may have queued or running at once. */
export const MAX_ACTIVE_OPERATIONS_PER_USER = 5;

/**
 * No length cap here: the engine's byte limit is checked against the image's capacity, which answers a
 * too-long message with its sizes. The route's body cap bounds what is read.
 */
export const EncodeRequest = z.strictObject({
  imageId: z.uuid(),
  /** One message per layer, each with its own method; the engine fixes the embedding order. */
  layers: LayerList,
});
export type EncodeRequest = z.infer<typeof EncodeRequest>;

export const DecodeRequest = z.strictObject({
  imageId: z.uuid(),
  /**
   * `"auto"` tries every method with its defaults and no code. A method, or a list of up to 3 with
   * different ids, tries exactly those (a layer with other parameters or a code needs its own
   * selection). Every layer found is revealed.
   */
  method: z.union([z.literal("auto"), MethodSelection, MethodSelectionList]),
});
export type DecodeRequest = z.infer<typeof DecodeRequest>;

/** What the encode job reads from `operations.params`: the layers' methods in request order, no messages. */
export const EncodeParams = z.object({ layers: z.array(MethodSelection).min(1).max(MAX_LAYERS) });
export type EncodeParams = z.infer<typeof EncodeParams>;
export const DecodeParams = DecodeRequest.pick({ method: true });

export const OperationType = z.enum(["encode", "decode", "experiment"]);
export type OperationType = z.infer<typeof OperationType>;

export const EncodeLayerResult = z.object({
  method: StegoMethod,
  messageBytes: z.number().int().nonnegative(),
  capacityBytes: z.number().int().nonnegative(),
});
export type EncodeLayerResult = z.infer<typeof EncodeLayerResult>;

export const EncodeResult = z.object({
  kind: z.literal("encode"),
  /** In request order. */
  layers: z.array(EncodeLayerResult).min(1),
  /** Of the whole image with every layer: dB; null when it equals the source (PSNR is infinite). */
  psnr: z.number().nullable(),
  /** Null when a side is under 11 pixels, where SSIM is undefined. */
  ssim: z.number().nullable(),
  encodeMs: z.number().nonnegative(),
});
export type EncodeResult = z.infer<typeof EncodeResult>;

export const DecodeOutcome = z.enum(["found", "no-message", "corrupted", "method-mismatch"]);
export type DecodeOutcome = z.infer<typeof DecodeOutcome>;

export const DecodeAttempt = z.object({
  method: StegoMethod,
  outcome: DecodeOutcome,
  /** UTF-8 length of the message read; null unless it was found. */
  messageBytes: z.number().int().nonnegative().nullable(),
  /** Bits the method extracted: the frame header alone when no frame was found, else the whole frame. */
  bitsRead: z.number().int().nonnegative(),
  capacityBytes: z.number().int().nonnegative(),
  decodeMs: z.number().nonnegative(),
});
export type DecodeAttempt = z.infer<typeof DecodeAttempt>;

export const DecodeResult = z.object({
  kind: z.literal("decode"),
  attempts: z.array(DecodeAttempt),
  /** The first method that found a message. */
  detected: StegoMethod.nullable(),
  /** Every method that found a message, in the order tried. */
  found: z.array(StegoMethod).default([]),
});
export type DecodeResult = z.infer<typeof DecodeResult>;

export const OperationResult = z.discriminatedUnion("kind", [
  EncodeResult,
  DecodeResult,
  ExperimentResult,
]);
export type OperationResult = z.infer<typeof OperationResult>;

/** `OperationResult` as the history list shows it: an experiment without its variants and aggregates. */
export const OperationResultSummary = z.discriminatedUnion("kind", [
  EncodeResult,
  DecodeResult,
  ExperimentResultSummary,
]);
export type OperationResultSummary = z.infer<typeof OperationResultSummary>;

export const OperationAccepted = z.object({
  id: z.uuid(),
  status: JobStatus,
});
export type OperationAccepted = z.infer<typeof OperationAccepted>;

/** One row of the history: everything stored about an operation, with no URLs and no revealed message. */
export const OperationSummary = z.object({
  id: z.uuid(),
  type: OperationType,
  status: JobStatus,
  /** The method asked for; "auto" for a decode that tries them all. */
  method: z.union([StegoMethod, z.literal("auto")]),
  sourceImageId: z.uuid().nullable(),
  resultImageId: z.uuid().nullable(),
  /** The settings the user chose. Never the hidden message. */
  params: z.record(z.string(), z.unknown()),
  result: OperationResult.nullable(),
  /** Short public code of a failed job (e.g. `message_expired`). */
  error: z.string().nullable(),
  /** For a failed layered job, the index in the request of the layer it stopped on. */
  // The default keeps cache entries written before this field existed parsing.
  failedLayer: z.int().min(0).max(2).nullable().default(null),
  createdAt: z.iso.datetime(),
});
export type OperationSummary = z.infer<typeof OperationSummary>;

export const ListOperationsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(24),
  /** The opaque `nextCursor` of the previous page. */
  cursor: z.string().min(1).max(256).optional(),
  type: OperationType.optional(),
  /** `auto` selects decodes that try every method. */
  method: z.union([StegoMethod, z.literal("auto")]).optional(),
  status: JobStatus.optional(),
});
export type ListOperationsQuery = z.infer<typeof ListOperationsQuery>;

/** A history row: like `OperationSummary`, with a lighter experiment result. */
export const OperationListItem = OperationSummary.extend({
  result: OperationResultSummary.nullable(),
});
export type OperationListItem = z.infer<typeof OperationListItem>;

export const OperationPage = z.object({
  operations: z.array(OperationListItem),
  /** Pass as `cursor` for the next page; null on the last one. */
  nextCursor: z.string().nullable(),
});
export type OperationPage = z.infer<typeof OperationPage>;

/** One operation with a fresh presigned URL for its result image and, for a decode, the revealed message. */
export const Operation = OperationSummary.omit({ resultImageId: true }).extend({
  /** The stego image of a finished encode, with a fresh presigned URL. */
  resultImage: ImageDetail.nullable(),
  /** The decoded messages by method while their short-lived key exists, null afterwards. Never stored in Postgres. */
  revealed: z.partialRecord(StegoMethod, z.string()).nullable(),
});
export type Operation = z.infer<typeof Operation>;

/**
 * A robustness experiment: its history entry plus live progress and fresh presigned URLs for the stored
 * attacked images that still exist (they expire a day after the run). Never holds the hidden message.
 */
export const Experiment = OperationSummary.omit({ resultImageId: true }).extend({
  /** Variants done of the total while queued or running; null otherwise. */
  progress: ExperimentProgress.nullable(),
  /** Keyed by the `imageId` of the result's variants. */
  variantImages: z.record(z.uuid(), ImageDetail),
});
export type Experiment = z.infer<typeof Experiment>;
