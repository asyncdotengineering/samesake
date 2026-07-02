# How we Designed Road Distances in DoorDash Search
URL: https://careersatdoordash.com/blog/how-we-designed-road-distances-in-doordash-search-2/

## Key mechanisms
- **Isochrone replaces haversine for eligibility, not ranking.** They compute a travel-time polygon (not a radius circle) because topology (mountains, lakes, bridges) makes straight-line distance a bad proxy for deliverability; Figure 1 vs Figure 6 shows a 9-mile circle vs a road-following isochrone for the same address.
- **Offline precompute stack:** custom Galton fork → OSRM travel times from a grid around `(lat,lng)` → drop grid points exceeding target travel time → concave hull (`concaveman`) → GeoJSON isochrone (Figure 5 offline path).
- **Cache keyed by coarse location, not exact coordinates:** DynamoDB stores isochrones keyed by **geohash precision 7** (~0.076 km error); millions of entries, **<10 ms** lookup; coordinates within a cell share one isochrone.
- **Cold-cache async + explicit degraded fallback:** on cache miss the service launches an async generation job and returns **null**; online search falls back to **straight-line distance with a tighter radius** (not the full isochrone radius). Subsequent requests hit the warmed cache.
- **Market bootstrap:** new markets run a script to **pre-populate** isochrones for all geohashes before launch so selection is accurate on day one.
- **Online retrieval = hard geometric filter in the index, not a score feature:** isochrone → Elasticsearch `geoshape` polygon query; stores indexed as `geo_point` with prefix-tree geo index; intersection returns the candidate set **before** any ranking (Figure 5 online steps 1–5). District-specific, configurable travel-time parameters support selection experiments.
- **Session-pinned selection mode:** when fallback activates, the backend **persists at session level** whether the consumer is on isochrone vs straight-line (and which parameters), so browsing stays consistent within a session.

## Learnings for samesake

### L1: Hard eligibility belongs in filters/gates, not embeddings or raw RRF boosts  [maps: G2 | G7 | embedding hygiene]
- **DoorDash evidence:** Deliverability is enforced as an Elasticsearch **geo intersection** (polygon contains store point) upstream of ranking; straight-line is only an explicit, tighter fallback—not blended into relevance scores.
- **Samesake action:** Keep gender, category, price, color, material, fit, brand as **NLQ hard filters + categorical/price spaces** (REQ-11b); wire **`gate`** in `PipelineDef` (`fashion.ts`) to quarantine non-apparel / `category === "other"` / `confidence < FASHION_CONFIDENCE_FLOOR`; enforce **`pipeline_status = 'ready'`** at candidate selection in `search.ts` (REQ-6b) so ineligible rows never enter FTS/cosine/spaces. Promote availability/business boosts to **normalized post-RRF hook** in core `search()` (G7), not additive constants on raw RRF.
- **Why / caveat:** Same separation-of-concerns pattern—structural “can this appear?” vs “how good is the match?”—applies directly to fashion filters and quarantine. No geo layer exists; don’t invent one. The win is stopping attribute-bleed in `embed_doc` and unprincipled score mixing.

### L2: Expensive derived state = offline precompute + keyed cache + async warm, never inline on the query path  [maps: G1 | G6 | NEW]
- **DoorDash evidence:** Isochrones are computed offline (Galton/OSRM), stored in DynamoDB, fetched in <10 ms; cache miss triggers **async backfill**, not synchronous full routing on the search request.
- **Samesake action:** Treat **enrich**, **image embed**, and **`revalidateImages`** as the offline plane: scheduled conditional-GET/`pHash` pass (`revalidate-images.ts`, REQ-2/3c) resets `indexed_at`/`enriched_at`; **`stageCacheKey`** must include `image_etag`/`pHash` (REQ-3b/M1) so re-enrich doesn’t serve stale vision output; add **`retryFailed`** + `pipeline_status`/`attempt_count`/`next_attempt_at` (G6) instead of silent `enriched_at IS NULL` or zero-vector visual segments (REQ-18b/M5). Optional: catalog bootstrap script (analogous to market isochrone pre-population) that runs enrich→index for a new collection before traffic.
- **Why / caveat:** samesake’s “heavy geometry” is multimodal index state, not road networks—but the **serve-from-cache, warm-async, track-failures** pattern is directly portable. At single-retailer scale you won’t need millions of keys; you still need **invalidation correctness** (G1) more than massive precompute.

### L3: Degraded mode must be explicit, bounded, and session-consistent—never silent corruption  [maps: G3 | G6 | NEW]
- **DoorDash evidence:** Missing isochrone → **documented** fallback (tighter straight-line), not pretending the full polygon exists; **session persistence** of which selection logic is active prevents flip-flopping mid-browse.
- **Samesake action:** Eliminate silent degradations called out in the RFC: no **`data.title`** fallback when `compose` is declared (REQ-11/`embed-index.ts`); no zero-vector index on image-fetch failure (REQ-18b); **`markIndexSkipped`** must null `space_vec` (M6). Surface mode in **`explain`**: which channels fired, whether rerank ran, whether row was `quarantined`/`failed`. For search, if rerank is unavailable, keep **RRF-only** as the declared default (G4)—don’t scrape weaker text without logging.
- **Why / caveat:** DoorDash accepts **intentionally looser** geo selection on cold cache; samesake should accept **fewer/shallower results**, not wrong vectors or title-only embeddings. Session pinning matters less for stateless product search unless you add conversational NLQ sessions—then pin filter interpretation the same way.

### L4: Coarsen cache keys when precision loss is cheaper than per-request exactness  [maps: G1 | NEW]
- **DoorDash evidence:** Geohash-7 (~76 m) buckets many nearby addresses into one isochrone; error deemed acceptable vs per-coordinate storage/compute.
- **Samesake action:** When CDN metadata is missing, bucket **`stageCacheKey`** and **`content_hash`** on **`pHash`** hamming distance or quantized perceptual bucket (REQ-3c), not only raw URL—mirroring “one cell, many inputs.” Document acceptable false-share rate (near-duplicate image swap) vs false-miss cost (full re-enrich). Do **not** coarsen **`embed_doc`** text or filter enums the same way; only invalidation/cache keys.
- **Why / caveat:** Fashion SKUs are not geo cells, but CDN-stable URLs with changing bytes are the analogous “many requests, one wrong cached enrichment” failure—exactly G1+M1. Coarsening embeddings would harm recall; coarsening **invalidation keys** is appropriate.

## Applicability caveats
- **No ML, no ranking, no text retrieval:** The post is 2017 geo-filtering infrastructure (Galton/OSRM, Elasticsearch geo-shape). It does not cover embeddings, LLM enrichment, reranking, or RRF—so nothing transfers to G4/G5 reranker design or embedding hygiene beyond the generic “filter before rank” principle.
- **No geo/delivery domain:** samesake is single-vertical fashion product search; there is no consumer location, travel time, or supply-radius constraint to implement as an isochrone analog.
- **Different index engine:** DoorDash’s mechanism depends on Elasticsearch prefix-tree geo queries; samesake uses Postgres + pgvector + FTS—eligibility must stay SQL/`WHERE` filters and `pipeline_status`, not geoshape queries.
- **Scale asymmetry:** Millions of geohash cells and market-wide bootstrap scripts are overkill for one retailer catalog; adopt the **invalidation + async warm + explicit fallback** ideas, not the storage/compute footprint.
