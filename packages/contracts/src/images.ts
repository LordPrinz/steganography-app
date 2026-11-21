import { z } from "zod";

/** Largest upload accepted, before decoding. Stored images are re-encoded PNGs. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export const ImageKind = z.enum(["original", "stego", "variant"]);
export type ImageKind = z.infer<typeof ImageKind>;

export const ImageMeta = z.object({
  id: z.uuid(),
  kind: ImageKind,
  format: z.literal("png"),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  sizeBytes: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.iso.datetime(),
});
export type ImageMeta = z.infer<typeof ImageMeta>;

/** An image with a short-lived, presigned URL to fetch its PNG. */
export const ImageDetail = ImageMeta.extend({
  url: z.url(),
  urlExpiresAt: z.iso.datetime(),
});
export type ImageDetail = z.infer<typeof ImageDetail>;

export const MAX_PAGE_SIZE = 100;

export const ListImagesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(24),
  /** The opaque `nextCursor` of the previous page. */
  cursor: z.string().min(1).max(256).optional(),
});
export type ListImagesQuery = z.infer<typeof ListImagesQuery>;

export const ImagePage = z.object({
  images: z.array(ImageMeta),
  /** Pass as `cursor` for the next page; null on the last one. */
  nextCursor: z.string().nullable(),
});
export type ImagePage = z.infer<typeof ImagePage>;
