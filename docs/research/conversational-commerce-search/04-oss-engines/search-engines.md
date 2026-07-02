# OSS / Self-Hostable Search & Vector Engines — Prior-Art Dossier

**Scope:** Survey of open-source / self-hostable search and vector engines as *alternatives or components* to **samesake** — a TypeScript-first "search engine compiler" that compiles a typed catalog into a **Postgres + pgvector** hybrid search layer running *in the user's own app* (two containers: Postgres + app; no Redis/Elasticsearch/hosted vector DB). samesake's retrieval is hybrid FTS + cosine ANN over BYO embeddings (+ optional typed "spaces" vectors), fused with **reciprocal-rank fusion (RRF)**; hard filters compile to SQL predicates and gate *before* ranking.

This dossier evaluates each engine on five axes: **(1) hybrid search** (BM25/lexical + vector + fusion), **(2) filtered ANN**, **(3) scaling story**, **(4) license + commercial-use verdict**, **(5) comparison to samesake's in-Postgres approach.** Claims are tagged **PROVEN** (verified from primary docs / source) vs **MARKETED** (vendor claim, not independently confirmed here).

Research date: 2026-06-14.

---

## 0. The central architectural axis

Every engine here sits somewhere on a spectrum from **"a separate search service you operate alongside your DB"** to **"search inside the database you already run."** samesake is at the far "inside Postgres" end, and goes one step further: it's not just an extension, it's a **compiler** that emits the SQL/index layer from a typed catalog declaration.

- **Separate service** (operational tax: another datastore to run, sync, secure, scale): Vespa, OpenSearch, Elasticsearch, Typesense, Meilisearch, Qdrant, Weaviate, Milvus, Marqo.
- **Embedded/in-process library** (no server, file/object-store backed): LanceDB.
- **Inside Postgres** (no second datastore; reuse SQL transactions, joins, RLS, backups): pgvector, pgvectorscale (Tiger/Timescale), ParadeDB pg_search, pg_textsearch (Tiger/Timescale) — and **samesake** itself.

The "inside Postgres" cluster is samesake's direct architectural family. The rest are the engines a team would otherwise bolt on — and the operational and licensing cost of doing so is samesake's core differentiation argument.

---

## 1. Vespa

**What it is.** A search + ML serving engine (Yahoo-origin) that puts text, structured attributes, tensors, and ANN vectors in **one engine and one index**, with multi-phase ranking and a tensor-expression ranking language.

- **Hybrid search — PROVEN.** Native. Vespa builds hybrid rank profiles combining BM25 and vector (HNSW) signals, supporting both linear combination in the first phase and **reciprocal-rank fusion in the global phase**. Source: Vespa hybrid-search tutorial (`docs.vespa.ai/en/learn/tutorials/hybrid-search.html`) and Vespa blog "Improving Zero-Shot Ranking with Vespa Hybrid Search."
- **Filtered ANN — PROVEN.** Filters and ANN run in the same query plan; Vespa's ranking framework lets filters constrain candidate sets natively rather than as a post-filter.
- **Scaling — MARKETED (well-attested).** Vespa is the most battle-tested at very large scale (Yahoo serves it at web scale); designed for distributed, real-time, high-write workloads. This is its strongest selling point relative to the vector-DB crowd.
- **License — PROVEN.** **Apache 2.0.** Verified on the repo: "All the content in this repository is licensed under the Apache 2.0 license" (`github.com/vespa-engine/vespa`). **Commercial use: fully permitted, no copyleft, no SaaS clause.**
- **vs samesake.** Vespa is the "if you outgrow Postgres entirely" answer — the most capable single-engine hybrid system, and the one whose *architecture* (one index for text+tensor+attributes, multi-phase ranking) most resembles what samesake assembles inside Postgres. But it is a heavyweight separate cluster with a steep operational and conceptual learning curve (its own config/ranking DSL). samesake trades Vespa's ceiling for radically lower operational surface (no new datastore) and TypeScript-native ergonomics. **Use Vespa when corpus + QPS exceed what a single Postgres can serve and you have ops capacity; samesake is the opposite bet.**

---

## 2. OpenSearch

**What it is.** AWS's 2021 fork of Elasticsearch 7.10.2 (the last Apache-2.0 release), now governed under the Linux Foundation (OpenSearch Software Foundation, 2024).

- **Hybrid search — PROVEN.** First-class. Hybrid queries combine BM25 (`match`) with k-NN/neural clauses, fused by a **normalization processor** (introduced v2.10) offering `l2`/`min_max` normalization and arithmetic/harmonic/geometric-mean combination; later versions added rank-based combination. Sources: `docs.opensearch.org/latest/vector-search/ai-search/hybrid-search/`, `docs.opensearch.org/latest/search-plugins/search-pipelines/normalization-processor/`. Neural-search plugin GA'd in v2.9.
- **Filtered ANN — PROVEN.** Supports filtered k-NN (efficient/pre-filtering with the Lucene and Faiss engines).
- **Scaling — MARKETED (well-attested).** Distributed, shard/replica model inherited from Elasticsearch; scales horizontally to large corpora; heavier JVM footprint.
- **License — PROVEN.** **Apache 2.0** across projects (engine + neural-search). **Commercial use: fully permitted, including offering it as a service** — this is OpenSearch's entire reason to exist vs Elastic. This is the cleanest "Elasticsearch-class capability without license risk" option.
- **vs samesake.** OpenSearch is the obvious incumbent a fashion-commerce team reaches for: mature hybrid, faceting, analytics. The cost is a JVM cluster to run/tune/sync from the source-of-truth DB, plus dual-write/consistency complexity. samesake's pitch is "you already run Postgres; don't run a second search cluster." OpenSearch wins on raw search-feature breadth and scale; samesake wins on operational simplicity, transactional consistency (search reads see committed catalog state), and typed/compiler ergonomics.

---

## 3. Elasticsearch

**What it is.** The original; still the most feature-complete commercial search platform.

- **Hybrid search — PROVEN.** BM25 + dense vector (HNSW) + RRF and linear combination; mature.
- **Filtered ANN — PROVEN.** Filtered kNN with pre-filtering.
- **Scaling — MARKETED (well-attested).** Industry standard for large-scale search.
- **License — PROVEN, and the key caveat.** Tri-licensed: **SSPL, Elastic License 2.0 (ELv2), and (added Aug 2024) AGPLv3.** Quotes: "Elasticsearch source code is available under three license options: SSPL, AGPLv3, and the Elastic License 2.0." AGPLv3 is OSI-approved, so Elastic now calls it "open source again" (`elastic.co/blog/elasticsearch-is-open-source-again`, businesswire announcement). **Commercial-use verdict: usable, but every option carries a string.** ELv2 forbids offering it as a managed service. SSPL is *not* OSI-open-source and its service clause is viral over your "management stack." **AGPLv3 is copyleft and network-triggering** — if you embed Elasticsearch and expose it over a network, AGPL obligations can reach into your stack. For an *embedded-in-your-app* framework like samesake's target users, AGPL is precisely the trap to avoid. ELv2/SSPL also block the path AWS took.
- **vs samesake.** Same capability story as OpenSearch but with a meaningfully worse license posture for an embed-in-your-product use case. For samesake's "runs in the user's own app" model, Elasticsearch's licensing is an active liability that pgvector (PostgreSQL License) and OpenSearch (Apache-2.0) both avoid. **Differentiation point samesake can lean on: permissive licensing of the whole retrieval stack.**

---

## 4. Typesense

**What it is.** A C++, RAM-first, developer-friendly Algolia alternative; typo-tolerant instant search.

- **Hybrid search — PROVEN.** Supports keyword + vector hybrid. Notably ships **auto-embedding**: "Automatically generate embeddings from within Typesense using built-in models like S-BERT, E-5, etc or use OpenAI, PaLM API… build an out-of-the-box semantic search + keyword search experience" (`github.com/typesense/typesense`).
- **Filtered ANN — PROVEN.** Supports filtering combined with vector search.
- **Scaling — MARKETED.** RAM-resident dataset (whole dataset in memory) → fast but RAM-bounded; clustering via Raft. Best for low-latency moderate corpora, less suited to billion-scale.
- **License — PROVEN, important nuance.** Server is **GPL-3.0**; client libraries are Apache-2.0 (so app code linking the clients is fine). Quote from docs: "GPL covers and allows for this use case generously (eg: Linux is GPL licensed)." **Commercial-use verdict: permitted (GPL does not restrict commercial use), but GPL-3 copyleft is a concern if you modify/redistribute the server inside a proprietary product.** Running it as an unmodified network service is fine.
- **vs samesake.** Typesense is the closest in *spirit* to samesake on developer ergonomics (typed-ish, batteries-included, auto-embedding mirrors samesake's enrich pipeline). But it is a separate RAM-bound service. samesake keeps embeddings BYO and data in Postgres (durable, disk-backed, transactional). **Borrow from Typesense: the "out-of-the-box embedding generation as part of the engine" DX. Differentiate on: durability + no second datastore + SQL filter compilation.**

---

## 5. Meilisearch

**What it is.** Rust, memory-mapped-disk search engine; very strong instant-search/typo-tolerance DX.

- **Hybrid search — PROVEN.** Supports hybrid (keyword + semantic). **BYO embeddings** path (generate externally, index alongside) plus embedder integrations. Mirrors samesake's BYO-embedding stance.
- **Filtered ANN — PROVEN.** Filterable attributes combine with vector/semantic search.
- **Scaling — MARKETED.** Memory-mapped disk (not full-RAM like Typesense) → better memory profile; single-node oriented, horizontal scale weaker than OpenSearch/Vespa.
- **License — PROVEN, with nuance.** The **core engine is MIT** (permissive). Some sources note **BUSL-1.1** applies to certain newer/enterprise components — so "Meilisearch is MIT" is true of the community engine but **not blanket-true of every module.** **Commercial-use verdict: the MIT community engine is the most permissive in this whole list; verify any specific module isn't BUSL before embedding.**
- **vs samesake.** Meilisearch + BYO embeddings is conceptually the nearest "lightweight hybrid engine" peer. Still a separate service; no SQL/transactional integration; weaker hard-filter-before-rank semantics than compiling to SQL predicates. samesake's edge is again "no second datastore + SQL gating + typed compiler." **Borrow: Meilisearch's BYO-embedding ergonomics and instant-search UX bar.**

---

## 6. Qdrant

**What it is.** Rust vector database focused on **fast filtered search**.

- **Hybrid search — PROVEN.** Supports dense + sparse vectors and server-side fusion (RRF / DBSF) via the Query API; sparse vectors provide BM25-like lexical signal.
- **Filtered ANN — PROVEN, a genuine strength.** Qdrant's filtering is integrated into HNSW traversal (its **ACORN**-style approach) rather than naive post-filtering, maintaining performance even under highly selective filters ("find similar products, but only in stock, under $50" — the canonical commerce query). This is the most relevant capability for fashion-commerce hard filters.
- **Scaling — MARKETED.** Comfortable into the tens of millions of vectors; distributed mode (sharding/replication) available. Not pitched at Milvus's billion-scale ceiling.
- **License — PROVEN.** **Apache-2.0** (`github.com/qdrant/qdrant/blob/master/LICENSE`). **Commercial use: fully permitted, permissive.**
- **vs samesake.** Qdrant is the best-in-class *pure vector* component with excellent filtered-ANN — exactly the part samesake implements with pgvector + SQL predicates. The architectural question: do you want filtered ANN *inside* the HNSW graph (Qdrant) or *as a SQL predicate gating a pgvector scan* (samesake)? Qdrant's in-graph filtering is likely faster under extreme selectivity; samesake's SQL gating is simpler, transactional, and avoids a second datastore. Qdrant has **no native BM25 lexical engine** the way Postgres FTS does — it leans on sparse vectors. **Watch Qdrant's filtered-ANN technique as the bar samesake's SQL-gated pgvector approach must stay competitive against on selective filters.**

---

## 7. Weaviate

**What it is.** Go-based vector database with first-class hybrid search and a module ecosystem (vectorizers, rerankers).

- **Hybrid search — PROVEN, a flagship feature.** Native BM25 + vector hybrid with fusion (relative-score / ranked fusion). Among the easiest hybrid APIs in the vector-DB space.
- **Filtered ANN — PROVEN.** Filtered vector search with a query planner.
- **Scaling — MARKETED.** Millions to tens of millions comfortably; horizontal scaling available; lighter ceiling than Milvus.
- **License — PROVEN.** **BSD-3-Clause** (core). **Commercial use: fully permitted, permissive** (note: Weaviate Cloud / some enterprise features are separate).
- **vs samesake.** Weaviate is the "hybrid search is the headline" vector DB and the most direct competitor to samesake's *hybrid* positioning — but as a separate service with its own BM25 implementation rather than reusing Postgres FTS. samesake's claim against it: you get equivalent hybrid (FTS + ANN + RRF) without operating Weaviate alongside your Postgres, and your filters are real SQL against your real catalog. **Differentiate on integration + ops; concede that Weaviate's module/reranker ecosystem is broader today.**

---

## 8. Milvus

**What it is.** The scale king of OSS vector DBs (LF AI & Data project), disaggregated compute/storage architecture.

- **Hybrid search — PROVEN.** Multi-vector search and, since **v2.5, native full-text search via Sparse-BM25** (a sparse-vector BM25 implementation), enabling true BM25 + dense hybrid inside Milvus.
- **Filtered ANN — PROVEN.** Scalar filtering combined with ANN.
- **Scaling — PROVEN/MARKETED (well-attested).** Designed for scale from day one; disaggregated architecture separates compute and storage for independent scaling of reads/writes/indexing; **routinely deployed at hundreds of millions to billions of vectors** (e.g., the Reddit case study). This is its defining advantage.
- **License — PROVEN.** **Apache-2.0.** **Commercial use: fully permitted, permissive.**
- **vs samesake.** Milvus is the answer when the vector corpus is so large that Postgres/pgvector stops being viable — orders of magnitude beyond samesake's ~5k–LK-scale fashion corpora. For samesake's target (catalogs in the thousands-to-millions of products), Milvus is massive overkill with heavy operational complexity (etcd, object storage, multiple components). **samesake should explicitly position: "if you have a billion vectors, use Milvus; for a fashion catalog, you don't, and you shouldn't run a distributed vector cluster for it."**

---

## 9. LanceDB

**What it is.** An **embedded** (in-process, serverless), Apache-2.0 vector + multimodal store built on the **Lance** columnar format; "AI-native multimodal lakehouse," disk/object-store backed, no separate server process.

- **Hybrid search — PROVEN.** Supports hybrid search (vector + full-text/BM25) with rerankers (`lancedb.com/docs/search/hybrid-search/`).
- **Filtered ANN — PROVEN.** SQL-style filters combined with vector search; pre/post-filtering.
- **Scaling — MARKETED.** Pitched at "billion-scale" on the columnar format; scales via object storage rather than a cluster. Embedded model means no horizontal service to operate, but also no built-in multi-node query coordination — scale comes from storage + the host process.
- **License — PROVEN.** **Apache-2.0** (open-source core; LanceDB Cloud is separate). **Commercial use: fully permitted, permissive.**
- **vs samesake.** Architecturally the *most philosophically aligned non-Postgres option*: like samesake, LanceDB wants search to live **inside your application** with no separate search service. The difference is the substrate — LanceDB is its own columnar file format (great for multimodal/embedding-heavy ML lakehouse workflows, weaker on the transactional CRUD + relational catalog that a live commerce store needs), whereas samesake reuses Postgres (transactions, joins, RLS, the system of record). **For a fashion store whose catalog already lives in Postgres, samesake's "search where the data already is" beats adding a Lance dataset to sync. LanceDB is the stronger choice for an offline/ML-embedding-lakehouse pipeline.**

---

## 10. Marqo (OSS)

**What it is.** An "AI-native ecommerce search platform built for online brands in **fashion**, beauty, electronics, and home goods" — the single most on-target *vertical* match to samesake's fashion-first commerce framing. Wraps embedding generation (incl. multimodal CLIP-style) + vector search end-to-end.

- **Hybrid search — PROVEN (marketed feature).** Tensor (vector) + lexical hybrid; multimodal (text + image) embeddings as a built-in pipeline — overlapping samesake's enrich pipeline and image-aware `findProducts()`.
- **Filtered ANN — PROVEN.** Filtering with tensor search.
- **Scaling — MARKETED.** Vector-engine-backed; cloud offering for scale.
- **License — PROVEN, with a critical caveat.** OSS repo is **Apache-2.0**, BUT the repo carries a deprecation notice: **"NOTICE: Marqo's Open Source project is deprecated and will no longer receive updates."** (`github.com/marqo-ai/marqo`). **Commercial-use verdict: the license permits it, but a deprecated/unmaintained OSS project is a poor dependency** — the company has pivoted to its commercial/cloud product.
- **vs samesake.** Marqo is the closest *vertical positioning* competitor (fashion e-commerce, multimodal, search-as-a-product) — its existence validates samesake's market thesis. But (a) it's a separate service, not in-Postgres, and (b) **its OSS is now deprecated**, leaving an opening: a maintained, permissively-licensed, in-your-own-stack fashion-commerce search compiler. **This is the single most strategically useful finding for samesake: the most direct OSS analog just abandoned its open-source track.**

---

## 11. pgvector (+ ParadeDB / pg_search) — samesake's own family

**pgvector.** The foundation samesake builds on. Vector type, distance operators, **HNSW + IVFFlat** ANN indexes for Postgres.
- **Hybrid — PROVEN (assembled, not turnkey).** pgvector provides the ANN half; lexical comes from Postgres FTS (`tsvector`/`ts_rank`) or pg_search/pg_bm25; fusion (RRF) is application/SQL-level. **This is exactly what samesake compiles for you** — pgvector alone doesn't ship a fused hybrid query; you build it.
- **Filtered ANN — PROVEN.** v0.8.0 added **iterative index scans** (`hnsw.iterative_scan`, `ivfflat.iterative_scan`) to fix *overfiltering* — keep scanning the index until enough rows pass the `WHERE` clause (`github.com/pgvector/pgvector`). This is the mechanism behind samesake's "hard filters gate before ranking" working correctly with ANN.
- **Scaling — PROVEN/known limitation.** Bounded by single-Postgres scaling; HNSW build/memory cost grows with corpus. Fine for thousands–low-millions of vectors (samesake's regime); not billion-scale.
- **License — PROVEN.** **PostgreSQL License** (permissive, BSD-style). **Commercial use: fully permitted — the cleanest license posture in this entire survey for an embed-in-your-product framework.**

**ParadeDB pg_search.** Postgres extension giving **Elasticsearch-quality BM25** inside Postgres, built on **Tantivy** (Rust Lucene-alternative) via pgrx; supports full-text, faceted, and **hybrid** search over Postgres tables.
- **License — PROVEN, and the caveat for samesake.** **AGPL-3.0** for core extensions (pg_search, pg_analytics, pgvectorscale-in-ParadeDB), with a separate enterprise edition (`paradedb.com`). **AGPL is network-copyleft** — embedding it inside a product served over a network can trigger source-disclosure obligations. For samesake's "runs in the user's own app" model, **AGPL pg_search is a license hazard**; native Postgres FTS (PostgreSQL License) avoids it.

**pgvectorscale (Tiger Data / Timescale).** Postgres extension adding **StreamingDiskANN** index + **Statistical Binary Quantization**; complements pgvector for performance/scale. Filtered search via a streaming `get_next()` that keeps fetching nearest vectors until enough pass the filter (solving the same overfiltering problem pgvector 0.8 addresses, via DiskANN).
- **License — PROVEN.** **PostgreSQL License** ("Postgres OSS licensed," `github.com/timescale/pgvectorscale`). Note: Tiger also shipped **pg_textsearch** (BM25 in Postgres) under the **PostgreSQL License** — a permissively-licensed alternative to AGPL pg_search.
- **vs samesake — same family.** pgvectorscale is the natural *performance upgrade path* for samesake's vector side: StreamingDiskANN + binary quantization push pgvector toward "as fast as Pinecone" (Tiger's benchmark claim — MARKETED) while staying in Postgres and permissively licensed. **samesake should evaluate pgvectorscale + pg_textsearch as drop-in, permissively-licensed accelerators that preserve the in-Postgres, no-second-datastore thesis — and avoid AGPL pg_search.**

---

## 12. Comparison table

| Engine | Hybrid (BM25+vec+fusion) | Filtered ANN | Scaling | License | Commercial-use verdict | Architecture vs samesake |
|---|---|---|---|---|---|---|
| **Vespa** | Native; linear + **RRF** in global phase (PROVEN) | Native, in-plan (PROVEN) | Web-scale, distributed (best ceiling) | **Apache-2.0** | ✅ Fully permitted | Separate heavyweight cluster; closest *architecture* analog; far higher ops cost |
| **OpenSearch** | Native; normalization processor, multiple combos (PROVEN) | Filtered k-NN (PROVEN) | Distributed, horizontal | **Apache-2.0** | ✅ Fully permitted, incl. SaaS | Separate JVM cluster; mature; dual-write/sync tax |
| **Elasticsearch** | Native; RRF (PROVEN) | Filtered kNN (PROVEN) | Distributed, mature | **SSPL / ELv2 / AGPLv3** | ⚠️ All options carry strings; **AGPL/ELv2 risky for embed-in-product** | Same as OpenSearch but worse license posture |
| **Typesense** | Native + **auto-embedding** (PROVEN) | Yes (PROVEN) | RAM-bound; Raft cluster | **GPL-3.0** (server) | ⚠️ Permitted; copyleft if modifying/redistributing server | Separate RAM service; great DX |
| **Meilisearch** | Native; **BYO embeddings** (PROVEN) | Yes (PROVEN) | mmap disk; single-node-oriented | **MIT** core (some **BUSL-1.1** modules) | ✅ Core very permissive; verify module | Separate service; nearest lightweight peer |
| **Qdrant** | Dense+sparse + **RRF/DBSF** (PROVEN) | **In-graph filtering (best-in-class)** (PROVEN) | 10s of millions; distributed | **Apache-2.0** | ✅ Fully permitted | Pure-vector component; no native lexical (sparse only) |
| **Weaviate** | **Native hybrid (flagship)** (PROVEN) | Yes (PROVEN) | 10s of millions; horizontal | **BSD-3-Clause** | ✅ Fully permitted | Separate service; broad reranker ecosystem |
| **Milvus** | Native incl. **Sparse-BM25** v2.5 (PROVEN) | Yes (PROVEN) | **Billion-scale (best)** (PROVEN) | **Apache-2.0** | ✅ Fully permitted | Heavy disaggregated cluster; overkill for fashion catalogs |
| **LanceDB** | Native vec + FTS + rerankers (PROVEN) | Yes (PROVEN) | Billion-scale via columnar/object store (MARKETED) | **Apache-2.0** | ✅ Fully permitted | **Embedded/in-app** like samesake, but own Lance format, not Postgres |
| **Marqo (OSS)** | Tensor + lexical, **multimodal** (PROVEN) | Yes (PROVEN) | Vector-backed; cloud for scale | **Apache-2.0** but **OSS DEPRECATED** | ⚠️ License OK; **unmaintained — avoid as dependency** | Closest *vertical* (fashion) analog; OSS abandoned |
| **pgvector** | ANN half; hybrid = FTS+RRF you assemble (PROVEN) | **Iterative scans v0.8** fix overfiltering (PROVEN) | Single-Postgres bound | **PostgreSQL License** | ✅ **Cleanest for embed-in-product** | **samesake's foundation** |
| **ParadeDB pg_search** | Native BM25 (Tantivy) + hybrid in Postgres (PROVEN) | Yes (PROVEN) | Single-Postgres bound | **AGPL-3.0** (core) | ⚠️ **Network-copyleft — hazard for embed-in-app** | In-Postgres but AGPL; avoid |
| **pgvectorscale (Tiger)** | Complements pgvector; pair w/ pg_textsearch BM25 (PROVEN) | **StreamingDiskANN** streaming filter (PROVEN) | Single-Postgres, DiskANN-accelerated | **PostgreSQL License** | ✅ Fully permitted | **In-Postgres perf upgrade path for samesake** |

### Verdict row

> **For samesake's regime — fashion/visual commerce catalogs in the thousands-to-low-millions of products, hybrid (FTS+ANN+RRF) with hard-SQL-filter gating, embedded in the customer's own app, BYO embeddings, permissive licensing — the in-Postgres stack (pgvector + native FTS, optionally upgraded with pgvectorscale's StreamingDiskANN and Tiger's pg_textsearch BM25) is the *right* substrate, and AGPL options (ParadeDB pg_search, Elasticsearch-AGPL) are the *wrong* one.** Among separate services: **OpenSearch** is the safest mature alternative (Apache-2.0, full hybrid), **Vespa** the highest ceiling (Apache-2.0, but heavy), **Qdrant** the best filtered-ANN component, **Milvus** only if you truly hit billion-scale. **Marqo is the most direct vertical competitor and its OSS just deprecated — the clearest market opening for samesake.** samesake's defensible wedge is **not raw search capability** (the engines above match or exceed it) **but the elimination of the second datastore + transactional consistency + SQL-native hard filters + a TypeScript compiler that emits the whole layer from a typed catalog.**

---

## 13. Sources

- Vespa hybrid search tutorial — https://docs.vespa.ai/en/learn/tutorials/hybrid-search.html
- Vespa zero-shot ranking (hybrid) blog — https://blog.vespa.ai/improving-zero-shot-ranking-with-vespa-part-two/
- Vespa license (Apache-2.0) — https://github.com/vespa-engine/vespa
- OpenSearch hybrid search docs — https://docs.opensearch.org/latest/vector-search/ai-search/hybrid-search/index/
- OpenSearch normalization processor — https://docs.opensearch.org/latest/search-plugins/search-pipelines/normalization-processor/
- OpenSearch hybrid optimization blog — https://opensearch.org/blog/hybrid-search-optimization/
- OpenSearch vs Elasticsearch (licensing) — https://pulse.support/kb/opensearch-vs-elasticsearch
- Elasticsearch "open source again" (AGPLv3 added) — https://www.elastic.co/blog/elasticsearch-is-open-source-again
- Elastic license announcement (Aug 2024) — https://www.businesswire.com/news/home/20240829537786/en/Elastic-Announces-Open-Source-License-for-Elasticsearch-and-Kibana-Source-Code
- Elastic licensing FAQ — https://www.elastic.co/pricing/faq/licensing
- Elastic Apache→AGPL journey — https://pureinsights.com/blog/2024/elastics-journey-from-apache-2-0-to-agpl-3/
- Typesense repo (GPL-3.0; vector/hybrid; auto-embedding) — https://github.com/typesense/typesense
- Meilisearch vs Typesense (licenses, hybrid, BYO embeddings) — https://www.meilisearch.com/docs/resources/comparisons/typesense
- Meilisearch vs Typesense open-source 2026 — https://apiscout.dev/guides/meilisearch-vs-typesense-api-2026
- Qdrant license (Apache-2.0) — https://github.com/qdrant/qdrant/blob/master/LICENSE
- Qdrant/Weaviate/Milvus comparison (filtering, hybrid, scaling) — https://medium.com/@hadiyolworld007/vector-dbs-decoded-qdrant-vs-milvus-vs-weaviate-57455146b9f6
- Milvus billion-scale at Reddit (case study) — https://milvus.io/blog/choosing-a-vector-database-for-ann-search-at-reddit.md
- Milvus license — https://en.wikipedia.org/wiki/Milvus_(vector_database)
- LanceDB hybrid search docs — https://lancedb.com/docs/search/hybrid-search/
- LanceDB (Apache-2.0; multimodal lakehouse) — https://www.lancedb.com/
- Marqo repo (Apache-2.0; ecommerce/fashion; OSS deprecated notice) — https://github.com/marqo-ai/marqo
- pgvector repo (PostgreSQL License; HNSW/IVFFlat; iterative scans v0.8) — https://github.com/pgvector/pgvector
- pgvector filtering (overfiltering / iterative scans) — https://docs.pgedge.com/pgvector/v0-8-1/filtering/
- ParadeDB pg_search (BM25, Tantivy, hybrid; AGPL-3.0) — https://www.paradedb.com/blog/introducing-search
- pg_search on PGXN (AGPL) — https://pgxn.org/dist/pg_search/
- pgvectorscale repo (StreamingDiskANN, SBQ; PostgreSQL License) — https://github.com/timescale/pgvectorscale
- Tiger Data pg_textsearch (BM25 in Postgres; PostgreSQL License) — https://github.com/timescale/pg_textsearch
- Tiger Data "you don't need Elasticsearch / BM25 in Postgres" — https://www.tigerdata.com/blog/you-dont-need-elasticsearch-bm25-is-now-in-postgres
- Understanding DiskANN (Tiger) — https://www.tigerdata.com/blog/understanding-diskann
- "Faster than Pinecone, 75% cheaper, 100% open source" (pgvectorscale, MARKETED) — https://www.tigerdata.com/blog/how-we-made-postgresql-as-fast-as-pinecone-for-vector-data
