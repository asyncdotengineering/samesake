# Using CockroachDB to Reduce Feature Store Costs by 75%
URL: https://careersatdoordash.com/blog/using-cockroachdb-to-reduce-feature-store-costs-by-75/

## Key mechanisms
- **Redis-at-scale ops pain, not retrieval quality:** >100-node ElastiCache clusters required weekly upscales; blue-green restore + replay + cutover took 2–3 days with off-peak switchovers and occasional AWS instance-type failures — motivation was **cost + operability**, not better ranking.
- **Range-based distributed KV under Postgres SQL:** CockroachDB stores ordered PK intervals (“ranges”) that auto-split on size or hot-query load (Figure 1); new tables start as a **single range on one node**, throttling write throughput until splits redistribute load (Figure 5).
- **Initial schema = one row per (entity, feature_name):** ETL tables flattened to sequential KV rows per entity (Figure 2); high feature cardinality ⇒ many rows/ranges per entity ⇒ write CPU spikes and read-cache pollution from writes (Figure 7: quiescent-replica churn ↔ QPS drops).
- **Write-path tuning with measured thresholds:** INSERT batches of **~1000 values/query** pinned cluster CPU and throughput; **~25 values/query × more threads** restored throughput with balanced CPU (Figures 3–4). **Full-row INSERT** (no partial update) hit a “fast path” (~**30% lower CPU**). **Sorted keys within a partition** reduced cross-node fan-out.
- **Production ingest envelope:** **63× m6i.8xlarge**, peak **~2M rows/s** at ~30% CPU, but bursty drops to **<1M rows/s** when CPU hit 50–70%; cost was ~**30% of Redis** before schema fix — not the advertised 75% yet.
- **Condensed entity-centric JSON maps (the big win):** Replaced per-feature rows with `(entity_id, etl_source) → JSONB map of all features from that source** (Figure 8), keeping maps **<1MB** and **avoiding SQL `JSONB` merge** (merge forces a read in the query plan). Result: up to **~300% write throughput** vs baseline (Figure 11), **~50% lower p99.9 read latency** (Figure 12), and for **~700 features/request** reads “similar” to Redis (Figure 13). Final **~75% cost/value-stored** vs Redis; Redis still serves **>50%** of features (low cardinality / read-heavy cases).
- **Serving pattern:** Online ML **feature lookup by entity** at inference time — not search indexing, embeddings, or rank fusion.

## Learnings for samesake
### L1: Colocate derived search text in one entity write — never merge-read  [maps: G3 | G5 | N/A]
- DoorDash evidence: Moving from many `(entity, feature)` rows to one `(entity, source) → JSON map` cut write ops and range fan-out; they explicitly avoided **JSON merge updates** because Cockroach/SQL plans add a read before write.
- Samesake action: Wire `compose` inside `enrichOne` (`enrich-pipeline.ts`) so `embed_doc` + `rerank_doc` land in `enriched` in the **same UPDATE** that sets `enriched_at` / `pipeline_status` (RFC §4.2). Ban the ad-hoc post-enrich compose scripts (`compose-embed.ts`, playground upload paths). At index time, read `$enriched.embed_doc` once; at rerank time, read `$enriched.rerank_doc` — no second “scrape title/description” path (`search.ts:826-831`).
- Why / caveat: Same “group what you fetch together per SKU” principle, but samesake’s unit is a **product row + JSONB**, not a distributed feature store. Fashion catalogs (10⁴–10⁶ SKUs) won’t see CRDB-style range explosion; the win here is **correctness + fewer round trips**, not 75% infra savings.

### L2: Cap enrich/index batch size and sort row keys  [maps: G6 | NEW]
- DoorDash evidence: Large multi-value INSERTs (**1000/query**) created straggler-node bottlenecks under serialized isolation; **~25 values/query** with more workers improved throughput **and** tail stability; **sorting keys within a partition** reduced nodes touched per query.
- Samesake action: In `runEnrichCollection` / `runIndexCollection`, process rows in **bounded chunks (e.g. 25–50)** ordered by `id`, with per-chunk timeouts; surface chunk failures via G6’s `attempt_count` / `last_error` instead of silently skipping (`enrich-pipeline.ts:231-233`). Apply the same pattern to `revalidateImages` (`revalidate-images.ts`) so a full-catalog HEAD pass doesn’t stampede Postgres + CDNs.
- Why / caveat: Directly relevant to **G1 mass re-embed** (content_hash / ETag change) and **G6 retry drains** — smaller, sorted batches reduce lock contention on `c_<collection>` and HNSW index churn. Overkill for steady-state single-retailer ingest, essential for bulk recovery.

### L3: Treat “new table / cold index” as a warmup problem  [maps: G6 | N/A]
- DoorDash evidence: Fresh tables write to a **single range** until auto-split; they pre-split ranges or **throttle writes** until load distributes (Figure 5).
- Samesake action: For greenfield collections or post-RFC backfill (`pipeline_status` migration, C8 content_hash re-hash), don’t run unbounded `index()` in one job — use **`opts.limit` per pass + `next_attempt_at` staggering** (RFC C10) so embedding + HNSW maintenance doesn’t behave like a single-node hotspot. Document a recommended “initial catalog” rate in the fashion template.
- Why / caveat: Postgres/pgvector isn’t range-sharded like CRDB, but **bulk first-time index** still creates analogous pain: long transactions, bloated HNSW graphs, and spiky embed API usage. Fashion scale makes this manageable with scheduling discipline, not cluster pre-splitting.

### L4: Prefer full-row replace over partial patch on pipeline state  [maps: G2 | G6 | NEW]
- DoorDash evidence: **Insert entire row** (not a subset of columns) enabled a fast path (~30% CPU savings); partial updates were avoided where they triggered read-modify-write plans.
- Samesake action: When `gate` flips a row to `quarantined`, RFC already requires **one UPDATE** that nulls `doc`, `embedding`, `space_vec`, and clears `indexed_at` (REQ-5b) — implement as a single statement, not separate nulling passes. On index success, set `doc`, `embedding`, `space_vec`, `indexed_at`, **`pipeline_status='ready'`** together (RFC §4.3). Extend G6 so image-fetch failure never writes a **zero visual segment** then marks indexed (REQ-18b) — that’s DoorDash’s “bad partial write” analogue.
- Why / caveat: At samesake scale this is about **avoiding corrupt partial index state**, not CPU percentage. Strong alignment with RFC blockers M5/M6.

## Applicability caveats
- **Not a search/retrieval post:** No embeddings, ANN, lexical fusion, reranking, NLQ, or offline eval — it’s online **entity feature lookup** for ML inference. Nothing here informs RRF weights, cross-encoder defaults (G4), or embedding hygiene (REQ-11b).
- **Scale mismatch:** DoorDash’s problem space is **10× feature growth**, **2M rows/s**, **63× 32-vCPU nodes**, and Redis-vs-CRDB **$/stored-value**. Samesake is single-vertical Postgres + pgvector for one catalog; the 75% cost story does not justify adopting CockroachDB or a separate online store.
- **Redis still wins their hot path:** They kept **>50% of features on Redis** where reads dominate and cardinality is low — analogous caution for samesake: don’t add Redis/cache layers for “DoorDash did it”; your hot path is **vector + FTS search**, not per-request feature hydration.
- **JSON grouping ≠ better relevance:** Condensing features improved **I/O efficiency**, not model quality. The transferable bit is **storage/write shape**, which the RFC’s `compose`/`gate` hooks already capture — not new ranking signal.
