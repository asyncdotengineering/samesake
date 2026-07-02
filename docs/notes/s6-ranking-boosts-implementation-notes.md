# S6 — multiplicative ranking boosts (C13)

## Decisions

- **Single ranking home:** `packages/server/src/core/ranking.ts` owns normalized min-max relevance, multiplicative hard axes, additive soft axes, min-relevance floor, and multiplicative `buryUnavailable` (`× buryFactor`, default 0.2).
- **Hard vs soft:** Default hard = `availability`; default soft = `newness`, `personalization`, `visual`, `business`. Fashion delegates via `resolveAxis` for visual/personalization only.
- **Hook placement:** Core `search()` applies `CollectionSearchDef.rankingPolicy` after rerank blend, before final slice — S5 order preserved.
- **Fashion facade:** `fashion-search.ts` `rankHits` is a thin wrapper over `applyRankingPolicy`; removed additive `score += available*weight` and raw `score -= 2`.

## Fashion test changes

None required — existing assertions remain valid under multiplicative availability (filters still exclude unavailable; personalization/visual soft boosts unchanged).

## Verification

- `bun test packages/server/test/ranking.test.ts` — REQ-20 unit cases
- `bun test packages/server/test/ranking-search.test.ts` — REQ-19 core hook integration
- `bun test packages/server/test/fashion-search.test.ts` — facade green
- Full suite: `222 pass / 0 fail` with `bun test --concurrency 1 packages/server/test` (parallel run hits known Neon 5001ms hook-timeout flakes in unrelated files per brief)

## Delegation grep

Old additive boost removed from `rankHits`; only `applyRankingPolicy` in `fashion-search.ts`.
