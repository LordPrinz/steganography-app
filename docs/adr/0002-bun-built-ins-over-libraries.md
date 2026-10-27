# 2. Bun built-ins over libraries

- **Status:** accepted
- **Date:** 2026-10-27

## Context

Bun 1.4 includes a router, a Postgres client, an S3 client, password hashing and an image pipeline.
The usual alternatives (Hono, Drizzle, AWS SDK, sharp) add dependencies, native builds or abstractions
over things Bun already does.

## Decision

| Need             | Use                                 | Instead of               |
| ---------------- | ----------------------------------- | ------------------------ |
| HTTP routing     | `Bun.serve({ routes })`             | Hono / Express           |
| Postgres         | `Bun.SQL` + plain `.sql` migrations | Drizzle / Prisma / pg    |
| R2 / MinIO       | `Bun.s3` / `S3Client`               | AWS SDK                  |
| Passwords        | `Bun.password` (argon2id)           | bcrypt / argon2 packages |
| Images           | `Bun.Image`                         | sharp / jimp             |
| Tests            | `bun:test`                          | Jest / Vitest            |
| Native hot loops | `bun:ffi`                           | N-API addons             |

Libraries stay where Bun has no equivalent: zod (validation and shared contracts), Next.js / React (UI).

## Consequences

- Fewer dependencies, no native addon builds, one runtime to learn.
- No ORM: queries are tagged-template SQL, row types in `packages/db/src/types.ts` are maintained by hand
  next to the migrations, and DB tests run against a real Postgres in CI.
- Newer Bun APIs (`Bun.Image`) may change; `image-io` keeps them behind a small interface.
