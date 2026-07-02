# Powering Search & Recommendations at DoorDash
URL: https://careersatdoordash.com/blog/powering-search-recommendations-at-doordash/

## Key mechanisms
- **Two-phase online query: hard selection, then ranking.** Elasticsearch query first applies geoshape selection (only stores orderable from the consumer’s address/driving distance), then scores the surviving subset — not the full catalog.
- **Knowledge-based pairwise recommender, not item-only scores.** For each (consumer `c_i`, store `s_j`) pair they materialize features `f^k_ij` (e.g., cuisine overlap between past orders and store cuisine, page-view overlap, price-range affinity). Labels: positive = ordered; negative = exposed in selectable range but did not order.
- **Logistic regression trained offline, served inline.** `P(order) = sigmoid(Σ w_k · f^k_ij)`; weights `w_k` fit offline on implicit feedback within the same geographic selection constraints used online.
- **Profile split: item offline, user online.** Store profile `d(s_j)` is written by the indexing pipeline into Elasticsearch; consumer profile `d(c_i)` is maintained by an offline ML pipeline in Postgres and fetched with **one extra DB read per search** (cacheable). The ES **script-score** ranking function combines runtime `d(c_i)` (query args) with indexed `d(s_j)` (document fields) inside the ES JVM — no round-trip scoring service.
- **Empirical motivation for non-global ranking.** Pre-personalization sort experiments (popularity, price, delivery ETA, ratings) showed no single global winner; “best” varies by user → personalization layer added on top of baseline retrieval.
- **Fault-tolerant degradation.** If consumer profile fetch or personalization path fails, search falls back to the baseline non-personalized feed rather than erroring.
- **Figure (“Personalization Search Architecture”) intent:** offline loop indexes store-side signals + refreshes consumer profiles; online loop is client → search API → DB fetch `d(c_i)` → ES script-score over pre-filtered candidates → ranked results. Latency claim: personalization rolled to 100% with no ES latency impact because scoring stays in-cluster.

## Learnings for samesake
### L1: Hard selection before relevance fusion  [maps: G2 | NEW | N/A]
- DoorDash evidence: geoshape selection removes non-orderable stores **before** logistic-regression scoring; training negatives are also drawn only from the selectable set.
- Samesake action: Treat NLQ hard filters (price/color/gender/category/availability) **and** RFC `pipeline_status='ready'` gate (`embed-index.ts` staleClause + `search.ts` candidate filters per REQ-6b) as a selection layer that shrinks the candidate pool before RRF/rerank — quarantined/low-confidence rows never enter any channel, not just cosine.
- Why / caveat: Same architectural invariant (constraints first, scores second) even though samesake’s constraints are catalog/quality filters, not driving-distance geoshapes. Already aligned with RFC G2; DoorDash validates making selection explicit and non-skippable rather than hoping bad rows sink in fusion.

### L2: Static catalog signals offline, dynamic user signals at query time  [maps: G7 | NEW | N/A]
- DoorDash evidence: `d(s_j)` indexed offline in ES; `d(c_i)` fetched per request and passed as script parameters — personalization is not re-indexed per user.
- Samesake action: Keep enrichment outputs (`embed_doc`, visual `space_vec`, FTS) catalog-static; implement G7 by promoting `rankingPolicy` into core `search()` (`packages/server/src/core/ranking.ts` per RFC C13) so session/user/business boosts are query-time hooks, not baked into `$enriched.embed_doc` or re-embedded vectors.
- Why / caveat: Directly counters attribute-bleed (REQ-11b): DoorDash never puts “this user likes Thai” into the store document. Samesake lacks DoorDash-scale behavioral profiles today, but the seam is correct for when click/order history exists.

### L3: Pairwise query×candidate features, not flat score nudges  [maps: G7 | NEW | N/A]
- DoorDash evidence: Features are explicitly `(c_i, s_j)` interactions (`f^k_ij`), e.g., cuisine overlap — not a single store popularity scalar added everywhere.
- Samesake action: Refactor `fashion-search.ts:rankHits` additive constants (`score -= 2` for unavailable, flat business weights on raw RRF ~0.01–0.05 scores) into normalized, named interaction terms in core `rankingPolicy`: e.g., `match(query.price_band, hit.price)`, `match(nlq.category, hit.category)`, optional `affinity(user.history_categories, hit.category)` — each on a 0–1 normalized relevance scale (REQ-20).
- Why / caveat: DoorDash uses hand-crafted overlap features + LR; samesake won’t ship LR (RFC non-goal), but the **feature shape** transfers. Flat constants on incomparable RRF scales are exactly what G7 hardens.

### L4: Explicit baseline fallback when personalization context is missing  [maps: G4 | NEW | N/A]
- DoorDash evidence: Failure to fetch `d(c_i)` → fall back to default non-personalized ranking; search still returns results.
- Samesake action: Codify the same contract for optional stages: absent `ctx.rerank` or `rerank: false` → pure RRF (already true at `search.ts:825`); absent/throwing `rankingPolicy` or failed rerank LLM call → log + return first-stage RRF order, never empty/error. Document this in the fashion template default wiring (RFC C12/C13).
- Why / caveat: Fashion search is latency-sensitive like DoorDash’s claim; graceful degradation matters more than squeezing last-mile personalization when `generate` is unavailable.

### L5: Implicit negatives must respect the same filter universe as online search  [maps: NEW | N/A]
- DoorDash evidence: Training negatives are stores **shown and selectable** for `c_i` but not ordered — not random global negatives.
- Samesake action: When building offline eval or future reranker/judge datasets (`examples/fashion-search/eval-*`, search-relevance tests), sample hard negatives from the post-filter candidate pool (same NLQ filters + `pipeline_status='ready'`) rather than random catalog SKUs. If adding click logs later, store `(query, filters, candidate_set, chosen_id)` not just `(query, chosen_id)`.
- Why / caveat: No behavioral loop in samesake yet, so this is **eval/training hygiene**, not a near-term product change. Still prevents inflated offline metrics that online RRF+rerank cannot reproduce.

## Applicability caveats
- **Domain mismatch:** restaurant discovery with geospatial sparsity and three-sided marketplace dynamics ≠ single-vertical fashion SKU search; cuisine-overlap pair features have no direct analog beyond category/style affinity.
- **Retrieval stack mismatch:** 2017 Elasticsearch inverted index + script-score logistic regression ≠ samesake’s pgvector HNSW + RRF over FTS/cosine/spaces/recency + optional cross-encoder rerank. No embedding dims, losses, rerank thresholds, or eval methodology to import.
- **Personalization data gap:** DoorDash’s lift comes from order/page-view history at marketplace scale; a small retailer likely lacks `d(c_i)` — G7 hooks are architecturally right but evidence of impact doesn’t transfer without behavioral volume.
- **No pipeline-integrity lessons:** DoorDash says nothing about index drift, enrichment gating, compose seams, or retry state — the RFC’s G1–G6 problems are outside this post’s scope; only G7’s *shape* (query-time, pairwise, fallback) partially resonates.
- **Thin eval:** “Significant lift in conversion from search to checkout” with no offline metric, A/B detail, or feature ablation — treat as directional, not a benchmark to chase.
