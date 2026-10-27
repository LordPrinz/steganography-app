# Contributing

## Team roles

| Role                  | Owns                                                                             | Area on the board |
| --------------------- | -------------------------------------------------------------------------------- | ----------------- |
| **Engine & research** | `packages/stego-engine`, `packages/image-io`, robustness experiments, benchmarks | Engine            |
| **Backend & DevOps**  | `apps/api`, `apps/worker`, `packages/db`, auth, storage, CI/CD, deployment       | API, Infra        |
| **Frontend & QA**     | `apps/web`, UI of the robustness lab, charts, E2E tests                          | Web               |

Everyone writes docs for their own area. Every PR is reviewed by someone from a **different** area, so the whole team knows the whole system. Owners are listed in [.github/CODEOWNERS](.github/CODEOWNERS).

## Board

`Backlog → Todo → In Progress → QA → Done`

| Status      | Meaning                             | How it gets there                        |
| ----------- | ----------------------------------- | ---------------------------------------- |
| Backlog     | Not planned yet                     | new issue (automatic)                    |
| Todo        | Planned for the current sprint      | sprint planning (manual)                 |
| In Progress | Someone is working on it            | branch `ST-<n>-…` pushed (automatic)     |
| QA          | PR open: code review + manual check | PR opened / ready for review (automatic) |
| Done        | Merged to `main`                    | PR merged (automatic)                    |

Fields: **Area**, **Priority** (P0 blocks others · P1 this sprint · P2 nice to have), **Size** (S ≤ ½ day · M 1–2 days · L split it), **Sprint** (2 weeks).

Every task is a GitHub issue — create it from the board with _+ Add item → Create new issue_, never as a draft (drafts have no number).

## Flow

```bash
gh issue develop 44 --name ST-44-set-user-permissions --checkout   # or "Create a branch" on the issue
# …work…
git commit -m "chore: Set user permissions"     # hook turns it into "[ST-44] chore: Set user permissions"
git push -u origin HEAD                          # pre-push: branch name, typecheck, tests
gh pr create --fill                              # PR title must follow the same format
```

## Conventions

- **Ticket** `ST-<n>` is issue `#<n>` (autolinked on GitHub).
- **Branch:** `ST-<n>-short-kebab-description`.
- **Commit / PR title:** `[ST-<n>] <type>(<optional scope>): <Description>`
  - types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `perf`, `ci`, `build`
  - scopes: `engine`, `image-io`, `api`, `worker`, `db`, `web`, `infra`
  - `!` after the type/scope marks a breaking change.
- PRs are **squash-merged**; the PR title becomes the commit on `main`.

## Git hooks (Husky)

| Hook                 | Runs                                           |
| -------------------- | ---------------------------------------------- |
| `prepare-commit-msg` | adds `[ST-<n>]` from the branch name           |
| `commit-msg`         | validates the header format                    |
| `pre-commit`         | `biome check --staged --write` on staged files |
| `pre-push`           | branch name check, `typecheck`, `bun test`     |

CI repeats every check, so `--no-verify` only moves the failure to the PR.

## Definition of done

- Acceptance criteria in the issue are met.
- Tests cover the change; CI is green.
- One approving review from another area.
- Docs and `docs/DESIGN.md` updated if a decision changed (larger decisions get an ADR in `docs/adr`).
