import {
  EncodeParams,
  type EncodeResult,
  MAX_IMAGES_PER_USER,
  MAX_PNG_BYTES,
  MAX_USER_IMAGE_BYTES,
} from "@stego/contracts";
import { type ImageRepository, JobError, type OperationRepository } from "@stego/db";
import {
  CapacityExceededError,
  capacity,
  createMethod,
  hide,
  MAX_MESSAGE_BYTES,
  psnr,
} from "@stego/engine";
import { encodePng } from "@stego/image-io";
import { newImageKey, type ObjectStore } from "@stego/storage";
import type { JobHandler } from "../handlers.ts";
import { loadSource } from "./source.ts";

export interface EncodeDeps {
  images: Pick<ImageRepository, "findOwned" | "create">;
  operations: Pick<OperationRepository, "attachResultImage">;
  storage: Pick<ObjectStore, "get" | "put" | "delete">;
}

/** Hides the message in the source image and stores the result as a new `stego` image of the owner. */
export function createEncodeHandler({ images, operations, storage }: EncodeDeps): JobHandler {
  return async ({ operation }, context) => {
    const params = EncodeParams.safeParse(operation.params);
    if (!params.success) throw new JobError("invalid_params");
    const [selection] = params.data.layers;
    let method: ReturnType<typeof createMethod>;
    try {
      method = createMethod(selection);
    } catch (error) {
      if (error instanceof RangeError) throw new JobError("invalid_params", { cause: error });
      throw error;
    }

    const message = await context.message();
    const source = await loadSource({ images, storage }, operation);
    context.signal.throwIfAborted();

    const started = performance.now();
    let stego: ReturnType<typeof hide>;
    try {
      stego = hide(source, message, method);
    } catch (error) {
      if (error instanceof CapacityExceededError) throw new JobError("capacity_exceeded");
      throw error;
    }
    const png = await encodePng(stego);
    const encodeMs = performance.now() - started;
    if (png.byteLength > MAX_PNG_BYTES) throw new JobError("image_too_large");
    context.signal.throwIfAborted();

    // The mean squared error is 0 for an identical image, where PSNR is infinite; JSON has no Infinity.
    const quality = psnr(source, stego);
    const key = newImageKey(operation.user_id);
    await storage.put(key, png);
    try {
      const row = await images.create(
        {
          userId: operation.user_id,
          kind: "stego",
          storageKey: key,
          format: "png",
          width: stego.width,
          height: stego.height,
          sizeBytes: png.byteLength,
          sha256: new Bun.CryptoHasher("sha256").update(png).digest("hex"),
        },
        { maxImages: MAX_IMAGES_PER_USER, maxBytes: MAX_USER_IMAGE_BYTES },
      );
      if (!row) throw new JobError("quota_exceeded");
      await operations.attachResultImage(operation.id, row.id);
    } catch (error) {
      await storage.delete(key).catch((cleanup) => {
        console.error("Could not remove an object whose row was not saved", key, cleanup);
      });
      throw error;
    }

    const result: EncodeResult = {
      kind: "encode",
      messageBytes: new TextEncoder().encode(message).byteLength,
      capacityBytes: Math.min(capacity(source.width, source.height, method), MAX_MESSAGE_BYTES),
      psnr: Number.isFinite(quality) ? quality : null,
      encodeMs: Math.round(encodeMs),
    };
    return result;
  };
}
