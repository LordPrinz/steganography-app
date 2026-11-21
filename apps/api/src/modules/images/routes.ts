import {
  type ImageDetail,
  type ImageMeta,
  type ImagePage,
  ListImagesQuery,
  MAX_UPLOAD_BYTES,
} from "@stego/contracts";
import { InvalidImageError } from "@stego/image-io";
import type { KeyValueStore } from "@stego/kv";
import type { BunRequest } from "bun";
import { z } from "zod";
import { BusyError } from "../../lib/concurrency-limit.ts";
import { decodeCursor } from "../../lib/cursor.ts";
import { HttpError, json } from "../../lib/http.ts";
import { createRateLimiter, enforce, type RateLimitOptions } from "../../lib/rate-limit.ts";
import type { RequireUser } from "../auth/routes.ts";
import {
  type ImageService,
  ImageTooLargeError,
  QuotaExceededError,
  UnsupportedImageError,
} from "./service.ts";

export const IMAGE_RATE_LIMITS = {
  // Per user: every upload decodes and re-encodes an image, the API's most expensive request.
  upload: { name: "upload-user", limit: 60, windowMs: 60 * 60_000 },
} satisfies Record<string, RateLimitOptions>;

/** Room in the request body for multipart boundaries and headers around the file. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

/** What `createServer` lets through for the whole API; the upload route is the only one that needs it. */
export const MAX_REQUEST_BYTES = MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD_BYTES;

export interface ImageRoutesDeps {
  images: ImageService;
  kv: KeyValueStore;
  requireUser: RequireUser;
}

const notFound = () => new HttpError(404, "not_found", "Image not found");

export function imageRoutes({ images, kv, requireUser }: ImageRoutesDeps) {
  const uploadLimiter = createRateLimiter(kv, IMAGE_RATE_LIMITS.upload);

  /** A malformed id cannot name an image, so it is a plain 404 like any other miss. */
  function imageId(req: BunRequest<"/images/:id">): string {
    const id = z.uuid().safeParse(req.params.id);
    if (!id.success) throw notFound();
    return id.data;
  }

  return {
    "/images": {
      POST: async (req: BunRequest): Promise<Response> => {
        const user = await requireUser(req);
        await enforce(() => uploadLimiter.hit(user.id));
        const file = await readUpload(req);
        try {
          return json<ImageMeta>(await images.upload(user.id, file), { status: 201 });
        } catch (error) {
          if (error instanceof UnsupportedImageError) {
            throw new HttpError(415, "unsupported_image", "Upload a PNG, JPEG or WebP image");
          }
          if (error instanceof BusyError) {
            throw new HttpError(503, "busy", "Busy, try again shortly", undefined, {
              "Retry-After": "2",
            });
          }
          if (error instanceof QuotaExceededError) {
            throw new HttpError(
              413,
              "quota_exceeded",
              "Storage quota reached; delete some images first",
            );
          }
          if (error instanceof ImageTooLargeError) {
            throw new HttpError(413, "image_too_large", "The image is too large once re-encoded");
          }
          if (error instanceof InvalidImageError) {
            throw new HttpError(
              400,
              "invalid_image",
              "The file is not a valid image of a supported size",
            );
          }
          throw error;
        }
      },

      GET: async (req: BunRequest) => {
        const user = await requireUser(req);
        const query = ListImagesQuery.safeParse(Object.fromEntries(new URL(req.url).searchParams));
        if (!query.success) throw new HttpError(400, "invalid_request", "Invalid query");
        const after = query.data.cursor === undefined ? undefined : decodeCursor(query.data.cursor);
        if (after === null) throw new HttpError(400, "invalid_cursor", "Invalid cursor");
        return json<ImagePage>(await images.list(user.id, { limit: query.data.limit, after }));
      },
    },

    "/images/:id": {
      GET: async (req: BunRequest<"/images/:id">) => {
        const user = await requireUser(req);
        const image = await images.get(user.id, imageId(req));
        if (!image) throw notFound();
        return json<ImageDetail>(image);
      },

      DELETE: async (req: BunRequest<"/images/:id">) => {
        const user = await requireUser(req);
        if (!(await images.remove(user.id, imageId(req)))) throw notFound();
        return new Response(null, { status: 204 });
      },
    },
  };
}

/** The `file` part of a multipart upload, size-checked. Content is judged later, from its bytes. */
async function readUpload(req: Request): Promise<Uint8Array> {
  const contentType = req.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data\s*;/i.test(contentType)) {
    throw new HttpError(415, "unsupported_media_type", "Send the image as multipart/form-data");
  }
  // Parsed straight from the request to avoid holding a second copy of the body. Bun's server limit
  // stops chunked bodies at MAX_REQUEST_BYTES; a declared length is refused before reading.
  if (Number(req.headers.get("content-length")) > MAX_REQUEST_BYTES) {
    throw new HttpError(413, "payload_too_large", "Request body is too large");
  }
  const form = await req.formData().catch(() => {
    throw new HttpError(400, "invalid_request", "Malformed multipart body");
  });
  // With several `file` parts the first one counts.
  const file = form.get("file");
  if (!(file instanceof File)) {
    throw new HttpError(400, "invalid_request", 'Expected a "file" part holding the image');
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new HttpError(413, "payload_too_large", "Image is too large");
  }
  if (file.size === 0) throw new HttpError(400, "invalid_request", "The file is empty");
  return file.bytes();
}
