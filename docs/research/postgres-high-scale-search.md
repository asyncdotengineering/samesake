# Postgres for high-scale search — research + roadmap (task #17)

Status: Ready to inform decisions · Date: 2026-07-01 · Scope: how far samesake's PG-native search
scales, the lexical/BM25 (#11) decision, and what to adopt now vs later. Grounded in 2024–2026
sources (cited at the end); numbers are from vendor/community benchmarks, treat as order-of-magnitude.

## TL;DR (the decisions)

1. **samesake is nowhere near Postgres's scale limits and won't be for a long time.** Launch corpus is
   **~100k+ products** (the 5.5k `fashionparity` set is test data); a *large* single fashion store is
   up to ~1M SKUs. 100k × 1536-dim ≈ **0.6 GB vectors / ~1.2 GB HNSW index** — fits in RAM on a 4–8 GB
   box; even 1M ≈ 6 GB / ~10 GB (fine on 16–32 GB). PG's hard wall (HNSW index outgrowing RAM) is
   ~**10M × 1536-dim (~80–120 GB index)** — ~100× beyond launch. The scaling question is **not**
   sharding/billions; it's "right config for catalog-scale + know the exit."
2. **The only genuine near-term *quality* gap is #11 — the lexical leg (`ts_rank_cd`).** Every source
   (even the pro-Postgres ones) agrees `ts_rank` ranking is weak (no IDF, no length normalization, no
   TF saturation, no efficient top-N). Real BM25 exists in PG (**ParadeDB `pg_search`**, **VectorChord
   `vchord_bm25`**) — but both need `shared_preload_libraries`, i.e. **a Postgres instance we
   control**, and **`pg_search` was dropped from new Neon projects (Mar 2026)**. So #11 is a
   *deployment* decision, which is exactly why it was deferred here rather than hot-fixed.
3. **Free wins available on ANY managed PG today (no infra change):** `halfvec` (2× smaller vectors,
   ~2× faster build, <1% recall loss), **iterative index scans** (pgvector 0.8 — the built-in fix for
   filtered vector search under-returning), **keyset pagination**, and **`setweight` field-weighting**
   to make even `ts_rank` better. Do these first.

## 1. Where samesake actually sits (scale honesty)

| | Launch (~100k) | Large single store (the "1") | PG-native ceiling |
|---|---|---|---|
| Products / vectors | ~100k+ (5.5k is test data) | up to ~1M | HNSW index fits RAM to ~1–5M × 1536-dim; wall ~10M (~80–120 GB) |
| Vector storage (1536-dim fp32) | ~0.6 GB (index ~1.2 GB; ~0.6 GB w/ halfvec) | ~6 GB @ 1M (index ~10 GB) | column ~6 KB/row; index ≈ 1.5–2× |
| Single-node PG comfort | trivial (4–8 GB box) | comfortable (16–32 GB box) | degrades when a single table > ~100–200M rows / working set ≫ RAM |

**Implication:** for one store's catalog, a single tuned Postgres with pgvector HNSW is *comfortable*.
We do **not** need pgvectorscale, VectorChord, Citus, sharding, or read-replica fan-out at this scale.
Chasing billion-vector tech for a fashion catalog is premature scaling. The compounding investment is
**retrieval quality** (BM25 + the eval loops we built), not distributed-systems capacity.

## 2. The lexical / #11 decision — real BM25 in Postgres

**Why `ts_rank_cd` is the wrong tool** (unanimous across ParadeDB, VectorChord, Neon): it's
document-local — no corpus-global stats. It can't tell a rare discriminating term from a common one
(no IDF), doesn't saturate term frequency, doesn't normalize by document length, and **has no
efficient top-N** (must score every matching row before `LIMIT`). Neon measured native top-N ranked
search at **38,797 ms vs 81 ms** for `pg_search` on 10M rows.

**Two real-BM25 options** (both Rust extensions needing `shared_preload_libraries`, both **AGPL-3.0**,
both **NOT installable on stock RDS/Aurora/Cloud SQL/Neon**):

| | **ParadeDB `pg_search`** | **VectorChord `vchord_bm25`** |
|---|---|---|
| Engine | Tantivy (Lucene-class, battle-tested) as a native `USING bm25` index | Custom BM25 + BlockMax-WeakAnd (dynamic pruning) |
| Maturity | **Production-ready**, v2 API, named customers | Self-described "early stages", v0.2.x, ~370★ |
| Features | Broad: fuzzy/typo, faceting, JSON/JSONB, phrase/slop, field boosting, highlighting, aggregation pushdown | Ranking only; tokenizer is a *separate* ext (`pg_tokenizer`); strong multilingual tokenizers |
| Perf | 20–1000× vs native FTS; ~parity with Elasticsearch | ~3× ES QPS headline → **~40% after aligning stopwords/stemmer**; NDCG@10 ~ ES |
| Deploy | ParadeDB distro / Docker / self-host; **dropped from new Neon (Mar 2026)** | `vchord-suite` Docker / self-host; EDB-packaged |

**Recommendation — measure first, then bake-off; no default winner.** (Bias check: much of the
pro-`pg_search` narrative is ParadeDB's own content marketing + a Neon partner post — loud ≠ correct;
and "more features" ≠ "right for a 100k fashion catalog." An earlier draft of this doc leaned ParadeDB
on maturity/content; that lean is not evidence.)

1. **First establish whether the lexical leg is even the bottleneck.** It's 1 of 3 RRF legs, and our
   `gemini-embedding-2` semantic leg already absorbs typos/vocab (the red-team confirmed this). Try the
   **zero-infra mitigations** — `setweight` field-weighting on the `tsvector` (title ≫ tags ≫
   description), `pg_trgm` fuzzy fallback (extension already installed), and RRF leg-reweighting — and
   measure with the golden + red-team suites. These may capture most of the gain at ~zero operational
   cost, on any managed PG.
2. **Only if the eval shows lexical is the limiting factor AND we've committed to controlled-PG
   deployment, run a bake-off on OUR corpus** across `{tuned ts_rank+setweight+trgm, ParadeDB
   pg_search, VectorChord vchord_bm25}`, judged by the eval suites — not vendor blogs.
3. **Honest ParadeDB vs VectorChord trade (unsettled):** ParadeDB = more mature (v2, named customers),
   feature-complete (faceting/JSON/highlight/fuzzy), **but** a heavier dependency (Tantivy embedded,
   deep planner/storage hooks → upgrade/compat risk), BM25-only (still run pgvector separately), AGPL,
   dropped from Neon. VectorChord = leaner, pgvector-native, and a **more coherent single bet for a
   vector-first framework** (one suite: vectors + BM25 + tokenizer, RaBitQ, ~10× updates) — **but**
   earlier-stage, ranking-only, needs the extra `pg_tokenizer` piece, no head-to-head-vs-pg_search
   numbers. Both AGPL-3.0, both need `shared_preload_libraries` (self-host). Decide on our own bake-off.

**Neither ships RRF** — hybrid fusion stays hand-written SQL (which we already do), and RRF should be
re-validated on our catalog (it *can* hurt on some datasets).

**If we stay on Neon/managed PG (no controlled instance):** BM25 is off the table. Mitigations that
*are* available: (a) **`setweight`** the `tsvector` (title ≫ tags ≫ description) — real precision gain,
needs a re-index; (b) lean on the semantic (cosine) leg, which already carries typo/vocab resilience
(our red-team confirmed the embedding leg handles misspellings); (c) `pg_trgm` similarity fallback for
fuzzy matching (extension already installed).

## 3. Vector scaling — adopt now vs later

**Now (works on any managed PG, including Neon; low risk):**
- **`halfvec` (fp16) as the default embedding type.** ~2× smaller storage + index, ~2× faster build,
  **<1% recall loss** on normalized embeddings. Retrofitting later onto millions of vectors is painful
  — adopt from day one. (Also unlocks >2000-dim models if ever needed; plain `vector` HNSW caps at 2000.)
- **Iterative index scans** (`SET hnsw.iterative_scan = relaxed_order`, pgvector 0.8): the built-in fix
  for the classic "HNSW post-filtering returns too few rows" problem — directly relevant since our
  search applies hard filters (gender, price, availability) after vector retrieval.
- **Tune `hnsw.ef_search`** per query (default 40): ~97% recall @ 40, ~99.6% @ 200, at a QPS cost —
  expose it as a knob; keep m=16, ef_construction=200–256.

**Later (only if a tenant reaches multi-million vectors AND we self-host):**
- **pgvectorscale `StreamingDiskANN`** (Timescale, PostgreSQL-licensed): disk-resident index (SSD ≪
  RAM), **28× lower p95 latency / 75% cheaper than Pinecone at 50M × 768-dim**, plus streaming
  post-filter with no recall loss. Requires self-host or Timescale Cloud — **not** on Neon/RDS.
- **VectorChord** (IVF + RaBitQ, AGPL): **~100× faster indexing (100M vectors in <20 min), ~10× update
  throughput vs pgvector HNSW**, scales to 1B. Its thesis — HNSW fits Postgres badly for heavy
  writes/deletes (VACUUM must repair the graph) — is worth remembering if we ever have high catalog
  churn. Self-host only.

**Binary quantization** (16–32× memory cut) is a scale-emergency lever, not for us yet — it needs a
rerank pass and only works for high-dim, bit-diverse vectors.

## 4. Architecture levers + thresholds (for reference; not needed at our scale)

| Lever | Use when | Breaks when | Our status |
|---|---|---|---|
| Vertical + tune + PgBouncer | <500 GB, <200 conns | single table >~100–200M rows | ✅ ample headroom |
| Read replicas (streaming) | read-heavy (90%+ reads), ~seconds-stale OK | writes saturate primary; replica lag → stale results | not needed yet; easy later |
| Connection pooling (PgBouncer txn / **Hyperdrive** / Supavisor) | many serverless clients | pooling ≠ faster queries | **relevant now**: our CF Workers deploy uses Hyperdrive→Neon (cuts cold connect ~6→1 round-trips) |
| Declarative partitioning | one table >100M rows / 50 GB, keyed | queries don't filter on partition key; 1000s of partitions bloat planning | far off; if multi-tenant, partition/RLS by tenant later |
| Sharding (Citus) | multi-tenant SaaS never joined across tenants, high write volume | cross-tenant analytics; N-node ops burden | not needed; avoid until forced |

Proof points: OpenAI serves 800M users on **one primary + ~50 read replicas, no sharding**; Notion
sharded only at ~30M users / multi-TB tables. We are orders of magnitude away from either.

## 5. The escape hatch (when to move the search leg off Postgres)

Move BM25/vector search to a dedicated engine (OpenSearch / Typesense / vector DB) **only** when a
single tenant crosses: search queries regularly >5 s despite tuning, corpus >~1 TB / multi-million
SKUs with wide rows, **or** sub-second user-facing faceted latency at high concurrency is required.
Pattern: CDC (Debezium) from PG WAL → engine, PG stays source of truth. For samesake this is a
distant, per-large-tenant decision — not a framework default. Owning-your-Postgres is the moat until
then.

## 6. Scale-ceiling estimate for samesake

- **Comfortable on a single tuned Postgres (pgvector HNSW + halfvec):** up to **~1–2M products per
  project** with sub-100 ms warm search, no exotic extensions. Covers essentially every fashion store.
- **With BM25 (`pg_search`) on controlled PG:** same corpus range but *Elasticsearch-class lexical
  quality + faceting/highlighting/fuzzy* — the toolkit upgrade, not a scale upgrade.
- **With pgvectorscale/VectorChord (self-host):** tens of millions of vectors per node — only relevant
  if samesake becomes multi-tenant-at-scale on shared infra.
- **Escape hatch:** >~a few million SKUs/tenant with sub-second faceted UX → external engine.

## 7. Phased roadmap

- **P-now (any managed PG, no infra change, lean):** default embeddings to `halfvec`; enable iterative
  scans; expose `ef_search`; add `setweight` field-weighting to the FTS leg; keyset pagination for deep
  pages; materialized facet counts where hot. Each gated by the search eval + red-team suites we built.
- **P-next (decide deployment):** choose the search-PG deployment story. If we control it (Fly/EC2/
  ParadeDB Docker) → pilot **`pg_search`** BM25 on the fashionparity corpus, wire it as the lexical leg
  behind the existing RRF, and gate on the golden + red-team evals (this closes #11 *and* powers
  autocomplete/merchandising/highlighting from the earlier gap analysis). If we must stay on Neon →
  ship the `setweight` + trigram-fuzzy mitigations and record BM25 as blocked-on-deployment.
- **P-later (only if pulled by a real large tenant):** self-host + pgvectorscale/VectorChord for
  multi-million vectors, or the external-engine escape hatch. Do the end-state thinking then, not now.

## 8. #11 verdict (the question that triggered this)

`ts_rank_cd` is correctly identified as the weak leg — **but** (a) real BM25 needs a Postgres instance
we control (`shared_preload_libraries`; Neon dropped `pg_search`), so it's a deployment decision, not a
code edit; and (b) at 100k with a strong semantic leg, **we haven't yet proven the lexical leg is the
bottleneck.** So the honest path is: **ship the managed-PG-safe mitigations first** (`setweight` +
`pg_trgm` + RRF leg-reweighting), **measure** with the eval suites, and **only if lexical is confirmed
limiting, run a bake-off** (`tuned ts_rank` vs `pg_search` vs `vchord_bm25`) on our own corpus. No
pre-committed BM25 vendor — ParadeDB and VectorChord are both contenders with real trade-offs, to be
decided by our numbers, not their blogs.

## Sources

Vector scaling: github.com/pgvector/pgvector (0.8.4) · jkatz.github.io/post/postgres/pgvector-scalar-binary-quantization · github.com/timescale/pgvectorscale · tigerdata.com/blog/pgvector-is-now-as-fast-as-pinecone-at-75-less-cost · dbi-services.com/blog/pgvector-a-guide-for-dba-part-2-indexes-update-march-2026 · dev.to/philip_mcclarence_2ef9475/scaling-pgvector-memory-quantization-and-index-build-strategies · blog.vectorchord.ai (VectorChord 1.0).
BM25/lexical: paradedb.com/blog/hybrid-search-in-postgresql-the-missing-manual · paradedb.com/blog/elasticsearch-vs-postgres · neon.com/blog/postgres-full-text-search-vs-elasticsearch · blog.vectorchord.ai/bringing-searchengine-ranking-to-postgresql-with-vectorchordbm25 · github.com/tensorchord/VectorChord-bm25 · docs.paradedb.com/deploy/self-hosted/extension · neon.com/docs/extensions/pg_search.
Architecture: velodb.io/glossary/ways-to-scale-postgresql · tinybird.co/blog/postgresql-horizontal-scaling · citusdata.com/blog/2017/05/10/scaling-connections-in-postgres · crunchydata.com/blog/citus-the-misunderstood-postgres-extension · citusdata.com/blog/2025/02/06/distribute-postgresql-17-with-citus-13 · neon.com/blog/hyperdrive-neon-faq · supabase.com/blog/supavisor-postgres-connection-pooler · stacksync.com/blog/keyset-cursors-postgres-pagination · gajus.medium.com/lessons-learned-scaling-postgresql-database-to-1-2bn-records-month · openai.com/index/scaling-postgresql · notion.com/blog/sharding-postgres-at-notion.
