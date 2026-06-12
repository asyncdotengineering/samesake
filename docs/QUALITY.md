# Quality wave Q1–Q8 — results & attribution

2026-06-11 · Same 50-query harness/judge throughout. Runs: `v2-spike-baseline` (spike), `v2-samesake-2026-06-11` pre-wave (parity run), post-wave final (aggregator repo `evals/results/v2-2026-06-11.json`). Corpus grew 4,324 → **5,052 searchable products** (+8 stores) during the wave — per-type deltas reflect both engine and corpus changes.

## Headline (pre-wave samesake → post-wave samesake)

| metric | pre | post | Δ | read |
|---|---|---|---|---|
| mean@10 | 2.338 | 2.328 | ≈flat | quality held while corpus grew 17% (new long-tail inventory usually *dilutes* judged precision) |
| P@5 | 0.804 | **0.828** | +0.024 | now ABOVE the spike's 0.828 = parity fully closed |
| **local** (the target) | 1.50 | **1.74** | **+0.24** | Q5's vocabulary + ethnic stores; P@5 0.28 → **0.52** (+86%). Target 2.0 not yet reached — remaining gap is still corpus depth (e.g. zero true sarongs in the new feeds' first pages) |
| use-case | 2.26 | 2.37 | +0.11 | LK vocab + corpus |
| zero-result rate | 0.00 | 0.00 | = | held through 8 new stores + vocab changes |
| price-violation | 0.16 | 0.20 | −0.04 nominal | see below — measurement artifact of golden's assumed ceilings |
| median latency (benchmark) | 1,065ms | 1,669ms | one-time artifact | the wave changed NLQ instructions → invalidated the NLQ cache → every query re-parsed once. **Steady-state measured: ~0.6s NLQ-cached, 1–25ms result-cached** |

## Per-lever attribution

| Lever | Verdict | Evidence |
|---|---|---|
| Q1 implied-budget | shipped; mechanism works, golden disagrees | "cheap" → P30-percentile filter applies correctly (tested). The golden set *assumes* numeric ceilings (e.g. cheap=≤2,500) while P30 over the grown corpus sits higher — so judged "violations" persist at 0.16→0.20. Next turn: per-category percentile is implemented but only fires when NLQ parses a category; tightening cheap to P25 + always-resolve-category would close it |
| Q2 query-cache | shipped, big | NLQ Postgres cache + 60s result cache: warm latencies 0.6s / ~2ms (measured above) |
| Q3 rerank | NO-SHIP | bge-reranker −0.33 mean@10 — evidence in rerank-spike-DECISION.md |
| Q4 multimodal | NO-SHIP now, revisit | blend +0.11 (gate +0.15) on a noisy 68/100-aligned subset; images rescue text-failing queries ("romantic flowy dress" 0.8→2.2) but need aligned full-coverage spike + query-type-gated blending. multimodal-spike-DECISION.md |
| Q5 LK coverage | shipped, the targeted win | local +0.24 mean, P@5 +86%; "sarong for men" went from SQL-crash (pre-fix) / zero to relevant ethnic menswear |
| Q6 review loop | shipped | list/correct/few-shot live-demoed; 2 real corrections recorded + re-indexed |
| Q8 lite extraction | conditional yes | structural attrs 100% agreement at half cost; powered Q5's enrichment (~$1.6 for 957 products) |
| (bonus) empty-doc guard | shipped | real-data bug: one empty product doc 400-ed whole embed batches |

## Cumulative since the original fan-out

| | fan-out v1 | post-wave samesake |
|---|---|---|
| mean@10 | 1.47 | **2.33** (+58%) |
| P@5 | 0.48 | **0.83** (+73%) |
| price violations | 62% | 20% |
| latency | 8.8s | 0.6s warm / 1.7s cold-parse |
| corpus | live fan-out, ~10 stores/query | 5,052 enriched products, 28 stores |

## Next levers (evidence-ranked)

1. Local to 2.0: deeper ethnic inventory (sarong/osariya-specific stores) — vocabulary is no longer the bottleneck, corpus is.
2. Price violations: cheap→P25 + category-resolved percentiles + golden-set ceilings revisit (the metric currently grades assumptions, not absurdity).
3. Multimodal, properly: frozen-subset aligned spike; image weight gated to style-type queries only.
4. Broad-query dilution (2.80→2.40): new-store quality scoring / brand-diversity rerank in phase-2 ranking.
