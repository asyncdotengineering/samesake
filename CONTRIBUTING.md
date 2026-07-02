# Contributing to Samesake

Samesake is in **alpha**: APIs break freely between minors, there are no compatibility layers, and
the codebase is reshaped rather than patched. If that cadence suits you, contributions are welcome.

## Prerequisites

- [Bun](https://bun.sh) 1.2+
- Postgres 15+ (16 recommended) with `vector` (pgvector ≥ 0.7; 0.8 recommended), `pg_trgm`,
  `unaccent`, `fuzzystrmatch`. The easiest way is the pgvector image — contrib extensions ship in
  the base image and `matcher.migrate()` creates all four:

  ```bash
  docker run -d --name samesake-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 pgvector/pgvector:0.8.0-pg16
  ```

## Setup

```bash
bun install
cp .env.example .env   # set SAMESAKE_DATABASE_URL (and provider keys only if you need live LLM paths)
bun run build          # builds packages/sdk, server, cli, mcp
```

**Build-order gotcha**: workspace packages resolve `@samesake/*` types from `dist/`, not `src/`.
After changing types in `packages/sdk`, rebuild it before typechecking dependents; rebuild
`packages/server` and `packages/cli` before running examples.

## Verifying changes

```bash
bun run typecheck   # tsc --noEmit across the workspace
bun run lint        # oxlint over packages/*/src
bun run test        # sdk + server suites (needs SAMESAKE_DATABASE_URL)
```

- Tests run from the repo root so the root `bunfig.toml` test timeout applies.
- Against a high-latency database (e.g. Neon over the internet) a test can occasionally flake on
  timeout — rerun before diagnosing. A local Docker Postgres does not have this problem.

The three **release-gate examples** must pass before any release — they are the minimal adopter
paths and they have caught silent breaks the unit suites missed:

```bash
bun run examples:hello-search
bun run examples:hello-spaces
bun run examples:quickstart
```

CI (`.github/workflows/ci.yml`) runs typecheck, both suites, and the release-gate examples against
a fresh pgvector container.

## Making changes

- Keep diffs surgical — touch only what the change requires.
- Behavior changes need tests; bug fixes need a test that reproduces the bug.
- No compatibility shims or deprecation aliases (alpha rule): rename/reshape outright and update
  all callers in the same PR.
- User-facing changes need a changeset: `bunx changeset` (this drives versioning and CHANGELOG).
- The docs site lives in `apps/docs` (Astro/Starlight); `cd apps/docs && bun run build` must pass
  if you touched docs content.

## Where to start

- `docs/system-behavior-spec.md` — what the system does today, with file-path citations.
- `ROADMAP.md` — what's being built next and what was explicitly rejected.
- `docs/stage-fit-audit-and-iron-out-plan.md` — the full audit behind the roadmap.

Open an issue before large changes so direction is agreed before the diff exists.
