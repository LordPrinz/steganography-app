# Design

Living document. Record a decision here when it changes; larger ones get an ADR in [`adr/`](adr).

## Goals

1. Hide and recover a text message in an image with three methods: LSB, DCT (Koch–Zhao) and Haar DWT + QIM.
2. Measure how each method survives JPEG compression, resizing, blur and combinations of them.
3. Wrap it in a multi-user web app: accounts, gallery, history and a robustness lab.

The robustness lab is the core of the project; accounts and gallery are standard plumbing.

## Components

```
web (Next.js) ──/api/v1/* rewrite──▶ api (Bun.serve) ──▶ Postgres (jobs, metadata)
                                        ├──▶ Redis (rate limits, cache)
                                        │                    ▲
                                        ▼                    │
                                  R2 / RustFS ◀─────── worker (Bun)
                                                   uses stego-engine + image-io
```

| Package         | Depends on            | Notes                                                                            |
| --------------- | --------------------- | -------------------------------------------------------------------------------- |
| `stego-engine`  | `native` (planned)    | Pure functions over raw RGBA pixels and bit streams. No I/O, trivially testable. |
| `image-io`      | `Bun.Image`, `native` | Decode, re-encode, attacks. Takes and returns bytes, never paths.                |
| `native`        | `bun:ffi`             | Pixel kernels in C behind a typed TS client (ADR 4).                             |
| `contracts`     | zod                   | Request/response schemas shared by api and web.                                  |
| `db`            | `Bun.SQL`             | Plain SQL migrations, a small migration runner, row types.                       |
| `api`, `worker` | all of the above      |                                                                                  |
| `web`           | `contracts` only      | Never imports the engine, so nothing server-side ends up in the browser bundle.  |

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
frontend polls job status. The queue is not in Redis: jobs are durable and transactional with their rows.

A failed attempt goes back to `queued` with exponential backoff (`run_after`) until `maxAttempts`, then
`failed`. A job type without a handler, or one that runs past its timeout (10 min by default), fails at once.
While a job runs the worker renews `locked_at` every 30 s. A `running` job whose lock is older than the
2-minute lease was left by a crashed worker and is claimed again. `attempts` doubles as a fencing token, so
the old owner can no longer renew or complete it. On SIGTERM the worker stops claiming and finishes the job
it holds. The operation's `status` follows its job, and each operation has at most one job.

`jobs.error` holds only a short code from `JobError` (`timeout`, `no_handler`, …). Any other error is
stored as `internal_error`, and its details go only to the worker log. Handler results are stored in
`operations.result` and errors are logged, so neither may contain the hidden message, and neither may
`operations.params`. Handlers treat `params` as user input and parse it with the contract schema.

### Redis for ephemeral state

Rate-limit counters and small caches live in Redis behind a `KeyValueStore` port (Bun `RedisClient`).
Only losable, short-lived data goes there; anything durable stays in Postgres. `GET /api/v1/health/ready`
reports 503 when Redis is down. See ADR 3.

### Image processing on Bun.Image

`Bun.Image` covers decoding (with `maxPixels` against decompression bombs and EXIF auto-orient), JPEG at
a given quality and resizing with selectable kernels. It does **not** expose raw pixels or blur, so
`image-io` adds a PNG ↔ RGBA codec and a Gaussian blur (backlog).

### Pixel kernels in C

Every per-pixel loop (colour conversion, LSB, DCT + Koch–Zhao, Haar DWT + QIM, blur, PSNR/SSIM/BER, PNG
filters) is C in `packages/native`, built with `cc -O3` and loaded through `bun:ffi` `dlopen`. One FFI
call covers a whole image or plane. JavaScript owns all buffers, and C returns status codes. Floats
are compiled without FMA contraction or fast-math, so results match across x64 and arm64. Tests compare
each kernel with a naive TS oracle, and an ASan/UBSan harness checks memory safety. See ADR 4.

### Security baseline

- Passwords: `Bun.password` (argon2id).
- Auth: short-lived JWT access token + refresh token (hashed in DB, revocable), both in `httpOnly`,
  `SameSite=Lax` cookies. Same-origin API via Next rewrites, so no CORS.
- Storage: private bucket, keys `users/{userId}/{uuid}.png`, short-lived presigned URLs issued only
  after an ownership check. Every query by id is scoped to the current user.
- Uploads: format sniffed from bytes, pixel limit, size limit, metadata stripped.
- The hidden message is **never** stored in the database.

### Bun built-ins over libraries

Bun ships what this project needs: `Bun.serve` (routing), `Bun.SQL` (Postgres), `RedisClient` (Redis),
`Bun.s3` (R2 / RustFS, presigned URLs), `Bun.password`, `Bun.Image`, `Bun.hash.crc32`, `bun:test`, `bun:ffi`.
A library is added only when Bun has no equivalent (zod for validation, Next.js and React for the UI). See ADR 2.

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
