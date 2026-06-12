# V02g spaces gate: OFF BY DEFAULT

2026-06-11 · Fashion corpus (5,045 space_vec docs: style 1536d text + price 8d + freshness 8d + category 32d), spaces leg at RRF weight 1, default space weights. 50-query harness, same judge/cache. Raw: aggregator `evals/results/v2-spaces-gate.json`.

| metric | baseline (no spaces) | spaces leg ON | gate |
|---|---|---|---|
| mean@10 | 2.328 | 2.242 | ≥ 2.30 ✗ |
| P@5 | 0.828 | 0.784 | ≥ 0.82 ✗ |
| style | 2.075 | 1.925 | improve ✗ |
| local | 1.740 | 1.620 | improve ✗ |

**Verdict: spaces capability SHIPS (V02 merged, tested, 79 green) but stays OFF by default.** A flat-weighted segmented vector added as a third RRF leg dilutes the validated FTS+cosine ordering — structural segments (price/freshness/category) inject similarity signal even for queries that don't reference them, and the style segment duplicates the cosine leg.

What would change the verdict (future, eval-gated):
1. **Query-aware space weights** — NLQ already parses category/price intent; zero out structural segments unless the query references them (the Superlinked pattern is described params → weights, not flat weights).
2. Replace the legacy cosine leg with the spaces leg (not both — they double-count the same text vector).
3. Calibrated default weights (style 1, others ≤0.2) via small sweep.
Each is a ≤1-eval-run experiment on the existing infra; none block V1.

Engineering found by this gate (real bugs/gaps, fixed or filed):
- `apply` does not ALTER existing tables for new columns (manual space_vec ALTER needed) → exactly V03b's schema-evolution scope, now with a concrete repro.
- In-process config vs DB-stored config divergence is silent (apply with/without SPACES flag) → V03b: apply must report a config diff.
- 730 Q5 docs had title-only embeddings (compose step skipped in the Q5 pipeline) — repaired during this gate (~$0.04); the corpus is now uniformly composed, which RAISED the no-spaces baseline quality as a side effect.
- Non-apparel rows permanently re-scanned as "pending" — V03b should mark them terminal.
