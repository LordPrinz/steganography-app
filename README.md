# Steganography App

Image steganography web app: hide and recover data using **LSB**, **DCT (Koch–Zhao)** and **Haar DWT + QIM**, with a robustness lab that benchmarks each method against JPEG compression, resizing and blur.

- **Architecture & decisions:** [docs/DESIGN.md](docs/DESIGN.md)
- **Workflow, roles & conventions:** [CONTRIBUTING.md](CONTRIBUTING.md)
- **Wiki:** generated from these docs on every merge to `main` ([`wiki.yml`](.github/workflows/wiki.yml)); edit the files in this repository, not the wiki
- **Board:** GitHub Projects → _Steganography App_

## Stack

| Layer             | Tech                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Runtime / tooling | [Bun](https://bun.com) 1.4 — package manager, test runner, `Bun.serve`, `Bun.SQL`, `Bun.s3`, `Bun.Image`, `Bun.password` |
| Frontend          | Next.js 16 (App Router), React 19, Tailwind CSS 4, TanStack Query                                                        |
| API & worker      | Bun + TypeScript, Zod contracts                                                                                          |
| Database          | PostgreSQL via `Bun.SQL`, plain SQL migrations                                                                           |
| Object storage    | Cloudflare R2 via `Bun.s3` (RustFS locally)                                                                              |
| Cache / limits    | Redis via Bun `RedisClient`                                                                                              |
| Quality           | Biome, TypeScript strict, Husky git hooks, GitHub Actions                                                                |

## Repository layout

```
apps/
  api/            HTTP API (Bun.serve)
  worker/         background jobs: encoding, decoding, robustness experiments
  web/            Next.js frontend
packages/
  stego-engine/   steganographic methods, payload framing, metrics — pure TS, no I/O
  image-io/       decoding / encoding / attacks on top of Bun.Image
  native/         pixel kernels in C, loaded through bun:ffi
  contracts/      Zod schemas shared by api and web
  db/             SQL migrations, migration runner, row types (Bun.SQL)
infra/            docker-compose for Postgres, Redis and RustFS (S3)
scripts/          git hooks and GitHub automation (Bun scripts)
docs/             design docs and ADRs
```

## Getting started

Requirements: Bun ≥ 1.4.4, Docker, a C compiler (Xcode command line tools, gcc or clang).

```bash
bun install            # also installs the git hooks and builds the C kernels
cp .env.example .env
bun run infra:up       # Postgres :5432, Redis :6379, RustFS S3 :9000 (console :9001/rustfs/console/)
bun run db:migrate
bun run dev            # api :4000, worker, web :3000
```

## Scripts

| Command                       | What it does                                                             |
| ----------------------------- | ------------------------------------------------------------------------ |
| `bun run dev`                 | api + worker + web in watch mode                                         |
| `bun run check` / `check:fix` | Biome lint + format                                                      |
| `bun run typecheck`           | `tsc` in every workspace                                                 |
| `bun test`                    | all tests (DB / Redis tests need `TEST_DATABASE_URL` / `TEST_REDIS_URL`) |
| `bun run build`               | production build of the web app                                          |
| `bun run db:new <name>`       | new empty migration `packages/db/migrations/NNNN_<name>.sql`             |
| `bun run db:migrate`          | apply migrations                                                         |
| `bun run native:build`        | rebuild the C kernels (`packages/native/build/`)                         |
| `bun run native:sanitize`     | run the C kernels under ASan + UBSan                                     |
| `bun run native:bench`        | benchmark TS vs TinyCC vs `-O3` on a 12 MP image                         |
| `bun run native:format`       | format the C sources (clang-format 19.1.7 through `pipx`)                |
