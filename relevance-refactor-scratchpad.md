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
- server tsc 0 ✓ · sdk tsc 0 ✓ · docs build 28 ✓ · e2e demo ✓ (POSITIVE/NEGATIVE/NUMERIC/BYPASS).
- Full suite: 231 pass + error-rate-abort (pre-existing 5000ms Neon-latency flake on untouched enrich code) → gave it a 30s budget (commit 466abfe), passes 3/3 isolated. Final suite re-run for the clean 232/0 baseline.

## Commits
- c88a12f (a) floor + bypass · d0b7e9b (b) NLQ reference pattern · cebb633 (c1) nlq schema test
- 42fcdcd (c2) reranker recipe + docs + release 2.1.0 · 466abfe test-budget fix

## Decision (c)
Cosine+FTS floor = framework default (model-free, Cloudflare-safe, 96%). Cross-encoder (mxbai, 100%) = BYO recipe (onnxReranker + workersAiReranker), not bundled — native ONNX can't run on Workers. Documented with benchmark in reference/reranking. 2.1.0 staged, NOT published (not requested).
