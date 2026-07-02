# Decision 02 — Retrieval & Ranking Architecture

## TL;DR
> Keep **FTS + cosine ANN fused by RRF** (industry consensus). Make three upgrades, in
> priority order: **(1) fix filtered-ANN over-filtering** (must-do), **(2) add an optional,
> distilled, latency-gated cross-encoder reranker over the RRF top-K** (the highest-leverage
> quality lever, ahead of re-enabling "spaces"), **(3) expose tunable convex-combination (CC)
> fusion** for tenants with labeled data. **Do not** adopt ColBERT or SPLADE — they break the
> two-container promise. Keep "spaces" off by default but re-investigate it as a *fusion/
> training* problem.

---

## 1. Hybrid FTS + ANN + RRF — keep it; it's the consensus

The single strongest external endorsement is **Walmart's *Semantic Retrieval*** (KDD 2022):
they independently arrived at samesake's exact shape — *inverted index (FTS) + neural
embedding ANN, fused, gated for tail queries* — at hyperscale and got it through a relevance
review. Taobao MGDSPR, Instacart, Etsy, and Mercari all converge on hybrid. JD.com's DPSR
quantifies *why* the ANN leg matters: **+1.29% conversion overall but +10.03% on tail
queries** — semantic retrieval's payoff concentrates in the long tail. (`03-academic/large-retailer-product-search.md`)

**Implication:** samesake is mainstream-correct. Lead with Walmart + Instacart as validation.
Two adoptions to surface as BYO-embedding guidance: **hard-negative mining** (in-batch +
offline) is the universal recall lever every retailer stresses; and **train/inference
embedding-model consistency** must be a compile-time invariant (Taobao's named failure mode).

## 2. Fusion: RRF default, CC when labeled (Bruch TOIS 2023)

RRF (Cormack 2009, k=60) consumes *ranks not scores*, so it fuses FTS and ANN with no
calibration or training — ideal for a compiler that ships before any tenant has eval data.
**But** Bruch et al. (ACM TOIS 2023) prove **convex combination of normalized scores beats RRF
in- and out-of-domain with only a tiny tuning set**, and that **RRF is *more* parameter-
sensitive than folklore** ("we find RRF to be sensitive to its parameters").

**Decision:** keep RRF(k=60) as the zero-config default; **sweep k inside the eval gate**
(don't treat 60 as sacred); expose a **CC path (min-max normalization, tunable α)** that a
tenant promotes to once it has ≈50+ labeled queries. CC's per-component weighting is also a
*cleaner* way to down-weight a weak signal (e.g. "spaces") than dropping it entirely.
(`03-academic/hybrid-fusion-and-vector-scaling.md`)

## 3. The next quality lever: cross-encoder reranker (not "spaces")

A cross-encoder over the **top-K RRF candidates** (k≈50–100) is the textbook way to lift
P@5 / grade@10, and it fits samesake's architecture cleanly: it is a pure scoring function
*after* retrieval, needs no new index, respects "stop at retrieval" (reorders grounded
products, doesn't act), and is BYO-model-friendly.

The literature is unambiguous and operationally encouraging:
- RankGPT (EMNLP 2023): zero-shot listwise LLM reranking **beats supervised SOTA** (+2.3–2.7
  nDCG on TREC/BEIR), and **distills to a 440M model that beats a 3B supervised** one.
- RankZephyr (7B) / RankVicuna are **fully open** — no closed-API dependency, matching
  samesake's BYO ethos.
- E-commerce-specific work points to *small, pointwise/setwise, latency-aware* rerankers
  (Qwen2.5-0.5B/3B), **not** frontier listwise calls.
- **The warning:** an "Efficiency–Effectiveness Reranking FLOPs" paper (2025) shows LLM
  rerankers buy nDCG at large compute cost — and *Shallow Cross-Encoders* (ECIR 2024) shows a
  small model scoring *more* candidates beats a big model scoring few at a fixed latency
  budget (TinyBERT-gBCE **+51% nDCG@10 vs MonoBERT-Large at 25 ms/query**).

**Decision:** ship a cross-encoder reranker as an **optional module gated like "spaces"** —
it must beat current grade@10≈2.33 / P@5 0.83 *within a stated latency + FLOPs budget*.
Prefer a **shallow/distilled** reranker scoring more candidates over a deep one scoring few.
For visual fashion, the high-value variant is a **multimodal cross-encoder** (text query ×
product text+image), aligning with the enrich pipeline. This is a **stronger, lower-risk bet
than turning "spaces" back on.** (`03-academic/conversational-and-generative-retrieval.md`,
`03-academic/hybrid-fusion-and-vector-scaling.md`)

## 4. "Spaces" (segmented vectors) — keep off, re-investigate as fusion/training

"Spaces" failed samesake's eval gate (flat-weighted as a third RRF leg). But **Etsy's unified
graph+transformer+term embedding succeeded (+5.58% purchase rate)** and Marqo's GCL trains
multi-aspect embeddings — so the *concept* (multi-aspect/segmented representation) is
externally validated. The likely problem is **how the segments are produced and RRF-weighted**,
not the idea. Two concrete re-investigation paths: (a) weight segments via **CC**, not flat
RRF (down-weight weak segments instead of dropping the leg); (b) revisit how the segment
vectors are trained/composed. **Keep off by default; re-gate per-tenant under CC weighting.**
This is lower priority than §3. (`03-academic/large-retailer-product-search.md`)

## 5. ColBERT / SPLADE — do not adopt

- **ColBERT/ColBERTv2/PLAID** (late interaction) is the first-stage quality ceiling but
  **architecturally hostile to "just Postgres"** — multi-vector token store + centroid-pruned
  candidate gen + MaxSim kernel, none of which pgvector has. Adopting it breaks the
  two-container promise. *This is precisely why the cross-encoder reranker (§3) is the
  pragmatic quality lever instead.* Revisit only if pgvector gains native multi-vector/MaxSim.
- **SPLADE** (learned sparse) is *more* Postgres-compatible (`sparsevec`), but the released
  weights are **CC BY-NC-SA (non-commercial)** — a hard blocker — and expansion bloats
  postings lists at scale. **Park it.** For fashion, the bigger near-term win is the **enrich
  pipeline generating good lexical text** for Postgres FTS, capturing most of SPLADE's
  "expansion" benefit with no learned sparse model. (`03-academic/hybrid-fusion-and-vector-scaling.md`)

## 6. Filtered-ANN over-filtering — the #1 architectural risk (must-fix)

"Hard filters gate before ranking" is the right product behavior, but on an **approximate**
HNSW index it is the classic **over-filtering trap**: the index returns a fixed candidate
budget, *then* the predicate culls it — a selective filter can starve results. pgvector's own
docs: with HNSW and default `ef_search=40`, a condition matching 10% of rows leaves ~4 results.

**Decision (must-do, not optional):**
1. Enable + tune **pgvector iterative index scans** (`hnsw.iterative_scan='relaxed_order'`,
   sized `hnsw.max_scan_tuples` / `scan_mem_multiplier`; IVFFlat analogues).
2. For **highly selective** predicates, **pre-filter to a CTE then exact KNN** — exact is fine
   on small filtered sets; samesake's catalogs are not billions.
3. **Eval-gate filtered-query recall explicitly** — over-filtering is invisible in unfiltered
   grade@10. (This is the single most important addition to the eval harness — see `06`.)
4. **Surface in `/search/explain`** when iterative scanning triggered (auditability is already
   a samesake feature; this makes the silent failure visible).

The academic right answer is **predicate-aware traversal** (ACORN SIGMOD 2024: 2–1000×
throughput at fixed recall; Filtered-DiskANN WWW 2023; Qdrant's in-graph filtering), which
pgvector does **not** implement — so iterative scans + exact fallback is samesake's mitigation,
and Qdrant's in-graph filtering is the bar to stay competitive against on selective filters.
(`03-academic/hybrid-fusion-and-vector-scaling.md`, `04-oss-engines/search-engines.md`)

## 7. Fashion-specific retrieval depth (from `08-rag/rag-in-fashion`)

Fashion retrieval is **six tasks**, not one: similarity, attribute/category, compatibility,
complete-the-look (scene-based), fill-in-the-blank (FITB), conversational/VQA grounding.
samesake covers similarity + attribute/category well; the **gaps are compatibility /
complete-the-look / FITB — all of which are retrieval, not generation.** Compatibility is
*fundamentally different from similarity*: ANN over a similarity embedding retrieves the wrong
items; it needs a **learned compatibility embedding (Polyvore co-occurrence) + an asymmetric,
category-gated query** — implementable as a typed samesake "space" / query mode. Two cheap,
high-value enrich wins (deepen retrieval, don't add generation):
- **Region-grounded embeddings** — VL-CLIP (Walmart, 2025): crop the garment (Grounding DINO)
  before embedding; LLM-normalize attribute text. Lifted HITS@5 ~0.30→0.68, **+18.6% CTR,
  +4% GMV** in production A/B.
- **LLM image captions → text embeddings** — Pinterest OmniSearchSage: caption product images
  with a generative LLM, embed the captions as enrich fields feeding both FTS and the doc
  embedding. Cheaper and more Postgres-FTS-friendly than raw CLIP, and auditable in
  `/search/explain`.

Safe-to-ship fashion models: **FashionCLIP (MIT)**, **Marqo-FashionCLIP/SigLIP (Apache-2.0)**.
Canonical datasets (DeepFashion, Polyvore, FACAD, Fashion-Gen) are mostly research-only —
treat as **eval assets, not redistributable training data**.

## Flip conditions
- Promote **CC → default** for a tenant at ≥~50 labeled queries.
- Adopt the **cross-encoder reranker** only when it clears grade@10/P@5 within a latency+FLOPs budget.
- Revisit **ColBERT** if pgvector gains multi-vector/MaxSim; **SPLADE** with a permissive LSR model.
- Build the **compatibility space** only if tenant usage shows real "complete-the-look" demand.

## Sources
`03-academic/hybrid-fusion-and-vector-scaling.md`, `03-academic/large-retailer-product-search.md`,
`03-academic/conversational-and-generative-retrieval.md`, `08-rag/rag-in-fashion.md`,
`04-oss-engines/search-engines.md`, `01-marqo/scaling-performance.md`.
