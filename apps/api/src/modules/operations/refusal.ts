import { HttpError } from "../../lib/http.ts";
import {
  ExperimentImageTooLargeError,
  ExperimentImageTooSmallError,
  InvalidMethodError,
  MessageTooLargeError,
  OperationActiveError,
  SourceNotFoundError,
  TooManyActiveOperationsError,
  TooManyVariantsError,
} from "./service.ts";

/**
 * Room for a message of MAX_MESSAGE_BYTES in the worst JSON form (every control byte escaped as six
 * characters is 384 KiB), plus the rest of the request.
 */
export const MAX_ENCODE_BODY_BYTES = 512 * 1024;

/** Maps what the service refuses to the API's errors; anything else is a 500. */
export async function refuse<T>(call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (error) {
    throw refusal(error);
  }
}

function refusal(error: unknown): unknown {
  if (error instanceof SourceNotFoundError) {
    return new HttpError(404, "image_not_found", "Image not found");
  }
  if (error instanceof InvalidMethodError) {
    return new HttpError(400, "invalid_request", "The method parameters are not valid");
  }
  if (error instanceof MessageTooLargeError) {
    return new HttpError(422, "message_too_large", "The message does not fit in the image", {
      needed: error.needed,
      available: error.available,
      ...(error.method && { method: error.method }),
    });
  }
  if (error instanceof ExperimentImageTooLargeError) {
    return new HttpError(
      422,
      "experiment_image_too_large",
      "The image is too large for an experiment",
      { pixels: error.pixels, maxPixels: error.maxPixels },
    );
  }
  if (error instanceof ExperimentImageTooSmallError) {
    return new HttpError(
      422,
      "experiment_image_too_small",
      "The image is too small for an experiment",
      { minSide: error.minSide },
    );
  }
  if (error instanceof TooManyVariantsError) {
    return new HttpError(400, "too_many_variants", "The experiment would run too many variants", {
      variants: error.variants,
      maxVariants: error.maxVariants,
    });
  }
  if (error instanceof OperationActiveError) {
    return new HttpError(409, "operation_active", "Wait for the operation to finish first");
  }
  if (error instanceof TooManyActiveOperationsError) {
    return new HttpError(
      429,
      "too_many_operations",
      "Too many operations in progress; wait for one to finish",
      undefined,
      { "Retry-After": "5" },
    );
  }
  return error;
}
