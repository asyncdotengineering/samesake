# Changelog

All notable changes to samesake. Format roughly follows [Keep a Changelog](https://keepachangelog.com/).

## [1.0.0] — 2026-06-11

V1.0 launch prep. Closes the 0.2→1.0 arc.

### Package rename (npm availability verified 2026-06-11)

```
npm view samesake name version          → E404 (available)
npm view @samesake/core                 → E404 (available)
npm view @samesake/server                → E404 (available)
npm view @samesake/cli                   → E404 (available)
```

**Decision**: unscoped `@samesake/core` (SDK) + `@samesake/server` + `@samesake/cli`. Optional `@samesake/jobs-pgboss` unchanged.

Renamed from interim **`samesake`** / **`samesake-server`** / **`samesake-cli`** (successor to **linkable** entity-resolution packages). All imports, docs, examples, and CLI binary updated. Historical note retained in README.

### Added

- **[`BENCHMARKS.md`](./BENCHMARKS.md)** — three-way fan-out → spike → samesake story with honest methodology and caveats.
- **Typed embedding spaces** (V0.2) — segmented vectors, query-time weights, RRF leg; off by default per [`docs/spaces-gate.md`](./docs/spaces-gate.md).
- **`s.image` multimodal space** (V0.2i) — per-space image embedding with cross-modal query encoding.
- **Schema evolution** — config differ, migration plan/apply, destructive guard (V03b).
- **Job runner seam** — in-process default + `@samesake/jobs-pgboss` adapter (V03b).
- **Observability & policy** — structured logger, `/v1/metrics`, search explain, configurable LLM/embed/connector policy, per-project API keys (V03c).
- **CLI** — `samesake dev`, `samesake migrate`, `samesake eval` (V04).
- **Docs set** — spaces, production, migrating-from-superlinked, release checklist; `examples/hello-spaces`.

### Changed

- All publishable packages at **1.0.0**.
- Manual release gate (no CI): `bun test` + `bun run typecheck` + `bun scripts/pack-assert.ts` per [`docs/release.md`](./docs/release.md).

## [0.3.0] — 2026-06-11

Production spine: CI, publish-ready packaging. Builds on search core, quality wave ([docs/QUALITY.md](./docs/QUALITY.md)), and V0.2 spaces.

### Added

- **(removed) GitHub Actions CI — superseded by the manual release gate** — full suite against runner-native PostgreSQL + pgvector (no Docker, no Neon, no `.env` in CI); build → typecheck → test → pack dry-run assertions.
- **`eval-regression` workflow** — `workflow_dispatch` stub; configure `GEMINI_API_KEY` secret for live harness (aggregator `scripts/eval-search.js`).
- **Package READMEs** for `@samesake/core`, `@samesake/server`, `@samesake/cli` (since renamed to `@samesake/core` family in 1.0.0).
- **Typed embedding spaces** (V0.2) — segmented vectors, query-time weights, RRF leg.
- **`s.image` multimodal space** (V0.2i) — per-space image embedding with cross-modal query encoding.

### Changed

- Workspace packages version **0.3.0** (publish-ready; `npm publish` not performed).
- `repository`, `license`, `publishConfig`, and `files` whitelists verified via `scripts/pack-assert.ts`.

## [Unreleased] — search framework + dx

### Added

- **Search capability** on the samesake substrate — `collection()`, hybrid FTS+vector RRF search, filters, facets, NLQ, enrichment pipeline, connectors, eval harness.
- **[`docs/quickstart-search.md`](./docs/quickstart-search.md)** — 15-minute path from `bun install` to first hybrid search (no LLM required).
- **[`examples/hello-search/`](./examples/hello-search/)** — minimal runnable example: collection → push documents → index with stub embed → search with filters.
- **[`examples/fashion-search/`](./examples/fashion-search/)** — full fashion vertical with live parity eval ([`PARITY.md`](./examples/fashion-search/PARITY.md)).

### Changed

- **README** rewritten — positions the repo as a dev-first commerce search + match framework (package names `@samesake/core` / `@samesake/server` retained pending rename; renamed in 1.0.0).

## [Unreleased prior] — v1.2 — bulk-import extraction

### Architectural change

Bulk-import functionality has been **extracted from the matcher core** into a standalone example at [`examples/bulk-import/`](./examples/bulk-import/). The matcher is now pure stateless — no in-process workers, no queues, no module-load-time background polling. Serverless deploys (Vercel, Cloudflare Workers) just work.

### Removed (from core)

- `src/db/boss.ts` — pg-boss queue boot
- `src/core/import-controller.ts` — bulk-import orchestration
- `src/core/import-parser.ts` — xlsx + csv parser
- `src/core/import-worker.ts` — 8-wave matcher logic
- `POST /v1/projects/:p/imports`, `GET /v1/projects/:p/imports/:id`, `GET .../rows`, `POST .../rows/:rowId/resolve` — all bulk-import HTTP routes
- `samesake_imports` and `samesake_import_rows` tables from per-project DDL
- `pg-boss` and `xlsx` from `package.json` dependencies

### Added

- **`POST /v1/projects/:p/match-batch`** — new batch primitive. Accepts `[{queryText, phone?, ref?}, ...]`, runs the cheap waves (phone-exact, name-exact, alias-hit, unambiguous-phonetic) once over the whole batch in SQL, falls back to per-row `match()` for survivors. Returns `[{ref, hitMethod, candidates, combined}, ...]` plus per-wave counts. This is the primitive consumer bulk-import code calls into.
- **`examples/bulk-import/`** — standalone Bun service that composes the matcher's primitives into an opinionated import service:
  - own `package.json` with `pg-boss` + `xlsx` deps
  - own `bulk_import.*` Postgres schema (separate from matcher's per-project schemas)
  - own pg-boss queue (`bulk_import_pgboss.*` schema)
  - HTTP endpoints: `POST /imports` (xlsx upload), `GET /imports/:id` (status), `GET /imports/:id/rows?status=...` (list), `POST /imports/:id/rows/:rowId/resolve` (human resolution)
  - calls samesake's `/match-batch` + `/upsert` + `/confirm` over HTTP — no code coupling to matcher internals
  - `bun smoke.ts` runs the end-to-end test (9 assertions)

### Fixed

- `runMatchBatch`'s alias-hit wave was passing `JSON.stringify(scope)` as a jsonb parameter, which postgres-js then double-encoded into a jsonb-string. The alias wave never matched. Fixed to use the `asJsonb()` helper that lets postgres-js encode once correctly.

### Test impact

- `examples/hello/run.ts` — dropped the 2 bulk-import assertions (they referenced removed routes), added 1 new `/match-batch` assertion. **Net: 19 → 18 assertions; still 100% green.**
- `examples/bulk-import/smoke.ts` — new file with 9 assertions covering full upload → wave-match → human resolve → alias-feedback loop.

### Migration notes

Consumers of the old `/v1/projects/:p/imports*` endpoints need to deploy the new `examples/bulk-import/` service alongside the matcher. The example's API surface is identical in shape (intake / status / list / resolve) but on its own port (default 3040) and with its own database schema. Migration is a configuration change, not a code change — your operator UI just points at the new base URL.

## [1.1.0] — 2026-05-17

### Added

- **Provider abstraction** — Gemini, Voyage, OpenAI selectable via `providers.gemini.*` / `providers.voyage.*` / `providers.openai.*` in entity configs. Embedding cache keyed on `(provider, model, dim, sha1(text))`.
- **Decline penalty + pair-history continuous alias score** — `pair_history.(confirm_count, decline_count)`, sigmoid scoring, `exp(-0.5 · max(decline-confirm, 0))` multiplicative penalty.
- **F1 threshold calibration** — `POST /v1/projects/:p/calibrate` grid-searches threshold over `[0.50, 0.99]`, persists per-scope.
- **Decline endpoint** — `POST /v1/projects/:p/decline`.
- **Explain endpoint walkthrough** — `/explain` returns full per-channel breakdown; README has a worked example.
- Schema-as-source-of-truth refactor — `src/sdk/schemas.ts` Zod schemas, boundary validation, zero `as` casts outside `db/` infrastructure.
- multiNER cross-script benchmark harness — `examples/benchmark-multiner/` (Sinhala → English: 0.988 top-1; Tamil → English: 0.408).
- Same-language perturbation benchmark — `examples/benchmark-perturbations/` (typos / OCR / partial extractions; 99.4% rank-1 on single-char perturbations).
- Deployment guide — `docs/deployment.md` covering 6 paths (VPS / Fly / Railway / Render / Hybrid / Kubernetes) + serverless tradeoffs.
- Tutorial — `docs/tutorial.md` (15-minute zero-to-first-match walkthrough).
- Premise + AGENTS + CLAUDE — orientation files for human + AI collaborators.

### Fixed

- Tamil phonetic table (5 consonant classes mis-grouped) → cross-script `Amma`=`අම්මා`=`அம்மா` all hash to `N`.
- pg-boss type errors (deprecated `retentionDays`, wrong `monitorStateIntervalSeconds`, `stop({wait:true})` not an option, missing EventEmitter cast).
- `phone_eq` channel in `/explain` was checking "candidate has a phone" not "query phone matches candidate phone".

## [1.0.0] — 2026-05-16

Initial public release. People-side + product-side matching, Sinhala/Tamil cross-script via embeddings + Indic-Soundex, dedup, variant suggestions, alias feedback loop, scope-based isolation. 14-assertion smoke test against live Gemini.

See `RFC.md` for the original v1.0 contract.
