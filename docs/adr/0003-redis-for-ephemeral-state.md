# 3. Redis for ephemeral shared state

- **Status:** accepted
- **Date:** 2026-11-04

## Context

Login needs rate limiting (#15), and uploads will need it later. A counter in API process memory resets
on every restart and is not shared between API instances. Postgres could hold the counters, but they
are written on every request and expire within minutes, which means churn and bloat for data nobody
keeps. Bun 1.4 ships a Redis client (`RedisClient` / `Bun.redis`), so Redis adds no npm dependency.

## Decision

- Redis holds only short-lived state that can be lost: rate-limit counters and small caches.
- The API and the worker reach it through a narrow `KeyValueStore` port, shared in `@stego/kv` (`get`, `set` with TTL, `del`, atomic
  `increment`, `ping`). The composition root creates the Bun `RedisClient` adapter. Tests use an
  in-memory fake, and the same contract suite runs against a real Redis when `TEST_REDIS_URL` is set.
- The client runs with `enableOfflineQueue: false` and reconnects in the background. While Redis is
  down, commands fail at once instead of holding requests open.
- Rate limiting uses a fixed window. `INCR` and `PEXPIRE` run in one Lua script, so a counter always
  has a TTL.
- `GET /api/v1/health/ready` returns 503 when Redis does not answer within 1 s.
- The job queue stays in Postgres (`FOR UPDATE SKIP LOCKED`), because jobs must be durable and
  transactional with their rows.

## Consequences

- Docker Compose and CI each run one more service. Locally it is Redis 8 with an AOF volume and the
  port bound to `127.0.0.1`. Its password comes from `REDIS_PASSWORD` in `.env` and is never committed.
- Rate-limit keys hold a SHA-256 of the id, so e-mails and IPs are not stored in Redis.
- If Redis is lost, only counters and cache entries go with it, so it needs no backup.
- Auth (#15) keeps two things here: rate-limit counters and the logout denylist of access token `jti`s,
  each with a TTL equal to the token's remaining lifetime. Both fail open while Redis is down. Rate limits
  are skipped rather than blocking every login, since argon2 still makes each guess expensive. The
  denylist is skipped too, so a logged-out access token stays valid until it expires (15 minutes at most).
  The refresh token is revoked in Postgres either way, so the session cannot be extended.

## Update: the hidden message in transit (#50)

Redis also carries the hidden message between API and worker, in both directions, because it may never
reach Postgres or the logs.

- Encode: the API stores the message under `op:{operationId}:message` with a 15-minute TTL in the request
  that enqueues the job. The job row only holds the operation id. The worker reads it on every attempt and
  deletes it when the job is succeeded or failed for good. If it is gone, the job fails with
  `message_expired` and is not retried.
- Decode: the worker stores the revealed message under `op:{operationId}:revealed` with a 5-minute TTL.
  The operation's `GET` returns it while the key exists. The stored result keeps only the outcome.
- Key names are built from the operation id alone, and a message may not exceed the engine's
  `MAX_MESSAGE_BYTES`.
- The worker needs Redis (`REDIS_URL`) and claims no job while Redis does not answer, since it could not
  read the message.
- With the AOF enabled, a deleted or expired message can stay in the append-only file until the next
  rewrite. Redis still holds no message for longer than its TTL, but the file is disk, so it must be
  protected like the database.
