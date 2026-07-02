```
# Personalizing the DoorDash Retail Store Page Experience
URL: https://careersatdoordash.com/blog/personalizing-the-doordash-retail-store-page-experience/

## Key mechanisms
- **Two-stage homepage architecture (Figure 2):** Collection retrieval picks which themed shelves appear per pagination page *before* item ranking runs, so the system never fetches/ranks every SKU against every collection on each load.
- **Collection retrieval model (Figure 3):** Supervised engagement predictor (click / add-to-cart probability) over collection-level features: aggregate popularity (CTR, click volume, order subtotal), consumer traits (DashPass, new vs power user, order count), per-consumer history on that collection, cross-surface item engagement (search + category clicks), and context (time-of-day, day-of-week, store type, geo).
- **Horizontal item ranker:** Started as CTR prediction; mitigated niche high-CTR / low-ATC failure by **up-weighting training positives where click → add-to-cart → conversion**. Feature buckets: item engagement history, item attributes (price, discount, brand, taxonomy, popularity), consumer preferences (category, dietary, price sensitivity), plus **team-built consumer/item semantic embeddings** layered on dense features.
- **Position-bias handling (Figure 4):** Mobile shows ~3 cards without horizontal scroll; impressions cliff at position 4 makes raw CTR non-comparable across positions. Model trains with **item position + product surface** as features; at inference **position is forced to 0** on the target surface.
- **Deterministic post-ranking business layer (Items IV, VI):** After ML scores: down-rank **missing photos**, down-rank **high out-of-stock probability** (separate OOS model), enforce **intra-collection category diversity**, **dedupe items across collections**, and **inter-collection diversity** via taxonomy aggregation.
- **MMR diversification:** Post-rank greedy selection with \(O(j,I) = S_j - \lambda \cdot \mathrm{sim}(j,I)\); similarity on **category/brand** (items) and **aggregated item taxonomy** (collections); **\(\lambda\) tuned in online experiments**—not offline-only.

## Learnings for samesake
### L1: Treat RRF as retrieval, not the conversion objective  [maps: G4 | G5 | G7]
- DoorDash evidence: A single CTR ranker systematically promoted niche click-bait SKUs with poor add-to-cart; they fixed it by reweighting toward click→ATC→conversion, not by tweaking feature engineering alone.
- Samesake action: Keep RRF (`packages/server/src/core/search.ts`) as the multi-channel **recall/fusion** stage; ship RFC **G4/G5** so fashion search defaults to a second-stage `fashionRerank()` (LLM or visual) over `enriched.rerank_doc`, and apply **G7** `rankingPolicy` boosts only **after** rerank on a **normalized** score—never as raw constants added to RRF outputs (`fashion-search.ts:163-168`).
- Why / caveat: Same failure mode as CTR-only ranking: cosine+spaces can over-rank visually similar but wrong-intent or unavailable SKUs. samesake lacks DoorDash’s labeled click/ATC logs, so the second stage must proxy intent via reranker + declared business hooks, not a learned conversion model.

### L2: Make business/quality rules an explicit post-ML seam  [maps: G2 | G7]
- DoorDash evidence: Photo presence and a dedicated OOS model adjust ranks *after* the ranker; these are separate from the engagement model and applied uniformly via “item post-processing.”
- Samesake action: Implement RFC **G7** as a deterministic post-fusion hook in core `search()` (`core/ranking.ts`), mirroring DoorDash’s layering: (1) relevance fusion + rerank, (2) then normalized penalties for `availability`, missing `image_url`, and low `enriched.confidence` surfacing (confidence already captured—**G2 `gate`** should prevent indexing, but search-time bury remains useful for stale rows). Extend fashion `rankingPolicy` with a `requireImage`/`buryNoImage` factor analogous to “no photo” down-rank.
- Why / caveat: DoorDash runs a separate OOS ML model; samesake can start with catalog `availability` + pipeline `pipeline_status` (RFC **G6**) without building OOS prediction. Single-retailer scale makes hard rules cheap and auditable—better than baking availability into embeddings or RRF.

### L3: Add optional result-list MMR after rerank  [maps: NEW]
- DoorDash evidence: Even strong rankers cluster near-duplicates (three apple SKUs in a row; similar collections vertically). They apply **MMR after ranking** with category/brand similarity and tune \(\lambda\) online.
- Samesake action: Add an optional `diversityPolicy` on `CollectionSearchDef` (fashion template default): greedy re-order top-\(K\) reranked hits using enriched attrs already in DB—`category`, `pattern`, `colors[0]`, `product_type`—with \(\mathrm{sim}\) = Jaccard/overlap on those fields; expose \(\lambda\) in template config for playground A/B. Implement in `packages/server/src/core/search.ts` after `rerankHits`, before `rankingPolicy`.
- Why / caveat: Fashion catalogs repeat silhouettes/colors; RRF+visual space actively *clusters* look-alikes. DoorDash’s cross-collection dedupe has no direct analog, but **in-list** MMR transfers cleanly. Skip at small `limit` or when the query is exact-SKU intent (NLQ hard filters already narrow).

### L4: Do not import position-bias training; do import the inference discipline  [maps: N/A]
- DoorDash evidence: Train with observed position + surface; **infer as if every candidate is shown at position 0** on the serving surface.
- Samesake action: **No change** to training (no ranker training loop). If you later log result clicks, store **rank position** in analytics and, only if building a learned ranker, apply the same infer-at-top rule. Today, avoid interpreting playground click-through by rank without position normalization.
- Why / caveat: samesake serves vertical ranked lists, not 3-visible horizontal carousels (Figure 4). Position bias is real but weaker; the transferable bit is “don’t compare raw engagement across ranks” when you eventually add behavioral reranking.

### L5: Collection retrieval ≈ NLQ hard-filter shrink, not a new subsystem  [maps: NEW | N/A]
- DoorDash evidence: Collection retrieval exists purely to cut compute—rank items only within collections chosen for the current page.
- Samesake action: **Do not** build a collection-retrieval tier. Instead, treat NLQ-extracted hard filters (price, color, gender, category in the existing NLQ path) as the first-pass shrink before multi-channel retrieval—document that filters must run **before** RRF candidate union to preserve the cost/latency win DoorDash gets from retrieval.
- Why / caveat: Single vertical, one result list, `RERANK_POOL=50` already bounds rerank cost. The learning is **ordering**: filter → retrieve → fuse → rerank → business rules → optional MMR—not “add another ML retriever.”

## Applicability caveats
- The post is **store-homepage shelf personalization** (collections × pagination × user history), not query-driven product search; most features (DashPass, cross-store purchase history, dietary prefs, geo/time context) have **no samesake equivalent** today and should not drive schema work.
- Mechanisms are **architectural**, not reproducible numerically: no model names, embedding dims, loss formulas, offline metrics, or rerank thresholds—only “CTR reweighted toward conversion” and “\(\lambda\) via online experiments.”
- DoorDash’s **semantic embeddings** are team-internal; samesake already owns doc/visual/spaces embeddings—there is nothing to copy except the *pattern* of not relying on one embedding for both retrieval and final order.
- **G1, G3, G6** (image-byte invalidation, unskippable compose, durable pipeline retries) are **not addressed** by this post; those remain RFC-only workstreams with no DoorDash evidence here.
```
