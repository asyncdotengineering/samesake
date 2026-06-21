# Relevance Floor + NLQ Refactor — Implementation Notes

Mode: autonomous-stand + zero-tech-debt. Refactored the **actual packages** (`@samesake/core`, `@samesake/server`), not the example. All under the unpublished **2.1.0**.

## What shipped (a → b → c)

### (a) Relevance floor with structured-intent bypass — `packages/server/src/core/search.ts`
- `search.relevanceFloor`: absolute query–document cosine floor (FTS keyword matches exempt) that drops semantic-only hits below the threshold → suppresses no-match padding.
- **Reshape, not patch**: the floor was a policy read *inside* the SQL builder (`runHybridQuery` read `def.search.relevanceFloor`). Moved the policy up to `runRanked` and passed the floor as a **parameter**. `runRanked` computes `effectiveFloor = Object.keys(r.nlq.filters).length > 0 ? null : configuredFloor` — when NLQ derived hard filters, those filters define relevance, so the semantic floor is skipped. This is the **bypass** that fixes filter-dominated queries (`"anything under 2000"` was returning 0; now returns the ≤2000 set).
- Also fixed a real regression the floor introduced earlier: `searchExplain` errored (`could not determine data type of parameter $9`) because the floor param was bound before the explain/non-explain branch but only used in one. Param now bound only on the path that uses it. Regression test added.

### (b) NLQ schema/instructions — reference pattern — `packages/sdk/src/templates/fashion.ts`
- Rewrote `fashionNlqSchema` (`.optional()` + `"0 if none"` → `.nullable()` + operational descriptions) and `FASHION_NLQ_INSTRUCTIONS` (added few-shot `<examples>`). Pattern learned from `octalpixel/linkable apps/shopbook-demo/api/_lib/routes/extract.ts`.
- Fixes inconsistent `semantic_query` stripping: `"men's footwear under 1500"` previously left `semantic_query = "men's footwear under 1500 LKR"` (price noise polluting the embedding and therefore the floor's signal); now consistently `"men's footwear"`, with all filters extracted (price + category + gender + colour + occasion).
- The example (`examples/fashion-search/fashion.ts`) interpolates `FASHION_NLQ_INSTRUCTIONS`, so it inherits the fix automatically.

### (c) Decision: cosine floor = default; cross-encoder = BYO recipe
**Decision (owner call, benchmark-backed):** the cosine+FTS floor is the **framework default** relevance gate. A cross-encoder reranker is the stronger signal but is shipped as a **BYO recipe**, not bundled.
- Rationale: cosine floor is model-free, works on every runtime, simple (one signal/threshold), and scored 96% on the calibration probe. The cross-encoder scored 100% but: (1) `rerank` is already BYO, (2) a native ONNX reranker (`onnxruntime-node`) **cannot run on Cloudflare Workers**, so bundling it would break the documented Workers deploy path, (3) a second relevance-signal path (cosine-in-SQL + reranker-post-rerank, different calibrated thresholds) is dual-signal complexity not worth 4 pts for a framework default.
- Shipped the recipe: `examples/fashion-search/rerank.ts` — `onnxReranker()` (local `mxbai-rerank-xsmall` via transformers.js, Node/Bun) + `workersAiReranker(env.AI)` (Cloudflare Workers AI `@cf/baai/bge-reranker-base`). Documented in `reference/reranking` with the benchmark and the Cloudflare constraint.

## The diagnose finding that reframed this work
The reported "NLQ doesn't extract numeric/price filters" was a **diagnostic error** (mine, earlier in the session): I read `res.derivedFilters`, which is **not populated on a regular search result** — applied constraints live in `searchExplain().constraintTrace.appliedFilters`. NLQ extraction was always working (`searchExplain` shows `{price:{$lte:1500}, gender:"men", category:"footwear"}`). The instrumentation loop (raw model output → `max_price:4000`) falsified the "extraction broken" hypothesis. The genuine bugs the loop surfaced: the `searchExplain` regression (fixed in a) and inconsistent `semantic_query` stripping (fixed in b).

## Calibration benchmark (the data behind c)
Deterministic hand-labels (22 positive + 12 negative queries) on the seeded demo store, cross-encoder (mxbai) as a candidate signal:

| algorithm | best θ | neg-reject | pos-keep | combined |
|---|---|---|---|---|
| reranker (cross-encoder) | 0.12 | 100% | 100% | **100%** |
| cosine + FTS-exempt (shipped default) | 0.52 | 92% | 100% | 96% |
| min-max RRF / autocut | — | **0%** | 100% | 50% |

min-max RRF (the framework's prior `minRelevanceFloor` notion) and Weaviate-style autocut **cannot reject negatives** — they are relative methods that always return a top result. Confirmed empirically; ruled out.

## Things to know
- **2.1.0 is unpublished.** Versions bumped (`@samesake/core` + `@samesake/server` → 2.1.0); not `npm publish`'d (not requested).
- **The seed was re-dumped** (`examples/fashion-search/datasets/demo-store-seed.sql`) to carry the final config (floor + nullable NLQ schema + few-shot instructions).
- **Known cosine-floor edge:** `"office chair"` returns 1 weak hit (a "…Work…" formal shoe — office/work overlap, cosine ≈0.51 just over 0.5). The cross-encoder recipe rejects it (documented); the model-free default accepts the occasional borderline.
- **Schema change requires re-apply:** the NLQ schema is stored in `config_json` at apply-time; existing projects must re-apply to pick up the new nullable schema/few-shot instructions (alpha — breaking changes embraced).
