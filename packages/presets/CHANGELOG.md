# @samesake/presets

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
