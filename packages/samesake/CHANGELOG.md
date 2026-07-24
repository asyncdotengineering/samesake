# samesake

## 6.0.1

### Patch Changes

- @samesake/cli@6.0.1

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
  - @samesake/cli@6.0.0

## 5.0.0

### Major Changes

- Lockstep version alignment: all samesake packages now share one version line (5.0.0). No functional changes in this bump beyond the alignment.

## 3.1.0

### Minor Changes

- 396c9a5: The bare `samesake` npm name is now a CLI alias for `@samesake/cli`, so `bunx samesake init`
  works. Versions ≤ 0.2.0 of this name (an early entity-resolution DSL) are superseded.

### Patch Changes

- Updated dependencies [396c9a5]
  - @samesake/cli@3.1.0
