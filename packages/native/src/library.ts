/**
 * Loads libstego once, on first use, and refuses a library built for another ABI version.
 *
 * Internal to the package: callers use the typed wrappers in the other modules.
 */

import { dlopen, suffix } from "bun:ffi";
import { join } from "node:path";

/** Must equal STEGO_ABI_VERSION in c/stego.h. */
export const ABI_VERSION = 1;

const LIBRARY_PATH = join(import.meta.dir, "..", "build", `libstego.${suffix}`);

const symbols = {
  stego_abi_version: { args: [], returns: "i32" },
  stego_rgba_to_ycbcr: {
    args: [
      "buffer",
      "buffer_length",
      "u32",
      "u32",
      "buffer",
      "buffer_length",
      "buffer",
      "buffer_length",
      "buffer",
      "buffer_length",
      "buffer",
      "buffer_length",
    ],
    returns: "i32",
  },
  stego_ycbcr_to_rgba: {
    args: [
      "buffer",
      "buffer_length",
      "buffer",
      "buffer_length",
      "buffer",
      "buffer_length",
      "buffer",
      "buffer_length",
      "u32",
      "u32",
      "buffer",
      "buffer_length",
    ],
    returns: "i32",
  },
} as const;

type NativeSymbols = ReturnType<typeof dlopen<typeof symbols>>["symbols"];

export class NativeLibraryError extends Error {
  override readonly name = "NativeLibraryError";
}

let loaded: NativeSymbols | undefined;

export function native(): NativeSymbols {
  loaded ??= openLibrary(LIBRARY_PATH);
  return loaded;
}

export function openLibrary(path: string): NativeSymbols {
  let library: ReturnType<typeof dlopen<typeof symbols>>;
  try {
    library = dlopen(path, symbols);
  } catch (cause) {
    throw new NativeLibraryError(
      `Cannot load ${path}. Build it with \`bun run native:build\` (needs a C compiler).`,
      { cause },
    );
  }
  const version = library.symbols.stego_abi_version();
  if (version !== ABI_VERSION) {
    library.close();
    throw new NativeLibraryError(
      `${path} has ABI version ${version}, expected ${ABI_VERSION}. Rebuild it with \`bun run native:build\`.`,
    );
  }
  return library.symbols;
}
