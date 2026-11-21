# 8. Haar DWT + QIM: band, level and step

- **Status:** accepted
- **Date:** 2026-11-21

## Context

Issue #11 asks for a method that hides one bit per Haar wavelet coefficient by quantisation index
modulation (QIM), with a configurable band (LL, HL, LH), level and step. Two things need a decision:
how to get an exact round trip when the modified luminance has to go back into 8-bit RGB, and which
parameters to recommend.

## Decision

- The method is `dwtQim({ band, level, step })`, a `ConfiguredMethod` with id 3. The kernels are in
  `packages/native/c/dwt.c` (ADR 4): an orthonormal 2-D Haar transform in place on the luminance
  (Y of BT.601, in double), repeated on the LL quadrant for each level. JavaScript allocates the
  transform plane and the line buffer.
- One bit per coefficient of the chosen band at the chosen level, in row-major order of the band, so
  `extract(n)` is a prefix of `extract(m)`. Capacity is `(width >> level) * (height >> level)`.
  Only the top-left region whose sides are multiples of 2^level is transformed; the remaining
  rows and columns are copied unchanged.
- QIM with step d: bit 0 sits on multiples of d, bit 1 on multiples of d plus d / 2. Reading takes the
  nearer lattice, so an error below d / 4 is harmless.
- Exact round trip: the change of each pixel's luminance is rounded to an integer and added to R, G
  and B, then clamped to 0..255. Rounding moves a level-L coefficient by at most 2^L / 2, which
  stays below the d / 4 tolerance only when d > 2^(level + 1), so `dwtQim` rejects smaller steps.
  Steps above 255 are rejected too, so the LL range clamp below always has room (the range is at
  least 510 wide).
  That bound covers rounding, not clamping. Near black and white a change cannot be applied in
  full, so the embedder reads the result back exactly as the extractor does and moves each
  coefficient that decodes wrongly again, up to 16 rounds. An LL coefficient can only lie in
  [0, 255 * 2^level], so its target is the nearest lattice point of the bit inside that range
  (an unreachable point just outside it caused failures on flat white covers in the first version).
  Bits that still fail are counted in `failed`, and the method throws instead of returning an image
  that would not round-trip.
- What is guaranteed: nothing is proven for every image. Tests embed and read back flat covers
  (luma 0, 1, 5, 20, 235 to 255), random covers near black and white and noise, for all three bands,
  levels 1 to 3 and the steps 12 to 96 of the table below that exceed 2^(level + 1), and none failed.
  Steps at or below the bound fail on many covers (for example step 1 at level 3 on noise).
- Alpha is never touched.

## Bench

`bun run bench --preset dwt-qim` embeds 4096 random bits into three generated 512 x 512 images (smooth,
textured, edges), averages PSNR (luminance) and BER, and attacks the stego image with JPEG at
quality 90, 75 and 50. Apple M3 Max, Bun 1.4.4.

| band | level | step | PSNR dB | no attack | JPEG 90 | JPEG 75 | JPEG 50 |
| ---- | ----- | ---- | ------- | --------- | ------- | ------- | ------- |
| LL   | 1     | 12   | 55.16   | 0.0000    | 0.0259  | 0.1864  | 0.3469  |
| LL   | 1     | 16   | 52.74   | 0.0000    | 0.0095  | 0.0968  | 0.2533  |
| LL   | 1     | 24   | 49.27   | 0.0000    | 0.0011  | 0.0267  | 0.1274  |
| LL   | 1     | 32   | 46.73   | 0.0000    | 0.0000  | 0.0069  | 0.0680  |
| LL   | 1     | 48   | 43.36   | 0.0000    | 0.0000  | 0.0012  | 0.0130  |
| LL   | 1     | 64   | 41.03   | 0.0000    | 0.0000  | 0.0005  | 0.0024  |
| LL   | 1     | 96   | 37.39   | 0.0000    | 0.0000  | 0.0000  | 0.0003  |
| HL   | 1     | 12   | 54.22   | 0.0000    | 0.1278  | 0.3835  | 0.4046  |
| HL   | 1     | 16   | 51.71   | 0.0000    | 0.0729  | 0.2847  | 0.4601  |
| HL   | 1     | 24   | 48.09   | 0.0000    | 0.0213  | 0.1716  | 0.3976  |
| HL   | 1     | 32   | 45.50   | 0.0000    | 0.0046  | 0.0914  | 0.2684  |
| HL   | 1     | 48   | 41.90   | 0.0000    | 0.0000  | 0.0453  | 0.1761  |
| HL   | 1     | 64   | 39.31   | 0.0000    | 0.0000  | 0.0186  | 0.0889  |
| HL   | 1     | 96   | 35.72   | 0.0000    | 0.0000  | 0.0002  | 0.0436  |
| LH   | 1     | 12   | 54.33   | 0.0000    | 0.2856  | 0.4452  | 0.4844  |
| LH   | 1     | 16   | 51.78   | 0.0000    | 0.1994  | 0.3973  | 0.4755  |
| LH   | 1     | 24   | 48.12   | 0.0000    | 0.0510  | 0.3566  | 0.4593  |
| LH   | 1     | 32   | 45.52   | 0.0000    | 0.0225  | 0.2607  | 0.3941  |
| LH   | 1     | 48   | 41.88   | 0.0000    | 0.0010  | 0.1356  | 0.3559  |
| LH   | 1     | 64   | 39.31   | 0.0000    | 0.0002  | 0.0384  | 0.2496  |
| LH   | 1     | 96   | 35.71   | 0.0000    | 0.0000  | 0.0036  | 0.1345  |
| LL   | 2     | 12   | 55.87   | 0.0000    | 0.0632  | 0.1864  | 0.4669  |
| LL   | 2     | 16   | 52.39   | 0.0000    | 0.0084  | 0.0460  | 0.2997  |
| LL   | 2     | 24   | 49.13   | 0.0000    | 0.0001  | 0.0168  | 0.0608  |
| LL   | 2     | 32   | 46.76   | 0.0000    | 0.0000  | 0.0008  | 0.0049  |
| LL   | 2     | 48   | 43.29   | 0.0000    | 0.0000  | 0.0000  | 0.0033  |
| LL   | 2     | 64   | 40.82   | 0.0000    | 0.0000  | 0.0000  | 0.0000  |
| LL   | 2     | 96   | 37.33   | 0.0000    | 0.0000  | 0.0000  | 0.0000  |
| HL   | 2     | 12   | 55.71   | 0.0000    | 0.0713  | 0.2195  | 0.4655  |
| HL   | 2     | 16   | 52.04   | 0.0000    | 0.0251  | 0.0479  | 0.3612  |
| HL   | 2     | 24   | 48.58   | 0.0000    | 0.0004  | 0.0129  | 0.1440  |
| HL   | 2     | 32   | 46.06   | 0.0000    | 0.0000  | 0.0036  | 0.0303  |
| HL   | 2     | 48   | 42.43   | 0.0000    | 0.0000  | 0.0000  | 0.0036  |
| HL   | 2     | 64   | 39.82   | 0.0000    | 0.0000  | 0.0000  | 0.0007  |
| HL   | 2     | 96   | 36.11   | 0.0000    | 0.0000  | 0.0000  | 0.0000  |
| LH   | 2     | 12   | 55.85   | 0.0000    | 0.0811  | 0.1739  | 0.4905  |
| LH   | 2     | 16   | 52.02   | 0.0000    | 0.0094  | 0.0353  | 0.3140  |
| LH   | 2     | 24   | 48.53   | 0.0000    | 0.0001  | 0.0090  | 0.0335  |
| LH   | 2     | 32   | 46.00   | 0.0000    | 0.0000  | 0.0022  | 0.0125  |
| LH   | 2     | 48   | 42.38   | 0.0000    | 0.0000  | 0.0000  | 0.0018  |
| LH   | 2     | 64   | 39.77   | 0.0000    | 0.0000  | 0.0015  | 0.0015  |
| LH   | 2     | 96   | 36.06   | 0.0000    | 0.0000  | 0.0000  | 0.0000  |

Every embedding in the table succeeded (no bit failed the read-back).

Observations:

- PSNR depends on the step and barely on the band: about 55 dB at step 12, 47 dB at 32, 37 dB at 96.
- LL is the most robust band at both levels. HL and LH need roughly twice the step for the same BER,
  and LH at level 1 is the weakest.
- Level 2 survives JPEG better than level 1 at the same step, because a coefficient averages a 4 x 4
  block, but it holds a quarter of the bits (1/16 bit per pixel against 1/4).

## Recommended defaults

- `dwtQim({ band: "LL", level: 2, step: 32 })`: 46.8 dB, BER 0 at JPEG 90, 0.0008 at 75, 0.005 at 50.
  Hamming(7,4) or repetition (ADR 6) can take the JPEG 50 rate lower still.
- More capacity: `dwtQim({ band: "LL", level: 1, step: 48 })`: 43.4 dB, BER 0 at JPEG 90, 0.001 at 75,
  0.013 at 50.
- The lab can sweep step, band and level around these.

## Consequences

- The method is registered in the shared contract and codec suites at level 1 (all bands), and deeper
  levels run the contract suite in `dwt-qim.test.ts`.
- The codec suite's large image grows to 2048 x 2048 for methods that cannot hold the 64 KiB message
  limit in 512 x 512 pixels.
- Each embedding runs the transform twice or more (embed, then read back), and on 4096 x 4096 the
  plane takes 128 MB. Both stay inside the image limits.
- Resize and blur were not benchmarked here.
