import { describe, expect, test } from "bun:test";
import { readInfo, resize, toJpeg, toPng } from "../src/pipeline.ts";

const fixture = await Bun.file(new URL("./fixtures/gradient-64x48.png", import.meta.url)).bytes();

describe("image-io pipeline", () => {
  test("reads dimensions without decoding", async () => {
    expect(await readInfo(fixture)).toEqual({ width: 64, height: 48, format: "png" });
  });

  test("re-encodes to PNG", async () => {
    expect(await readInfo(await toPng(fixture))).toMatchObject({
      width: 64,
      height: 48,
      format: "png",
    });
  });

  test("lower JPEG quality produces smaller files", async () => {
    const [q30, q95] = await Promise.all([toJpeg(fixture, 30), toJpeg(fixture, 95)]);
    expect((await readInfo(q30)).format).toBe("jpeg");
    expect(q30.length).toBeLessThan(q95.length);
  });

  test("rejects out-of-range JPEG quality", () => {
    expect(() => toJpeg(fixture, 0)).toThrow(RangeError);
  });

  test("resizes to exact dimensions", async () => {
    expect(await readInfo(await resize(fixture, 32, 24))).toMatchObject({ width: 32, height: 24 });
  });
});
