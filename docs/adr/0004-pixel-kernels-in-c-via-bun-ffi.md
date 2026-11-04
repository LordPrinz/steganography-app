# 4. Pixel kernels in C via bun:ffi

- **Status:** accepted
- **Date:** 2026-11-04

## Context

The robustness lab runs every method against many attack variants, on images up to 4096 × 4096. That
work is per-pixel loops: colour conversion, 8 × 8 DCT, Haar DWT, QIM, Gaussian blur, PSNR/SSIM and PNG
filters. The project brief asks for the algorithms to be written mostly in C and called from Bun. The
original design (DESIGN.md) kept them in TypeScript and left C as an optional M5 spike (#26).

Measured on RGBA → YCbCr → RGBA, 4000 × 3000 (12 MP), Apple M3 Max, Bun 1.4.4, median of 5 runs,
buffer allocation included (`bun run native:bench`):

| Implementation             | Time   |
| -------------------------- | ------ |
| TypeScript (JIT)           | 77 ms  |
| C, TinyCC (`bun:ffi` `cc`) | 169 ms |
| C, `cc -O3` + `dlopen`     | 32 ms  |

Colour conversion is close to memory-bound. We expect larger gains for DCT, blur and SSIM, which do
far more arithmetic per pixel. TinyCC does not optimise and is slower than the JIT, so production
uses `cc -O3`.

## Decision

- Pixel loops are written in C, in a new workspace `packages/native` (`@stego/native`). `stego-engine`
  and `image-io` will import it directly as their kernels land (#3, #4, #9–#13). Orchestration stays in TypeScript: payload frame, CRC
  (`Bun.hash.crc32`), method registry, codec. So do the operations Bun already does natively: JPEG and
  resize (`Bun.Image`), zlib.
- `bun run native:build` compiles `c/*.c` with the system `cc` into a shared library under
  `packages/native/build/` (gitignored). `bun install` runs it as a postinstall step and only warns
  when no compiler is present. The `bun test` preload rebuilds the library when a C source or the
  build script is newer than it. Without a compiler the preload skips the build, so only the native
  tests fail and the rest of the suite still runs; a compile error fails the whole run.
- Flags are `-std=c17 -O3 -Wall -Wextra -Werror -ffp-contract=off`, plus `-fstack-protector-strong`,
  `-D_FORTIFY_SOURCE=2` and full RELRO on Linux. There is no `-ffast-math` and no `-march=native`. Embedding and extraction may run on different machines (arm64 laptop, x64 server),
  and fused multiply-add or fast-math would change float results between them.
- The FFI boundary is coarse: one call per whole operation on an image or plane (a method's embed or
  extract, a blur, a metric). JavaScript allocates every buffer. C allocates only scratch memory that it
  frees before returning. Buffers go in as `buffer` + `buffer_length`, so C always sees the real byte
  length.
- Arguments are validated twice: the TypeScript client throws `RangeError` on bad dimensions or lengths,
  and C checks again and returns a negative status code, which the client turns into
  `NativeKernelError`. `stego_abi_version()` guards against a stale library after a signature change.
- Each kernel has a naive TypeScript oracle in the test files (formula-level, no optimisation), and the
  tests compare C against it bit for bit, or with a stated tolerance where floats differ. There is no
  TypeScript fallback at runtime.
- `c/test/sanitize.c` drives every kernel with exact-size `malloc` buffers under ASan and UBSan
  (`bun run native:sanitize`, CI job "Native"). An ASan library loaded into Bun would not help here:
  typed arrays live in the JavaScript heap, which has no redzones. When we injected an off-by-one into
  that setup, it went unreported. `float-cast-overflow` is enabled explicitly because gcc, which CI
  uses, leaves it out of `-fsanitize=undefined`. CI also checks the C sources with clang-format 19.1.7, pinned through
  `pipx run clang-format==19.1.7` (the same command as `bun run native:format`).

## Consequences

- A C compiler becomes a dev and build requirement for api and worker (Xcode command line tools, gcc or
  clang). The web app does not need one. Deployment images get a build stage with a compiler (#23).
- Each method ticket delivers three things: the C kernel, its TS oracle test and a harness case.
- C is memory-unsafe code fed by user-supplied images. The pixel limit (`MAX_PIXELS`, 4096²) and the
  double validation bound every buffer, and the harness runs in CI on every change.
- `stego-engine` stops being dependency-free once it imports `@stego/native`. The kernels are
  deterministic and never mutate their inputs, so engine functions stay pure.
