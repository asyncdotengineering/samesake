# Changelog

All notable changes to samesake. Format roughly follows [Keep a Changelog](https://keepachangelog.com/).

## [2.1.0]

### Added

- **`search.relevanceFloor`** — an absolute query–document cosine floor (0–1) that drops semantic-only hits below the threshold; FTS keyword matches are exempt. Suppresses no-match padding (a query with no real match returns few/no results instead of the nearest neighbours). **Bypassed for structured-intent queries**: when NLQ derives hard filters (price/colour/category/etc.), those filters define relevance, so the semantic floor is skipped and filter-dominated queries (e.g. "anything under 2000") are never emptied. `fashionSearchPreset` defaults it to `0.5` (calibrated for `gemini-embedding-2`; override via the new `relevanceFloor` option). Calibrated on a labelled positive/negative probe (positives mean cosine ≈0.60, negatives ≈0.46). A cross-encoder reranker is a stronger relevance signal still (100% vs 92% no-match rejection on the same probe) — see `reference/reranking` for the BYO recipe — but the cosine floor is the model-free, runtime-universal default (a native ONNX reranker cannot run on Cloudflare Workers).

### Changed

- **NLQ extraction reshaped to a structured-output pattern** — `fashionNlqSchema` constraint fields are now `.nullable()` (forcing the model to emit each one, value or null) with operational descriptions, and `FASHION_NLQ_INSTRUCTIONS` carries few-shot `<examples>`. Fixes inconsistent `semantic_query` cleaning so price/colour words no longer leak into the embedded query (and therefore the relevance floor's signal).

### Removed

- **`@samesake/jobs-pgboss`** (breaking) — the optional pg-boss `JobRunner` adapter is removed. It held job closures in an in-memory map and only enqueued an id, so a separate worker process (or any restart) silently dropped jobs — it never worked cross-process, defeating the point of a queue. `JobRunner` is a one-method BYO interface (like `embed`/`generate`): implement it against your own queue/worker. Cross-process durability needs a handler-registry redesign of the contract (resolve named handlers from the payload instead of a closure) — tracked in [#44](https://github.com/asyncdotengineering/samesake/issues/44). `inProcessRunner` remains the default.

### Fixed

- `searchExplain` no longer errors (`could not determine data type of parameter`) when `relevanceFloor` is set — the floor parameter is bound only on the query path that uses it.

## [2.0.2]

### Fixed

- **Quarantine gate leak when the collection has spaces** — the indexer's space-backfill clause (`OR space_vec IS NULL`) sat outside the `pipeline_status = 'ready'` guard, so a freshly-enriched **quarantined** row (NULL `space_vec`) was indexed and promoted to `ready`, defeating the gate. Any collection with both an enrich gate and spaces (e.g. every fashion store) leaked non-apparel / low-confidence / cross-signal-disagree items into search. The backfill is now guarded by `pipeline_status`.

## [2.0.1]

### Added

- **`matcher.removeDocuments(project, collection, ids)`** — delete rows by id from a collection (returns `{ removed }`). Powers the delete path in the Medusa/Shopify/WooCommerce/Porulle integration guides; previously there was no per-collection delete in `@samesake/server`.

## [2.0.0] — indexing DSL (breaking)

### Breaking changes

- **Removed `CollectionEmbeddingDef.source`** — doc embeddings no longer accept a `$`-template string; declare text in `indexing.surfaces` instead.
- **Removed `fashion.composeEmbedDoc` / `fashion.embedDocSource` / `FASHION_EMBED_DOC_SOURCE`** — use `fashion.indexing()` surface builders.
- **Removed doc-path `resolveEmbedTemplate`** — no `$`-template expansion, no `data.title` fallback, no apparel hardcode.
- **`collection().indexing` is now required** — a config without it is a compile error.
- **Generated `fts` column derives only from persisted `fts_src`** — legacy fallback expressions are removed.

Migrate by: replace `embeddings.*.source` with an `indexing.surfaces` builder; see [/guides/pipeline-lifecycle](/guides/pipeline-lifecycle).

### Added

- **Pipeline lifecycle columns** — `pipeline_status`, `attempt_count`, `last_error`, `next_attempt_at`, `gate_reason`, `image_etag`, `image_checked_at` on collection rows; backfilled existing indexed rows to `ready` on apply.
- **`recordFailure` / `retryFailed`** — durable failure tracking with exponential backoff; rows exceeding `maxAttempts` (default 5) move to `dead`; enrich runs abort when per-run error rate exceeds threshold (G6).
- **Image content invalidation** — `content_hash` incorporates image validator tokens; `matcher.revalidateImages()` probes ETags, resets `indexed_at` (and `enriched_at` when vision stages consume images) on change; stage cache keys include image validator (G1).
- **`revalidateImages` matcher method** — idempotent HEAD/ETag probe per `image_url`; pHash fallback when CDN strips validators.
- **Blend-not-replace reranker** — position-aware fusion of first-stage RRF with reranker scores; `fashionRerank(generate)` default LLM judge reranker exported from `@samesake/server` (G4/G5).
- **Multiplicative `rankingPolicy`** — core `search()` applies normalized relevance fusion (`relevance^α × availability × business × personalization`) with `minRelevanceFloor` and multiplicative `buryUnavailable`; hook on `CollectionSearchDef.rankingPolicy` (G7).
- **Offline eval harness** — `matcher.runEval()` with graded facet-decomposed LLM judge, Hit@K/nDCG@K/MRR/null-rate/constraint-violation metrics, judge cache, JSON artifacts, and `thresholds → pass` CI gate; runnable via `examples/fashion-search/eval-judge.ts` (G8).
- **Docs** — `apps/docs` guides: pipeline lifecycle, eval gate (floor/exponent tuning procedure); updated tuning, eval, integration, and build guides for the `indexing` DSL.

### Changed

- Added apply-time indexing manifest validation: dense surfaces must reference existing embeddings and FTS search requires an FTS indexing surface.
- **Enrich persists indexing surfaces** — `doc`, `rerank_doc`, `fts_src` written at enrich; indexer consumes persisted text; `indexing.gate` sets `quarantined` or `ready` (G2/G3/G5).
- **`search()` excludes non-`ready` rows** when the collection has an enrich pipeline — quarantined/failed/dead rows never surface in FTS, cosine, or spaces legs.
- **Default rerank** uses blend fusion when `rerank` is wired; `rerank: false` restores pure RRF.

### Fixed

- Image-fetch/embed failures mark rows `failed` instead of silently indexing zero vectors.
- Quarantine clears stale vectors (`doc`, `embedding`, `space_vec`) so previously indexed rows cannot leak into search after a gate flip.

### Pending empirical calibration

- `FASHION_CONFIDENCE_FLOOR = 0.5` and default `relevanceExponent = 1` remain **placeholders** until tuned via `eval-judge.ts` + `runEval` sweep with `GEMINI_API_KEY`. Procedure documented in `apps/docs/src/content/docs/guides/eval-gate.mdx`.

## [1.3.0] — 2026-06-18 — modes, retrieval primitives & fashion template

Bakes six retrieval primitives into the core packages so samesake works well off-the-shelf
with the right defaults and no required config. Backed by 2025–26 fashion/e-commerce IR work
(SIGIR/WWW/RecSys, incl. Walmart Global Tech).

### Added

- **Fashion enrichment template** (`@samesake/core`) — `fashion.*` / `fashionEnrichPipeline`,
  `fashionSearchFields`, `fashionSpaces`, `composeFashionEmbedDoc`, `fashionClassifySchema` /
  `fashionExtractSchema`, `fashionNlqSchema` / instructions, `fashionTaxonomy` / `fashionEnums`.
  Schemas are declared with **zod** (field-level `.describe()` carries the instruction — Mastra
  pattern); the framework converts them to JSON Schema via `normalizeSchema`. The fashion
  example's `generate` sends them via Gemini `responseJsonSchema`.
  Best-default catalog enrichment (category, colors, occasion, style, material, fit + a
  search-ready embed doc + fashion-aware NLQ) so consumers get attribute-aware search without
  rewriting ~200 lines. Region-neutral and parametrized (data keys, models). The fashion example
  now consumes it; live smoke confirms e.g. a "Crimson" title normalizes to `colors:["red"]`.
- **FTS soft-OR** — the lexical leg now uses `websearch_to_tsquery` rewritten to OR-of-terms, so
  multi-term queries match docs sharing *any* term (ranked by `ts_rank_cd`) instead of going inert
  on the AND of all terms. **Default: on, no config.**
- **Composed query (image + text modifier)** — `mode:"similar"` with both `image` and `q` keeps the
  visual leg (anchor) and the text-cosine leg (modifier) active and fused via RRF — "like this, but
  black / longer / cheaper". The plain `/search` HTTP route now accepts `image` too.
- **Adaptive cross-encoder rerank seam** — new BYO `rerank` on `createMatcher`; when present, search
  reranks the top-N first-stage pool (`RERANK_POOL=50`) and slices to `limit`; pure RRF otherwise.
  Per-query `rerank:false` to force first-stage. `RerankFn` exported.
- **Visual grounding seam** — new BYO `groundImage` on `createMatcher`, applied to images before
  embedding on both the index and query paths (pass-through when absent). `GroundImageFn` exported.
- **Self-calibration + LLM-judge eval** — `matcher.evaluateSearch` (graded relevance@k + nDCG@k via
  caller labels or the configured `generate` LLM as judge) and `matcher.calibrateSearch` (sweeps a
  small mode/weight grid, returns the recommended config). Lets defaults tune themselves.
- **Variant/result diversification** — `collection({ search: { variantGroup: "<field>" } })` collapses
  near-duplicate variants to the best-scoring item per group; per-query `diversify:false` to disable.
  Off unless `variantGroup` is declared.

### Search modes (intent vs similar) — part of 1.3.0

Makes search robust to intent-based filtering and not biased toward keywords, and makes
"similar" mean genuine visual + semantic similarity rather than keyword matching.

### Added

- **`mode: "intent" | "similar"`** on `search` / `searchExplain` (in-process + HTTP `POST .../search`,
  `.../search/explain`). Resolved automatically when omitted: `"similar"` if a query image is
  present, else `"intent"`. Exported `SearchMode` from `@samesake/core`.
- **Mode-aware weighting** in `parseSearchWeights`: `intent` caps the keyword (FTS) leg to a
  tiebreaker (`0.3 × cosine`) and turns the spaces/visual leg off for text queries;
  `similar` turns keyword off so semantic + visual decide. Image-kind spaces are zeroed for
  text queries (cross-modal text re-embedding is noise). Explicit `weights` still override.
- Pure-image similarity (`mode: "similar"` + image + no text) now drops the cosine text leg so
  the visual space carries ranking, without needing the agent/fashion wrapper.
- `find_similar_products` runs in `similar` mode.
- Evidence harnesses: `examples/fashion-search/repro-similar.ts` (keyword-decoy pollution +
  fix), `repro-visual.ts` (genuine visual similarity defeats text contamination),
  `eval-configs-lk.ts` (intent guardrail: `mode=intent` == old default, no regression).

### Changed

- **Default text search is now `mode: "intent"`** — keyword is a tiebreaker, not co-equal with
  semantics. On the LK intent eval this is identical to the old flat default (relevance@3 0.67)
  while removing keyword dominance.
- `examples/fashion-search` enables spaces + the `visual` image space **by default** (opt out
  with `SPACES=0` / `SPACES_VISUAL=0`). Safe now because intent mode does not weight them.
- Dropped the redundant `style` text-space from the fashion example: it duplicated
  `Channels.cosine({embedding:"doc"})` and pushed the segmented vector past pgvector's 2000-d
  HNSW limit. The cosine channel carries text semantics; spaces carry visual/price/category/freshness.

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
