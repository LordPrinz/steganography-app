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
- **Capacity: independent per layer.** `capacityLayered(width, height, methods)` returns what
  `capacity` returns for each method, in the given order. Layers do not share bit positions (each is
  a different domain, and LSB starts at pixel 0), so nothing is subtracted. The tests fill all three
  layers to capacity and every one still reveals.
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

Procedure: five images (the four natural `kodim` fixtures at 384 x 256 plus one generated 512 x 512),
a 64-byte message per layer, all six orders of the three methods, each layer measured with `measure`
after no attack, JPEG 90 and JPEG 75. Orders were embedded with sequential `hide` calls in a
throwaway script. Apple M3 Max, Bun 1.4.4. Every figure is a mean over the five images; "exact" counts
images where the frame revealed cleanly.

LSB loses to any method that runs after it, in every parameter set: BER 0.51 to 0.57, 0 of 5 exact
without an attack. That fixes LSB last. The remaining question is DCT against DWT (DWT LL level 2,
step 32, and the rest below with LSB last):

| order         | PSNR dB | DCT none / JPEG 75 BER | DWT none | DWT JPEG 90 | DWT JPEG 75 (exact) |
| ------------- | ------- | ---------------------- | -------- | ----------- | ------------------- |
| DCT, DWT, LSB | 39.29   | 0.0000 / 0.0000        | 0.0000   | 0.0000      | 0.0031 (3/5)        |
| DWT, DCT, LSB | 39.29   | 0.0000 / 0.0000        | 0.0000   | 0.0016      | 0.0043 (2/5)        |

DWT at level 1, step 32 shows the effect more strongly: with DWT first, a later DCT pass destroys it
(BER 0.42 without an attack, 0 of 5 exact); with DCT first it is exact without an attack and JPEG 75
gives BER 0.034. DCT is not hurt by a later DWT pass in any run. The reason is the size of the
perturbation: DCT moves a block's coefficients by tens of units, which is a large fraction of a DWT
step, while a DWT step of 32 to 64 on a coarse band moves each DCT coefficient far less than the
margin P = 40.

Load matters too. With each layer at 95% of its capacity (capped at 4000 bytes), DCT, DWT, LSB is
still exact without an attack on all five images, while DWT, DCT, LSB reveals the DWT layer on only
one of five (BER 0.0071 at step 32, 0.0030 at step 64).

DWT parameters, order DCT, DWT, LSB:

| DWT band, level, step | PSNR dB | DWT JPEG 90 | DWT JPEG 75 (exact) |
| --------------------- | ------- | ----------- | ------------------- |
| LL, 2, 32             | 39.29   | 0.0000      | 0.0031 (3/5)        |
| LL, 2, 64             | 38.62   | 0.0000      | 0.0008 (4/5)        |
| LL, 1, 32             | 39.30   | 0.0020      | 0.0344 (0/5)        |

Level 2 beats level 1 because the coefficient is averaged over 4 x 4 pixels and moves less under the
DCT layer's changes. Step 64 costs 0.7 dB and survives more. With Hamming(7,4) around both DCT and DWT
(`bun run bench --preset layered`, four natural images, 64-byte messages) every DCT and DWT layer
reveals exactly after JPEG 90, 75 and 50 (16 of 16 each), mean PSNR is 35.5 dB, and the LSB layer is
exact without an attack only (BER about 0.5 after any JPEG).

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
