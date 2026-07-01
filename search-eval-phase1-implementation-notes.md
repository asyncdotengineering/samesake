# Search eval + Phase-1 retrieval fix — implementation notes

Goal: a reproducible search-relevance eval on our **current data**, a captured pre-fix baseline JSON,
one data-driven Phase-1 retrieval fix, and a post-fix JSON to compare. Everything framework-direct.

## Eval bed + method

- **Corpus:** `fashionparity` — the real LK corpus (5,512 products, 5,052 embedded), not the 50-item
  `demo_store`. This is what `evals/golden-queries-fashion-lk.json` and BENCHMARKS were built for.
- **Scorer:** `matcher.evaluateSearch` (LLM-as-judge) — no hand-rolled ranking scoring. Judge +
  generate model = **`gemini-3.1-flash-lite`**, embeddings = **`gemini-embedding-2`** (stamped into every
  artifact). There is no "flash 3" in the pipeline.
- **Query set:** 50 golden queries (8 buckets) + a new 12-query **typo** bucket (`evals/search-queries-typo.json`).
- **Runner:** `examples/fashion-search/eval-search.ts` — `--phase=baseline|postfix`, groups the
  framework's per-query output into buckets, writes `evals/runs/<ts>-search-<phase>.{json,md}`.
- **Fair comparison:** the runner `apply()`s the collection config in-process before evaluating. This
  is required and production-representative — NLQ schema/instructions are functions that cannot be
  rehydrated from the DB, so without apply the engine falls back to a *derived* NLQ schema. Both
  pre and post use the same applied path; they differ only by the fix.

## Data-driven finding (my initial hypothesis was wrong — the gate caught it)

I expected **typo tolerance** to be the Phase-1 win. The baseline disproved it: the `gemini-embedding-2`
semantic leg already handles typos — the typo bucket scored **1.92** (above the 1.61 overall). Shipping
typo tolerance would have been theater. The baseline instead exposed the real gap:

- **use-case: grade 1.23, nDCG 0.66, and 30% no-results** — 3 queries returned **zero** hits:
  "office wear for women", "smart casual outfit for men", "resort wear for a holiday".

## Root cause

The NLQ model maps vague use-case queries to **`category: "other"`**, and `category` is a **hard
filter**. In the taxonomy `"other"` = the *non-apparel* bucket (gift cards, homeware), which is
quarantined at index time → matches zero apparel → empty results. ("gym wear for women" worked
because NLQ correctly picked `category: "activewear"`.)

## Fix (root cause, framework, no workaround)

`packages/sdk/src/templates/fashion.ts` — `fashionNlqSchema()` + `FASHION_NLQ_INSTRUCTIONS`:
**remove `"other"` from the NLQ category enum** (so structured output cannot emit it) and instruct the
model to leave `category` null for vague use-case/style queries and let `semantic_query` carry the
intent. No engine coercion/fallback — the model simply can no longer produce the poison value.

## Pre → Post (fashionparity, k=5, gemini-3.1-flash-lite judge)

| bucket | pre grade | post grade | Δ | pre no-results | post no-results |
|---|---|---|---|---|---|
| **use-case** | 1.23 | **1.77** | **+0.54** | **30%** | **0%** |
| negation | 1.65 | 1.80 | +0.15 | 0% | 0% |
| keyword / broad / price / typo | — | — | 0.00 | 0% | 0% |
| attribute | 1.35 | 1.33 | −0.03 | 0% | 0% |
| style | 1.25 | 1.15 | −0.10 | 0% | 0% |
| local | 1.12 | 0.96 | −0.16 | 0% | 0% |
| **overall** | **1.611** | **1.679** | **+0.068** | **5%** | **0%** |

**Interpretation (honest):**
- The win is real and partly **deterministic**: overall no-results **5%→0%** (use-case 30%→0%) is not
  judge-dependent, and use-case grade **+0.54** is far above noise.
- The style/local −0.1x deltas are **within single-LLM-judge noise**: every query's hit count is
  unchanged (5→5), most per-query grades are identical, drift is ≤0.4 per query on 5–8-query buckets,
  and the fix only alters NLQ output for queries that emitted `"other"` (which style/local mostly did
  not). I did not over-claim these as real.

## Harness hardening this exposed (follow-ups)

1. **Persist a shared judge cache** keyed by `(query, docId, judge-model)` so a doc appearing in both
   pre and post reuses its grade — then any bucket delta reflects *retrieval* change only, removing the
   noise above. (Framework change to `evaluateSearch`'s per-run in-memory judge cache.)
2. `topIds` are now persisted per query in the artifact so pre/post retrieval can be diffed exactly.

## Verify

- Root `tsc --noEmit` clean; enrichment scorer tests still green (11/11) after the SDK change.
- Reproduce: `cd examples/fashion-search && bun --env-file=../../.env eval-search.ts --phase=baseline|postfix`.

## P2 (retrieval/NLQ robustness) + P3 (harness honesty)

Verified with the deterministic judge (P3 #10) so pre/post deltas reflect retrieval, not judge noise.

**Shipped:**
- **#5 NLQ price robustness** (`FASHION_NLQ_INSTRUCTIONS` + schema): strip $/Rs/rupees, "5k"→5000,
  IGNORE non-positive / inverted (min>max) bounds, "for N" is not a price. Red-team: "shoes under
  -500" / "top for 0 rupees" now ignore the nonsensical bound and return normal results instead of
  price=0 junk. Neutral on the golden price bucket.
- **#7 price hygiene gate** (`fashionIndexing`): quarantine rows with price ≤ 0 (reason
  `invalid-price`). Unit-tested (`fashion-template.test.ts`). Applies on next index; the already-baked
  fashionparity corpus still shows price=0 rows (num-05) until re-indexed.
- **#9 judge sees price** (`candidateSummary` + `hitText`): the LLM judge now gets each candidate's
  price, so it can verify numeric constraints. Effect: golden price bucket 1.8→2.64 (accurate now),
  and the red-team's 3 numerical "WEAK" false-alarms (num-01/03/04) disappeared — they were judge
  blind-spots, not retrieval failures. Red-team findings 16→13.
- **#10 persistent judge cache** (`calibrate-search.ts`, keyed `search-judge:<version>:sha1(query id)`
  via the stage-cache table): a doc seen in both pre and post runs reuses its grade → deterministic
  pre/post. Proven: p2base→p2post left keyword/broad/style/typo buckets bit-identical; only
  retrieval-changed queries moved.

**NOT shipped:**
- **#6 styles-soft** (example config): reverted. Neutral on the golden `style` bucket (1.35→1.35) with
  a small `local` regression (1.04→0.88) and no measured benefit — same discipline as P1 #2/#3.
  (The SDK `fashionSearchFields` default is already `soft:true`; the example diverged — left as-is.)

**Deferred (out of P1/P2/P3 scope):** OOD rejection (7/8 junk-shown — the P0 `relevanceFloor`
calibration), multilingual Sinhala/Tamil, and lexical-leg/BM25 (#11 → research task #17).
