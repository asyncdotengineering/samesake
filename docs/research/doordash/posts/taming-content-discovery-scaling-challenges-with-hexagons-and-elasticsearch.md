```
# Taming Content Discovery Scaling Challenges with Hexagons and Elasticsearch
URL: https://careersatdoordash.com/blog/taming-content-discovery-scaling-challenges-with-hexagons-and-elasticsearch/

## Key mechanisms
- **Per-entity fan-out on eligibility fetch:** Campaigns are stored/configured at per-store granularity; Discovery asks Campaign Service for every store in a consumer's deliverable radius (thousands in LA/NYC), causing Campaign→Cassandra fan-out at app-open (Figure 5). Load scales as **T × V × S × C** (Traffic × Verticals × Stores × Campaigns).
- **Batching as a partial fix:** Calls batched to send *X* stores at a time with an empirically tuned batch size; reduced app-side load but did not solve DB fan-out or long-term growth.
- **H3 hex cardinality reduction:** Chose **H3** over S2/Geohash after API/circle-fill testing; stores grouped into hex cells instead of fetched individually. PoC: **~500×** fan-out reduction (non-dense), **~200×** (dense). Empirical optimum: **H3 resolution 9** (balance of approximation vs. compute).
- **Push filters to the retrieval engine:** Moved from "fetch all campaigns → filter in memory" to **Elasticsearch** with a **denormalized campaign index** filtered at query time on geohash, start/end dates, time-of-day, experience, placement type, etc. Cassandra kept for point lookups; ES chosen because multi-key filtering is its strength. Claimed **~50%** fewer campaigns fetched online; ES **boosting** used for business-priority campaigns.
- **Campaign object = declarative eligibility rules:** JSON campaigns encode limitations (active dates, experience, store memberships, user criteria, placements/sort_order/experiment_name) — eligibility is data-driven, not hardcoded in the Discovery service.
- **Stated future direction (not built):** hierarchical/dynamic H3 resolution by market density; tiered offline/online storage; **first-pass ranker** to shrink store/campaign candidates before expensive online evaluation (e.g., user↔campaign relevancy scores in dense SF).

## Learnings for samesake
### L1: Push eligibility to the index/query layer, not post-fetch memory  [maps: G2 | G7 | N/A]
- DoorDash evidence: Their biggest win was stopping "fetch everything, filter in app memory" — denormalizing campaign eligibility into Elasticsearch and filtering on geohash/dates/placement at retrieval cut fetched volume ~50%.
- Samesake action: Treat `pipeline_status`, availability, and NLQ hard filters (price, color, gender, category) as **SQL predicates in every channel's candidate query** in `packages/server/src/core/search.ts` (REQ-6b), not as post-RRF cleanup. For G7, index availability/newness/business signals at `embed-index.ts` time and consume them in the core `rankingPolicy` hook — retire query-time scraping in `fashion-search.ts:138-173`.
- Why / caveat: Same architectural move (eligibility metadata lives with the indexed row) at samesake's SKU scale (~10³–10⁵), not DoorDash's store×campaign cardinality. No ES migration needed — Postgres + generated `fts` + HNSW already play the "filter-at-retrieval" role.

### L2: Reduce candidate cardinality before the expensive stage  [maps: G4 | NEW | N/A]
- DoorDash evidence: H3 hex grouping cut fan-out 200–500×; their roadmap explicitly names a **first-pass ranker** to fetch a smaller, more relevant campaign subset in dense markets instead of thousands online.
- Samesake action: Formalize samesake's existing two-stage shape — multi-channel retrieval → **RRF fusion → rerank pool (50)** — as intentional cardinality control. Before expanding `RERANK_POOL` or adding channels, benchmark on `apps/playground/lib/search-relevance.test.ts` / fashion eval configs: measure latency vs. nDCG when pool shrinks (analogous to picking H3 res 9). Wire G4 default reranker (`fashionRerank`) as the mandatory second stage for vague-intent queries, not an optional add-on.
- Why / caveat: samesake has no geo fan-out; the analog is **SKU × channels × rerank cost**, not stores × campaigns. Gains are query-latency and rerank quality, not Cassandra QPS.

### L3: Empirically tune "resolution" thresholds — don't ship constants from intuition  [maps: NEW | G7 | N/A]
- DoorDash evidence: H3 resolution level, batch size, and ES-vs-memory split were chosen via **real-time PoC benchmarking** with reported multipliers (500×/200×/50%), not theory.
- Samesake action: Before locking RFC defaults (`FASHION_CONFIDENCE_FLOOR=0.4`, error-rate abort 25%, G7 boost weights), run a small grid on the fashion eval suite: sweep confidence floor vs. quarantine rate and search recall; sweep normalized boost weights vs. rank stability. Document chosen values in `templates/fashion.ts` with the eval set that justified them.
- Why / caveat: Directly transferable discipline; samesake's "resolution knobs" are confidence gates and boost weights, not hex size. At single-vertical scale this is hours of eval, not a production PoC fleet.

### L4: Batching/loop retries are a stopgap; durable pipeline state is the structural fix  [maps: G6 | N/A]
- DoorDash evidence: Batching reduced app load but **failed long-term** under growing T×V×S×C; the durable fix was restructuring what you fetch (H3 + ES-filtered index), not bigger batches.
- Samesake action: Implement G6 (`pipeline_status`, `attempt_count`, `last_error`, `next_attempt_at`, `retryFailed`, error-rate abort in `enrich-pipeline.ts` / new `core/retry.ts`) and delete consumer hand-loops like `for (i<10) { enrich() }` in `examples/fashion-search/spike-avirate.ts`. Treat M5 (image-fetch failure → `failed`, not zero-vector index) as the same class of bug DoorDash had — silent corruption instead of surfaced failure.
- Why / caveat: samesake's enrich/index fan-out is row-parallel LLM+embed cost, not millions of Cassandra reads; G6 matters for **operability and silent-failure prevention**, not infra cost at DoorDash scale.

## Applicability caveats
- **Not a search/relevance post:** No embeddings, dense retrieval, reranking, textualization, or eval methodology — zero direct guidance for enrich→index→search quality (G1, G3, G5, embedding hygiene).
- **Geospatial grouping is irrelevant:** H3 hexes solve delivery-radius store grouping; a single-retailer fashion catalog has no geo fan-out equivalent.
- **Different system role:** Elasticsearch here is a **campaign eligibility CMS/index**, not a vector product search engine; samesake's Postgres+pgvector stack already covers a different problem.
- **Scale mismatch:** Millions of DB QPS and 75% K8s cost cuts reflect marketplace discovery at national scale; samesake's bottleneck is enrichment quality and pipeline integrity, not campaign-service fan-out.
- **Honest bottom line:** Two durable ideas transfer — **filter at retrieval** and **cardinality reduction before expensive stages** — both largely already implicit in samesake's RRF+rerank design and partially addressed by the RFC (G2/G6/G7). Treat this as ops/architecture validation, not a relevance playbook.
```
