# 7. Koch–Zhao coefficient pair and strength

- **Status:** accepted
- **Date:** 2026-11-21

## Context

Koch–Zhao hides one bit per 8 × 8 block in the relation of two mid-frequency DCT coefficients. Two
choices decide how well it works: which pair of coefficients to compare, and the strength P, the
margin by which the two magnitudes are pushed apart. A larger P survives more JPEG damage and costs
more image quality. Issue #5 asks for the choice to be made from measurements, and issue #10 builds
the method on it.

## Method as built

- The method works on the luminance Y (BT.601, as in JPEG). Block `i` (row-major, whole blocks only)
  holds bit `i`. With the orthonormal DCT-II coefficients `c1` and `c2` at the configured positions,
  the bit is 1 when `|c1| > |c2|`, otherwise 0. Pixels in a right or bottom strip narrower than 8 are
  never touched, and capacity is `floor(w / 8) * floor(h / 8)` bits.
- Embedding makes `|c1| - |c2| >= P` for a 1 and `|c2| - |c1| >= P` for a 0. A block that already
  satisfies this is left alone. Otherwise the two magnitudes move apart around their mean, signs kept,
  and the change `c1 * basis1 + c2 * basis2` is added to R, G and B alike, so Cb and Cr do not move.
  Only two coefficients are needed, so the kernel never runs a full transform.
- Rounding to 8 bits and clipping at 0 and 255 disturb the coefficients. Every block is therefore
  checked the way extraction reads it. When the check fails, the margin doubles (up to six times) and the
  block is redone from the original pixels. A block that still fails makes the kernel return
  `STEGO_E_EMBED`. A round trip without an attack recovers the bits exactly, also on noise, on all-black
  and on all-white images.
- Everything runs in C (`packages/native/c/dct.c`, ADR 4). The cosines come from a table of
  `cos(k * pi / 16)`, so there is no libm dependency and results stay the same on every platform. The
  TS oracle uses `Math.cos` and the textbook formula; on images whose blocks have a clear margin it agrees with C
  pixel for pixel. Exactly flat or linear blocks have coefficients of zero up to rounding error, whose sign
  differs between implementations, so the oracle test uses noisy covers.

## Experiment

`bun run bench --preset koch-zhao` (the bench CLI in `tools/bench`) embeds a fixed random payload
at full capacity into four natural photographs and measures PSNR and the raw bit error rate after JPEG
at quality 90, 75 and 50 (`Bun.Image`, through `applyAttack`). The images are Kodak Lossless True Color
images 3, 8, 15 and 23, scaled to 384 × 256 (1536 bits each); source and licence are in
`tools/bench/images/README.md`. Values are means over the four images. Four coefficient pairs and six
strengths were compared.

| pair           |   P | PSNR (dB) | BER q90 | BER q75 | BER q50 |
| -------------- | --: | --------: | ------: | ------: | ------: |
| (4,3) vs (3,4) |  10 |     45.97 |   0.52% |  42.43% |  48.31% |
| (4,3) vs (3,4) |  20 |     40.92 |   0.03% |   0.88% |  46.84% |
| (4,3) vs (3,4) |  30 |     37.56 |   0.00% |   0.07% |   2.39% |
| (4,3) vs (3,4) |  40 |     34.87 |   0.00% |   0.02% |   0.42% |
| (4,3) vs (3,4) |  50 |     32.94 |   0.00% |   0.02% |   0.08% |
| (4,3) vs (3,4) |  60 |     31.32 |   0.00% |   0.02% |   0.03% |
| (3,2) vs (2,3) |  10 |     44.85 |   0.21% |   1.06% |  35.74% |
| (3,2) vs (2,3) |  20 |     40.52 |   0.03% |   0.07% |   0.83% |
| (3,2) vs (2,3) |  30 |     37.30 |   0.00% |   0.03% |   0.07% |
| (3,2) vs (2,3) |  40 |     34.93 |   0.00% |   0.00% |   0.02% |
| (3,2) vs (2,3) |  50 |     33.04 |   0.00% |   0.00% |   0.00% |
| (3,2) vs (2,3) |  60 |     31.42 |   0.00% |   0.00% |   0.00% |
| (2,1) vs (1,2) |  10 |     42.54 |   0.11% |   0.31% |   2.93% |
| (2,1) vs (1,2) |  20 |     39.48 |   0.07% |   0.08% |   0.21% |
| (2,1) vs (1,2) |  30 |     36.85 |   0.05% |   0.08% |   0.08% |
| (2,1) vs (1,2) |  40 |     34.74 |   0.03% |   0.05% |   0.05% |
| (2,1) vs (1,2) |  50 |     32.99 |   0.02% |   0.02% |   0.03% |
| (2,1) vs (1,2) |  60 |     31.46 |   0.00% |   0.02% |   0.00% |
| (4,1) vs (1,4) |  10 |     44.05 |   0.13% |   0.81% |  35.60% |
| (4,1) vs (1,4) |  20 |     40.13 |   0.07% |   0.07% |   0.46% |
| (4,1) vs (1,4) |  30 |     37.23 |   0.03% |   0.08% |   0.05% |
| (4,1) vs (1,4) |  40 |     34.78 |   0.03% |   0.03% |   0.03% |
| (4,1) vs (1,4) |  50 |     32.95 |   0.00% |   0.00% |   0.02% |
| (4,1) vs (1,4) |  60 |     31.38 |   0.00% |   0.00% |   0.02% |

What the numbers show:

- The PSNR depends on P and hardly on the pair (a block changes by about `P` in two coefficients
  whichever they are), so the pair only decides robustness. PSNR is low in absolute terms because
  the payload fills every block.
- Below P = 20 the higher pairs fall apart at quality 75 and 50 (35% to 42% BER at P = 10, near
  chance). The low pair (2,1) vs (1,2) degrades more gently, but it never reaches zero errors, even at
  P = 60.
- (3,2) vs (2,3) is the first pair to reach 0.00% at q75 (P = 40) and q50 (P = 50). It is also the
  classic mid-frequency Koch–Zhao choice.
- We did not test why the pairs differ; the table is the evidence, not an explanation.

## Decision

- Default pair: **(3,2) vs (2,3)** (`u` horizontal, `v` vertical frequency; the first is the larger
  for a 1).
- Default strength: **P = 40**: 0.00% raw BER at JPEG q90 and q75 on all four images, 0.02% at q50
  (about one bit in 5000), at 34.9 dB PSNR.
- Target: the default survives **JPEG quality 75** with no error correction, and quality 50 with
  `hamming74()` around it. Tests in `koch-zhao.test.ts` check both on the fixture photos. P = 30
  (37.3 dB) is the choice when quality matters more and the attack is milder, P = 50 or more
  when q50 must hold without a code; both are one argument away: `kochZhao({ strength })`.
- Resizing, blur and combinations are measured by the lab (#18), not here.

## Consequences

- Capacity is one bit per 8 × 8 block, 64 times lower than the pixel count. A 4096 × 4096 image
  holds 32 KiB, so the 64 KiB message cap of ADR 5 can never be reached with this method. The shared
  codec suite takes a cover size per method, and the three tests that need an image holding
  `MAX_MESSAGE_BYTES` run only for methods that can; the forged-frame test runs for all of them.
- `STEGO_E_EMBED` is a new status code (`embed-failed`). It should not occur in practice, since
  the margin can grow by a factor of 64, but it keeps the guarantee that `embed` either returns an
  image that reads back exactly or throws.
- The bench and the JPEG regression tests live in `tools/bench`, which depends on `@stego/image-io`.
  `stego-engine` does not.
- The numbers hold for these four photographs and for `Bun.Image`'s JPEG encoder. If lab results on a
  larger set disagree, the defaults are revisited here.
