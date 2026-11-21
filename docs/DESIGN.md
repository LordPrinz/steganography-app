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
                                        ├──▶ Redis (rate limits, cache, message handoff)
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
An error-correcting code (repetition with majority vote, or Hamming(7,4)) can wrap any configured method:
`withErrorCorrection(method, code)` encodes the frame bits before embedding and decodes them after
extraction, and capacity shrinks by the code rate. The codec does not change. See ADR 6.

Only the stego codec (`hide`, `reveal`, `measure`, `capacity`) builds and reads frames; the frame and bit
packing are internal to `stego-engine`. Methods receive bits and know nothing about the frame. `reveal`
reads the header first, then the whole frame, and reports `no-message` (no valid header), `corrupted`
(bad length, CRC or UTF-8) or `method-mismatch`. Messages are capped at `MAX_MESSAGE_BYTES` (64 KiB), which
bounds what a forged length field can make `reveal` read. See ADR 5.

### Output is always lossless

Encoded images are stored and served as PNG, byte-for-byte. JPEG input is decoded to pixels first.
Next.js image optimisation is disabled (`images.unoptimized`) because re-encoding destroys hidden data.

### Embedding domain

DCT and DWT embed in luminance (Y of YCbCr): JPEG keeps luma at full resolution and subsamples chroma.
Rounding / clipping to 0–255 after the inverse transform can flip bits even without an attack, so every
method's round-trip test without attacks must recover the payload exactly.

Haar DWT + QIM (`dwtQim({ band, level, step })`) hides one bit per coefficient of one band at one level.
It reads the image back during embedding and moves again any bit that rounding or clamping would flip.
The step must exceed 2^(level + 1). Recommended: LL, level 2, step 32. See ADR 8.

Koch–Zhao embeds one bit per whole 8 × 8 block of Y by pushing the magnitudes of two DCT coefficients at
least P apart. The pair is (3,2) vs (2,3) and P is 40, chosen from measurements on natural images: the
default survives JPEG quality 75, and quality 50 with Hamming(7,4). Embedding checks every block the way
extraction reads it and retries with a larger margin when rounding or clipping spoils it, so the round
trip is exact. See ADR 7.

### Layered embedding

`hideLayered(image, layers)` hides one message per method in the same image: DCT first, DWT second, LSB
last, whatever order the caller lists them in. Each layer embeds its own frame through the unchanged
codec, so `reveal(image, method)` and `measure` read one layer at a time, and `capacityLayered` reports
each method's own capacity (a full set of layers can still fail the verification pass). DWT does not survive a later DCT pass and LSB does not survive any later
method, so the order is fixed by measurements. A message that does not fit throws `CapacityExceededError`
with the layer index; a layer that does not reveal after embedding throws `LayerConflictError`.
Two layers cannot use the same method. See ADR 9.

Engine source and tests stay free of I/O. Experiments that need image files or attacks live in the bench CLI (`tools/bench`), which depends on engine, `image-io` and `contracts`; its fixtures are in `tools/bench/images`.

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

Polling stays the source of truth, and Redis only shortens the wait. After the transaction that inserts a job
commits, the API calls `notify()` from `@stego/kv`, which publishes an empty message on `jobs:enqueued`. The
worker listens on a Redis client of its own and, on a message, skips its pause and claims at once. Bursts of
messages collapse into one extra claim, and the message carries no ids or params. If Redis is down, `notify()`
logs the error and returns, so the enqueue still succeeds, and the worker finds the job on its next poll. The
subscription is renewed after every reconnect; a message sent in between is covered by polling.

`jobs.error` holds only a short code from `JobError` (`timeout`, `no_handler`, …). Any other error is
stored as `internal_error`, and its details go only to the worker log. Handler results are stored in
`operations.result` and errors are logged, so neither may contain the hidden message, and neither may
`operations.params`. Handlers treat `params` as user input and parse it with the contract schema.

### Redis for ephemeral state

Rate-limit counters, small caches and the hidden message in transit live in Redis behind a `KeyValueStore`
port (Bun `RedisClient`). The port, its adapters and the message handoff are in `@stego/kv`, which both
apps import. Only losable, short-lived data goes there; anything durable stays in Postgres.
`GET /api/v1/health/ready` reports 503 when Redis is down, and the worker claims no job while Redis does
not answer. See ADR 3.

The hidden message never reaches Postgres or the logs. For encode, the API stores it under
`op:{operationId}:message` (TTL 15 min, at most `MAX_MESSAGE_BYTES`) in the request that enqueues the
job. The handler reads it with `context.message()` on every attempt, so retries work. The worker deletes
it once the job is succeeded or failed for good. A missing or expired message fails the job with
`message_expired` and no retry. For decode, the handler calls `context.reveal()`, which stores the text
under `op:{operationId}:revealed` (TTL 5 min). `GET` on the operation returns it while the key exists;
afterwards the history shows only the outcome. Key names use the operation id only. Redis keeps an AOF on
disk, so a message can outlive its delete in the file until the next rewrite; the TTLs bound the window.

### Image processing on Bun.Image

`Bun.Image` covers decoding (with `maxPixels` against decompression bombs and EXIF auto-orient), JPEG at
a given quality and resizing with selectable kernels. It does **not** expose raw pixels or blur, so
`image-io` adds a PNG ↔ RGBA codec (`decodeRgba`/`encodePng`) and a separable Gaussian blur in
`@stego/native` (radius ⌈3σ⌉, edge pixels repeated, alpha untouched).

### Attacks and scenarios

An attack is a JSON object such as `{ "type": "jpeg", "quality": 75 }`, `{ "type": "resize", "scale": 0.5 }`
or `{ "type": "blur", "sigma": 1.5 }`; a scenario is an ordered list of up to 8 of them. Both are zod
schemas in `@stego/contracts` (`Attack`, `Scenario`), so the same JSON goes into the history and back.
Parameters are relative, so one scenario fits any image. `image-io` maps each attack type to its
implementation in one registry (`applyAttack`), and `applyScenario` runs the list in order on RGBA
pixels. A resize changes the size for the attacks after it, as when a downscaled image is then
recompressed; `applyScenario` scales the final result back to the original size (non-blind decoding,
above). Both resizes use the Lanczos-3 filter. A JPEG step drops transparency (alpha becomes 255).
The attacks reject parameters they cannot run, but only the schema enforces the lab's ranges, so the
API must parse every scenario with `Scenario` before it reaches the worker. Every attack passes a shared
contract suite (`image-io/test/attack-contract.test.ts`).

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
  - Access token: HS256 JWT, 15 minutes, cookie path `/api/v1`. The MAC key is derived from `JWT_SECRET`
    with HKDF and used through Bun's HMAC (no JWT library). Logout puts its `jti` on a Redis denylist
    until it expires.
  - Refresh token: 256 random bits, 7 days, cookie path `/api/v1/auth`, stored as SHA-256. Every refresh
    rotates it. A rotated token presented within 10 s of the rotation (two tabs refreshing at once) gets
    a 401 and nothing else happens. Later than that it counts as leaked, and all of the user's sessions
    are revoked.
  - CSRF: every state-changing request must carry `Origin: APP_ORIGIN`, otherwise 403. The check wraps
    all routes in `createServer`. Non-browser clients (curl, scripts) have to send the header too.
  - JSON request bodies are capped at 64 KiB.
  - Rate limits (fixed window, Redis), 429 with `Retry-After`: login 20 / 15 min per IP and 10 failures
    / 15 min per e-mail and IP (successful logins do not count), register 5 / hour per IP, refresh
    60 / 15 min per IP. IPv6 clients are counted per /64.
  - Guessing one account from many IPs: after 100 failures in an hour, each login for that account is
    held back 100 ms per extra failure, at most 3 s. It is slowed down, never locked.
  - No account enumeration: register answers 202 whether or not the e-mail is taken, and login gives the
    same 401 for an unknown e-mail and a wrong password, with the same argon2 work in both cases.
  - Client IP: Next cannot see the real connection address of a request (it fills in `X-Forwarded-For`
    only when the client did not send one), so Caddy (`infra/Caddyfile`) sits in front of Next and sets
    `X-Client-IP` from the TCP connection. Next passes it on, and the API believes it only from peers in
    `TRUSTED_PROXIES` (the Next server); from anyone else it uses the socket address. **In production Next
    must be reachable only through Caddy**, or clients can pick their own IP. Deployment (ST-23) has to
    keep that.
- Storage: private bucket, keys `users/{userId}/{uuid}.png`, short-lived presigned URLs issued only
  after an ownership check. Every query by id is scoped to the current user.
- Uploads (`POST /api/v1/images`, multipart field `file`; with several `file` parts the first counts):
  - At most 10 MiB, PNG, JPEG or WebP by magic bytes (the declared type is ignored), at most 4096 × 4096
    pixels.
  - The image is decoded and re-encoded as PNG, which drops EXIF and every other metadata chunk. The
    uploaded bytes are never stored.
  - The re-encoded PNG may be at most 32 MiB (413 `image_too_large`). A noisy image can grow a lot when
    it is stored losslessly.
  - 60 uploads per hour per user.
  - Quota per user: 200 images and 1 GiB of stored PNG (413 `quota_exceeded`). It is checked early, and
    again inside the insert transaction under a per-user row lock, so concurrent uploads cannot
    overshoot. A refused upload leaves no object in storage.
  - A decode holds up to 64 MiB of pixels, so at most 2 decodes run at once per API process. A third
    gets 503 with `Retry-After: 2` straight away; nothing queues.
- Request body limits:
  - Bun has one body limit for the whole server, so it is set to fit uploads (10 MiB plus multipart
    overhead).
  - JSON bodies are capped at 64 KiB in `parseBody`.
- Gallery: `GET /api/v1/images` pages newest first with an opaque keyset cursor on `(created_at, id)`,
  backed by `images_user_gallery_idx`. Another user's image is a 404, never a 403. Deleting removes the
  object from storage first, then the row, so a failed delete can be retried.
- Operations (`POST /api/v1/operations/encode`, `POST /api/v1/operations/decode`,
  `GET /api/v1/operations/:id`):
  - A request names a method with its parameters and an optional error-correcting code (repetition or
    Hamming(7,4)). Each method has a zod schema in `@stego/contracts` that fills in defaults and checks the
    ranges, and the engine's `createMethod` registry builds the method. Encode takes `layers` (exactly one
    until layered embedding exists); decode takes one method or `"auto"`, which tries every method with its
    default parameters and no error correction.
  - The source image must be the user's own (404 `image_not_found` otherwise). For encode the message is
    checked against the capacity before anything is queued: 422 `message_too_large` with `needed` and
    `available` in bytes (the message itself is never echoed).
  - The API stores the message in Redis first, then inserts the operation and its job in one transaction,
    then calls `notify()`. If the insert fails or the user is over the cap, the message is deleted at once.
    The answer is 202 with the operation id and a `Location` header.
  - Limits per user: 120 requests per hour (Redis), and at most 5 queued or running operations (counted in
    Postgres under the same per-user row lock as the image quota, so concurrent requests cannot overshoot;
    429 `too_many_operations`).
  - The worker loads the source through an owner-scoped lookup, runs the codec, and for encode stores the
    stego PNG under the user's prefix as a new `images` row of kind `stego` (same quota and 32 MiB ceiling as
    uploads), then records it in `operations.result_image_id`. Permanent problems (`source_missing`,
    `invalid_image`, `invalid_params`, `capacity_exceeded`, `image_too_large`, `quota_exceeded`) fail the job
    without retries.
  - `operations.result` holds metrics only. Encode: message bytes, capacity bytes, PSNR and time; PSNR is
    `null` when the stego image is identical to the source (infinite PSNR has no JSON form). Decode: one
    attempt per method with its outcome (`found`, `no-message`, `corrupted`, `method-mismatch`), message
    bytes, capacity and time, plus the first method that found a message.
  - `GET` is scoped to the owner, and another user's operation is a 404. It adds a presigned URL for the
    result image and, for a succeeded decode, the revealed message while its Redis key lives. It answers with
    `Cache-Control: no-store`. Succeeded and failed operations never change, so their stored fields are
    cached in Redis for 10 minutes (cache-aside, with the owner's id inside the entry); the URL and the
    revealed message are never cached. If Redis is down the read falls back to Postgres.
- History (`GET /api/v1/operations`, `DELETE /api/v1/operations/:id`):
  - The list is the owner's operations newest first, paged with the same opaque keyset cursor on
    `(created_at, id)` as the gallery (default 24, at most 100), backed by `operations_user_history_idx`.
    Filters `type`, `method` (`auto` means a decode that tries every method) and `status` are applied to
    the rows the `(user_id, created_at, id)` index walks. `EXPLAIN ANALYZE` on 200k rows (50 users) shows an
    index scan that stops early when matches are common (the PR has the plans); a filter that matches very
    few rows would walk more of the user's history.
  - A row carries the stored fields and `params`, but no presigned URL and no revealed message; those stay
    on the detail endpoint, which also returns `params`. The list answers with `Cache-Control: no-store`.
  - `DELETE` removes only a succeeded or failed operation (204; its job goes with it, the images stay in the
    gallery). A queued or running one is a 409 `operation_active`, because the worker still writes to it.
    Another user's operation is a 404. The cached view and any revealed message are dropped with the row.
- Robustness lab (`POST /api/v1/experiments`, `GET /api/v1/experiments/:id`):
  - Mode A hides the message with every registered method (default parameters, no code) and attacks each
    stego image with the 11 default scenarios (no attack, JPEG 90/75/50, resize 0.75/0.5, blur 0.5/1/2,
    resize 0.5 + JPEG 75, blur 1 + JPEG 75): 33 variants. Mode B takes one method with its parameters and
    optional code, plus 1 to 16 scenarios that chain at most 48 attacks in total (400 `invalid_request`). The API expands both into explicit `methods` and `scenarios`
    lists in `operations.params`, so a later change to the defaults cannot alter a queued job. The code
    sits next to the method id, as in encode.
  - Limits: an image of at most 1024 x 1024 pixels (422 `experiment_image_too_large`, with `pixels` and
    `maxPixels`), at most 36 variants (400 `too_many_variants`), and a message that fits every method it
    runs (422 `message_too_large` with `needed`, `available` and the `method` that failed first; in mode A
    a small image can fail on the DCT or DWT while LSB would fit). Experiments share the cap of 5 queued or
    running operations with encode and decode. They have their own rate limit, 20 per hour per user
    (`experiment-user`), charged before validation like encode. An image with a side under 11 pixels is
    refused too (422 `experiment_image_too_small`, with `minSide`), because SSIM is undefined there. The
    worker checks both image limits again (`image_too_large`, `image_too_small`).
  - The source of an experiment or an encode must be an original or stego image: a variant is a 404
    `image_not_found` there. A decode may take a variant, so the user can try to read what survived.
  - The message follows the encode path: Redis only, never `operations.params`, the result or the logs.
  - The worker hides the message once per method, then for each scenario attacks the stego image, reads the
    message back with `measure` and compares the attacked image with the cover (PSNR, SSIM). `result` holds
    per-variant metrics, per-method embedding metrics and aggregates (success rate and mean BER per method
    and scenario, with the attack type and its strength for a table or a line chart). It has no message.
  - Every attacked image is stored as an `images` row of kind `variant` with `expires_at` 24 hours ahead.
    Variants are not in the gallery and not in the image quota (the gallery index is partial, `WHERE kind
    <> 'variant'`). They have their own cap: 512 MiB of unexpired variant bytes per user, checked in
    `createVariant` under the same per-user row lock as uploads. Over the cap the image is not stored,
    the variant's `imageId` is `null` and the experiment goes on with its metrics. A worker cron (`Bun.cron`, every 15 minutes) deletes expired variants, object first and
    row second, so a failure leaves a row the next run retries. Batches page by `(expires_at, id)`, so a
    row that keeps failing does not hold back newer ones. An expired variant is served by no endpoint
    (no URL) even before the sweep removes it. A retried job (after a crash) may leave
    the variants of the failed attempt behind; they count against the 512 MiB cap until they expire with
    the TTL like the rest. Deleting an
    experiment from the history does not delete its variants; they also expire.
  - Progress is `{ done, total }` under `op:{id}:progress` in Redis (TTL 10 min, refreshed after every
    variant) and only shown while the operation is queued or running. If Redis fails, the job goes on
    without reporting.
  - `GET /experiments/:id` is owner-scoped (404 for another user's, a missing id, or an operation that is
    not an experiment) and answers with `Cache-Control: no-store`. A finished experiment's stored fields
    use the same cache-aside entry as other operations; the presigned variant URLs are made per request and
    left out for variants that expired. The history lists experiments with `type=experiment` (`method` is
    `auto` for mode A). A history row carries the experiment's `mode`, `messageBytes` and per-method
    summary but not its `variants` or `aggregates` (up to 36 variants per row would bloat a page of 100);
    the full result is on `GET /experiments/:id`.
- The hidden message is **never** stored in the database.

### Web sessions

- The auth cookies are scoped to `/api/v1`, so Next.js middleware and server components never see them.
  Route protection is therefore client-side: pages under the `(app)` route group render behind
  `RequireAuth`, which asks `GET /auth/me` and redirects to `/sign-in?next=<path>`. This is a usability
  guard only; the API enforces access on every request.
- The `next` value goes through `safeReturnPath`: same-origin relative paths only, never an auth page.
- On a 401 the web client refreshes the session and repeats the request once. Refresh is single-flight
  per tab (one shared promise) and per browser (`navigator.locks`, with a shared timestamp so a tab that
  waited for the lock skips its own refresh), which keeps parallel tabs inside the API's 10 s rotation
  grace window. A second 401 is returned to the caller, never looped. Requests with non-replayable bodies
  (FormData, streams) opt out of the retry.
- Signing in or out clears the whole query cache, so one user's data never shows for the next.

### Bun built-ins over libraries

Bun ships what this project needs: `Bun.serve` (routing), `Bun.SQL` (Postgres), `RedisClient` (Redis),
`Bun.s3` (R2 / RustFS, presigned URLs), `Bun.password`, `Bun.Image`, `Bun.hash.crc32`, `bun:test`, `bun:ffi`.
A library is added only when Bun has no equivalent (zod for validation, Next.js and React for the UI). See ADR 2.

## Metrics

| Metric         | Meaning                                                                                                                                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Decode success | Frame decoded and CRC matches                                                                                                                                                                                                   |
| BER            | Share of payload bits (UTF-8 message, no header or CRC) read wrong, after decoding when a code is used; defined even when the CRC fails                                                                                         |
| Channel BER    | With an error-correcting code only: share of coded bits the inner method read wrong, over the whole expected frame (header, payload, CRC), before the code corrects anything. Compared with BER it shows what the code absorbed |
| PSNR / SSIM    | Visual quality, computed on luminance                                                                                                                                                                                           |
| Capacity       | UTF-8 message bytes that fit, after the error-correcting code (if any) and frame overhead                                                                                                                                       |
| Time           | Encode / decode duration                                                                                                                                                                                                        |

PSNR and SSIM compare the luminance (Y, as the transform methods use it) of cover and stego image; alpha
is ignored. PSNR is `Infinity` for identical images. SSIM uses the parameters of Wang et al. 2004 (11 × 11
Gaussian window, σ = 1.5, K1 = 0.01, K2 = 0.03, L = 255), averaged over every window that fits inside the
image, so both sides must be at least 11 pixels. It matches scikit-image's `structural_similarity` with
`gaussian_weights=True, sigma=1.5, use_sample_covariance=False`. All three are exported from `stego-engine`
as `psnr`, `ssim` and `ber`.

## Data model

Defined in `packages/db/migrations/*.sql`, mirrored by row types in `packages/db/src/types.ts`:
`users`, `refresh_tokens`, `images`, `operations` (user-visible history), `jobs` (work queue).
`images.expires_at` is set for `variant` images (attacked images of the lab) and null for every other kind;
a check constraint keeps the two in step, and a partial index serves the worker's expiry sweep.
Queries are tagged-template SQL (`` sql`SELECT … WHERE id = ${id}` ``), parameterised by Bun.
Migrations are forward-only; an applied file is checksummed and must never be edited.
