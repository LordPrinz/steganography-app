import type { MethodSelection } from "@stego/contracts";
import { JobError } from "@stego/db";
import {
  CapacityExceededError,
  type ConfiguredMethod,
  createMethod,
  hideLayered,
  LayerConflictError,
  type RgbaImage,
} from "@stego/engine";

/** Builds the methods of a job's selections; parameters the engine rejects fail the job for good. */
export function buildMethods(selections: readonly MethodSelection[]): ConfiguredMethod[] {
  return selections.map((selection) => {
    try {
      return createMethod(selection);
    } catch (error) {
      if (error instanceof RangeError) throw new JobError("invalid_params", { cause: error });
      throw error;
    }
  });
}

/**
 * Hides every layer in one image (`hideLayered`; the engine fixes the order). A message that does not
 * fit, or a layer that does not survive the others, fails the job for good with `capacity_exceeded` or
 * `layer_conflict`; the error carries the index of the layer in the request, never the message.
 */
export function hideAll(
  cover: RgbaImage,
  methods: readonly ConfiguredMethod[],
  messages: readonly string[],
  /** Record the failing layer's index on the error (a request with layers); mode A and B have none. */
  { reportLayer = true }: { reportLayer?: boolean } = {},
): RgbaImage {
  try {
    return hideLayered(
      cover,
      methods.map((method, index) => ({ method, message: messages[index] as string })),
    );
  } catch (error) {
    if (error instanceof CapacityExceededError) {
      throw new JobError("capacity_exceeded", reportLayer ? { layer: error.layer } : undefined);
    }
    if (error instanceof LayerConflictError) {
      throw new JobError("layer_conflict", reportLayer ? { layer: error.layer } : undefined);
    }
    throw error;
  }
}
