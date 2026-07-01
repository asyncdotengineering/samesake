# Enrichment-accuracy eval — implementation notes

Closes the loop named as samesake's make-or-break risk: **search relevance was measured; enrichment
correctness was not.** `evaluateSearch` grades a downstream symptom; a mis-extracted color or a
missed neckline only shows up there as blurred noise. This adds the root-cause measurement — the
enrichment twin of `evaluateSearch`.

## What shipped

- **`packages/server/src/core/evaluate-enrich.ts`**
  - `scoreEnrichment(gold, predicted, attributes)` — pure, no I/O. Per-attribute TP/FP/FN →
    precision/recall/F1, micro + macro overall, coverage, per-product diffs.
  - `makeEvaluateEnrichService(ctx, projectsService)` → `evaluateEnrichment(project, collection,
    { gold, attributes })` — reads `enriched` rows for the gold ids from the collection table and
    scores them. Wired onto the matcher (`matcher.evaluateEnrichment`) next to `evaluateSearch`.
  - Re-exported from `@samesake/server` (`scoreEnrichment` + types).
- **`packages/server/test/evaluate-enrich.test.ts`** — 11 tests: perfect match, hallucination (FP),
  miss/NULL (FN), `enriched=null`, `unknown`→empty, explicit-empty vs unlabeled-skip, boolean attr,
  micro-vs-macro, missing row, plus a service test with a fake storage (proves SQL + jsonb-string parse + score).
- **`evals/golden-enrichment-fashion-lk.json`** — v1 gold: 50 real LK products (the `demo_store`
  Myntra subset), hand-labeled from titles.
- **`evals/fixtures/enrichment-demo-store-predicted.json`** — the 50 rows' captured pipeline
  `enriched` output, so the eval runs offline (no DB/LLM) with identical numbers.
- **`examples/fashion-search/eval-enrichment.ts`** — runner. `--fixture` (offline), default (live via
  matcher), `--bootstrap [products.json]` (emit a blank gold template to label a new corpus).

## Scoring model (decisions)

- **Every value is a set token.** Single-value attrs (category, gender…) are a 1-element set;
  multi-value attrs (colors) a set. `TP=|pred∩gold|`, `FP=|pred\gold|`, `FN=|gold\pred|`, aggregated
  per attribute, then micro (pool all) + macro (mean of per-attr F1). This scores single- and
  multi-value attributes uniformly and directly encodes Velou's "NULL is worse than wrong": a missed
  attribute is an FN, a hallucinated one an FP.
- **Unlabeled ≠ empty.** A gold label KEY that is absent → the attribute is skipped for that product
  (we didn't label it). A label VALUE of `[]`/`"unknown"` → explicitly no value, and IS scored (so
  predicting a value is an FP). `"unknown"` predictions normalize to the empty set.
- **`empty` per attribute.** Defaults to `["unknown"]`; `is_apparel_product` overrides to `[]`
  (true/false are both real values, neither means "no value").
- **Coverage is reported, not hidden.** Missing prediction rows (id not found) are counted, not
  scored (data gap ≠ extraction error). `enriched=null` rows ARE scored (every gold value → FN — the
  pipeline failed to enrich). Status breakdown (`ready`/`quarantined`) is reported so gate behavior
  is visible.

## v1 gold scope (deliberately narrow, honest)

Labeled only the controlled, title-derivable, gate/filter-critical attributes: **category, gender,
colors, pattern (where stated), is_apparel_product**. Labeling rules are in the gold file header
(base-color mapping, garment-category-wins-over-`kids`, enum-only — validated against
`@samesake/core` fashion enums at generation time).

Excluded from v1 (documented, room to grow):
- `product_type` — free text; exact-match scoring is misleading until a canonicalization step exists.
- `occasions / styles / fit / material / neckline` — image-derived; need image-based labeling, not title-only.

## Results (50-product demo_store LK corpus)

Live (`matcher.evaluateEnrichment`) and offline (`--fixture`) produce identical numbers:

| attribute | P | R | F1 |
|---|---|---|---|
| category | 94.0% | 94.0% | 94.0% |
| gender | 100% | 100% | 100% |
| colors | 98.1% | 100% | 99.0% |
| pattern | 100% | 100% | 100% |
| is_apparel_product | 98.0% | 98.0% | 98.0% |
| **micro** | 97.6% | 98.1% | **97.8%** |
| **macro F1** | | | **98.2%** |

**Real findings the loop surfaced (the point of building it):**
1. **`6842` "Timberland … Brush Shoe Accessories"** — a shoe-care brush classified as an apparel
   accessory and **`status=ready`** (not gated). A non-apparel tool leaking into accessory search — a
   genuine gate/enrichment bug, now visible and regressable.
2. **`34009` "Girls Black Top"** — classified `kids`, gold `tops` → the real kids/garment taxonomy overlap.
3. **`39524` laptop sleeve** — classified `bags` but correctly gated non-apparel (gold `other`).
4. **`15970` "Navy Blue Shirt"** — pipeline emitted `[navy, blue]`; gold base-color rule = `[navy]` (over-emission).

## How to run

```bash
cd examples/fashion-search
bun eval-enrichment.ts --fixture                 # offline, no DB/LLM (CI-safe)
bun --env-file=../../.env eval-enrichment.ts     # live, against the seeded demo_store corpus
bun eval-enrichment.ts --bootstrap               # emit a blank gold template for a new corpus
```

Artifacts land in `evals/runs/<ts>-enrichment-{fixture,live}.{json,md}`.

## Assumptions / env notes

- `evaluateEnrichment` reads an **already-enriched, already-registered** corpus. It does NOT
  re-`apply`/re-migrate the collection — doing so on the curated `demo_store` seed triggers a
  destructive `space_vec` dim change (48→816, pre-existing config drift between the baked seed and
  the current fashion config). Registration is the seed's job (`datasets/demo-store-seed.sql`).
- The `demo_store` gold matches the seeded corpus by product id, so live and fixture agree exactly.

## Gate wiring (next, not in this change)

`evaluateEnrichment` is the primitive; wiring it as a CI/merge gate on enrich-prompt / taxonomy /
`FASHION_CONFIDENCE_FLOOR` changes (fail on per-attribute F1 regression) is the natural follow-up,
mirroring how `bench-retrieval.ts` gates ranking changes.

## P1 enrichment-quality fixes (via live re-enrich harness)

`eval-enrichment.ts --reenrich` re-enriches the 50 gold products live (text-only; the demo raw
images are expired signed URLs) through the current pipeline, then scores — so enrich-prompt changes
are actually exercised (the seeded corpus is baked). Pre and post are both text-only, isolating the fix.

**Shipped: #4 colour over-emission.** `fashionExtractSchema` colors rule now collapses compound
single-shade names to one base ("navy blue"→[navy], not [navy,blue]). Clean win, no collateral:

| | pre | post |
|---|---|---|
| colors F1 | 0.99 | **1.00** |
| category F1 | 0.94 | 0.94 (unchanged) |
| micro F1 | 0.978 | **0.981** |

**NOT shipped: #2 non-apparel gate + #3 kids/garment.** Both were attempted as classify-prompt edits
and every variant NET-REGRESSED (the re-enrich gate caught it each time):
- #3 "prefer garment category / kids-only-generic" → fixed girls-top + shoe-brush but broke activewear
  (track pants→bottoms) and generic kidswear (→tops): category 0.94→0.90.
- #2 "tools/tech sleeves → non-apparel" → made **watches** classify as non-apparel; a narrower
  "watches ARE fashion" variant then scrambled watch *categories* → category 0.82.

Conclusion: the classify stage (already 94% category / 98% is_apparel) is too sensitive to global
instruction edits for these 2-3 ambiguous edge cases (shoe brush, girls-top, laptop "sleeve bag").
The correct mechanism is the framework's **few-shot correction loop** (`review.ts` →
`correctionExamples` injected into the enrich prompt) — targeted per-product examples that don't
perturb the global classifier — not prompt surgery. Left as follow-up; #4 shipped.
