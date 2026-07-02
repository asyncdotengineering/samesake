```
# Bridging Affordability, Familiarity, and Novelty: DoorDash's LLM-assisted personalization framework
URL: https://careersatdoordash.com/blog/doordash-kdd-llm-assisted-personalization-framework/

## Key mechanisms
- **Three-objective framing drives every stage.** Familiarity, affordability, and novelty are not post-hoc metrics — they decide what to retrieve, how to rank, and how to present (Figure 1). Trade-offs are explicit before model choice.
- **Two-stage retrieval → rank, not one fused score.** A two-tower model learns separate customer/item embeddings from sparse order histories, engagement sequences, numerical/context features, and pre-trained embeddings; serving is dot-product top-N recall with recency/popularity/reorder blended in. A separate multi-task mixture-of-experts ranker then optimizes click-through, add-to-cart, in-session conversion, and delayed conversion on a shared representation, specialized per surface (Figure 2).
- **Same query, different intent via user context.** Search ranking incorporates dietary preferences, brand affinities, price sensitivity, and past shopping habits so identical queries (e.g. "ragu") resolve to different item types per user — personalization is injected at rank time, not only at query rewrite.
- **Affordability as a modeled signal, not a sort key.** Per-customer price sensitivity, bulk/size preference, and stock-up behavior feed a Value-to-Consumer objective; a Deals Generation Engine pairs promotions to customers under budget/efficiency constraints and surfaces them on carousels, search, and notifications.
- **Novelty via structured co-occurrence + cross-domain graphs.** Intra-vertical novelty uses co-purchase patterns and preference profiles; cross-vertical novelty maps restaurant order clusters through food/retail knowledge graphs to retail SKUs (e.g. weekly ramen orders → instant ramen kits, Asian condiments).
- **Hierarchical RAG for LLM cost/precision.** Instead of catalog-wide prompting, context is narrowed through category trees and structured retrieval before any LLM call (Figure 4) — compact prompts, fast inference, stable recommendations at millions-of-SKU scale.
- **Semantic IDs as a shared retrieval layer.** Compact, hierarchy-encoding embeddings power cold-start, free-text-to-product retrieval ("cozy fall candles"), intent-aligned task recs (gifting, recipes), and a common semantic layer reused across search, recommendations, and future agentic flows.
- **LLMs scoped to semantic gaps only.** Classic ML handles scalable recall/ranking; LLMs generate topical collections, summarize order history into vector context, rewrite queries, explain recs, and augment the product knowledge graph — not end-to-end ranking.

## Learnings for samesake
### L1: Treat RRF as recall, rerank as default second stage  [maps: G4 | G5]
- DoorDash evidence: Two-tower dot-product recall produces a candidate pool; a dedicated MTML MoE ranker is always applied before surfacing — first-stage retrieval is never the final order.
- Samesake action: Ship `fashionRerank()` as the default `RerankFn` in `packages/sdk/src/templates/fashion.ts` (RFC C12); wire it in the fashion template so `search()` reranks the RRF pool (`RERANK_POOL=50`) unless `rerank: false`. Pair with `composeFashionRerankDoc` → `enriched.rerank_doc` consumed in `packages/server/src/core/search.ts` rerank path (RFC C6/C11).
- Why / caveat: DoorDash's ranker is learned on billions of engagement events; samesake won't train MTML at fashion scale. A BYO cross-encoder or LLM-judge reranker on top of RRF is the right analogue — the structural lesson (two explicit stages) transfers even if the model doesn't.

### L2: Separate hard attributes from dense semantic text  [maps: G3 | REQ-11b]
- DoorDash evidence: User-specific hard signals (dietary prefs, brand affinities, price sensitivity) are modeled as separate features blended at recall/rank; they are not collapsed into a single embedding string. Semantic IDs encode hierarchy compactly; LLM context is narrowed hierarchically rather than dumped wholesale.
- Samesake action: Implement REQ-11b in `composeFashionEmbedDoc` (`packages/sdk/src/templates/fashion.ts`): keep only graded/compositional text (`search_document`, `product_type`, `occasions`, `styles`, `details`, non-solid `pattern`) in `embed_doc`; route `category`, `gender`, `colors`, `material`, `fit`, `brand` exclusively to filters and space channels. Put the attribute-dense superset into `rerank_doc` for the second stage (G5).
- Why / caveat: DoorDash has rich behavioral features samesake lacks; the transferable pattern is "exact-matchable attrs in structured channels, fuzzy intent in dense text" — directly counters attribute-bleed when the same attrs also appear in spaces/filters.

### L3: Make derived representations pipeline hooks, not consumer chores  [maps: G3 | G2]
- DoorDash evidence: LLM work (order summarization → vector context, knowledge-graph augmentation, collection generation) sits inside the five-step loop (Figure 2), not as optional post-processing the app team must remember to call.
- Samesake action: Wire `PipelineDef.compose` and `PipelineDef.gate` in `enrichOne` (`packages/server/src/core/enrich-pipeline.ts`) so `embed_doc`/`rerank_doc` are always emitted and low-confidence/non-apparel rows land in `pipeline_status='quarantined'` before index (RFC C4–C7). Delete standalone `compose-embed.ts` call sites in playground/examples.
- Why / caveat: DoorDash's loop is discovery-surface-oriented; samesake's is ingest→enrich→index. The failure mode is identical: skipped compose today silently falls back to `data.title` in `embed-index.ts:348-349`. This is the highest-confidence RFC alignment in the post.

### L4: Promote business/availability boosts to a normalized post-fusion hook  [maps: G7]
- DoorDash evidence: Recall blends recency, popularity, and reorder signals; rankers optimize multiple business outcomes (conversion, basket value) on a shared representation; affordability is a per-user modeled objective (Value-to-Consumer), not raw price sort. Objectives are commensurate within each stage.
- Samesake action: Extract `fashion-search.ts:rankHits` into `packages/server/src/core/ranking.ts`; expose `CollectionSearchDef.rankingPolicy` on core `search()` (RFC C13). Apply availability bury, recency, and any merchant boosts on min-max- or rank-normalized RRF scores — not `score -= 2` on raw RRF (~0.0–0.05).
- Why / caveat: DoorDash personalizes price sensitivity per user; samesake has no order-history tower. Still applies for availability bury, recency nudges, and merchant/collection boosts that already exist in the fashion facade — the fix is scale commensurability, not copying their price-sensitivity model.

### L5: Hierarchical narrowing before LLM calls in enrich/NLQ  [maps: NEW]
- DoorDash evidence: Hierarchical RAG uses category trees + structured retrieval to shrink LLM context before generation (Figure 4); Semantic IDs encode catalog hierarchy for precise free-text retrieval without brute-force catalog prompts.
- Samesake action: (1) In enrich stage 2 `extract`, pass only the stage-1 `classify` output (category/type/gender) as structured context — never re-describe the full attribute schema per call. (2) In NLQ (`search` query rewrite), resolve category/gender/price filters first, then rewrite within that slice. (3) Longer term: consider a compact categorical "semantic id" space segment (beyond current one-hot category space) if catalog grows beyond single-retailer scale.
- Why / caveat: samesake's catalog is orders-of-magnitude smaller than DoorDash's multi-vertical millions-of-SKU corpus, so full hierarchical RAG is overkill today. The pattern — structured pre-filter → smaller LLM context — reduces enrich cost and hallucination rate on long-tail attrs (`material`, `fit`) without new infra.

## Applicability caveats
- **No actionable model/eval specifics.** The post names no embedding dims, losses, training data volumes, or offline metrics — it is a KDD workshop recap, not a reproducible recipe. Do not infer architecture details beyond what is stated.
- **Behavioral personalization doesn't transfer.** Two-tower models on order histories, price-sensitivity estimation, co-purchase novelty, cross-vertical restaurant→retail graphs, and the Deals Generation Engine all require transaction-scale behavioral data samesake doesn't have and shouldn't build for a single-retailer visual search MVP.
- **Learned rankers vs BYO rerank.** DoorDash's MTML MoE ranker is a fleet-scale production system; samesake's provider-agnostic `rerank`/`generate` contract (RFC non-goal: "a learned ranker") means the lesson is *stage separation*, not "train MoE."
- **Multi-surface MoE is irrelevant.** Per-surface expert specialization (home carousel vs checkout aisle vs category page) has no samesake equivalent — one search API, one fashion vertical.
- **"Semantic IDs" are aspirational here.** DoorDash describes them as a shared hierarchy-encoding layer; the post gives no training procedure or ID format. Treat as directional (compact categorical retrieval) rather than a spec to implement verbatim.
```
