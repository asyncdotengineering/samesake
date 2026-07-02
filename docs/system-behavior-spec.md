# Samesake — System Behavior Specification

Status: Ready for review · Written 2026-07-02, verified against `@samesake/*` 2.6.0 source.

This document specifies what the system **actually does today**, grounded in code. It is the
baseline for the "enrichment + fast search toolkit anyone can replace their ecommerce search with"
direction. Every claim cites a file path. Where behavior is intentional-but-uncalibrated, it says so.

---

## 1. What Samesake is

A TypeScript-first **search engine compiler** for commerce catalogs. The developer declares a
catalog and its retrieval spaces in TypeScript (`collection()` from `@samesake/core`); the runtime
(`createMatcher()` from `@samesake/server`) compiles that declaration into a Postgres + pgvector
search layer running inside the consumer's own app. BYO models: the consumer supplies `embed`
(required) and optionally `parse` / `generate` / `rerank` / `groundImage` closures — the framework
never holds an LLM API key.

Two products live in one factory:

| Product | DSL entry | Runtime surface |
|---|---|---|
| **Collection search** (the momentum product) | `collection()` | `matcher.search / facets / enrich / index / ingest / evaluateSearch / …` |
| **Entity resolution / dedup** ("match") | `entity()` | `matcher.match / confirm / decline / calibrate / duplicates / …` |

They share embeddings, the Postgres cache tables, and per-project runtime DDL. This duality is the
single biggest structural fact of the codebase (see §10).

**Packages** (all 2.6.0): `@samesake/core` (`packages/sdk/` — DSL, zero runtime deps except zod),
`@samesake/server` (`packages/server/` — runtime + Hono app), `@samesake/cli` (HTTP client + direct
`migrate`), `@samesake/mcp` (stdio MCP server, pure HTTP client of `/v1`). Reference HTTP runner:
`apps/matcher/` (~115 LOC total — the cleanest consumer template).

**Stack**: Bun + Hono + Postgres 15+ with `vector`, `pg_trgm`, `unaccent`, `fuzzystrmatch`.
Two containers in production: Postgres and the app process. No Redis, no Elasticsearch.

---

## 2. Data model — one physical table per collection

`core/collections-schema-gen.ts` emits, per project + collection:

```
id, data jsonb, enriched jsonb, content_hash,
<declared field columns>,                     -- copied from data/enriched at index time
doc, rerank_doc, fts_src,                     -- the three indexing surfaces (text)
gate_reason,
fts tsvector GENERATED from fts_src,          -- GIN indexed; hardcoded 'english' config
embedding vector(dim),                        -- HNSW cosine (doc embedding)
space_vec vector(total),                      -- HNSW cosine (concatenated typed spaces)
ingested_at, enriched_at, indexed_at, updated_at,
pipeline_status ('pending'|'ready'|'quarantined'|'failed'), attempt_count,
last_error, next_attempt_at, image_etag, image_checked_at
```

Three **indexing surfaces** are first-class and separate: `doc` (what gets embedded),
`rerank_doc` (what the reranker reads), `fts_src` (what the lexical leg matches). Built by
`def.indexing.surfaces[*].build(ctx)` during enrich (`core/enrich-pipeline.ts →
persistIndexingSurfaces`).

## 3. Indexing pipeline behavior

Four separately-invocable stages (`createMatcher.ts` wires a `make*Service` per stage). All run
**inline** — durability is the caller's problem (wrap in Inngest/Upstash/CF/Vercel; six guides in
`apps/docs`).

1. **Ingest** (`core/ingest.ts`) — direct `upsertDocuments` or pull from declared connectors
   (Shopify feed, WooCommerce feed, JSONL — `packages/server/src/connectors/`). Computes
   `content_hash` (`connectors/normalize.ts`); a hash change **nulls** `enriched_at`/`indexed_at`,
   re-triggering downstream stages. Invalidates the in-process search cache.
2. **Enrich** (`core/enrich-pipeline.ts`) — selects `enriched_at IS NULL` rows, runs each declared
   `enrich.stages[]` through the consumer's `generate` with a zod schema (converted to JSON Schema
   by `core/schema-input.ts`). Per-stage cache keyed on SHA1(prompt + image validators + schema)
   (`db/stage-cache.ts`). Images fetched via SSRF-safe `core/fetch-image.ts`. Then builds the three
   indexing surfaces and runs `def.indexing.gate(ctx)` → `ready` or `quarantined` + `gate_reason`.
   Concurrency pool default 8; error-rate circuit breaker (`core/pipeline-failure.ts`); human
   corrections feed back as few-shot examples (`core/review.ts → correctionExamples`, run-global).
3. **Embed/index** (`core/embed-index.ts`) — batches of 24; embeds `doc` with document task type,
   L2-renormalizes; assembles `space_vec` from declared spaces (`core/spaces.ts`); copies declared
   field columns (supports `enriched.*` paths); optional `groundImage` crops the product region
   before image embedding. Guarded by `pipeline_status='ready' AND indexed_at < enriched_at`.
4. **Retry/revalidate** — `core/retry.ts` (failed rows past exponential backoff),
   `core/revalidate-images.ts` (ETag-based image invalidation), dead-lettering via `markDead`.

**Deletion**: only fashion sync has a delete branch (`core/fashion-search.ts:339`). There is **no
generic `removeDocuments`** on the Matcher, though integration docs reference one (gap-audit F3).

## 4. Enrichment behavior (LLM)

The **mechanism** is generic (`enrich-pipeline.ts`); the **content** ships as the fashion template
(`packages/sdk/src/templates/fashion.ts`):

- Stage `classify` → `category` (taxonomy id), `product_type`, `gender`, `is_apparel_product`.
- Stage `extract` (conditional: apparel only) → `colors` (base-colour collapsed: "navy blue" →
  `["navy"]`), `raw_color`, `pattern`, `material`, `fit`, `occasions`, `styles`, `modesty`,
  per-category fine attributes, `search_document` (the LLM-written retrieval narrative),
  `confidence`, `uncertain_fields`.
- **Gate** (`fashionIndexing().gate`): quarantines non-apparel, `category === "other"`,
  non-positive price, `confidence < FASHION_CONFIDENCE_FLOOR` (0.5,
  `templates/fashion.ts:239`, flagged PLACEHOLDER — tune via eval), uncertain load-bearing fields
  (category/gender/colors), or cross-signal disagreement between title/tags/type and the enriched
  category (`crossSignalAgrees`).

Enrichment quality is measured, not assumed: `matcher.evaluateEnrichment(...)`
(`core/evaluate-enrich.ts`) scores per-attribute precision/recall/F1 against a human gold set
(`evals/golden-enrichment-fashion-lk.json`).

Enrichment does **not** derive price or query intent — price is a raw field; intent is derived at
query time by NLQ.

## 5. Search behavior

Flow in `core/search.ts` (`makeSearchService`, ~1,040 lines):

1. **NLQ** (`core/nlq.ts`) — skipped for ≤2-token digit-free queries. The consumer's `generate`
   slot-fills a schema derived from filterable fields (or the fashion NLQ schema) producing:
   `semantic_query` (constraint-stripped), **hard filters**, `excludeTerms`, and `budgetHints`
   ("cheap"/"premium" → price-percentile filter, 10-min cache). Cached 7 days in the stage cache.
   On LLM failure: degraded fallback, `semantic_query = q`.
2. **Query embedding** — query task type; optional query-image vectors with grounding.
3. **Hybrid retrieval, single SQL statement** — up to four CTE legs, each `row_number()`-ranked,
   fused with FULL OUTER JOIN + **RRF (k=60)**, candidate pool 150:
   `lex` (Postgres FTS, AND-coverage-first then OR-fallback for recall), `sem` (pgvector cosine on
   `embedding`), `spc` (cosine on `space_vec`), `rec` (recency decay).
   Semantic-only hits must clear `def.search.relevanceFloor` (FTS matches exempt; bypassed when NLQ
   produced hard filters). Only `pipeline_status='ready' OR NULL` rows are visible.
4. **Filters/facets** — Mongo-style operators compiled to SQL (`core/search-filter.ts`); `soft`
   fields relax automatically when <3 rows return. Facets = enum counts, array unnest, numeric
   ranges (`db/postgres/facets.ts`). Constraint provenance tracked per filter
   (`core/constraint-trace.ts`: nlq / explicit / budget_hint / agent).
5. **Mode-aware weighting** (`core/search-query.ts`) — `mode:"intent"` (default for text): keyword
   capped as a tiebreaker (0.3 × cosine weight), spaces leg off. `mode:"similar"` (default when an
   image is present): FTS off, semantic + visual lead. Explicit `weights` always override.
6. **Rerank** (`core/rerank.ts`) — optional second stage over top 50 when `rerank` is wired.
   **Blended, never replaced**: `mergeBlendedRerank` mixes retrieval position with reranker score
   by rank band (head/mid/tail = 0.75/0.6/0.4, `DEFAULT_RERANK_BLEND_WEIGHTS`); unscored hits keep
   their RRF slot; failures fall back to pure RRF.
7. **Diversify + ranking policy** — variant collapse via `search.variantGroup` (`diversifyHits`);
   `core/ranking.ts` applies multiplicative hard axes (availability/business) and additive soft
   axes on normalized relevance (`relevanceExponent` default 1, flagged PLACEHOLDER).
8. **Explain** — `searchExplain` returns per-leg ranks, `rrf_score`, per-space cosines.

Facades on top: `fashionSearch` (`core/fashion-search.ts` — image-weight boost, personalization
scoring, no-result filter-relaxation ladder) and agent tools (`core/agent-tools.ts` —
`findProducts`/`findSimilarProducts` with per-candidate constraint verification and grounding
metadata; OpenAPI + MCP descriptors).

**Known ceiling**: the lexical leg is `ts_rank_cd` with a **hardcoded `'english'`** FTS config
(`collections-schema-gen.ts:88`, `search.ts:313`) — document-local ranking (no IDF/BM25), and no
multilingual product search even though cross-script primitives (`samesake_normalise`,
`samesake_phonetic`) exist in `db/system-ddl.ts` and are used by the entity-resolution path.

## 6. Evaluation behavior

- **Search relevance** — `matcher.runEval` / `evaluateSearch` (`core/eval/run.ts`): golden queries
  (`{id, type, query, constraints?, grades?}`) + LLM judge grading 0–3; computes hit@k, nDCG@k,
  MRR, nullRate, constraintViolationRate per query type; pass/fail thresholds; writes JSON+MD
  artifacts (`evals/runs/`). Judge grades cached per (judge-version, query, doc) so pre/post diffs
  reflect retrieval changes, not judge noise.
- **Calibration** — `matcher.calibrateSearch` sweeps a mode/weight grid and recommends defaults.
- **Enrichment accuracy** — §4.
- **Constraint checking is fashion-hardcoded** (`run.ts:62–78`: price/color/gender/category only).
- Golden sets are Sri-Lanka fashion; CLI `eval` is retrieval-only with no judge.

## 7. Consumption surfaces

One matcher, three call styles: in-process (`matcher.search(...)`), web-standard
(`matcher.fetch(request)`), composable (`matcher.app` Hono at `/v1`). Plus CLI (24 commands) and
MCP (6 read-only tools). HTTP surface: health/ops, collection pipeline
(ingest/documents/enrich/index/review), search (+explain/evaluate/calibrate/facets), fashion
(fashion-search/fashion-sync), agent (find-products/find-similar), and 9 entity-resolution routes.
Auth: Bearer master key or per-project key.

## 8. Multi-tenancy / multi-vendor — current truth

- Isolation unit is the free-text **project** name (`matcher.search("shop", …)`) — a flat
  namespace, one schema per project. No quotas, no per-project keys' scoping beyond auth.
- `CollectionDef` has **no `scopes`** (`packages/sdk/src/types.ts:432`); only `EntityDef` supports
  `scopes` (used for record-linkage isolation).
- "Vendor" is a **facet column** (fashion template maps `brand` from `vendor` path,
  `templates/fashion.ts:394`). No per-vendor index, relevance policy, boost, quota, or eval.
- The marketplace story that exists is real but narrow: enrichment **normalizes heterogeneous
  seller listings into one schema**, then vendor is a filter/facet
  (`apps/docs/.../guides/marketplace-search.mdx`).

## 9. Operational behavior

- Runtime DDL per project; migrations via `prepareMigrations` with a destructive-op guard.
- Pipeline failure handling: per-row attempt counts, exponential backoff, dead-letter, error-rate
  circuit breaker. Quarantine (`gate_reason`) is queryable via review endpoints.
- In-process TTL search cache, opt-in, invalidated on ingest/index/sync. No cross-process cache.
- Observability: `/v1/metrics`, structured logger seam, `searchExplain`.
- Env contract has drifted: root `.env.example` uses `SAMESAKE_DATABASE_URL` /
  `GOOGLE_GENERATIVE_AI_API_KEY`; docs quickstart uses `DATABASE_URL` / `API_KEY`;
  `apps/matcher/src/index.ts:2–10` ships a shim mapping between the two conventions.

## 10. Structural facts an owner must know

1. **Entity resolution is a second product bolted onto the factory**: `core/schema-gen.ts`
   (664 lines) + `match.ts` (709) + calibrate/variants/upsert/parse/phonetic + 9 routes + 8 CLI
   commands, versus the collection-search stack. Momentum (changelog, examples, docs) is entirely
   on collection search; `apps/bom-quotation` is the only match consumer.
2. **StorageAdapter is a declared half-migration** (`db/storage-adapter.ts`, issue #59): ~10
   methods relocated; 8 core modules still execute raw SQL through the `client()` escape hatch
   (search 5×, embed-index 6×, fashion-search 4×, enrich 3×, review 3×, revalidate-images 3×,
   evaluate-enrich 1×, projects 1×). Postgres is the only implemented backend; names are hardwired.
3. **Two parallel fashion authoring APIs**: the live `fashion.*` template
   (`sdk/src/templates/fashion.ts`) vs the legacy `fashionAttributes` / `fashionAttributeSchema` /
   `fashionEnrichmentPreset` / `fashionSearchPreset` layer in `sdk/src/index.ts` (~L340–470) with a
   divergent enum vocabulary and **zero code callers** (one stale doc reference).
4. **Test-only public API**: `matcher.indexDocuments` (`search.ts:474`) bypasses the real pipeline
   (manual insert with precomputed embeddings); callers are exclusively `packages/server/test/*`,
   yet it ships on the public Matcher surface.
5. **Fashion leaks through the generic core**: root SDK/server export fashion symbols
   (`sdk/src/index.ts`, `createMatcher.ts` exposes `fashionSearch`, `app-builder.ts:492` exposes
   `/fashion-search`); eval constraint fields are fashion-hardcoded.
6. **Duplicated helpers across facades**: ranking-policy merge implemented twice (`ranking.ts` and
   `fashion-search.ts`), plus re-implemented `hitValue`/`asArray`/`intersects` in three modules.
7. **Un-calibrated placeholder constants**: `relevanceExponent` (1), `FASHION_CONFIDENCE_FLOOR`
   (0.5) — both flagged in-code for eval-driven tuning.
8. **Deprecated alias still exported**: `DEFAULT_PRODUCT_PARSE_INSTRUCTIONS` (`core/parse.ts:~76`,
   "will be removed in 0.7.x" — we're at 2.6.0).
