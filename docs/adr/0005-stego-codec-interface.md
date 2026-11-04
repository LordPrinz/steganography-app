# 5. Stego codec interface

- **Status:** accepted
- **Date:** 2026-11-04

## Context

The API, the worker and the robustness lab all need the same steps: encode the message as UTF-8, wrap
it in a frame, turn the frame into bits, check that it fits, embed it, and on the way back read the
header, read the rest, check the CRC and decode the text. `stego-engine` exported `frame`, `bits` and
`StegoMethod<Params>` separately, so every caller would have to put these steps together itself, and
each one could get capacity or error handling slightly wrong. Methods also took their parameters on
every call, so a caller had to carry the method and its parameters around as a pair.

## Decision

- `stego-engine` exports one module, the stego codec:
  - `hide(image, message, method)` returns a new image. It throws `CapacityExceededError { needed,
    available }`, in UTF-8 message bytes, when the message does not fit. That is a caller bug: the
    caller checks `capacity` first.
  - `reveal(image, method)` returns `{ ok: true, message }` or `{ ok: false, error }` with `error` one
    of `no-message`, `corrupted` or `method-mismatch`. Failure is a returned value; `reveal`
    does not throw for it.
  - `measure(attacked, expectedMessage, method)` returns `{ ok, ber }` or `{ ok: false, error, ber }`:
    the reveal outcome without the revealed message, plus `ber`. The caller already has the expected
    message, and leaving it out means a lab result can be stored without leaking the hidden text.
  - `capacity(width, height, method)` returns UTF-8 message bytes after the frame overhead.
- The message is a `string`. UTF-8 encoding and decoding happen only inside the codec. Decoding is
  strict (invalid UTF-8 means `corrupted`) and keeps a leading BOM, because it is part of the message.
- `method` is a configured method (`ConfiguredMethod`): an implementation with its parameters
  bound, e.g. `lsb({ bitsPerChannel: 1 })`. It has `id`, `capacityBits(width, height)`,
  `embed(image, bits)` and `extract(image, n)`. `extract(n)` must be a prefix of `extract(m)` for
  `n < m`, and both `embed` and `extract` throw `RangeError` beyond `capacityBits`.
- `reveal` reads the 8-byte header first. A missing or invalid header (bad magic, unknown version,
  unknown method id, or an image too small for a header) is `no-message`. A payload length above the
  capacity, a CRC mismatch or invalid UTF-8 is `corrupted`. A valid frame with another method's id
  is `method-mismatch`. The length bound means a damaged length field never makes a method read
  past what it can hold. Because the length and CRC are checked first, `method-mismatch` needs both
  methods to share a bit layout. A frame from a method that embeds in another domain (LSB vs DCT)
  reads as noise and gives `no-message`, and one longer than this method's capacity gives
  `corrupted`.
- BER counts only payload bits (the UTF-8 message). It compares the bits read from the attacked image
  with the bits of the frame the codec would write for the expected message, at the same positions.
  It is defined even when the CRC fails, and it is 0 for an empty message. Header and CRC bits are
  left out, so BER measures damage to the message only.
- `index.ts` exports the codec, `ConfiguredMethod`, `MethodId`, `RgbaImage` and the result and error
  types. `frame` and `bits` are internal.
- Two shared suites run over every configured method in `src/testing/methods.ts`: the method contract
  (internal seam) and the codec suite. Until LSB lands (#4) the list holds a test-only TypeScript
  fake method.

## Consequences

- Callers never touch frames or bits, and a new method plugs in by adding one entry to the test list
  and passing both suites.
- A configured method is a plain object, so the lab and the history can describe a run as method id
  plus parameters and rebuild the method from them.
- `reveal` calls `extract` twice (header, then the whole frame). Since methods run one FFI call per
  operation (ADR 4), that is two calls, not one per bit.
- `measure` reveals and extracts separately, so it costs one more `extract` than `reveal` alone.
  The lab can live with that. If it shows up in profiles, the codec can share the extracted bits
  without changing the interface.
