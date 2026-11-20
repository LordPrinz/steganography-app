# 6. Error correction as a method wrapper

- **Status:** accepted
- **Date:** 2026-11-21

## Context

DCT and QIM flip some bits under JPEG compression and resizing. The frame's CRC catches the damage,
but one flipped bit is enough to lose the whole message. Issue #12 asks for a repetition code and one
block code behind one interface, selectable per method, with the overhead counted in capacity.

The code could live in three places: inside each method, in the codec (an extra argument to
`hide`/`reveal`/`measure`/`capacity`), or between the two.

## Decision

- An `ErrorCorrectingCode` has `codeBits(dataBits)`, `dataBits(codeBits)`, `encode(bits)` and
  `decode(code, dataBits)`. Two codes implement it: `repetition({ factor })` (each bit repeated
  `factor` times in a row, majority vote; `factor` is odd and at least 3) and `hamming74()` (one flip
  corrected per 7-bit codeword, data padded with zeros to whole codewords).
- `withErrorCorrection(method, code)` returns a `ConfiguredMethod` with the same id. `embed` encodes
  before embedding, `extract` reads `codeBits(n)` bits and decodes them, and `capacityBits` is
  `code.dataBits(method.capacityBits(...))`. The codec and its interface (ADR 5) do not change, and
  `capacity` reports message bytes after the code rate and the frame overhead.
- Codewords sit one after another, so `extract(n)` stays a prefix of `extract(m)` and `reveal` still
  reads only the header first. The codes do not interleave: spreading copies over the whole capacity
  would make every read cover the whole image, which ADR 5's read bound rules out.
- The frame goes inside the code, so it cannot say which code was used. The code is a parameter of
  the configured method, like `bitsPerChannel`, and a run is described by method id, method
  parameters and code. Revealing with the wrong code reads noise, so the result is `no-message` or
  `corrupted`, never another message.
- With a code, `measure` reports BER on the decoded payload bits: the errors the message still has
  after correction. The raw channel BER is what `measure` gives for the same method without a code.
- The codes are plain TypeScript. They run over frame bits (at most about 0.5 Mbit before coding),
  not over pixels, so they belong with the frame and CRC on the TypeScript side of ADR 4.
- The shared method contract and codec suites run over LSB with repetition ×3 and with Hamming(7,4).
  Code-level tests inject seeded bit flips: up to the code's limit per codeword the message comes
  back exactly, and one flip more in a payload codeword gives a CRC error.

## Consequences

- A new code is one more `ErrorCorrectingCode` and works with every method, existing and future.
- Methods without a code behave exactly as before.
- Repetition ×3 cuts capacity to a third and Hamming(7,4) to four sevenths. The lab can compare
  codes on the same method and attack.
- Errors in a burst (one damaged 8 × 8 DCT block) can exceed what one codeword corrects. If DCT or
  QIM show that, interleaving within a bounded window can be added inside a code without touching
  the codec.
