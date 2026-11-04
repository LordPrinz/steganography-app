/**
 * Test preload (bunfig.toml): rebuilds libstego when a C source changed, so `bun test` never runs a
 * stale build. Without a C compiler it only warns; the native tests then fail with a build hint and
 * the rest of the suite still runs. A compile error always fails.
 */
import { build, isStale } from "./build.ts";

if (isStale()) {
  const compiler = process.env.CC ?? "cc";
  if (Bun.which(compiler)) build();
  else console.warn(`native: no C compiler (${compiler}) found, skipping the libstego build`);
}
