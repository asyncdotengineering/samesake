```
# Building a Gigascale ML Feature Store with Redis, Binary Serialization, String Hashing, and Compression
URL: https://careersatdoordash.com/blog/building-a-gigascale-ml-feature-store-with-redis/

## Key mechanisms
- **Gigascale feature-store requirements:** billions of feature–value pairs; tens of millions of reads/sec driven by ~1M predictions/sec × dozens of features each; nightly full batch refresh plus ~0.1% realtime writes; persistence for recovery; batch **random** multi-key reads per request (~1,000 lookups/prediction per Figure 4 caption).
- **Store selection via YCSB:** Docker benchmark of Redis 3.2, Cassandra, CockroachDB 20.1, ScyllaDB, YugabyteDB; workloads 100% batch-read and 95% read; **10,000 ops × batch size 1,000**; key sizes from production averages, **value sizes from a production histogram** (`fieldlengthhistogram`); fixed **125 ops/sec** for fair CPU comparison (Table 2 / Figure 1: Redis lowest read latency; <½ CockroachDB CPU at matched throughput).
- **Batch-read implementation:** SQL `WHERE key IN (...)`; Redis **pipelining**; Cassandra `executeAsync` — optimized for many unrelated keys per request, not sequential scans.
- **Redis hash colocation (largest win):** migrate `SET feature_for_entity` → `HSET entity_id field value`; reads become **`HMGET entity_id f1 f2 …`** — one command/entity vs many GETs; fields colocated on one cluster node (Table 4 / Figure 2: **>40% read latency drop**, **~5× CPU efficiency**; Table 5: 700.2 MiB → 422 MiB for 1M records before compression).
- **Type-specific value encoding (Table 3):** **Floats → string** (zeros as `'0'`, cheaper than binary when skewed sparse); **embeddings → protobuf bytes, explicitly not compressed** (high entropy); **int lists → protobuf + Snappy** (repetition compresses well; Snappy beats LZ4 on their 1M-record bench: 377 MiB vs 397.5 MiB, **1.9 ms vs 6.5 ms** deserialize for 1,000 lookups).
- **Feature-name compaction:** verbose names (~27 B, e.g. `daf_cs_p6m_consumer2vec_emb`) → **xxHash32(field_name)** as hash field keys (~15% extra memory on 1M sample; no measured CPU overhead).
- **Production rollup (Figure 3 / Figure 4):** ~298 GB → ~112 GB RAM per **billion** features; ~208 → ~72 vCPUs per **10M reads/sec**; Redis read latency **−40%**, end-to-end feature-store API **−15%** (deserialization included).
- **Explicit non-optimization:** TTL only at hash top-level (`entity_id`), not per-field; **future work:** exploit **sparse** feature matrices for further compaction.

## Learnings for samesake
### L1: Treat embeddings as incompressible, high-entropy blobs  [maps: NEW | embedding hygiene]
- DoorDash evidence: Table 3 + prose — embedding vectors stored as protobuf bytes; **compression skipped** because embeddings are high-entropy and yielded no gain (they cite entropy/compression literature).
- Samesake action: If/when you add a hot cache for index artifacts (stage-cache spill, edge cache of `embedding`/`space_vec` segments, or a Redis layer in front of Postgres), **store float vectors raw** (pgvector/binary/protobuf) and **do not Snappy/LZ4 them**; apply compression only to sparse, repetitive payloads (e.g. cached FTS token lists, int-ID histories). Document this in any cache module alongside `stage-cache.ts`.
- Why / caveat: Today vectors live in Postgres/pgvector — low immediate payoff. Becomes relevant if G6 scale or sub-ms serving pushes derived vectors out of row storage; principle still guards against cargo-cult “compress everything.”

### L2: Colocate all per-SKU derived text/vectors at write time — mirror Redis-hash “one HMGET per entity”  [maps: G3 | G5]
- DoorDash evidence: Biggest single gain was restructuring flat KV → **one hash per entity** so a prediction’s ~1,000 features arrive via **one HMGET** per entity, not scattered keys (Table 5: hashes alone cut memory ~40% and latency ~58% before compression).
- Samesake action: RFC already targets this — `compose` in `enrichOne` (`enrich-pipeline.ts`) must persist **`embed_doc` + `rerank_doc` inside `enriched` JSONB** before `enriched_at`; `search.ts` rerank must read `enriched.rerank_doc` only (REQ-13), never rescrape `title`. Extend the same colocation rule to index outputs: row must hold **`doc`, `embedding`, `space_vec` together** or be marked failed/quarantined (REQ-5b, M5/M6) — partial rows are the Postgres analogue of scattered Redis keys.
- Why / caveat: Postgres already colocates by row; the leak is **logical** (skippable compose, ad-hoc rerank text, zero-vector visual segment). Fix is pipeline integrity, not a new datastore.

### L3: Heterogeneous fields need heterogeneous encoding — parallel to embed_doc vs filters vs rerank_doc  [maps: G3 | embedding hygiene (REQ-11b)]
- DoorDash evidence: One-size serialization failed — floats as strings when sparse, lists compressed, embeddings uncompressed (Table 3); unified JSON would have wasted CPU or bytes.
- Samesake action: Enforce REQ-11b in `composeFashionEmbedDoc` (`templates/fashion.ts`): **dense embed_doc** = compositional text only (`search_document`, occasions, styles, details); **hard low-cardinality attrs** (`category`, `gender`, `colors`, `material`, `fit`, `brand`) stay in filters/categorical spaces/boosts; **`rerank_doc`** = verbose, attribute-dense string for cross-encoder (opposite density goal from embed_doc). Same entity, three representations — like DoorDash’s per-type Redis value column.
- Why / caveat: Directly reduces attribute-bleed the RFC calls out; DoorDash’s evidence supports *separating* dense vectors from exact-match categoricals, not merging them for serving efficiency.

### L4: Benchmark and tune with production-shaped cardinality, and measure optimizations incrementally  [maps: NEW]
- DoorDash evidence: YCSB seeded with **production value-size histogram**; benchmark mimicked **100 keys × 10 fields** ≈ real 1,000-feature requests; they report **per-technique** deltas (hashes >> compression >> xxHash) and note production CPU differs from YCSB because **query-key distribution ≠ stored-key distribution**.
- Samesake action: For search/index tuning (HNSW ef, RRF channel weights, `FASHION_CONFIDENCE_FLOOR`, rerank pool size), build eval harnesses (`search-relevance.ts`, fashion smokes) using **catalog histograms** — SKU count, `% quarantined`, embed_doc length, image failure rate, vague vs exact query mix — not uniform synthetic catalogs. When landing RFC chunks (C6/C12/C13), report **isolated** lift (compose-only, rerank-only, normalized boost-only) before combined runs.
- Why / caveat: Fashion vertical is tiny vs DoorDash; absolute latencies don’t transfer, but **workload-shaped benchmarking** prevents overfitting to demo catalogs.

### L5: Keep expensive freshness off the query path — batch refresh + cheap validators  [maps: G1 | G6]
- DoorDash evidence: **Nightly full feature refresh**; realtime writes ≈ **0.1% of reads**; read latency budget dominates (ms-scale inference).
- Samesake action: Align `revalidateImages` (`revalidate-images.ts`, REQ-2) and `retryFailed` (REQ-17) as **scheduled, bounded batch passes** with conditional GET / stored `image_etag` / pHash fallback (REQ-3c) — not inline on every `search()`. Pair with G6 **`pipeline_status`/`next_attempt_at`** so index/enrich failures don’t block search threads. Writes loose, reads strict — same asymmetry DoorDash exploits.
- Why / caveat: Catalog sizes are orders of magnitude smaller; still avoids turning G1 correctness work into search latency regressions.

## Applicability caveats
- **Wrong problem domain:** This is an **online ML inference feature store** (consumer/merchant features for ranking models), not a **product retrieval/search** stack. Samesake’s core loop (LLM enrich → pgvector + FTS + RRF → optional rerank) has no analogue to “1,000 unrelated feature lookups per prediction.”
- **Wrong storage layer:** DoorDash’s conclusions (Redis in-memory, ElastiCache, HMGET pipelining) **do not argue for replacing Postgres/pgvector** at samesake’s scale; CPU/memory wins are for **billions of KV features and 10M+ RPS**, not thousands–millions of SKUs.
- **No retrieval/ranking ML:** Post says nothing about embeddings for search, re-ranking, NLQ, confidence gating, or multimodal fusion — so it does **not** inform G4 default reranker choice, RRF weighting (G7), or enrich prompt design.
- **Serialization specifics are cache-tier only:** xxHash feature names and Snappy int-lists matter if you add a Redis/feature-cache; they are **not** actionable inside current `enriched` JSONB + pgvector schema without new infrastructure.
- **Honest bottom line:** Two durable transfers — (1) **don’t compress embeddings**, (2) **colocate + type-split serialized artifacts per entity** — plus benchmarking/freshness discipline. The Redis/gigascale KV story is otherwise **infra porn** for a single-vertical fashion search engine on Postgres; don’t justify Redis from this post alone.
```
