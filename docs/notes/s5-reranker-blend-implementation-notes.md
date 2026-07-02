# S5 reranker blend — implementation notes

## Commits
- `8ffa36c` C11: blend-not-replace in `rerankHits`, `rerank_doc` preference, `[0,1]` clamp, `core/rerank.ts`
- `4f30e3f` C12: `fashionRerank(generate)` in `core/rerank.ts`, exported from `@samesake/server`

## Placement (C12)
RFC cited `templates/fashion.ts`; sdk cannot import server. `fashionRerank()` lives in `packages/server/src/core/rerank.ts` beside blend helpers and wraps `makeLlmJudge` — one judge rubric (`FASHION_JUDGE_SYSTEM` in `eval/judge.ts`), grades mapped to `grade/2`.

## Blend weights (REQ-13b)
`DEFAULT_RERANK_BLEND_WEIGHTS`: head `0.75` (rank ≤3), mid `0.60` (≤10), tail `0.40` beyond. Cutoffs `headCutoff=3`, `midCutoff=10`. Exported as `RerankBlendWeights` for G8 tuning.

## Merge semantics
Scored hits compete for non-unscored slots sorted by blended score; unscored hits stay at original RRF indices (fixes old `[...reranked, ...rest]` demotion).

## `rerank_doc` resolution
Column `rerank_doc` on search rows (SQL SELECT added), then `data.enriched.rerank_doc`, then title scrape.

## Unverified
- S2 harness nDCG non-regression: `GEMINI_API_KEY` not exercised; blend unit tests are primary evidence.
- Full `bun test packages/server/test`: verified 216/0 on multiple runs; intermittent Neon hook-timeout flakes in unchanged files (`error-rate-abort`, `eval-run`) under parallel load.
