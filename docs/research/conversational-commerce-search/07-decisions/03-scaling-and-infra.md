# Decision 03 — Scaling & Infrastructure

## TL;DR
> **Stay in Postgres.** pgvector HNSW + native FTS is the *right* substrate for samesake's
> regime (fashion/visual catalogs in the thousands-to-low-millions of products). The
> permissively-licensed performance upgrade path is **pgvectorscale (StreamingDiskANN) +
> pg_textsearch BM25** — both PostgreSQL-licensed. **Avoid AGPL** (ParadeDB pg_search,
> Elasticsearch-AGPL) in an embed-in-product framework. Don't reach for Milvus/DiskANN/Vespa
> until a tenant genuinely exceeds single-Postgres HNSW limits.
> **Flip condition:** move a tenant to an external engine only when its catalog × vector
> dimensionality exceeds what single-Postgres HNSW can hold in RAM at the target recall/latency
> (empirically low-millions+ of vectors).

## The regime samesake actually serves

samesake's own corpus is ~5k docs; its target is catalogs in the **thousands-to-low-millions**.
In that regime, **HNSW in pgvector is the correct index** — state-of-the-art in-memory ANN,
log-scaling search (Malkov & Yashunin, TPAMI 2018). IVF-PQ, DiskANN, and ScaNN are
**billion-scale tools** whose compression/disk tradeoffs samesake does not need — and which
require leaving Postgres. eBay's billion-vector engine is a *different regime*; samesake should
**position explicitly**: "we are not a billion-vector engine; we are a compiler for catalogs
that fit comfortably in Postgres+pgvector." (`03-academic/hybrid-fusion-and-vector-scaling.md`,
`04-oss-engines/search-engines.md`)

Marqo's scaling posts claim sub-100ms p99 / <80ms at 10M products — but those are **marketing
with no corpus, hardware, or query set** (the scrape even leaked that the posts are generated
SEO collateral with a banned-term list). Don't compete on unpublished latency numbers; compete
on "runs on the Postgres you already operate." (`01-marqo/scaling-performance.md`)

## The in-Postgres family and the upgrade path (from `04-oss-engines`)

| Component | Role | License | Verdict |
|---|---|---|---|
| **pgvector** | HNSW/IVFFlat ANN; `sparsevec`; **iterative scans** (v0.8) fix over-filtering | **PostgreSQL License** | ✅ samesake's foundation — cleanest license for embed-in-product |
| **native Postgres FTS** (`tsvector`/`ts_rank`) | lexical leg of the hybrid | PostgreSQL License | ✅ default; avoids AGPL BM25 |
| **pgvectorscale** (Tiger) | **StreamingDiskANN** + statistical binary quantization; streaming filter | **PostgreSQL License** | ✅ the perf/scale upgrade that *stays in Postgres* |
| **pg_textsearch** (Tiger) | BM25 in Postgres | **PostgreSQL License** | ✅ permissive BM25 if native FTS is insufficient |
| **ParadeDB pg_search** | Elasticsearch-quality BM25 (Tantivy) | **AGPL-3.0** | ⚠️ **network-copyleft hazard for embed-in-app — avoid** |

**Decision:** the default stack is **pgvector + native FTS**. When a tenant needs more vector
performance, the *first* move is **pgvectorscale's StreamingDiskANN + statistical binary
quantization** (Tiger benchmarks "as fast as Pinecone" — MARKETED, but the license and
in-Postgres property are real and PROVEN). If native FTS proves insufficient for BM25-quality
lexical scoring, use **pg_textsearch (PostgreSQL License)**, **not** AGPL pg_search. Permissive
licensing of the whole retrieval stack is itself a positioning asset (Decision 01).

## When to leave Postgres (the honest ceiling)

HNSW in pgvector is **RAM-bound** — memory is the catalog-size ceiling, and HNSW build
cost/memory grow with corpus. The flip is **per-tenant**, triggered by catalog size, not by
default:

- **Qdrant** — best-in-class **in-graph filtered ANN** (ACORN-style); the bar samesake's
  SQL-gated pgvector approach must stay competitive against on highly selective filters. The
  natural external component if filtered-ANN at scale becomes the bottleneck.
- **Vespa** — highest ceiling (web-scale, one index for text+tensor+attributes, RRF in the
  global phase, Apache-2.0); the "outgrew Postgres entirely" answer, at high ops cost.
- **Milvus** — only if a tenant truly hits **billion-scale** (disaggregated, heavy ops).

All three are Apache-2.0 (commercially clean), but all reintroduce the **second-datastore
operational + consistency tax** that samesake exists to eliminate — so they are escape hatches,
not the plan.

## Strategic note: the OSS opening

**Marqo's own OSS project is deprecated** (`github.com/marqo-ai/marqo`: "no longer receive
updates") — the most direct *vertical* (fashion-commerce, multimodal) OSS analog just abandoned
its open-source track. That leaves a clear opening for a **maintained, permissively-licensed,
in-your-own-stack fashion-commerce search compiler.** (`04-oss-engines/search-engines.md`)

## Flip conditions
- **pgvector → pgvectorscale** when HNSW build/memory or recall@latency degrades at a tenant's growing corpus.
- **In-Postgres → external engine (Qdrant/Vespa/Milvus)** only when a tenant catalog exceeds
  single-Postgres HNSW RAM at target recall/latency (low-millions+ vectors) — and document that
  this breaks the two-container promise, so it is a tenant-specific exception.
- **Native FTS → pg_textsearch** if BM25-quality lexical scoring is needed (never AGPL pg_search).

## Sources
`04-oss-engines/search-engines.md`, `03-academic/hybrid-fusion-and-vector-scaling.md`,
`01-marqo/scaling-performance.md`.
