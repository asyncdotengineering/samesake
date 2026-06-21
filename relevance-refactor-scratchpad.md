# Relevance Floor + NLQ Refactor — Scratchpad

Mode: autonomous-stand + zero-tech-debt (reshape, not patch). Actual packages (sdk + server).

## Backlog
(empty)

## Doing
(empty)

## Done
- **(a)** Floor structured-intent bypass — `search.ts`: floor is now a caller-gated param; `runRanked` skips it when `r.nlq.filters` non-empty. searchExplain param-binding regression fixed. Tests: relevance-floor (4) + relevance-floor-bypass (2) green. Commit `c88a12f`.
- **(b)** NLQ reference pattern — `fashion.ts`: `.nullable()` + operational descriptions + few-shot `<examples>`. Verified on demo: `semantic_query` clean across price/colour/occasion queries, all filters extracted. Commit `d0b7e9b`.
- **(c)** Decision: cosine+FTS floor = framework default; cross-encoder = BYO recipe (`examples/fashion-search/rerank.ts`: `onnxReranker` + `workersAiReranker`), documented in `reference/reranking` with benchmark + Cloudflare constraint. CHANGELOG [2.1.0] expanded. Seed re-dumped. Pending commit.
- E2E on seeded demo (server dist rebuilt): POSITIVE→credible, NEGATIVE→∅ (laptop/ring), NUMERIC→price-filtered, BYPASS "anything under 2000"→5 hits (was 0). Docs build 28 pages. server tsc 0.

## Verify gate
- server tsc 0 ✓ · docs build 28 ✓ · e2e demo ✓ · full server suite: (running).
