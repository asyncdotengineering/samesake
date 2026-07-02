# docs-rerank-judge-providers — implementation notes

## Decisions

- **Blend helpers not in public API:** `blendRerankScore`, `mergeBlendedRerank`, and `retrievalBlendWeight` live in `core/rerank.ts` but are not re-exported from `@samesake/server` — docs describe behaviour by name, only cite `DEFAULT_RERANK_BLEND_WEIGHTS` as an importable export.
- **Remote rerank adapters:** HTTP examples follow the `RerankFn` contract from `types.ts`; response field names match each provider's documented API shape (not verified live in this task).
- **Judge cache:** Cache is in `core/eval/cache.ts`, used by `runEval` — not inside `makeLlmJudge` itself. Documented as eval-path cache per source.

## Cross-links added

- `guides/eval-gate.mdx` → relevance-judge
- `guides/pipeline-lifecycle.mdx` → reranking + relevance-judge
- `guides/tuning-search.mdx` → reranking + relevance-judge
- `start/build-a-search-experience.mdx` → reranking + providers

## Unverified

- Live HTTP calls to Cohere/Voyage/Jina rerank endpoints were not exercised; adapter snippets are structural examples only.
