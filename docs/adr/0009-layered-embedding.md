# 9. Layered embedding: LSB, DCT and DWT in one image

- **Status:** accepted
- **Date:** 2026-11-21

## Context

Issue #53 asks for the three methods in one image, each with its own message, each read back with its
own method. The methods touch the same pixels, so a later layer can damage an earlier one: LSB
rewrites the low bits that DCT and DWT rounding depends on, and DCT and DWT both change the luminance.
Four things need a decision: the embedding order, how layers are represented, how capacity is
counted, and what happens when a layer fails.

## Decision

- **Order: DCT, then DWT, then LSB**, fixed by the engine whatever order the caller lists the layers
  in. `hideLayered` sorts by a table keyed by method id (the registry for this one question; callers
  never switch on ids).
- **Representation: composition over the existing codec.** `hideLayered(image, layers)` takes
  `{ method, message }[]` and calls `hide` once per layer, in order. Every layer embeds its own frame
  with its own method id, so `reveal(image, method)` and `measure(...)` work per layer unchanged. No
  composite `ConfiguredMethod` (its single frame would force one message) and no change to the
  `ConfiguredMethod` interface or to ADR 5.
- **Capacity: each method reports its own.** `capacityLayered(width, height, methods)` returns what
  `capacity` returns for each method, in the given order. Layers do not share bit positions (each is
  a different domain), so nothing is subtracted, but that is not a guarantee: the layers disturb each
  other, and a full set of layers can still fail the verification pass with `LayerConflictError`. The
  tests fill all three layers to capacity on natural images with the preset's parameters and every
  one reveals.
- **Failures:**
  - A message that does not fit its method throws `CapacityExceededError` with a new `layer` field,
    the index in the caller's list. It is unset for a plain `hide`.
  - Two layers with the same method id throw `RangeError`: a reveal could not tell them apart. (An
    ECC wrapper keeps the id of the method it wraps, so it counts as the same method.)
  - After the last layer, `hideLayered` reveals every layer and compares the message. A layer that
    does not come back exactly throws `LayerConflictError { layer }`, so a layered image is never
    returned with a layer that is already broken. The message text stays out of both errors.
  - An error thrown by a method itself (for example DWT bits that cannot survive rounding) propagates
    as is.
- **Parameters for layered runs** (the engine does not fix them, the bench preset does): DCT with the
  defaults, DWT at LL level 2 with step 64, LSB at one bit per channel, and Hamming(7,4) around DCT
  and DWT. LSB cannot survive JPEG by design, so it has no ECC.

## Spike

Reproduce with `bun run bench:layered-order` (64-byte messages) and `bun run bench:layered-order 0.95`
(each layer filled to 95% of its capacity, capped at 4000 bytes). The script embeds every order of the
three methods with plain `hide` calls, not `hideLayered`, which fixes the order. Images: the four
natural `kodim` fixtures (384 x 256) plus one generated 512 x 512. Each cell is the mean BER over the
five images after no attack, JPEG 90 and JPEG 75, with the number of images whose frame revealed
exactly. DWT is LL, level 2, step 64 and DCT is the default; LSB is one bit per channel. Apple M3 Max,
Bun 1.4.4. All six orders were measured.

64-byte messages:

| order         | PSNR dB | layer | none         | JPEG 90      | JPEG 75      |
| ------------- | ------- | ----- | ------------ | ------------ | ------------ |
| DWT, DCT, LSB | 38.65   | DWT   | 0.0000 (5/5) | 0.0000 (5/5) | 0.0012 (3/5) |
| DCT, DWT, LSB | 38.65   | DWT   | 0.0000 (5/5) | 0.0000 (5/5) | 0.0012 (3/5) |
| LSB, DCT, DWT | 38.63   | DWT   | 0.0000 (5/5) | 0.0000 (5/5) | 0.0008 (4/5) |
| DCT, LSB, DWT | 38.62   | DWT   | 0.0000 (5/5) | 0.0000 (5/5) | 0.0008 (4/5) |
| DWT, LSB, DCT | 38.63   | DWT   | 0.0000 (5/5) | 0.0000 (5/5) | 0.0012 (3/5) |
| LSB, DWT, DCT | 38.63   | DWT   | 0.0000 (5/5) | 0.0004 (4/5) | 0.0023 (3/5) |

The DCT layer is exact in every run of every order (BER 0 after all three attacks). The LSB layer is
exact without an attack only when it is embedded last (5/5, BER 0.0000); in the four orders where a
method runs after it, BER is 0.51 to 0.56 and 0 of 5 are exact. LSB is first or second in four of the
six orders, so this alone fixes LSB last and leaves two orders: DCT, DWT, LSB and DWT, DCT, LSB. PSNR
differs by at most 0.03 dB between orders (38.62 to 38.65), so it does not decide anything.

At 64 bytes the two remaining orders are equal for step 64 (JPEG 75: 0.0012, 3/5 in both). For DWT step
32 the difference (JPEG 75 BER 0.0031 with 3/5 exact against 0.0039 with 2/5) is within noise on five
images. The decision therefore rests on two other cases.

Level 1, step 32, 64-byte messages. DWT first, then DCT, loses the DWT layer even without an attack:

| order         | PSNR dB | DWT none     | DWT JPEG 90  | DWT JPEG 75  |
| ------------- | ------- | ------------ | ------------ | ------------ |
| DWT, DCT, LSB | 39.35   | 0.4078 (0/5) | 0.3391 (0/5) | 0.3734 (0/5) |
| DCT, DWT, LSB | 39.34   | 0.0000 (5/5) | 0.0012 (3/5) | 0.0305 (0/5) |

Each layer filled to 95% of capacity, step 64 (PSNR falls to about 32 dB at this load):

| order         | PSNR dB | DWT none     | DWT JPEG 90  | DWT JPEG 75  |
| ------------- | ------- | ------------ | ------------ | ------------ |
| DWT, DCT, LSB | 32.00   | 0.0029 (1/5) | 0.0056 (1/5) | 0.0070 (1/5) |
| DCT, DWT, LSB | 32.01   | 0.0000 (5/5) | 0.0011 (2/5) | 0.0022 (1/5) |
| LSB, DCT, DWT | 32.01   | 0.0000 (5/5) | 0.0011 (2/5) | 0.0023 (1/5) |
| DWT, LSB, DCT | 31.98   | 0.0030 (2/5) | 0.0057 (1/5) | 0.0072 (1/5) |
| LSB, DWT, DCT | 31.98   | 0.0029 (2/5) | 0.0061 (1/5) | 0.0074 (1/5) |

(DCT, LSB, DWT matches DCT, DWT, LSB.) Whenever DCT runs after DWT, a full DWT layer is not exact even
without an attack; when DWT runs after DCT it is. DCT is exact in every run at this load too. So DCT
goes before DWT because a later DCT pass moves the DWT coefficients (a DCT change is a large part of a
DWT step) and a later DWT pass does not move DCT coefficients past the margin P = 40.

DWT parameters, order DCT, DWT, LSB, 64-byte messages: LL level 2 step 32 gives JPEG 75 BER 0.0031
(3/5), LL level 2 step 64 gives 0.0012 (3/5) at 0.7 dB lower PSNR, and LL level 1 step 32 gives 0.0305
(0/5), so level 2 is used. Step 32 against 64 is also within noise at 64 bytes; at 95% load step 32
leaves the DWT layer inexact without an attack on one of five images (4/5) where step 64 keeps 5/5,
which is why the preset uses 64. With Hamming(7,4) around both DCT and DWT (`bun run bench --preset
layered`, four natural images, 64-byte messages) every DCT and DWT layer reveals exactly after JPEG
90, 75 and 50 (16 of 16 each), mean PSNR is 35.5 dB, and the LSB layer is exact without an attack
only (BER about 0.5 after any JPEG).

## Consequences

- A layered image is always lossless PNG output (DESIGN.md): LSB layers do not survive any re-encoding.
- Layers cost PSNR: about 35.5 dB for the three layers with ECC, against about 37 to 47 dB for single
  methods. That is the price of the showcase feature and shows up in the lab per layer.
- The order is a property of the engine, not of the request, so the API takes a set of layers and the
  result does not depend on the order it arrives in. A new method has to add its place to the order
  table; the layered tests fail loudly if it does not fit.
- The final verification reveals every layer once, which is as many `extract` calls as the caller
  would make later anyway. Embedding a layered image costs roughly the sum of the layers plus that.
- The lab runs a layered image through the attack scenarios with `bun run bench --layered` or
  `--preset layered`: one row per layer, so success and BER are per layer; PSNR and SSIM are those of
  the whole stego image.
