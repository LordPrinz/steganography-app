import { describe, expect, test } from "bun:test";
import { ImageDetail, ImageMeta, ImagePage, ListImagesQuery, MAX_PAGE_SIZE } from "./images.ts";

const meta = {
  id: crypto.randomUUID(),
  kind: "original",
  format: "png",
  width: 640,
  height: 480,
  sizeBytes: 1234,
  sha256: "0".repeat(64),
  createdAt: new Date().toISOString(),
} as const;

describe("image contracts", () => {
  test("metadata survives a JSON round trip", () => {
    expect(ImageMeta.parse(JSON.parse(JSON.stringify(meta)))).toEqual(meta);
  });

  test("metadata rejects other formats and malformed hashes", () => {
    expect(ImageMeta.safeParse({ ...meta, format: "jpeg" }).success).toBe(false);
    expect(ImageMeta.safeParse({ ...meta, sha256: "xyz" }).success).toBe(false);
  });

  test("a detail adds a URL and its expiry", () => {
    const detail = { ...meta, url: "https://s3.example/obj?sig=1", urlExpiresAt: meta.createdAt };
    expect(ImageDetail.parse(detail)).toEqual(detail);
    expect(ImageDetail.safeParse(meta).success).toBe(false);
  });

  test("a page ends with a null cursor", () => {
    expect(ImagePage.parse({ images: [meta], nextCursor: null }).nextCursor).toBeNull();
  });

  test("the list query coerces and bounds the page size", () => {
    expect(ListImagesQuery.parse({})).toEqual({ limit: 24 });
    expect(ListImagesQuery.parse({ limit: "5", cursor: "abc" })).toEqual({
      limit: 5,
      cursor: "abc",
    });
    for (const limit of ["0", "-1", "1.5", "abc", String(MAX_PAGE_SIZE + 1)]) {
      expect(ListImagesQuery.safeParse({ limit }).success).toBe(false);
    }
  });
});
