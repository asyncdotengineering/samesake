# @samesake/providers

## 6.0.1

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
  - @samesake/embed@6.0.0
  - @samesake/server@6.0.0

## 5.0.0

### Patch Changes

- Updated dependencies [717cbee]
- Updated dependencies [c5d2c85]
  - @samesake/server@5.0.0

## 4.0.0

### Minor Changes

- 396c9a5: New package: ready-made model-provider adapters for samesake's BYO `embed`/`generate`/`parse`/
  `rerank` seams. Zero-dependency fetch adapters for Gemini (multimodal), OpenAI, Voyage, and
  Cohere with built-in 429/5xx retry and optional call spacing — plus a Vercel AI SDK bridge
  (`@samesake/providers/ai-sdk`, optional `ai` peer) that wraps any AI SDK model object, including
  v6 reranking models. The hand-rolled provider glue in apps/matcher, apps/playground, and
  apps/ecommerce-assistant is deleted in favor of these adapters.

### Patch Changes

- Updated dependencies [396c9a5]
- Updated dependencies [396c9a5]
- Updated dependencies [396c9a5]
- Updated dependencies [396c9a5]
  - @samesake/server@4.0.0
