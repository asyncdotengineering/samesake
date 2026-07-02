# Query-Side Processing: Understanding, Expansion/Rewriting, and Reranker Models

> Completeness-pass deep-dive for **samesake** — a TypeScript-first "search engine
> compiler" for visual commerce (fashion-first, Sri Lankan corpus: Sinhala/Tamil/English
> code-mixed). samesake compiles a typed catalog into a Postgres + pgvector layer running
> in the user's app (two containers; no Redis/Elasticsearch/hosted vector DB). Retrieval =
> Postgres FTS + cosine ANN over BYO embeddings + optional typed "spaces", fused via RRF.
> Hard filters compile to SQL predicates that gate before ranking. It has an NLQ parser
> (constrained schema), multimodal enrich pipeline, entity-resolution/dedup,
> `/search/explain`, and a `findProducts()` agentic surface that STOPS at retrieval.
> It already *plans* a cross-encoder reranker but never said **which one**. This document
> fills the entire query-side stack beyond the NLQ parser.

**Scope.** Three sub-areas:
1. **Query understanding** — typo correction, segmentation, attribute/entity extraction,
   unit/measurement parsing, color/size normalization, LLM-generated synonyms & taxonomies.
2. **Query expansion / rewriting** — HyDE, query2doc, doc2query/docTTTTTquery (index-time),
   pseudo-relevance feedback (PRF/RM3) — which help dense vs sparse, which fit Postgres.
3. **Reranker model landscape** — bge-reranker-v2-m3, Cohere Rerank 3.5, Jina v2,
   mxbai-rerank v2, MonoT5, listwise LLM rerankers, and feature-based LTR (LambdaMART/XGBoost).

**Evidence convention.** **[PROVEN]** = paper/benchmark/official doc/LICENSE.
**[MARKETED]** = vendor blog or unverified third-party comparison.

---

## Part 1 — Query Understanding

The NLQ parser samesake already ships turns a natural-language query into a *constrained
schema* (filters + intent). That is the **structural** half. The **lexical/normalization**
half — making the raw tokens match the corpus before any embedding or SQL runs — is the gap.
For an LK code-mixed corpus this half is disproportionately important: the weakest benchmark
type ("local" queries) fails primarily on **vocabulary mismatch**, not on intent parsing.

### 1.1 Spelling / typo correction

Two families, and the choice matters for code-mixed input:

- **Lexical / edit-distance** (SymSpell, Postgres `pg_trgm` similarity, Levenshtein). Cheap,
  deterministic, no model. Postgres already ships `pg_trgm` (trigram) and `fuzzystrmatch`
  (Levenshtein, Soundex, Metaphone) — so samesake can do typo correction **in the same
  container** with a GIN trigram index. This is the natural fit.
- **Context-sensitive / neural** (LLM rewrite, char-level seq2seq). Handles real-word errors
  ("blak" vs "back") and transliteration variance but adds an LLM call.

**LK-specific risk:** romanized Sinhala/Tamil has *no canonical spelling* ("kurthi" /
"kurti" / "kurtha" / "kurutha"). Edit-distance alone collapses these only if the corpus side
is also normalized. The durable fix is a **transliteration-aware normalization map built at
index time** (see 1.6 synonyms), not query-time fuzzy matching alone.

### 1.2 Query segmentation

Splitting a multi-concept query into spans ("red cotton saree blouse under 3000" →
[color=red][material=cotton][garment=saree blouse][price<3000]). In an e-commerce stack this
overlaps heavily with attribute extraction (1.3) — for samesake it is effectively the same
pass that feeds the NLQ parser's constrained schema. Worth treating as one step.

### 1.3 Attribute / entity extraction

This is the most mature LLM-for-commerce area and directly relevant.

- **[PROVEN]** *PAE: LLM-based Product Attribute Extraction for E-Commerce Fashion Trends*
  (arXiv:2405.17533, 2024) extracts fashion attributes — "color, sleeve style, product type,
  material, features, categories, age, and neck styles" — from **both text and images**,
  which aligns with samesake's multimodal enrich pipeline.
- **[PROVEN]** *Using LLMs for the Extraction and Normalization of Product Attribute Values*
  (arXiv:2403.02130, 2024) is the key citation for samesake because it frames extraction **and
  normalization** together and enumerates the exact failure modes samesake will hit:
  "granularity differences, morphological variations, multiple valid values, missing units,
  equivalent attribute definitions, contextual synonyms, and format variations."
- **[PROVEN]** *LLM-Ensemble* (arXiv:2403.00863) shows ensembling multiple LLMs improves
  attribute-value extraction — relevant only if accuracy justifies cost.

**Fit:** the **query-side** attribute extractor and the **index-side** enrich pipeline should
share one taxonomy and one normalization vocabulary. If query "kurti" and catalog "kurta top"
don't normalize to the same canonical value, no reranker downstream recovers it.

### 1.4 Unit & measurement parsing

Numeric/units normalization (size 8 vs UK 8 vs EU 38; "under 3k" → 3000 LKR; waist 32 →
inches). This is **deterministic parsing**, not ML, and belongs in the NLQ parser's
constrained schema where it compiles directly to SQL `WHERE` predicates (samesake's hard
filters). The research literature flags **"missing units"** as a top normalization failure
(arXiv:2403.02130) — for LK fashion, currency ("3k"/"Rs."/"LKR") and dual size systems
(UK/EU/US/free-size) are the concrete cases.

### 1.5 Color / size normalization

Colors and sizes are high-cardinality, synonym-rich, multilingual facets — the canonical
faceted-search normalization problem. arXiv:2403.02130 explicitly motivates normalization by
faceted search: "to enable features such as faceted product search ... it is necessary to ...
normalize the extracted values to a single, unified scale for each attribute." For LK:
"red"/"රතු"/"சிவப்பு"/"maroon"/"crimson" must collapse to one canonical color node, and
"free size"/"FS"/"one size" to one size node. This is a **controlled-vocabulary** problem
solved once at index time and reused at query time — not a per-query LLM call.

### 1.6 Synonym & taxonomy generation (LLM-generated)

The highest-leverage, lowest-risk query-understanding lever for samesake's weakest benchmark.

- **[MARKETED]** Industry consensus: "LLMs grasp semantic meanings in customer queries by
  utilizing synonyms, spell corrections, and relaxation rules" and "expanding queries with
  related terms and synonyms" (netguru LLM-use-cases survey). Treat as direction, not proof.
- **Pattern:** generate a **synonym/taxonomy dictionary offline** (LLM produces
  garment→synonym sets, color→variant sets, transliteration variants) → curate → load as a
  Postgres FTS **synonym dictionary** (`ts_dict` / thesaurus) and/or an expansion map. This
  pushes the LLM cost to build-time (matching the doc2query philosophy in Part 2) and keeps
  query-time deterministic and offline-capable — critical for samesake's no-external-deps,
  two-container posture.

**Why this beats query-time HyDE for LK:** an LLM is far better at *enumerating* known
transliteration variants of "kurti" once, offline, with human review, than at *hallucinating*
a fluent Sinhala-fashion hypothetical document per query at runtime (HyDE is documented to
degrade in low-resource settings — see 2.1). Synonyms are the safe LLM lever; HyDE is the
risky one for this corpus.

---

## Part 2 — Query Expansion / Rewriting

The central question for samesake: **which techniques help dense (pgvector ANN) vs sparse
(Postgres FTS), and which fit a Postgres-only, two-container, offline-capable runtime?**

| Technique | Where LLM runs | Helps sparse (FTS) | Helps dense (ANN) | Latency cost | Postgres fit |
|---|---|---|---|---|---|
| **doc2query / docTTTTTquery** | **Index time** | **Yes (strong)** | Indirect | Zero at query time | **Excellent** |
| **HyDE** | Query time | Weak | **Yes (strong)** | +1 LLM gen/query | Poor (online LLM) |
| **query2doc** | Query time | **Yes** | Yes | +1 LLM gen/query | Poor (online LLM) |
| **PRF / RM3** | None (stat.) | **Yes** | Yes (vector PRF) | +1 retrieval round | **Good (SQL-able)** |
| **LLM synonym expansion** | **Build time** | **Yes** | n/a (lexical) | Zero at query time | **Excellent** |

### 2.1 HyDE — Hypothetical Document Embeddings

- **[PROVEN]** *Precise Zero-Shot Dense Retrieval without Relevance Labels*, Gao, Ma, Lin,
  Callan, **2022** (arXiv:2212.10496). Method: zero-shot instruct an LLM to **generate a
  hypothetical document** for the query, embed *that* with an unsupervised encoder, and ANN on
  the resulting vector — "This vector identifies a neighborhood in the corpus embedding space,
  where similar real documents are retrieved." Verbatim claim: *"HyDE significantly outperforms
  the state-of-the-art unsupervised dense retriever Contriever and shows strong performance
  comparable to fine-tuned retrievers, across various tasks (e.g. web search, QA, fact
  verification) and languages (e.g. sw, ko, ja)."*
- **Mechanism note (load-bearing):** *"The document captures relevance patterns but is unreal
  and may contain false details ... the encoder's dense bottleneck filtering out the incorrect
  details."* HyDE is **a dense-retrieval technique** — it produces a query-vector, so it only
  helps samesake's **pgvector ANN leg**, not its FTS leg.
- **[PROVEN] Limitations for samesake's exact corpus:**
  - **Low-resource degradation:** *Query Expansion in the Age of LLMs* survey (arXiv:2509.07794)
    and follow-ups note HyDE "requires special adaptations for low-resource contexts" and that
    "prompt engineering ... feedback term filtering, and feedback weighting (Rocchio/RM3) are
    essential to curb off-topic expansions." Sinhala/Tamil fashion is exactly low-resource.
  - **Hallucination/drift:** "Zero-grounding methods like HyDE ... risk drift and hallucination
    without corrective signals"; "for well-specified, fact-bound domains ... HyDE is prone to
    hallucination."
  - **Latency:** "on small LLMs, HyDE incurs a 25–60% increase over RAG"; one extra LLM
    generation per query (often multiple hypothetical docs averaged).
- **Verdict for samesake:** **differentiate, don't default.** HyDE breaks samesake's
  offline/no-external-deps promise (needs an online generation model per query) and is weakest
  on the LK corpus. Viable only as an **opt-in BYO-generation enhancement** for the ANN leg in
  English/well-specified queries, gated behind `/search/explain` auditability.

### 2.2 query2doc

- **[PROVEN]** *Query2doc: Query Expansion with Large Language Models*, Wang, Yang, Wei,
  **EMNLP 2023** (arXiv:2303.07678). Method: few-shot prompt an LLM to generate a
  pseudo-document, then **concatenate it to the original query** (not replace the embedding).
  Verbatim: *"first generates pseudo-documents by few-shot prompting large language models
  (LLMs), and then expands the query with generated pseudo-documents."* Results: *"Boosts BM25
  performance by 3-15% on ad-hoc IR datasets (MS-MARCO, TREC DL)"* and improves dense retrievers
  in- and out-of-domain.
- **Key difference vs HyDE:** query2doc **keeps the original query terms** and appends generated
  text → it **helps sparse/BM25 (and Postgres FTS) directly**, where HyDE (vector-only) does
  not. The original query anchors against drift.
- **Verdict:** same online-LLM objection as HyDE, but **safer** (anchored, helps FTS).
  Same opt-in BYO-generation tier. If samesake ever runs an online generation model on the
  query path, **prefer query2doc over HyDE** because it benefits both retrieval legs and
  resists hallucination.

### 2.3 doc2query / docTTTTTquery — index-time expansion (best Postgres fit)

- **[PROVEN]** *From doc2query to docTTTTTquery*, Nogueira & Lin, **2019**
  (cs.uwaterloo.ca/~jimmylin/publications/Nogueira_Lin_2019_docTTTTTquery-v2.pdf; code:
  github.com/castorini/docTTTTTquery). Method: train a model (T5 in docTTTTTquery) to
  **generate likely queries a document answers**, append them to the document, then index the
  augmented documents. Reported: docTTTTTquery scores 0.21 BLEU vs doc2query's 0.088; each doc
  expanded with ~40 queries.
- **Decisive advantage (verbatim sense):** "expensive neural inference is pushed to indexing
  time ... 'bag of words' queries against an inverted index built on the augmented document
  collection are only slightly slower ... but the retrieval results are much better."
- **[PROVEN]** *Doc2Query--: When Less is More* (arXiv:2301.03266) shows filtering hallucinated
  expansions ("less is more") improves quality — the practical guardrail for production.
- **Verdict for samesake:** **ADOPT (highest priority of Part 2).** This is the *only* expansion
  technique that costs **zero at query time**, needs **no online LLM**, and **directly boosts
  Postgres FTS** — perfectly matching samesake's offline, two-container, FTS+ANN architecture.
  Run BYO generation model **inside the enrich/compile step** to append predicted queries
  (including LK transliteration variants and Sinhala/Tamil/English code-mixed forms) to each
  product's FTS document. This attacks vocabulary mismatch — samesake's actual failure mode —
  at the source. Apply Doc2Query-- filtering to avoid bloating the index with noise.

### 2.4 Pseudo-relevance feedback (PRF / RM3)

- **[PROVEN]** RM3: estimate an expanded query model from top-k first-pass results, interpolate
  expansion-term probabilities with original-query terms. Standard baseline in Anserini.
  Caveat: "remain vulnerable to topic drift when early results include noisy or tangential
  content" (arXiv:2601.11238 and the multi-dimensional PRF survey, Nature Sci. Reports 2024).
- **Vector PRF:** ColBERT-PRF / ANCE-PRF transform the **query vector** using first-pass result
  vectors (arXiv:2108.11044, *PRF with Deep LMs and Dense Retrievers: Successes and Pitfalls*).
  This is implementable in pgvector: run ANN, average the top-k result embeddings with the query
  embedding (Rocchio-style), re-run ANN — pure SQL + vector math, **no LLM, no new dependency.**
- **Verdict for samesake:** **integrate as an optional second retrieval round**, fully inside
  Postgres. Sparse RM3 can expand the FTS query from `ts_stat` term frequencies in top-k;
  vector PRF can nudge the ANN query vector. Both are deterministic and offline-capable. Risk =
  latency (one extra round) + drift; gate behind a flag and surface in `/search/explain`. Lower
  priority than doc2query but architecturally the **cleanest online expansion** for this stack.

---

## Part 3 — Reranker Model Landscape

samesake recommended "a cross-encoder" without naming one. Below are the real candidates with
licenses, sizes, latency, and BYO-fit. Three architectural classes:

1. **Cross-encoder rerankers** (query+doc → score): bge-reranker-v2-m3, Jina v2, mxbai-rerank,
   MonoT5, ms-marco-MiniLM. The default "cross-encoder" samesake meant.
2. **API rerankers** (managed): Cohere Rerank 3.5/4.
3. **Listwise LLM rerankers** (rank a whole list): RankZephyr / RankLLM.
4. **Feature-based LTR** (gradient-boosted trees over features): LambdaMART / XGBoost.

### 3.1 Comparison table

| Model | Type | Size | License | Languages | Latency (claimed) | Evidence | BYO/offline fit |
|---|---|---|---|---|---|---|---|
| **bge-reranker-v2-m3** | Cross-encoder | **0.6B params** | **Apache-2.0** | **100+** (built on bge-m3) | "50-100ms" GPU; "200-400ms" CPU [MARKETED]; ~0.14s/query nDCG@10 0.913 [MARKETED bench] | HF model card **[PROVEN]** for size/license | **Best** — self-host, multilingual, permissive |
| **Cohere Rerank 3.5** | API | n/a (hosted) | Proprietary API | EN + multilingual (= embed-multilingual-v3.0) | "100-150ms" [MARKETED]; ~595-603ms avg [MARKETED] | Cohere docs **[PROVEN]** ctx=4096; pricing | **Poor** — external dep, breaks 2-container/offline |
| **Jina reranker v2 base** | Cross-encoder | **278M (0.3B)** | **CC-BY-NC-4.0** (non-commercial weights) | 26 langs (MKQA) / 13 (MLDR) | "0.06s/query", nDCG@10 0.907 [MARKETED bench]; 3-6x w/ flash-attn | HF card **[PROVEN]** license | **Blocked** — weights NC; commercial = paid API only |
| **mxbai-rerank-large-v2** | Cross-encoder | **2B params** | **Apache-2.0** | **100+** | "0.89s" on A100 [MARKETED] | HF card **[PROVEN]** size/license; BEIR 57.49 [MARKETED] | Good (permissive) but **2B = heavier** |
| **mxbai-rerank-base-v2** | Cross-encoder | ~0.5B | **Apache-2.0** | 100+ | "0.67s" A100 [MARKETED]; BEIR 55.57 [MARKETED] | HF card **[PROVEN]** | Good — lighter mxbai option |
| **MonoT5 (base/3B)** | Seq2seq pointwise | 60M/220M/**3B** | **Apache-2.0** (T5 base) | EN-centric | slower (T5 gen) | Castorini/pygaggle **[PROVEN]** sizes; BEIR SOTA-class [PROVEN paper] | OK but EN-centric, dated vs bge |
| **RankZephyr** | Listwise LLM | **7B** | (Zephyr/MIT-family) | EN-centric | high (LLM gen) | arXiv:2312.02724 **[PROVEN]** | Heavy; quality-max only |
| **LambdaMART / XGBoost** | Feature LTR | tiny (trees) | **Apache-2.0** (XGBoost) | language-agnostic (features) | <1ms/doc | XGBoost docs **[PROVEN]** | **Excellent** — needs click/feature data |
| **ms-marco-MiniLM-L-6-v2** | Cross-encoder | 22M | Apache-2.0 | **EN only** | "<50ms" [MARKETED] | sbert **[PROVEN]** | Fast but English-only → wrong for LK |
| **VERDICT** | — | — | — | — | — | — | **bge-reranker-v2-m3 = default; LambdaMART = phase-2 personalized stage; mxbai-base = alt; Cohere = managed escape hatch; Jina/MiniLM/MonoT5 = avoid** |

### 3.2 Why bge-reranker-v2-m3 is the default cross-encoder for samesake

- **[PROVEN] License:** `apache-2.0` (HF model card) — no commercial restriction, safe to ship
  inside a customer's app. This alone eliminates **Jina v2** (CC-BY-NC-4.0: *"licenced for
  research and evaluation purposes ... For commercial usage, please refer to Jina AI's APIs"*).
- **[PROVEN] Multilingual:** built on bge-m3, **100+ languages** — the only candidate that
  credibly covers Sinhala/Tamil/English code-mixed without an English-only ceiling (rules out
  ms-marco-MiniLM and largely MonoT5).
- **Size/latency:** 0.6B params is the sweet spot — lighter than mxbai-large (2B) and RankZephyr
  (7B), heavier than MiniLM but multilingual. **[MARKETED]** ~50-100ms GPU / 200-400ms CPU and
  ~0.14s/query with nDCG@10 0.913 (third-party benches; treat as directional, not contractual).
- **Architecture fit:** pure model weights + BYO inference → drops into samesake's BYO-model
  posture and stays inside the two containers. No network egress, works offline.

### 3.3 Cohere Rerank 3.5 — the managed escape hatch (not the default)

- **[PROVEN]** Context length 4096 tokens; *"Performs well in English and non-English languages;
  supports the same languages as embed-multilingual-v3.0"*; *"A single search unit is defined as
  one query with up to 100 documents to be ranked"* (Cohere docs/pricing).
- **[PROVEN] Pricing:** pay-as-you-go Rerank v3 ≈ **$2.00 per 1M tokens** of query+documents
  (aipricing.guru, eesel) — enterprise/dedicated is custom (Model Vault ~$5/hr or $3,250/mo per
  Medium instance, per Cohere pricing page). Per-search billing historically quoted ~$2/1000
  searches; current public tier is token-based.
- **Verdict:** **AVOID as default** — it is an external network dependency and a hosted service,
  directly contradicting samesake's "no Redis/Elasticsearch/hosted vector DB, runs in your app"
  thesis. Keep as a documented **opt-in managed adapter** for users who explicitly want SLA/zero
  GPU ops and accept the dependency.

### 3.4 mxbai-rerank v2 — the viable Apache-2.0 alternative

- **[PROVEN]** `apache-2.0`; large-v2 = **2B params**, base-v2 ≈ 0.5B, 100+ languages.
  **[MARKETED]** BEIR avg 57.49 (large) / 55.57 (base); 0.89s / 0.67s on A100.
- **Verdict:** strong **alternative** to bge. `mxbai-rerank-base-v2` competes with bge on size;
  large-v2 trades 2B-param latency for top BEIR. Offer as a swappable BYO reranker, but bge-v2-m3
  remains default on the **proven** multilingual + lighter-weight combination.

### 3.5 MonoT5, Jina v2, MiniLM, RankZephyr — why they're not the pick

- **MonoT5** **[PROVEN]** Apache-2.0, sizes 60M/220M/3B, BEIR SOTA-class in its era — but
  seq2seq generation is slower than a classifier cross-encoder and the strong variants are
  **English-centric**. Superseded for multilingual commerce by bge/mxbai.
- **Jina v2** — best-in-class small multilingual reranker on **[MARKETED]** benches, but
  **CC-BY-NC weights are a hard commercial blocker** for an embedded library. **Avoid.**
- **ms-marco-MiniLM-L-6-v2** — fastest (~22M, <50ms) but **English-only** → structurally wrong
  for the LK corpus.
- **RankZephyr** **[PROVEN]** (arXiv:2312.02724) — 7B open listwise LLM, *"competitive ... and,
  in a few cases, goes beyond RankGPT4"*. Quality-max but heavyweight and EN-centric; reserve for
  a future "max-quality" tier, not the default.

### 3.6 Feature-based LTR (LambdaMART / XGBoost) — the *complementary* stage

This is **not** an alternative to a cross-encoder; it's a different layer.

- **[PROVEN]** XGBoost's `rank:ndcg` objective implements LambdaMART (XGBoost LTR docs,
  Apache-2.0). It ranks over **feature vectors** (BM25/FTS score, ANN cosine, RRF rank, price,
  recency, popularity, **click/CTR signals**, freshness) and directly optimizes NDCG.
- **Why it fits samesake's roadmap:** samesake already plans **score modifiers** and
  **context-vector personalization**. A LambdaMART stage is the principled home for exactly those
  signals — it fuses the retrieval scores samesake already computes (FTS, ANN, RRF) **plus**
  business features into one learned ranking, with millisecond per-doc inference and a tiny model.
- **Constraint:** needs **labeled/click data**, which a new deployment lacks → this is a
  **phase-2** stage that switches on once a tenant has interaction logs. Until then, the
  cross-encoder (bge) carries reranking.
- **Recommended layering:** `FTS + ANN (+spaces) → RRF fusion → bge cross-encoder rerank →
  (phase 2) LambdaMART feature rerank with personalization/score modifiers`.

---

## Relevance to samesake — adopt / avoid / differentiate / integrate

**ADOPT (do this):**
1. **doc2query/docTTTTTquery at index time** (BYO generation model inside enrich/compile),
   appending predicted queries **including LK transliteration & code-mixed variants** to each
   product's FTS document, with Doc2Query-- filtering. Single highest-leverage move against
   vocabulary mismatch — samesake's documented weakest spot — and it costs **zero at query time**.
2. **bge-reranker-v2-m3** as the named default cross-encoder: Apache-2.0, 100+ langs, 0.6B,
   self-hostable inside the two containers. This is the concrete answer to the unspecified
   "a cross-encoder."
3. **LLM-generated synonym/taxonomy dictionary built offline**, loaded as a Postgres FTS
   thesaurus + canonical normalization map for color/size/garment (shared by query-side
   extraction and index-side enrich).
4. **Deterministic unit/measurement + color/size normalization** in the NLQ-parser → SQL
   hard-filter path (currency "3k"/"Rs.", UK/EU/US/free-size).

**INTEGRATE (optional, gated, in-Postgres):**
5. **Vector PRF (Rocchio over pgvector) and sparse RM3 (over `ts_stat`)** as an opt-in second
   retrieval round — no new dependency, fully offline, surfaced in `/search/explain`.
6. **LambdaMART/XGBoost feature-rerank stage** as the phase-2 home for samesake's planned
   score modifiers + context-vector personalization, switched on once click/interaction data
   exists.
7. **mxbai-rerank-base-v2** as a swappable Apache-2.0 alternative reranker; **Cohere Rerank 3.5**
   as a documented managed adapter for users who accept the external dependency.

**DIFFERENTIATE (be deliberate, don't default):**
8. **HyDE / query2doc** require an **online generation model per query**, which breaks
   samesake's offline/no-external-deps promise and are **weakest on the low-resource LK corpus**
   (documented HyDE degradation + hallucination). Offer only as an opt-in BYO-generation tier
   for the ANN leg; **prefer query2doc over HyDE** (anchored, helps FTS too, resists drift).

**AVOID:**
9. **Jina reranker v2** (CC-BY-NC weights — commercial blocker for an embedded library),
   **ms-marco-MiniLM** (English-only), **RankZephyr/MonoT5-3B** as defaults (heavy + EN-centric).

**Architectural through-line:** every recommended lever either runs **at build/index time**
(doc2query, synonyms, normalization) or **inside Postgres/the two containers** (bge reranker,
PRF, LambdaMART). The query-time-online-LLM techniques (HyDE/query2doc/Cohere) are all pushed to
opt-in tiers — preserving samesake's "runs in your app, no hosted services, offline-capable"
identity while still naming concrete, modern best-in-class options.

---

## Open questions

1. **doc2query for code-mixed:** does a BYO generation model produce *useful* Sinhala/Tamil
   query predictions, or only English? Needs an eval on the ~5k LK corpus measuring grade@10 /
   P@5 uplift on "local" queries specifically.
2. **bge-reranker-v2-m3 on LK code-mixed:** its 100+ langs cover Sinhala/Tamil nominally, but
   no public benchmark proves code-mixed reranking quality. Needs an in-corpus A/B vs RRF-only.
3. **CPU vs GPU for bge:** can ~0.6B cross-encoder rerank top-50 within an acceptable budget on
   CPU-only deployments (the realistic two-container default), or does it force a GPU container?
4. **PRF drift on a 5k corpus:** with only ~5k docs, do top-k PRF expansions help or amplify
   noise? Small corpora are drift-prone — needs measurement.
5. **Synonym dictionary maintenance:** who curates the LLM-generated thesaurus, and how is it
   versioned/audited so `/search/explain` can attribute a match to a synonym rule?
6. **Index size from doc2query:** appending ~40 predicted queries/doc inflates the FTS index;
   what is the storage/latency cost at LK-catalog scale, and does Doc2Query-- filtering keep it
   bounded?
7. **LambdaMART cold start:** what is the minimum interaction volume before the feature-rerank
   stage beats the bge cross-encoder, and how to fall back gracefully before then?
8. **mxbai vs bge head-to-head** on the actual LK corpus — the public BEIR gap (57.49 vs n/a)
   does not predict code-mixed fashion performance.

---

## Sources

**Query expansion / rewriting (papers):**
- HyDE — *Precise Zero-Shot Dense Retrieval without Relevance Labels*, Gao, Ma, Lin, Callan, 2022. https://arxiv.org/abs/2212.10496
- *Query2doc: Query Expansion with Large Language Models*, Wang, Yang, Wei, EMNLP 2023. https://arxiv.org/abs/2303.07678
- *From doc2query to docTTTTTquery*, Nogueira & Lin, 2019. https://cs.uwaterloo.ca/~jimmylin/publications/Nogueira_Lin_2019_docTTTTTquery-v2.pdf — code: https://github.com/castorini/docTTTTTquery
- *Doc2Query--: When Less is More*, 2023. https://arxiv.org/pdf/2301.03266
- *Query Expansion in the Age of Pre-trained and Large Language Models: A Survey*, 2025. https://arxiv.org/pdf/2509.07794
- *Pseudo Relevance Feedback with Deep Language Models and Dense Retrievers: Successes and Pitfalls*, 2021. https://arxiv.org/pdf/2108.11044
- *A multi-dimensional semantic pseudo-relevance feedback framework*, Nature Sci. Reports, 2024. https://www.nature.com/articles/s41598-024-82871-0
- *LLM-Assisted Pseudo-Relevance Feedback*, 2026. https://arxiv.org/abs/2601.11238

**Query understanding (commerce):**
- *PAE: LLM-based Product Attribute Extraction for E-Commerce Fashion Trends*, 2024. https://arxiv.org/abs/2405.17533
- *Using LLMs for the Extraction and Normalization of Product Attribute Values*, 2024. https://arxiv.org/pdf/2403.02130
- *LLM-Ensemble: Optimal LLM Ensemble for E-commerce Product Attribute Value Extraction*, 2024. https://arxiv.org/pdf/2403.00863
- *17 Proven LLM Use Cases in E-commerce* (industry survey). https://www.netguru.com/blog/llm-use-cases-in-e-commerce

**Reranker models (model cards / docs):**
- bge-reranker-v2-m3 (Apache-2.0, 0.6B). https://huggingface.co/BAAI/bge-reranker-v2-m3
- Cohere Rerank docs (v3.5, ctx 4096). https://docs.cohere.com/docs/rerank — pricing: https://cohere.com/pricing , https://www.aipricing.guru/cohere-pricing/
- jina-reranker-v2-base-multilingual (CC-BY-NC-4.0, 278M). https://huggingface.co/jinaai/jina-reranker-v2-base-multilingual
- mxbai-rerank-large-v2 (Apache-2.0, 2B). https://huggingface.co/mixedbread-ai/mxbai-rerank-large-v2
- MonoT5 — castorini/pygaggle (Apache-2.0, 60M/220M/3B). https://github.com/castorini/pygaggle ; https://huggingface.co/castorini/monot5-3b-msmarco
- *RankZephyr: Effective and Robust Zero-Shot Listwise Reranking is a Breeze!*, 2023. https://arxiv.org/abs/2312.02724 ; RankLLM: https://castorini.github.io/rank_llm/

**Feature-based LTR:**
- XGBoost Learning to Rank (rank:ndcg / LambdaMART), Apache-2.0. https://xgboost.readthedocs.io/en/latest/tutorials/learning_to_rank.html
- *LambdaMART Explained* (Shaped). https://www.shaped.ai/blog/lambdamart-explained-the-workhorse-of-learning-to-rank

**Reranker comparisons (third-party, [MARKETED]):**
- *Best Reranker Models for RAG* (BSWEN, 2026). https://docs.bswen.com/blog/2026-02-25-best-reranker-models/
- *Best Rerankers for RAG in 2026* (futureagi). https://futureagi.com/blog/best-rerankers-for-rag-2026
- Agentset reranker leaderboard/compare. https://agentset.ai/rerankers
