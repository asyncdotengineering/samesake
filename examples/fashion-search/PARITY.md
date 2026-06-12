# Parity benchmark — samesake framework vs the spike's /search/v2

2026-06-11 · Same 50 golden queries, same ESCI LLM judge (gemini-3-flash-preview, cached), same corpus (4,555 LK products / 20 stores). Spike harness run unchanged from the aggregator repo: `node scripts/eval-search.js --target v2 --base http://localhost:8788`.

Result files (aggregator repo `evals/results/`): `v2-spike-baseline.json` (spike), `v2-samesake-2026-06-11.json` (this framework), `fanout-2026-06-10.json` (original fan-out v1).

## Acceptance gate: **MET**

| Metric | Gate | samesake | spike v2 | fan-out v1 |
|---|---|---|---|---|
| mean grade@10 | ≥ 2.30 | **2.338** | 2.422 | 1.470 |
| nDCG@10 | — | 0.935 | 0.941 | 0.820 |
| P@5 (≥2) | ≥ 0.78 | **0.804** | 0.828 | 0.480 |
| price-violation rate | ≤ 0.20 | **0.16** | 0.16 | 0.62 |
| zero-result rate | — | 0.00 | 0.00 | 0.00 |
| median latency | — | **1,065 ms** | 1,339 ms | 8,784 ms |

Per type (mean@10, samesake vs spike): keyword 2.60/2.68 · attribute 2.41/2.43 · use-case 2.26/2.31 · price 2.70/2.76 · negation 2.83/2.85 · style 2.04/2.23 · local 1.50/1.68 · broad 2.80/2.90. Deltas are within judge variance; `local` remains the corpus-coverage weak spot for both systems (known from the spike).

## Corpus & pipeline

- 4,555 products ingested through the framework's Shopify/Woo connectors (file-snapshot mode) — 100% of the snapshot, including Woo minor-unit price normalization.
- Enrichment: 1,327 products enriched LIVE through the framework pipeline (gemini-3.1-flash-lite classify → gemini-3-flash-preview extract, 0 failures), then the run was **stopped for cost control** and the remaining products' enrichments + all 4,324 embedding vectors were **imported from the spike's tables** (same products, same prompts, same models — SQL copy, $0). The live-enriched sample plus C2's test suite validate the pipeline; the import validates nothing was paid for twice.
- Index: 4,324 apparel docs (231 non-apparel auto-excluded), pgvector 1536d.

## Framework fixes found by this integration

1. `alsoMatch` enum clause rendered a duplicate SQL param index (two `next()` calls before any `params.push`) → Postgres `42P18` on every gender-bearing query. Fixed in `core/search.ts` + regression tests (commit 179e57b). Root cause of the first benchmark attempt's 12% zero-result rate.
2. Sharp edge worth knowing: the example resolves `@samesake/server` via built `dist/` — source fixes need `bun run build` in the package or they silently don't apply (tests run source; examples run dist).
3. Consumer-driven API additions during integration (commit ae4b608): public connector exports, `alsoMatch` on enum fields, NLQ `schema`/`model` overrides, non-apparel skip in embed-index.

## Verdict

The framework reproduces the spike's intent-search quality within tolerance on the identical harness, beats it on latency, and beats the original fan-out v1 on every metric by a wide margin.
