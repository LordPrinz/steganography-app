# Design

Living document. Record a decision here when it changes; larger ones get an ADR in [`adr/`](adr).

## Goals

1. Hide and recover a text message in an image with three methods: LSB, DCT (Koch–Zhao) and Haar DWT + QIM.
2. Measure how each method survives JPEG compression, resizing, blur and combinations of them.
3. Wrap it in a multi-user web app: accounts, gallery, history and a robustness lab.

The robustness lab is the core of the project; accounts and gallery are standard plumbing.

## Components

```
web (Next.js) ──/api/* rewrite──▶ api (Bun.serve) ──▶ Postgres (jobs, metadata)
                                        │                    ▲
                                        ▼                    │
                                  R2 / MinIO ◀──────── worker (Bun)
                                                   uses stego-engine + image-io
```

| Package         | Depends on       | Notes                                                                            |
| --------------- | ---------------- | -------------------------------------------------------------------------------- |
| `stego-engine`  | —                | Pure functions over raw RGBA pixels and bit streams. No I/O, trivially testable. |
| `image-io`      | `Bun.Image`      | Decode, re-encode, attacks. Takes and returns bytes, never paths.                |
| `contracts`     | zod              | Request/response schemas shared by api and web.                                  |
| `db`            | `Bun.SQL`        | Plain SQL migrations, a small migration runner, row types.                       |
| `api`, `worker` | all of the above |                                                                                  |
| `web`           | `contracts` only | Never imports the engine, so nothing server-side ends up in the browser bundle.  |

## Key decisions

### Payload frame

Every method embeds the same frame: `magic "SG" | version | method id | length (u32) | payload | CRC32`
(`packages/stego-engine/src/payload/frame.ts`). The CRC lets the decoder tell a real message apart from
noise read out of a clean image; without it "decoding success" and "detection" are undefined.
Error-correcting codes for DCT / QIM go on top of this frame (backlog).

### Output is always lossless

Encoded images are stored and served as PNG, byte-for-byte. JPEG input is decoded to pixels first.
Next.js image optimisation is disabled (`images.unoptimized`) because re-encoding destroys hidden data.

### Embedding domain

DCT and DWT embed in luminance (Y of YCbCr): JPEG keeps luma at full resolution and subsamples chroma.
Rounding / clipping to 0–255 after the inverse transform can flip bits even without an attack, so every
method's round-trip test without attacks must recover the payload exactly.

### Decoding after resizing

Resizing breaks the 8×8 / wavelet grid. The lab uses **non-blind** decoding for resize scenarios: the
attacked image is scaled back to the original size (known from the experiment) before decoding.
Blind resynchronisation is out of scope.

### Heavy work runs in the worker

Encoding and experiments (3 methods × N attack variants) run in `apps/worker`, never on the API event
loop. The API inserts a `jobs` row; the worker picks it with `SELECT … FOR UPDATE SKIP LOCKED`; the
frontend polls job status. No Redis.

### Image processing on Bun.Image

`Bun.Image` covers decoding (with `maxPixels` against decompression bombs and EXIF auto-orient), JPEG at
a given quality and resizing with selectable kernels. It does **not** expose raw pixels or blur, so
`image-io` adds a PNG ↔ RGBA codec and a Gaussian blur (backlog). Hot loops (DCT, Haar, convolution) may
get a C implementation via `bun:ffi` behind the same interface, verified against the TS version.

### Security baseline

- Passwords: `Bun.password` (argon2id).
- Auth: short-lived JWT access token + refresh token (hashed in DB, revocable), both in `httpOnly`,
  `SameSite=Lax` cookies. Same-origin API via Next rewrites, so no CORS.
- Storage: private bucket, keys `users/{userId}/{uuid}.png`, short-lived presigned URLs issued only
  after an ownership check. Every query by id is scoped to the current user.
- Uploads: format sniffed from bytes, pixel limit, size limit, metadata stripped.
- The hidden message is **never** stored in the database.

### Bun built-ins over libraries

Bun ships what this project needs: `Bun.serve` (routing), `Bun.SQL` (Postgres), `Bun.s3` (R2 / MinIO,
presigned URLs), `Bun.password`, `Bun.Image`, `Bun.hash.crc32`, `bun:test`, `bun:ffi`. A library is added
only when Bun has no equivalent (zod for validation, Next.js and React for the UI). See ADR 2.

## Metrics

| Metric         | Meaning                                      |
| -------------- | -------------------------------------------- |
| Decode success | Frame decoded and CRC matches                |
| BER            | Bit error rate of the payload bits           |
| PSNR / SSIM    | Visual quality, computed on luminance        |
| Capacity       | Payload bytes that fit, after frame overhead |
| Time           | Encode / decode duration                     |

## Data model

Defined in `packages/db/migrations/*.sql`, mirrored by row types in `packages/db/src/types.ts`:
`users`, `refresh_tokens`, `images`, `operations` (user-visible history), `jobs` (work queue).
Queries are tagged-template SQL (`` sql`SELECT … WHERE id = ${id}` ``), parameterised by Bun.
Migrations are forward-only; an applied file is checksummed and must never be edited.
