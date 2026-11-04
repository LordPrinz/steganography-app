/**
 * Builds libstego from c/*.c with the system C compiler ($CC, default `cc`).
 *
 *   bun packages/native/build.ts               rebuild build/libstego.<suffix>
 *   bun packages/native/build.ts --if-stale    only when a source or this script is newer than the library
 *   bun packages/native/build.ts --optional    warn instead of failing (used by postinstall)
 *   bun packages/native/build.ts --sanitize    build c/test/sanitize.c with ASan + UBSan and run it
 */

import { suffix } from "bun:ffi";
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const ROOT = import.meta.dir;
const SOURCES = join(ROOT, "c");
const BUILD_DIR = join(ROOT, "build");
const LIBRARY_PATH = join(BUILD_DIR, `libstego.${suffix}`);
const HARNESS_SOURCE = join(SOURCES, "test", "sanitize.c");
const HARNESS_PATH = join(BUILD_DIR, "sanitize");

/** -ffp-contract=off and no -ffast-math keep float results identical on x64 and arm64. */
const COMMON_FLAGS = ["-std=c17", "-Wall", "-Wextra", "-Werror", "-ffp-contract=off"];
const RELEASE_FLAGS = [
  "-O3",
  "-fPIC",
  "-fstack-protector-strong",
  "-D_FORTIFY_SOURCE=2",
  ...(process.platform === "linux" ? ["-Wl,-z,relro,-z,now"] : []),
];
/** gcc's -fsanitize=undefined leaves out float-cast-overflow, so it is listed explicitly. */
const SANITIZE_FLAGS = [
  "-O1",
  "-g",
  "-fno-omit-frame-pointer",
  "-fsanitize=address,undefined,float-cast-overflow",
  "-fno-sanitize-recover=all",
];

/** Library sources (c/*.c, c/*.h, without the harness) plus this script, which holds the flags. */
function buildInputs(): string[] {
  return readdirSync(SOURCES)
    .filter((name) => name.endsWith(".c") || name.endsWith(".h"))
    .map((name) => join(SOURCES, name))
    .concat(import.meta.path);
}

function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

export function isStale(): boolean {
  const built = mtime(LIBRARY_PATH);
  return built === 0 || buildInputs().some((file) => mtime(file) > built);
}

function compile(args: string[], output: string): void {
  const compiler = process.env.CC ?? "cc";
  const cFiles = buildInputs().filter((file) => file.endsWith(".c"));
  mkdirSync(BUILD_DIR, { recursive: true });
  const result = Bun.spawnSync([compiler, ...COMMON_FLAGS, ...args, "-o", output, ...cFiles], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (!result.success) throw new Error(`${compiler} failed to build ${output}`);
}

export function build(): string {
  const shared = process.platform === "darwin" ? "-dynamiclib" : "-shared";
  compile([...RELEASE_FLAGS, shared], LIBRARY_PATH);
  return LIBRARY_PATH;
}

/** Builds the sanitizer harness and runs it; throws when it reports a failure. */
function sanitize(): void {
  compile([...SANITIZE_FLAGS, HARNESS_SOURCE], HARNESS_PATH);
  const run = Bun.spawnSync([HARNESS_PATH], {
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, ASAN_OPTIONS: "abort_on_error=1" },
  });
  if (!run.success) throw new Error(`sanitizer harness failed (exit ${run.exitCode})`);
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      "if-stale": { type: "boolean", default: false },
      optional: { type: "boolean", default: false },
      sanitize: { type: "boolean", default: false },
    },
  });

  if (values.sanitize) {
    sanitize();
  } else if (!values["if-stale"] || isStale()) {
    try {
      console.info(`native: built ${build()}`);
    } catch (error) {
      if (!values.optional) throw error;
      console.warn(
        `native: ${(error as Error).message}; run \`bun run native:build\` once a C compiler is installed`,
      );
    }
  }
}
