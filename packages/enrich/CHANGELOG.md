# @samesake/enrich

## 6.0.1

### Patch Changes

- Fix the `samesake()` Postgres enrich → search → resolve → facets path end to end.

  The Tier-2 `samesake()` bundle path shipped in 6.0.0 was not exercised end to end
  (the integration suite covers the `createMatcher` path), so four bugs slipped through:

  - `PostgresEnrichStore` double-encoded jsonb `data`/`enriched` (JSON.stringify before
    postgres.js also serialised), so `data->>'field'` read null.
  - filterable field columns were never projected, so every filter/facet/NLQ-budget
    matched nothing. Field projection now lives in `@samesake/core`
    (`resolveFieldValue`/`projectFields`), the enricher writes `EnrichedRow.fields`, and
    `PostgresEnrichStore` persists them.
  - `resolve()` UNIONed dedup probes with per-member `ORDER BY … LIMIT` unparenthesized.
  - `resolve()`'s `*_dedup_suggestions` feedback table was not created by the migration.
  - `facets()` `filters` is now optional (facet the whole collection).

- Updated dependencies
  - @samesake/core@6.0.1

## 6.0.0

### Major Changes

- Canonical redesign: backend-neutral, model-neutral commerce enrichment + search.

  Three composable primitives (enrich / resolve / search) over four pluggable ports
  (EnrichStore, Retriever, CandidateProvider, VocabProvider), Functional Core /
  Imperative Shell. Postgres is now one peer backend (proven byte-identical, 316 tests);
  a Cloudflare D1 + LanceDB reference runs the identical engine with no Postgres. Adds a
  trainable Fellegi-Sunter resolve core (matchWeight + connected-components clustering).
  `@samesake/providers` now builds on `@samesake/embed`.

  BREAKING CHANGE: the entire public API is reshaped with no compatibility shims (alpha,
  deliberate break). Consumers migrate to the new `samesake()` / `createEnricher` /
  `createSearch` surfaces.

### Patch Changes

- Updated dependencies
  - @samesake/core@6.0.0
  - @samesake/embed@6.0.0
