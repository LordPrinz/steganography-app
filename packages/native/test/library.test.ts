import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { MAX_PIXELS, MAX_SIDE } from "../src/image.ts";
import { NativeLibraryError } from "../src/index.ts";
import { ABI_VERSION, native, openLibrary } from "../src/library.ts";
import { check, NativeKernelError } from "../src/status.ts";

const header = () => Bun.file(join(import.meta.dir, "..", "c", "stego.h")).text();

describe("library loading", () => {
  test("client and C header agree on the ABI version and limits", async () => {
    const text = await header();
    expect(text).toContain(`#define STEGO_ABI_VERSION ${ABI_VERSION}\n`);
    expect(text).toContain(`#define STEGO_MAX_SIDE ${MAX_SIDE}u\n`);
    expect(text).toContain("#define STEGO_MAX_PIXELS (4096u * 4096u)\n");
    expect(MAX_PIXELS).toBe(4096 * 4096);
  });

  test("every status code in the C header has a name in the client", async () => {
    const codes = [...(await header()).matchAll(/STEGO_E_\w+ = (-\d+)/g)].map((m) => Number(m[1]));
    expect(codes.length).toBeGreaterThan(0);
    for (const code of codes) {
      let error: unknown;
      try {
        check("kernel", code);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(NativeKernelError);
      expect((error as NativeKernelError).status).not.toBe("unknown");
    }
  });

  test("the built library loads and passes the ABI check", () => {
    expect(native().stego_abi_version()).toBe(ABI_VERSION);
  });

  test("a missing library fails with a hint to build it", () => {
    expect(() => openLibrary("/nonexistent/libstego.so")).toThrow(NativeLibraryError);
    expect(() => openLibrary("/nonexistent/libstego.so")).toThrow("bun run native:build");
  });
});
