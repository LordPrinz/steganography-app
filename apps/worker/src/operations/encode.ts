import {
  EncodeParams,
  type EncodeResult,
  EXPERIMENT_MIN_SIDE,
  MAX_IMAGES_PER_USER,
  MAX_PNG_BYTES,
  MAX_USER_IMAGE_BYTES,
} from "@stego/contracts";
import { type ImageRepository, JobError, type OperationRepository } from "@stego/db";
import { capacityLayered, MAX_MESSAGE_BYTES, psnr, ssim } from "@stego/engine";
import { encodePng } from "@stego/image-io";
import { newImageKey, type ObjectStore } from "@stego/storage";
import type { JobHandler } from "../handlers.ts";
import { buildMethods, hideAll } from "./layers.ts";
import { loadSource } from "./source.ts";

export interface EncodeDeps {
  images: Pick<ImageRepository, "findOwned" | "create" | "deleteOwned">;
  operations: Pick<OperationRepository, "attachResultImage" | "findOwned">;
  storage: Pick<ObjectStore, "get" | "put" | "delete">;
}

/** Hides the message in the source image and stores the result as a new `stego` image of the owner. */
export function createEncodeHandler({ images, operations, storage }: EncodeDeps): JobHandler {
  /** Stores the PNG and its row, and links the operation; undoes both when a later step fails. */
  async function storeStego(
    operation: { id: string; user_id: string },
    stego: { width: number; height: number },
    png: Uint8Array,
  ): Promise<void> {
    const key = newImageKey(operation.user_id);
    await storage.put(key, png);
    let rowId: string | undefined;
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
      rowId = row.id;
      await operations.attachResultImage(operation.id, row.id);
    } catch (error) {
      if (rowId) {
        await images.deleteOwned(operation.user_id, rowId).catch((cleanup) => {
          console.error("Could not remove an image row that was not linked", rowId, cleanup);
        });
      }
      await storage.delete(key).catch((cleanup) => {
        console.error("Could not remove an object whose row was not saved", key, cleanup);
      });
      throw error;
    }
  }

  return async ({ operation }, context) => {
    const params = EncodeParams.safeParse(operation.params);
    if (!params.success) throw new JobError("invalid_params");
    const methods = buildMethods(params.data.layers);

    const messages = await context.messages();
    if (messages.length !== methods.length) throw new JobError("invalid_params");
    const source = await loadSource({ images, storage }, operation);
    context.signal.throwIfAborted();

    const started = performance.now();
    const stego = hideAll(source, methods, messages);
    const png = await encodePng(stego);
    const encodeMs = performance.now() - started;
    if (png.byteLength > MAX_PNG_BYTES) throw new JobError("image_too_large");
    context.signal.throwIfAborted();

    // The mean squared error is 0 for an identical image, where PSNR is infinite; JSON has no Infinity.
    const quality = psnr(source, stego);
    // A retry after a crash between the steps below must not store a second image.
    const existing = await operations.findOwned(operation.user_id, operation.id);
    if (!existing?.result_image_id) {
      await storeStego(operation, stego, png);
    }

    const available = capacityLayered(source.width, source.height, methods);
    const result: EncodeResult = {
      kind: "encode",
      layers: params.data.layers.map(({ id }, index) => ({
        method: id,
        messageBytes: new TextEncoder().encode(messages[index]).byteLength,
        capacityBytes: Math.min(available[index] as number, MAX_MESSAGE_BYTES),
      })),
      psnr: Number.isFinite(quality) ? quality : null,
      // SSIM needs a window that fits inside the image.
      ssim:
        Math.min(source.width, source.height) >= EXPERIMENT_MIN_SIDE ? ssim(source, stego) : null,
      encodeMs: Math.round(encodeMs),
    };
    return result;
  };
}
