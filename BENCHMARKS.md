# Benchmarks

Honest, reproducible quality numbers for the samesake search framework. No marketing inflation — the numbers are the story.

## Unbiased multi-domain benchmark — the standing gate for ranking changes

**Lesson learned (post-mortem):** the LK parity eval below used *keyword-snapshot relevance labels* — the items a keyword search already returned. Those labels **reward keyword behavior**, so they misjudge ranking changes: when soft-OR FTS was added, this biased metric showed a fake intent "regression" (0.67→0.63) that did not exist on real relevance. Judge ranking changes on **unbiased** relevance, not word-overlap.

The fix is institutional: `examples/fashion-search/bench-retrieval.ts` (`bun run bench`) — **hand-assigned graded relevance** across **fashion + electronics (out-of-domain)**, real `gemini-embedding-2`, with an acceptance gate that fails the run on regression. nDCG@5, soft-OR (default) vs strict-AND:

| config (nDCG@5) | electronics strict-AND | electronics soft-OR | fashion strict-AND | fashion soft-OR |
|---|---|---|---|---|
| keyword | 0.362 | **0.938** | 0.477 | **0.977** |
| flat    | 0.893 | 0.934 | 0.997 | 0.997 |
| intent  | 0.893 | 0.934 | 0.997 | 0.997 |
| similar | 0.893 | 0.893 | 0.997 | 0.997 |

On unbiased labels soft-OR is **neutral-to-better** for intent/flat and **+0.50–0.58** for the keyword leg (strict-AND goes inert — scores 0.00 — on vocab-mismatch/use-case queries). The improvements **generalize out-of-domain** (electronics mirrors fashion). For programmatic self-tuning use `matcher.calibrateSearch(...)` or the CLI `samesake calibrate-search` (LLM-as-judge when no labels are supplied) — both judge on relevance, not keyword overlap.

## PARITY RUN (same harness, same 4,555-doc corpus)

> Caveat: the labels in this parity run are keyword-snapshot results and therefore keyword-biased — see the unbiased benchmark above for the relevance-judged numbers used to gate ranking changes.

Same 50 golden queries, same ESCI LLM judge (`gemini-3-flash-preview`, cached), same LK fashion product corpus (**4,555 products / 20 stores**). Harness: aggregator repo `scripts/eval-search.js`. Result files in aggregator `evals/results/`.

| System | mean@10 | P@5 | price-violation | median latency |
|--------|---------|-----|-----------------|----------------|
| **Fan-out v1** (original) | 1.47 | 0.48 | 62% | 8.8s |
| **Spike v2** (aggregator `/search/v2`) | 2.42 | 0.83 | 16% | 1.34s |
| **samesake** (parity run) | 2.33 | 0.83 | 16–20% | 1.07s cold |

### Per-type mean@10 (parity run — samesake vs spike, 4,555 docs)

| type | samesake | spike |
|------|----------|-------|
| keyword | 2.60 | 2.68 |
| attribute | 2.41 | 2.43 |
| use-case | 2.26 | 2.31 |
| price | 2.70 | 2.76 |
| negation | 2.83 | 2.85 |
| style | 2.04 | 2.23 |
| local | 1.50 | 1.68 |
| broad | 2.80 | 2.90 |

`local` remains the weak spot for both systems — corpus depth for ethnic/LK inventory, not engine regression.

Much of the parity corpus enrichment and precomputed vectors were imported from the spike pipeline — see [`examples/fashion-search/PARITY.md`](./examples/fashion-search/PARITY.md).

## POST-WAVE (not apples-to-apples — corpus grew to 5,052 docs)

After additional ingestion waves the corpus grew **17%** (4,555 → 5,052 enriched products, 28 stores). These numbers use the same harness and judge but a **larger corpus** — do not compare directly to the parity table above.

| metric | post-wave samesake |
|--------|-------------------|
| mean@10 | 2.33 |
| P@5 | 0.83 |
| price-violation | 16–20% |
| median latency | 0.6s warm @5,052 docs |

Holding mean@10 near parity-run levels while the corpus grew is a positive signal, but it is not a same-corpus win over spike v2.

## Spaces gate (V02g)

Spaces capability ships but stays **off by default**. Flat-weighted segmented vector as a third RRF leg did not pass the gate on the 5,045-doc fashion corpus.

| metric | baseline (no spaces) | spaces leg ON | gate |
|--------|---------------------|---------------|------|
| mean@10 | 2.328 | 2.242 | ≥ 2.30 ✗ |
| P@5 | 0.828 | 0.784 | ≥ 0.82 ✗ |
| style | 2.075 | 1.925 | improve ✗ |
| local | 1.740 | 1.620 | improve ✗ |

Verdict and engineering findings: [`docs/spaces-gate.md`](./docs/spaces-gate.md).

## Aspects gate (C9, multi-aspect retrieval) — 2026-07-18

Per-aspect retrieval (visual + facets legs, NLQ-routed) was gated on the enlarged harness
(67 queries incl. typo + multilingual, k=5, cross-family judge `gpt-4.1-mini`) against a
same-code same-corpus baseline (aspect legs zero-weighted), 5,512-doc corpus with full
visual + facets backfill. Gate run + the protocol's two calibration runs:

| metric (mean grade@5) | baseline | aspects run 1 | cal 1 (doc floored) | cal 2 (halved weights) |
|---|---|---|---|---|
| overall | **1.916** | 1.808 | 1.844 | 1.856 |
| style | 2.075 | 1.825 | 1.675 | 1.65 |
| local | 0.76 | 0.48 | 0.76 | 0.68 |
| use-case | 1.92 | **2.12** | 2.08 | **2.10** |
| negation | 1.70 | 1.70 | 1.95 | **2.00** |

**Verdict: intent-mode aspect legs ship OFF by default** (same protocol as the V02g spaces
gate). The visual leg consistently hurt style/overall regardless of routing and weight
calibration; the doc embedding already carries style semantics. Two real findings survive:
(1) facets evidence improves use-case (+0.18) and negation (+0.30) — the recorded follow-up
is a facets-only intent experiment (per-query `weights.aspects` override is the sanctioned
mechanism); (2) the image-query path through the `visual` aspect works and replaces spaces —
verified live: an image query returns its own product at rank 1 via the visual leg (REQ-10).
Artifacts: `evals/runs/2026-07-18T*aspects-{baseline,on,cal1,cal2}.*`.

Note: these figures are not comparable to the historical parity tables above (different
query count, k, judge family, and corpus size).

## Enrichment accuracy — the root-cause gate (separate from search relevance)

Search relevance is downstream of enrichment: a mis-extracted color or missed neckline corrupts
ranking, but a relevance metric only sees blurred noise. `matcher.evaluateEnrichment(...)` scores the
pipeline's extracted attributes against a **human-labeled gold set** (`evals/golden-enrichment-fashion-lk.json`,
50 real LK products from the `demo_store` corpus, labeled independently from titles) with per-attribute
precision/recall/F1. Reproduce: `cd examples/fashion-search && bun eval-enrichment.ts --fixture`
(offline, no DB/LLM) or `bun --env-file=../../.env eval-enrichment.ts` (live) — both give identical numbers.

| attribute | precision | recall | F1 |
|---|---|---|---|
| category | 94.0% | 94.0% | 94.0% |
| gender | 100% | 100% | 100% |
| colors | 98.1% | 100% | 99.0% |
| pattern | 100% | 100% | 100% |
| is_apparel_product | 98.0% | 98.0% | 98.0% |
| **overall (micro)** | **97.6%** | **98.1%** | **97.8%** |
| **macro F1** | | | **98.2%** |

Scoring: each value is a set token; TP = pred∩gold, FP = hallucinated, FN = missed ("NULL is worse
than wrong"). v1 gold covers the controlled, gate/filter-critical attributes only (free-text
`product_type` and image-derived `occasions/styles/fit/material` are out of scope until labeled from
images — see [implementation notes](./search-enrichment-accuracy-implementation-notes.md)).

The disagreement list is the payoff: this run flagged a shoe-care brush (`6842`) mis-classified as an
apparel accessory and **not** gated (leaking into accessory search) — a real bug the search eval
could not have localized.

## Methodology

- **Golden set**: 50 queries covering keyword, attribute, use-case, price, negation, style, local, and broad intent types.
- **Judge**: ESCI LLM grading (0–3 relevance scale), results cached per (query, result-set hash). The parity/post-wave tables above were produced by a historical spike run that used `gemini-3-flash-preview`; the **framework's current judge + generate model is `gemini-3.1-flash-lite`** (see `examples/fashion-search/gemini.ts`) — there is no "flash 3" in the live pipeline. New eval runs (e.g. `eval-search.ts`) stamp the model used into their artifact.
- **Corpus**: LK fashion e-commerce — Shopify/Woo connectors, enrichment pipeline (classify + extract), pgvector 1536d embeddings.
- **Metrics**: mean grade@10 (primary), P@5 (precision at relevance ≥2), nDCG@10, price-violation rate, zero-result rate, median latency.

### Caveats

- **Single judge model** — ESCI grades are stable run-to-run but not ground truth; human spot-checks recommended for production tuning.
- **LK fashion corpus** — numbers reflect one vertical and one locale; do not extrapolate to general e-commerce without your own eval.
- **Corpus growth** — post-wave numbers use a larger doc set than the parity run; label comparisons accordingly.
- **NLQ cache invalidation** — changing NLQ instructions forces one-time re-parse; cold-run latency includes this; steady-state ~0.6s is the operational number.

## Reproduce

**From this repo alone you can run:**

- Stub-embed smoke examples: `bun examples/hello-search/run.ts`, `bun examples/hello-spaces/run.ts`
- Match smoke (needs Gemini): `bun examples/hello/run.ts`

**Requires external LK fashion dataset (`FASHION_DATASET_DIR`):**

1. Obtain raw Shopify/Woo JSON snapshots (not bundled in this repo).
2. `FASHION_DATASET_DIR=/path/to/raw bun examples/fashion-search/ingest.ts`
3. Start matcher: `bun run dev` with fashion config.
4. Clone the aggregator eval repo (`project-search-web-search`) and run: `node scripts/eval-search.js --target v2 --base http://localhost:3030`

Detailed provenance: [`docs/QUALITY.md`](./docs/QUALITY.md), [`examples/fashion-search/PARITY.md`](./examples/fashion-search/PARITY.md).
