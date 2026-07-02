```
# Building Faster Indexing with Apache Kafka and Elasticsearch
URL: https://careersatdoordash.com/blog/open-source-search-indexing/

## Key mechanisms
- **Legacy pain was indexing latency, not retrieval quality**: full-catalog backfill took up to **1–2 weeks**; incremental updates could lag ~**1 week** before appearing in search — making index freshness the bottleneck for experimentation and correctness.
- **Four-bucket architecture (Figure 1)**: Postgres/Cassandra/Snowflake **sources** → **Kafka** (message queue + log-compacted, indefinitely retained topics) → **Flink Assemblers** (hydrate + transform) + **Flink Sinks** (schema-shape + write) → **Elasticsearch** search destination.
- **Application-level CDC, not Debezium**: Aurora/Postgres Debezium was rejected after storage-team perf tests (too much overhead on the online DB). Instead, **save hooks** in the owning service emit change events to Kafka on every CRUD write.
- **ID-only events + hydrate-at-assemble for consistency**: Kafka messages carry **only entity IDs**, not field values — avoiding `{store_id:10, is_active=true}` vs `false` races from distributed app instances. The Flink **Assembler re-fetches authoritative entity state via REST** before building the search document.
- **Assembler backpressure optimizations**: **windowed dedupe** (same entity within a time window → one REST call) plus **aggregation** (e.g., collect item updates for a store over **10 seconds**, then one bulk REST call per store).
- **Two ingestion modes with different load shapes**: (1) **real-time CDC stream** for operator/menu edits; (2) **batched Flink source** for nightly **ETL/ML model outputs** (scores, tags in Snowflake) — explicitly **not** routed through the CDC path because nightly ETL would create write spikes; batch size is tuned so downstream ES doesn't get overwhelmed.
- **Sink write path**: one **Kafka consumer group per ES index** (per-index offsets); `DocumentProcessor` maps hydrated events to index schema; **Flink Elasticsearch connector** with built-in **rate limiting/throttling**; **time-window bulk indexing**; failures → **log + dead-letter queue** for later replay.
- **Fast backfill reuses the online hydration path**: bootstrap **ID tables** in the data warehouse; a Flink source streams all IDs through the **same Assembler hydration logic** as incremental indexing. During bootstrap, the **incremental indexer is scaled down** to prevent stale incremental writes racing ahead of the bulk pass; incremental is scaled back up once offsets are recent.
- **Forced reindex**: publish a single **entity ID** to the online-assembler topic to trigger full re-hydration → reindex; messages carry **unique trace tags** for end-to-end debugging.
- **Reported results**: store catalog backfill **1 week → 6.5 h**; item catalog **2 weeks → 6.5 h**; reindex of existing entities **1 week → 2 h**.

## Learnings for samesake
### L1: Assemble search documents from source-of-truth at index time, not from stale change payloads  [maps: G3 | G6]
- DoorDash evidence: change events carry **IDs only**; the Assembler **re-reads the entity via REST** and amalgamates the final ES document — explicitly to fix multi-instance write races and stale partial updates.
- Samesake action: wire the RFC's `compose`/`gate` inside `enrichOne` (`enrich-pipeline.ts`) so textualization and gating always run on the **current Postgres row** (`data` + freshly merged `enriched`), never on a consumer-hand-rolled intermediate. For `index`, re-resolve `$enriched.embed_doc` from persisted `enriched` JSONB at embed time — do not accept pre-composed strings passed out-of-band (delete playground `compose-embed.ts` call sites per RFC C7).
- Why / caveat: samesake has no distributed-writer race, but the same failure mode exists today — skipped compose + title fallback is silently serving a **stale/wrong representation**. The DoorDash pattern validates the RFC's "unskippable assembly step" design, not a need for REST microservices.

### L2: Separate hot incremental path from batched slow enrichment with different throttling  [maps: G6 | NEW]
- DoorDash evidence: **CDC stream** for operator edits vs **custom batched Flink source** for nightly ML/ETL table reloads; ETL deliberately avoids the CDC pipeline because bulk nightly updates would spike writes; batch size is chosen to protect Elasticsearch.
- Samesake action: treat **LLM enrich** (`runEnrichCollection`) and **cheap re-index paths** (`revalidateImages` → null `indexed_at`; image-only re-embed) as distinct schedulable jobs with separate batch sizes and rate limits in G6's `retryFailed`/run abort logic. Enrich runs should support **row-level dedupe within a window** (same `id` touched twice in one batch → one LLM pass), mirroring Assembler windowed dedupe.
- Why / caveat: fashion catalog is orders of magnitude smaller than DoorDash, so you won't need Kafka — but enrich is your **ETL spike** (LLM vision), and running it with the same cadence/throttling as vector re-embed will either waste money or stall freshness. G1's scheduled `revalidateImages` is the cheap CDC analogue; full re-enrich is the expensive nightly ETL analogue.

### L3: First-class forced reindex-by-ID with trace correlation  [maps: G1 | G6]
- DoorDash evidence: operators send a **single entity ID** into the online indexing topic; messages are **tagged** so each stage's handling is traceable, giving both a rebuild lever and a correctness audit trail when upstream events were dropped or a downstream call timed out.
- Samesake action: add a matcher method (sibling to `retryFailed` in RFC C10) — e.g. `reindexRows(project, collection, ids[], { traceId })` — that resets `pipeline_status`/`next_attempt_at` for those IDs and runs enrich→index with the `traceId` propagated through `ctx.observability` on every stage. This complements G1's `revalidateImages` (detect drift) and G6's automatic retry (drain failures).
- Why / caveat: at samesake scale you can already "fix" a row by nulling timestamps in SQL, but that's untraced and error-prone. DoorDash's point is operability: stale-index complaints need a **one-ID surgical rebuild**, not a full collection re-run.

### L4: Index failures must be durable and replayable, not counted-and-dropped  [maps: G6]
- DoorDash evidence: any ES bulk-index failure is **logged and written to a dead-letter queue** for later processing — failures are first-class persisted artifacts, not run-summary counters.
- Samesake action: implement RFC REQ-16/17/18 so a failed enrich/index attempt sets `pipeline_status='failed'`, `last_error`, `attempt_count`, `next_attempt_at` — and critically, **never marks the row indexed** (fixes M5: image-fetch failure must not write a zero vector + `indexed_at`). Expose failed/dead rows via the existing review/query surface; `retryFailed` is samesake's DLQ consumer. Remove the current `failed++` then discard pattern in `enrich-pipeline.ts:231-233`.
- Why / caveat: Postgres row state replaces Kafka DLQ — RFC already chose in-table durability. The learning is behavioral: DoorDash treats indexing as a **reliable delivery problem**; samesake currently treats enrich failures as telemetry.

### L5: Mutex full bootstrap re-embeds against incremental indexing  [maps: NEW]
- DoorDash evidence: during catalog bootstrap/backfill, the **incremental indexer is scaled down** until bootstrap completes and Kafka offsets are recent — preventing incremental stale writes from landing in ES mid-backfill.
- Samesake action: when rolling out REQ-11b embed_doc hygiene or the compose/gate seam (mass re-enrich/re-embed), add a collection-level **maintenance mode** or job lock so `runIndexCollection`/`runEnrichCollection` incremental passes don't interleave rows with old `embed_doc` composition alongside newly composed rows in the same HNSW index. At minimum, gate search on `pipeline_status='ready'` (RFC REQ-6b) until backfill completes.
- Why / caveat: a fashion catalog re-embed may take minutes, not 6.5 hours — but mixed-schema vectors in one index (title-only fallback rows next to composed rows) is exactly the silent quality regression the RFC is closing.

## Applicability caveats
- **No retrieval/ML signal here**: the post covers indexing **infra** (Kafka/Flink/ES throughput, CDC, backfill). Zero mention of embeddings, reranking, query understanding, or eval — nothing actionable for G4/G5/G7 or embedding hygiene.
- **Stack mismatch**: samesake is Postgres + pgvector in-process with pg-boss-style jobs, not a separate Elasticsearch cluster fed by log-compacted Kafka. Most of Figure 1 (Flink connectors, per-index consumer groups, ES rate limiting) does not transfer literally.
- **Scale mismatch**: DoorDash's win is shrinking **week-long** full-catalog rebuilds; samesake's single-vertical catalog makes full reindex feasible without a warehouse bootstrap table — but the **operational patterns** (forced reindex, DLQ/replay, bootstrap/incremental mutex, hydrate-at-assemble) still apply at smaller scale.
- **Multi-vertical platform framing doesn't apply**: DoorDash built plug-and-play indexing for new business lines; samesake is intentionally single-vertical (fashion) with provider-agnostic hooks — the "vertical team self-service" motivation is irrelevant.
```
