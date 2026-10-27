# 1. Monorepo on Bun workspaces

- **Status:** accepted
- **Date:** 2026-10-27

## Context

Three people build a frontend, an API with a background worker, and a steganography engine, all in
TypeScript. The original plan used two repositories (backend, frontend).

## Decision

One repository with Bun workspaces: `apps/{api,worker,web}` and `packages/{stego-engine,image-io,contracts,db}`.
Bun is the package manager, test runner and server runtime. Next.js runs on Node through `next dev/build`.

## Consequences

- API request/response types are shared through `packages/contracts` instead of being copied.
- One CI pipeline, one set of conventions, atomic changes across api and web.
- Apps can still be deployed independently.
- No Turborepo: `bun run --filter` is enough for this size.
