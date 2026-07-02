# Hybrid Fusion & Vector Scaling — Prior-Art Dossier

> Research dossier for **samesake** — a TypeScript-first "search engine compiler" for visual commerce that compiles a typed catalog into a **Postgres + pgvector** search layer running **inside the user's own app** (two containers: Postgres + app; no Redis / Elasticsearch / hosted vector DB). Retrieval is **hybrid**: Postgres FTS + cosine ANN over BYO embeddings (+ optional typed "spaces" vectors), fused with **reciprocal-rank fusion (RRF)**. Hard filters compile to SQL predicates that **gate before ranking**; soft filters relax. NLQ parser, multimodal enrich, entity-resolution/dedup, `/search/explain`, and an agentic `findProducts()` surface that stops at retrieval.
>
> This document surveys the retrieval-systems literature samesake depends on and extracts what governs **quality vs latency vs catalog-size scaling**, with practical takeaways for a Postgres+pgvector hybrid RRF stack.

**Scope:** RRF & dense+sparse fusion · late interaction (ColBERT / ColBERTv2 / PLAID) · learned sparse (SPLADE) · cross-encoder reranking · ANN index scaling (HNSW, IVF-PQ, DiskANN, ScaNN, filtered/predicate ANN).

**Legend:** **[PROVEN]** = peer-reviewed / reproducible benchmark result · **[MARKETED]** = vendor/blog claim, not independently verified · **[CONTEXT]** = our synthesis for samesake.

---

## 0. TL;DR for samesake

1. **RRF is the right default for samesake, but it is not parameter-free.** The canonical Cormack 2009 result is robust, but Bruch et al. (SIGIR 2023) show **convex combination (CC) of normalized scores beats RRF in- and out-of-domain when you have even a tiny tuning set**, and that RRF is *more* sensitive to its `k` parameter than folklore claims. samesake should keep RRF as the zero-config default and expose CC (with min-max normalization) as the tuned path once a labeled eval set exists. **[PROVEN]**
2. **Hard-filter-before-rank is the correct architecture, and it is exactly where naïve pgvector breaks.** Approximate HNSW returns a fixed candidate budget *then* filters, so a selective predicate can starve results. pgvector 0.8.0's **iterative index scans** are the supported fix; samesake must enable and tune them (`hnsw.iterative_scan`, `hnsw.max_scan_tuples`). The academic answer (ACORN / Filtered-DiskANN) is predicate-aware graph traversal, which pgvector does not yet implement. **[PROVEN]**
3. **HNSW is the correct index for a single-node, in-RAM, ≤ low-millions catalog** (samesake's ~5k–low-millions regime). IVF-PQ and DiskANN are billion-scale tools whose compression/disk tradeoffs samesake does not need yet — but they define the ceiling if a tenant's catalog explodes. **[CONTEXT]**
4. **Cross-encoder reranking is the highest-leverage quality lever samesake is *not* using.** A cross-encoder over the top-k RRF candidates is the standard way to lift P@5 / grade@10; the cost is latency and a second model. This is the most defensible "spaces didn't pass the eval gate, what next?" move. **[PROVEN]**
5. **Late interaction (ColBERT/PLAID) and learned sparse (SPLADE) are powerful but architecturally hostile to "just Postgres."** Both need specialized indexes (multi-vector token stores; long sparse postings lists). They are the strongest reasons samesake's "two containers, no extra infra" promise is a *real* differentiator — and the strongest temptation to break it. **[CONTEXT]**

---

## 1. Reciprocal Rank Fusion (RRF) & dense+sparse fusion

### 1.1 RRF — the canonical method

- **Title:** *Reciprocal Rank Fusion outperforms Condorcet and Individual Rank Learning Methods*
- **Authors / year:** Gordon V. Cormack, Charles L. A. Clarke, Stefan Büttcher — **SIGIR 2009**.
- **Link:** https://dl.acm.org/doi/10.1145/1571941.1572114 (also https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf)

**Method.** Each retriever produces a ranked list. The fused score of document *d* is:

```
RRF(d) = Σ_r  1 / (k + rank_r(d))
```

summed over retrievers *r*, where `rank_r(d)` is *d*'s 1-based rank in retriever *r* and `k` is a smoothing constant (the paper uses **k = 60**). Documents not returned by a retriever contribute 0.

**Why it fits samesake.** RRF consumes only **ranks, not scores** — so it fuses Postgres FTS (BM25-like `ts_rank`) and cosine ANN without score calibration, normalization, or training. That property is exactly why it is the de-facto hybrid-search fusion in OpenSearch, Elasticsearch, Weaviate, Azure AI Search, and pgvector tutorials. **[PROVEN]** that it beats Condorcet and supervised learning-to-rank fusion on TREC data; the **k = 60** value is an empirical default, not a derived optimum.

### 1.2 The important counter-result: convex combination can beat RRF

- **Title:** *An Analysis of Fusion Functions for Hybrid Retrieval*
- **Authors / year:** Sebastian Bruch, Siyu Gai, Amir Ingber — **ACM TOIS 2023** (arXiv Oct 2022).
- **Link:** https://arxiv.org/abs/2210.11934 · https://dl.acm.org/doi/10.1145/3596512

**Findings (verbatim claims):**
- "**CC outperforms RRF in in-domain and out-of-domain settings.**"
- "the learning of a **CC fusion is generally agnostic to the choice of score normalization**" (min-max vs theoretical min-max).
- "CC is **sample efficient, requiring only a small set of training examples** to tune its only parameter."
- Contrary to common belief, the paper finds **"RRF to be sensitive to its parameters."**

**Convex combination** = `score(d) = α · norm(s_dense) + (1−α) · norm(s_sparse)`, with min-max normalization. With a handful of labeled queries you can tune `α`.

**Corroborating empirical notes from secondary sources** (treat as **[MARKETED]** unless re-verified): some practitioner benchmarks report CC@α=0.5 Recall@5 ≈ 0.726 vs RRF ≈ 0.716 — i.e., a real but modest edge that depends on tuning data being available. On BEIR, hybrid generally beats the best single retriever **except** on BioASQ, Touché-2020, ArguAna, and Quora — a reminder that **fusion is dataset-dependent and must be eval-gated, not assumed.** **[PROVEN: BEIR exceptions are a known result]**

> **samesake takeaway.** Keep **RRF (k=60) as the untuned default** — it needs no labels and is implementation-agnostic, ideal for a compiler that ships before any tenant has eval data. Then expose a **CC path with min-max normalization and a tunable α**, activated once a tenant produces a labeled eval set (samesake already has an eval harness: mean grade@10 ~2.33, P@5 0.83). Do **not** treat k=60 as sacred — sweep it in the eval gate. The "spaces" vectors that failed the eval gate are a third RRF input; CC's per-component weighting is a cleaner way to *down-weight* a weak signal than dropping it entirely.

---

## 2. Late interaction — ColBERT / ColBERTv2 / PLAID

### 2.1 ColBERT — late interaction (MaxSim)

- **Title:** *ColBERT: Efficient and Effective Passage Search via Contextualized Late Interaction over BERT*
- **Authors / year:** Omar Khattab, Matei Zaharia — **SIGIR 2020**.
- **Link:** https://arxiv.org/abs/2004.12832

**Method.** Query and document are **independently** encoded by BERT into **per-token** embeddings (multi-vector). Relevance = **MaxSim**: for each query token, take the max cosine over all document tokens, then sum across query tokens. The expensive cross-attention is deferred ("late") to a cheap dot-product stage, so document embeddings can be **precomputed and indexed offline**.

**Claims (verbatim):** ColBERT runs "**two orders-of-magnitude faster and requiring four orders-of-magnitude fewer FLOPs per query**" than BERT cross-encoders, while remaining "**competitive with existing BERT-based models (and outperforms every non-BERT baseline)**." **[PROVEN]**

**Cost.** Storing per-token vectors is the catch — index size balloons vs single-vector dense retrieval. This is the central tension ColBERTv2/PLAID exist to fix.

### 2.2 ColBERTv2 — compress the multi-vector index

- **Title:** *ColBERTv2: Effective and Efficient Retrieval via Lightweight Late Interaction*
- **Authors / year:** Keshav Santhanam, Omar Khattab, Jon Saad-Falcon, Christopher Potts, Matei Zaharia — **NAACL 2022**.
- **Link:** https://arxiv.org/abs/2112.01488

**Claims (verbatim):** combines "an **aggressive residual compression mechanism**" (cluster token embeddings to centroids; store quantized residuals) with "a **denoised supervision strategy**" (distillation + hard negatives) to "**reduce the space footprint of late interaction by 6–10×**" while establishing "**state-of-the-art quality within and outside the training domain**." **[PROVEN]** ColBERTv2 is a standard strong out-of-domain (BEIR) baseline.

### 2.3 PLAID — make late-interaction search fast at scale

- **Title:** *PLAID: An Efficient Engine for Late Interaction Retrieval*
- **Authors / year:** Keshav Santhanam, Omar Khattab, Christopher Potts, Matei Zaharia — **CIKM 2022**.
- **Link:** https://arxiv.org/abs/2205.09707

**Claims (verbatim):** centroid interaction + centroid pruning "**reduce late interaction search latency by up to 7× on a GPU and 45× on a CPU** against vanilla ColBERTv2, while continuing to deliver state-of-the-art retrieval quality"; achieves "**latency of tens of milliseconds on a GPU and tens or just few hundreds of milliseconds on a CPU at large scale, even at the largest scales evaluated with 140M passages.**" **[PROVEN]**

> **samesake takeaway.** Late interaction is the **quality ceiling** for first-stage retrieval, but it is **architecturally incompatible with "just Postgres"**: it needs a multi-vector token store, centroid-pruned candidate generation, and a MaxSim scoring kernel. pgvector has no native multi-vector/MaxSim path. Adopting ColBERT would mean either (a) a bespoke token-vector table + custom SQL MaxSim (slow, awkward), or (b) bolting on a specialized engine — which **breaks the two-container promise**. Recommendation: **do not adopt for v1**; cite it as the reason a cross-encoder *reranker* (§4) is the pragmatic quality lever instead. Revisit only if pgvector gains multi-vector support or a tenant's quality bar justifies a third container.

---

## 3. Learned sparse retrieval — SPLADE

- **Titles / years:**
  - *SPLADE: Sparse Lexical and Expansion Model for First Stage Ranking* — Formal, Piwowarski, Clinchant — **SIGIR 2021**. https://arxiv.org/abs/2107.05720
  - *SPLADE v2: Sparse Lexical and Expansion Model for Information Retrieval* — **2021**. https://arxiv.org/abs/2109.10086
  - *From Distillation to Hard Negatives… (SPLADE++)* — **SIGIR 2022**.
  - *Efficient SPLADE* — query-specific regularization + disjoint encoders.
- **Code / license:** https://github.com/naver/splade (research code; **non-commercial CC BY-NC-SA 4.0** weights — *license is a real adoption blocker for a commercial product*). **[PROVEN — license]**
- **Survey:** *Towards Effective and Efficient Sparse Neural IR* — ACM TOIS 2024. https://dl.acm.org/doi/10.1145/3634912

**Method.** A transformer (MLM head) projects each query/document into a **sparse vector over the vocabulary**, with learned **term weighting + expansion** (terms not literally present get nonzero weight). A **FLOPS regularizer** controls sparsity so the representation stays cheap to index in an inverted file. Output is a sparse vector → it slots into a classic inverted index (BM25-style postings).

**Claims (verbatim, from sources):** "Some implementations of SPLADE have **similar latency to Okapi BM25** lexical search while giving as good results as state-of-the-art neural rankers on **in-domain** data" (Wikipedia/secondary). The Efficient SPLADE line achieves "**latency on par with BM25 under the same computing constraints.**" SPLADE shows strong BEIR (out-of-domain) numbers. **[PROVEN: SIGIR results]; [MARKETED: "on par with BM25" depends heavily on pruning/regularization config]**

**The scaling catch.** Query/document **expansion lengthens postings lists** — the FLOPS regularizer trades effectiveness for shorter lists. At web scale this dominates cost; *Efficiency and Effectiveness of SPLADE Models on Billion-Scale* (arXiv 2511.22263, 2025) studies exactly this index-size / latency / recall tension. **[PROVEN: problem is well-documented]**

> **samesake takeaway.** SPLADE is **more compatible with Postgres than ColBERT** — a sparse vocab vector can in principle live in a Postgres inverted/GIN structure or pgvector's `sparsevec` type (pgvector supports `sparsevec`). But: (1) the **NC license blocks commercial use** of the released models — samesake would need to train its own LSR model (heavy) or use a permissively-licensed alternative; (2) it adds a **second learned model** to the BYO-embeddings story; (3) expansion-driven postings bloat is a real cost at catalog growth. For fashion commerce, the **bigger near-term win is the enrich pipeline generating good lexical text** for Postgres FTS, capturing most of SPLADE's "expansion" benefit without a learned sparse model. Park SPLADE as a future "spaces"-style optional module.

---

## 4. Cross-encoder reranking

- **Foundational:** *Passage Re-ranking with BERT* — Nogueira & Cho, **2019**. https://arxiv.org/abs/1901.04085 (monoBERT: BERT jointly encodes `[query, passage]` → relevance score; large MRR gains on MS MARCO).
- **Latency-focused:** *Shallow Cross-Encoders for Low-Latency Retrieval* — **ECIR 2024**. https://arxiv.org/abs/2403.20222

**Method.** A cross-encoder takes the **concatenated** query+document, runs full cross-attention, and outputs a single relevance score. Maximum quality (full interaction), but **O(k) model invocations** per query — you must rerank a *candidate set*, never the whole corpus. So it is always a **second stage** over first-stage retrieval (FTS + ANN + RRF in samesake's case).

**The quality/latency tradeoff (verbatim).** From *Shallow Cross-Encoders*: "the scoring of K candidate documents requires applying the model K times, defining a tradeoff between latency window ω and number of scored documents K." At a **25 ms/query** budget on TREC DL 2019, **MonoBERT-Large reaches NDCG@10 0.431** while a **TinyBERT-gBCE shallow cross-encoder reaches 0.652 (+51%)** — because the smaller model can score *more* candidates inside the budget. Big cross-encoders "increase query latency by seconds" if applied to many candidates. **[PROVEN]**

**Governing levers:** model depth (quality per pair) × candidate count k (coverage) × latency budget. Distillation and cascades (cheap filter → expensive rerank on a shrinking set) are the standard production patterns.

> **samesake takeaway — this is the recommended next quality lever.** A cross-encoder reranker over the **top-k RRF candidates** (k ≈ 50–100) is the textbook way to lift P@5 / grade@10 and **fits samesake's architecture cleanly**: it is a pure scoring function applied *after* retrieval, needs no new index, and respects "stop at retrieval" (it reorders grounded products, doesn't act). It is **BYO-model-friendly** (tenant supplies a reranker; or use a small distilled one). Constraints: (1) it adds an inference dependency — keep it **optional / behind the eval gate**, mirroring how "spaces" is gated; (2) for visual fashion, a **multimodal cross-encoder** (text query × product text+image) is the high-value variant and aligns with samesake's multimodal enrich; (3) budget latency explicitly — prefer a **shallow/distilled** reranker scoring more candidates over a deep one scoring few. This is a stronger, lower-risk bet than turning "spaces" back on.

---

## 5. ANN index scaling — HNSW, IVF-PQ, DiskANN, ScaNN, filtered ANN

The first-stage dense retriever's index choice governs the **recall × latency × memory × catalog-size** frontier. samesake lives in pgvector, so HNSW and IVFFlat are the *available* tools; the rest define the ceiling and the failure modes.

### 5.1 HNSW — the default graph index (and pgvector's best option)

- **Title:** *Efficient and robust approximate nearest neighbor search using Hierarchical Navigable Small World graphs*
- **Authors / year:** Yu. A. Malkov, D. A. Yashunin — arXiv **2016**; **IEEE TPAMI 2018**, 42(4):824–836.
- **Link:** https://arxiv.org/abs/1603.09320

**Method.** A multi-layer proximity graph; upper layers are sparse "express lanes," lower layers dense. Search greedily descends layers. **Logarithmic search complexity scaling.** Key params: **M** (graph degree — memory & recall), **ef_construction** (build quality), **ef_search** (query-time recall × latency). **[PROVEN]** state-of-the-art recall/latency for **in-memory** ANN; the basis of most vector DBs.

**Governing tradeoffs:** ↑M → ↑recall, ↑memory, ↑build time. ↑ef_search → ↑recall, ↑latency. Fully in-RAM (no native disk paging) → **memory is the catalog-size ceiling**.

### 5.2 IVF-PQ — partition + compress for RAM-bound billions

- **Product Quantization:** Jégou, Douze, Schmid, **IEEE TPAMI 2011** — split a vector into M sub-vectors, quantize each via a codebook → ~**8 bytes/vector**, distances approximated from codebooks.
- **IVF:** k-means clusters the space; query probes only the nearest `nprobe` clusters. Combined as **IVF-PQ** (Faiss). https://github.com/facebookresearch/faiss/wiki

**Claims (secondary/Faiss):** IVF-PQ "can reduce memory usage to just **30–60 GB** while maintaining **90%+ recall** for **1 billion 768-d float32 vectors**" (vs ~3 TB raw); GPU IVF-PQ returns top-K in microseconds. **[PROVEN: PQ compression math; MARKETED: exact recall/mem figures are config-dependent]**

**Governing tradeoffs:** PQ is **lossy** → recall drops vs HNSW at the same memory unless you over-probe or re-rank with full vectors. `nprobe` is the recall×latency knob; `nlist`/M/`nbits` set the memory floor. pgvector's **IVFFlat** is the partition idea **without PQ** (no compression) and requires data present at build time.

### 5.3 DiskANN / Vamana — billion-scale on one box via SSD

- **Title:** *DiskANN: Fast Accurate Billion-point Nearest Neighbor Search on a Single Node*
- **Authors / year:** Subramanya, Devvrit, Simhadri, Krishnaswamy, Kadekodi — **NeurIPS 2019**.
- **Link:** https://suhasjs.github.io/files/diskann_neurips19.pdf

**Method.** The **Vamana** graph (a tunable-pruning relative of NSG) stored **on SSD** with compressed vectors in RAM; search pages graph neighborhoods from disk. **Claims (verbatim):** indexes "a **billion point database on a single workstation with just 64 GB RAM** and an inexpensive SSD"; on SIFT1B serves "**> 5000 queries/sec with < 3 ms mean latency and 95%+ 1-recall@1**"; in high-recall regimes "**index and serve 5–10× more points per node** compared to HNSW and NSG." Partition-and-merge enables out-of-core builds. **[PROVEN]**

### 5.4 ScaNN — anisotropic quantization (Google)

- **Title:** *Accelerating Large-Scale Inference with Anisotropic Vector Quantization*
- **Authors / year:** Guo, Sun, Lindgren, Geng, Simcha, Chern, Kumar — **ICML 2020**.
- **Link:** https://arxiv.org/abs/1908.10396 · https://github.com/google-research/google-research/tree/master/scann

**Method.** Quantization loss tuned for **maximum-inner-product search**: penalize the residual component **parallel** to the datapoint more than the orthogonal component (the parallel error is what corrupts large inner products = the relevant ones). **Claim (secondary):** outperforms other ANN libraries by ~**2×** on ann-benchmarks.com. **[PROVEN: ICML method; MARKETED: 2× headline]**

### 5.5 Filtered / predicate ANN — the part that matters most for samesake

samesake's **hard filters gate before ranking** (`price<=X`, `available=true`). With an **approximate** index this is the classic **over-filtering** failure: the index returns a fixed candidate budget, *then* the predicate culls it, often leaving too few results.

- **pgvector 0.8.0 — iterative index scans (the supported production fix).** With approximate indexes, "queries with filtering can return less results since filtering is applied **after** the index is scanned." Without it, "if a condition matches 10% of rows, with HNSW and the default `hnsw.ef_search` of 40, only ~4 rows match on average." Iterative scans "**keep fetching more candidates from the index until the filter is satisfied**" (`hnsw.iterative_scan` = `strict_order` | `relaxed_order`; bounded by `hnsw.max_scan_tuples`, `hnsw.scan_mem_multiplier`; IVFFlat analogues `ivfflat.iterative_scan` / `ivfflat.max_probes`). Tradeoff: **scanning more of the index raises latency** to recover completeness. **[PROVEN — pgvector docs/changelog; pgvector is MIT-licensed]**

- **Filtered-DiskANN** (Gollapudi et al., WWW 2023) — **filter-aware graph construction**: build edges that keep the subgraph for each filter value connected, so search stays within matching nodes. https://dl.acm.org/doi/10.1145/3543507.3583552
- **ACORN** — *ACORN: Performant and Predicate-Agnostic Search Over Vector Embeddings and Structured Data*, Patel, Kraft, Guestrin, Zaharia, **SIGMOD 2024**, https://arxiv.org/abs/2403.04871. Extends HNSW with **predicate-agnostic construction** + **predicate subgraph traversal**, supporting **arbitrary** predicates (not just small equality sets). Claim (verbatim): "**state-of-the-art performance on all datasets, outperforming prior methods with 2–1,000× higher throughput at a fixed recall.**" **[PROVEN]**
- **Survey:** *Survey of Filtered ANN Search over Vector-Scalar Hybrid Data* (2025), https://arxiv.org/abs/2505.06501 — frames the **prefilter vs postfilter** spectrum and where specialized graphs win (low-selectivity predicates, where postfilter collapses).

> **samesake takeaway — this is the load-bearing risk in the architecture.** "Hard filters gate before ranking" is **correct and the right product behavior**, but on an approximate HNSW index it is precisely the **over-filtering trap**. samesake **must**: (1) enable and tune **pgvector iterative scans** (`hnsw.iterative_scan='relaxed_order'`, sized `max_scan_tuples`); (2) for **highly selective** predicates, consider **pre-filter to a CTE then exact/`SET enable_seqscan` scan** (exact KNN is fine on small filtered sets — samesake's catalogs are not billions); (3) **eval-gate filtered-query recall explicitly**, not just unfiltered grade@10 — over-filtering is invisible in unfiltered benchmarks. The academic frontier (ACORN/Filtered-DiskANN) shows the *right* answer is predicate-aware traversal, which **pgvector does not yet implement** — so samesake's mitigation is iterative scans + small-set exact fallback, and `/search/explain` should surface when iterative scanning kicked in (auditability is already a samesake feature).

---

## 6. Quality vs latency vs catalog-size — the governing matrix

| Technique | Primary quality lever | Latency cost | Catalog-size scaling | Fits "just Postgres"? |
|---|---|---|---|---|
| **RRF fusion** | combines lexical+semantic, rank-only | negligible (merge) | trivial | **Yes** (native) |
| **Convex combination** | tuned α weighting | negligible | trivial | **Yes** (needs score normalization + labels) |
| **HNSW (pgvector)** | recall via M / ef_search | ef_search ↑ = latency ↑ | **RAM-bound**; great ≤ low-millions | **Yes** (native) |
| **IVFFlat (pgvector)** | nprobe | probe ↑ = latency ↑ | needs data at build; no compression | **Yes** (native, weaker than HNSW) |
| **IVF-PQ (Faiss)** | over-probe + rerank | µs on GPU | **billions in RAM** via PQ (lossy) | No (external engine) |
| **DiskANN/Vamana** | high recall on SSD | < 3 ms @ 1B | **billions on 1 node + SSD** | No |
| **ScaNN** | anisotropic quant for MIPS | very low | large-scale MIPS | No |
| **Filtered ANN (ACORN/Filtered-DiskANN)** | recall **under predicates** | predicate-aware traversal | scales with filter selectivity | No (pgvector lacks it → use **iterative scans**) |
| **SPLADE (LSR)** | learned term expansion | ~BM25 (if pruned) | postings bloat w/ expansion | Partial (`sparsevec`, but NC license) |
| **ColBERT/PLAID** | **token-level MaxSim (top quality)** | tens of ms (PLAID) | 140M passages shown | **No** (multi-vector, no pgvector path) |
| **Cross-encoder rerank** | **full cross-attention (top quality on top-k)** | **O(k) inferences** — the dominant cost | reranks a *candidate set* only | **Yes** (post-retrieval scorer; BYO model) |

**Reading the matrix for samesake (~5k → low-millions docs, single-node Postgres):**
- First-stage: **HNSW + Postgres FTS, fused by RRF** is the correct, native choice. No need for IVF-PQ/DiskANN/ScaNN — those solve a **billion-vector RAM/disk problem samesake doesn't have**, at the cost of leaving Postgres.
- Quality headroom comes from **(a) a cross-encoder reranker** (native-compatible, recommended) and **(b) CC fusion tuning** (native, needs labels), **not** from ColBERT/SPLADE (which cost the architecture).
- The **silent failure mode** is **filtered recall**, mitigated by **pgvector iterative scans + exact fallback on small filtered sets**.

---

## 7. PROVEN vs MARKETED ledger

**PROVEN (peer-reviewed / reproducible):**
- RRF beats Condorcet & supervised fusion on TREC (Cormack 2009).
- CC ≥ RRF in/out-of-domain with small tuning data; RRF *is* parameter-sensitive (Bruch TOIS 2023).
- ColBERT: 2 orders faster / 4 orders fewer FLOPs than BERT cross-encoders (SIGIR 2020).
- ColBERTv2: 6–10× smaller late-interaction index (NAACL 2022).
- PLAID: up to 7× GPU / 45× CPU latency cut vs ColBERTv2 (CIKM 2022).
- HNSW: log-scaling, SOTA in-memory ANN (TPAMI 2018).
- DiskANN: 1B points on 64 GB RAM + SSD, <3 ms, 95%+ recall@1 (NeurIPS 2019).
- ScaNN anisotropic quantization improves MIPS accuracy (ICML 2020).
- ACORN: 2–1000× throughput at fixed recall for predicate-agnostic search (SIGMOD 2024).
- pgvector over-filtering with approximate indexes; iterative scans as the fix (pgvector 0.8.0 docs/changelog). **pgvector is MIT-licensed.**
- Cross-encoder latency/candidate tradeoff; shallow CE +51% NDCG@10 at 25 ms budget (ECIR 2024).
- BEIR: hybrid beats best single retriever *except* on a known handful of datasets.

**MARKETED / config-dependent (verify before relying):**
- "SPLADE has latency on par with BM25" — true only with aggressive pruning/regularization; expansion bloats postings.
- IVF-PQ "30–60 GB for 1B 768-d vectors at 90%+ recall" — Faiss-blog figures, highly config-dependent (nlist, nbits, nprobe, rerank).
- ScaNN "2× faster than other libraries" — ann-benchmarks headline, dataset/param-dependent.
- Convex-combination Recall@5 0.726 vs RRF 0.716 — single secondary benchmark, not a general law.

---

## 8. Open questions for samesake

1. **What is samesake's filtered-query recall today?** Unfiltered grade@10 (~2.33) and P@5 (0.83) say nothing about over-filtering. Build a filtered-recall eval before trusting hard-filter-then-rank under HNSW.
2. **Cross-encoder reranker: BYO or bundled distilled?** A multimodal CE aligns with the enrich pipeline and is the strongest quality lever — but it adds an inference dependency. Gate it like "spaces."
3. **CC vs RRF default switch:** at what point (how many labeled queries) does samesake auto-promote a tenant from RRF to tuned CC?
4. **`sparsevec` for a SPLADE-style signal?** pgvector supports sparse vectors — is a *permissively-licensed* learned-sparse model worth it, or does enrich-generated lexical text capture most of the gain inside Postgres FTS already?
5. **Catalog-size ceiling:** at what tenant catalog size does pgvector HNSW (RAM-bound) stop being viable, forcing IVF-PQ/DiskANN-style external infra — and does that break the two-container promise?
6. **Should `/search/explain` surface fusion internals** (per-component ranks, whether iterative scanning triggered, RRF vs CC contribution) to make the hybrid auditable?

---

## Sources

- Cormack, Clarke, Büttcher — *RRF outperforms Condorcet…* — SIGIR 2009: https://dl.acm.org/doi/10.1145/1571941.1572114 · PDF: https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf
- Bruch, Gai, Ingber — *An Analysis of Fusion Functions for Hybrid Retrieval* — TOIS 2023: https://arxiv.org/abs/2210.11934 · https://dl.acm.org/doi/10.1145/3596512
- Khattab, Zaharia — *ColBERT* — SIGIR 2020: https://arxiv.org/abs/2004.12832
- Santhanam et al. — *ColBERTv2* — NAACL 2022: https://arxiv.org/abs/2112.01488
- Santhanam et al. — *PLAID* — CIKM 2022: https://arxiv.org/abs/2205.09707
- Formal, Piwowarski, Clinchant — *SPLADE* — SIGIR 2021: https://arxiv.org/abs/2107.05720 · *SPLADE v2*: https://arxiv.org/abs/2109.10086 · code: https://github.com/naver/splade
- *Towards Effective and Efficient Sparse Neural IR* — TOIS 2024: https://dl.acm.org/doi/10.1145/3634912
- *Efficiency and Effectiveness of SPLADE at Billion-Scale* — 2025: https://arxiv.org/abs/2511.22263
- Nogueira, Cho — *Passage Re-ranking with BERT* — 2019: https://arxiv.org/abs/1901.04085
- *Shallow Cross-Encoders for Low-Latency Retrieval* — ECIR 2024: https://arxiv.org/abs/2403.20222
- Malkov, Yashunin — *HNSW* — TPAMI 2018 / arXiv 2016: https://arxiv.org/abs/1603.09320
- Jégou, Douze, Schmid — *Product Quantization* — TPAMI 2011 · Faiss wiki: https://github.com/facebookresearch/faiss/wiki
- Subramanya et al. — *DiskANN* — NeurIPS 2019: https://suhasjs.github.io/files/diskann_neurips19.pdf
- Guo et al. — *Anisotropic Vector Quantization (ScaNN)* — ICML 2020: https://arxiv.org/abs/1908.10396 · code: https://github.com/google-research/google-research/tree/master/scann
- Gollapudi et al. — *Filtered-DiskANN* — WWW 2023: https://dl.acm.org/doi/10.1145/3543507.3583552
- Patel, Kraft, Guestrin, Zaharia — *ACORN* — SIGMOD 2024: https://arxiv.org/abs/2403.04871
- *Survey of Filtered ANN Search* — 2025: https://arxiv.org/abs/2505.06501
- pgvector (MIT) — repo & iterative-scan docs: https://github.com/pgvector/pgvector · pgvector 0.8.0 notes: https://www.thenile.dev/blog/pgvector-080
