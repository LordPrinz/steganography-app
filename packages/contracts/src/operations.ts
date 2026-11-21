import { z } from "zod";
import { ImageDetail, MAX_PAGE_SIZE } from "./images.ts";
import { JobStatus } from "./jobs.ts";
import { StegoMethod } from "./methods.ts";

const Position = z.tuple([z.int().min(0).max(7), z.int().min(0).max(7)]);

const LsbParams = z.strictObject({ bitsPerChannel: z.int().min(1).max(8).default(1) });

const KochZhaoParams = z
  .strictObject({
    pair: z.tuple([Position, Position]).default([
      [3, 2],
      [2, 3],
    ]),
    strength: z.number().gt(0).max(1024).default(40),
  })
  .refine(
    ({ pair }) => pair.every(([u, v]) => u !== 0 || v !== 0),
    "The DC coefficient cannot be used",
  )
  .refine(({ pair: [a, b] }) => a[0] !== b[0] || a[1] !== b[1], "The two positions must differ");

// Rounding to 8-bit pixels moves a level-L coefficient by up to 2^L / 2, so the step has to exceed 2^(L+1).
const DwtQimParams = z
  .strictObject({
    band: z.enum(["LL", "HL", "LH"]).default("LL"),
    level: z.int().min(1).max(8).default(2),
    step: z.number().gt(0).max(255).default(32),
  })
  .refine(({ level, step }) => step > 2 ** (level + 1), "The step must exceed 2^(level + 1)");

const ErrorCorrection = z.discriminatedUnion("code", [
  z.strictObject({
    code: z.literal("repetition"),
    factor: z
      .int()
      .min(3)
      .max(15)
      .refine((n) => n % 2 === 1),
  }),
  z.strictObject({ code: z.literal("hamming74") }),
]);

/** One entry per method; a new method is a new entry here and in the engine's registry. */
const METHOD_SELECTIONS = {
  lsb: z.strictObject({
    id: z.literal("lsb"),
    params: LsbParams.prefault({}),
    ecc: ErrorCorrection.optional(),
  }),
  "dct-koch-zhao": z.strictObject({
    id: z.literal("dct-koch-zhao"),
    params: KochZhaoParams.prefault({}),
    ecc: ErrorCorrection.optional(),
  }),
  "dwt-qim": z.strictObject({
    id: z.literal("dwt-qim"),
    params: DwtQimParams.prefault({}),
    ecc: ErrorCorrection.optional(),
  }),
} satisfies Record<StegoMethod, z.ZodType>;

/** A method with its parameters (defaults fill the gaps) and an optional error-correcting code. */
export const MethodSelection = z.discriminatedUnion("id", [
  METHOD_SELECTIONS.lsb,
  METHOD_SELECTIONS["dct-koch-zhao"],
  METHOD_SELECTIONS["dwt-qim"],
]);
export type MethodSelection = z.output<typeof MethodSelection>;

/** What `decode` tries for `"auto"`: every method with its default parameters and no error correction. */
export const AUTO_SELECTIONS: readonly MethodSelection[] = StegoMethod.options.map((id) =>
  MethodSelection.parse({ id }),
);

/** Operations a user may have queued or running at once. */
export const MAX_ACTIVE_OPERATIONS_PER_USER = 5;

/**
 * No length cap here: the engine's byte limit is checked against the image's capacity, which answers a
 * too-long message with its sizes. The route's body cap bounds what is read.
 */
export const EncodeRequest = z.strictObject({
  imageId: z.uuid(),
  message: z.string().min(1),
  /** One layer until layered embedding exists. */
  layers: z.tuple([MethodSelection]),
});
export type EncodeRequest = z.infer<typeof EncodeRequest>;

export const DecodeRequest = z.strictObject({
  imageId: z.uuid(),
  method: z.union([z.literal("auto"), MethodSelection]),
});
export type DecodeRequest = z.infer<typeof DecodeRequest>;

/** What the encode job reads from `operations.params`; the message is never part of it. */
export const EncodeParams = EncodeRequest.pick({ layers: true });
export const DecodeParams = DecodeRequest.pick({ method: true });

export const OperationType = z.enum(["encode", "decode"]);
export type OperationType = z.infer<typeof OperationType>;

export const EncodeResult = z.object({
  kind: z.literal("encode"),
  messageBytes: z.number().int().nonnegative(),
  capacityBytes: z.number().int().nonnegative(),
  /** dB; null when the stego image is identical to the source (PSNR is infinite). */
  psnr: z.number().nullable(),
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
});
export type DecodeResult = z.infer<typeof DecodeResult>;

export const OperationResult = z.discriminatedUnion("kind", [EncodeResult, DecodeResult]);
export type OperationResult = z.infer<typeof OperationResult>;

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

export const OperationPage = z.object({
  operations: z.array(OperationSummary),
  /** Pass as `cursor` for the next page; null on the last one. */
  nextCursor: z.string().nullable(),
});
export type OperationPage = z.infer<typeof OperationPage>;

/** One operation with a fresh presigned URL for its result image and, for a decode, the revealed message. */
export const Operation = OperationSummary.omit({ resultImageId: true }).extend({
  /** The stego image of a finished encode, with a fresh presigned URL. */
  resultImage: ImageDetail.nullable(),
  /** The decoded message while its short-lived key exists, null afterwards. Never stored in Postgres. */
  revealed: z.string().nullable(),
});
export type Operation = z.infer<typeof Operation>;
