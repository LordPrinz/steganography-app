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
- The API reaches it through a narrow `KeyValueStore` port (`get`, `set` with TTL, `del`, atomic
  `increment`, `ping`). The composition root creates the Bun `RedisClient` adapter. Tests use an
  in-memory fake, and the same contract suite runs against a real Redis when `TEST_REDIS_URL` is set.
- The client runs with `enableOfflineQueue: false` and reconnects in the background. While Redis is
  down, commands fail at once instead of holding requests open.
- Rate limiting uses a fixed window. `INCR` and `PEXPIRE` run in one Lua script, so a counter always
  has a TTL.
- `GET /api/v1/health/ready` returns 503 when Redis does not answer within 1 s.
- The job queue stays in Postgres (`FOR UPDATE SKIP LOCKED`), because jobs must be durable and
  transactional with their rows. Durable data never goes to Redis.

## Consequences

- Docker Compose and CI each run one more service. Locally it is Redis 8 with an AOF volume and the
  port bound to `127.0.0.1`. Its password comes from `REDIS_PASSWORD` in `.env` and is never committed.
- Rate-limit keys hold a SHA-256 of the id, so e-mails and IPs are not stored in Redis.
- If Redis is lost, only counters and cache entries go with it, so it needs no backup.
- We use no `ioredis` or `node-redis`, per ADR 2.
