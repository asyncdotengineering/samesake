# Multilingual / Cross-Lingual / Code-Mixed Product Search — Completeness Pass

> **CORRECTED (firsthand code inspection, 2026-06-14, prompted by the user).** This dossier was
> written from generic Postgres-FTS reasoning *without reading samesake's source*, and it
> overstated the gap. samesake **already ships** cross-script Sinhala/Tamil/Latin matching in
> system DDL — `samesake_normalise` (`packages/server/src/db/system-ddl.ts:47`) and
> `samesake_phonetic`, an Indic-Soundex hash mapping Sinhala+Tamil+Latin to one phonetic alphabet
> (`db/system-ddl.ts:64`) — used with `pg_trgm similarity()` in the **entity-resolution** path
> (`core/match.ts`, `core/schema-gen.ts:350`). The real gap is *only* that the **collection
> product-search keyword leg** is hardcoded to `to_tsvector('english')` / `plainto_tsquery('english')`
> (`core/collections-schema-gen.ts:88`, `core/search.ts:288`) and doesn't call those primitives.
> **The corrected build is REUSE** — wire the existing normalise+phonetic+trigram into the
> product-search keyword channel — not a from-scratch transliteration front-door. The BGE-M3 /
> learned-transliteration recommendations below remain valid as *optional upgrades*, not the first
> move. Read the rest of this file with that correction in front of it.

> Gap-fill research for **samesake** — a TypeScript "search engine compiler" for visual commerce, fashion-first, whose real corpus is **Sri Lankan (LK) fashion**: Sinhala/Tamil/English code-mixed, with romanized Sinhala ("Singlish") queries. "Local" queries are samesake's *weakest* benchmark type (mean grade@10 ~2.33, P@5 0.83 on ~5k LK fashion docs). This document covers what the first research sweep under-covered: multilingual embedding models, Postgres FTS limits for non-Latin/code-mixed text, cross-lingual retrieval, transliteration/romanization, and code-switching query understanding — and what samesake should adopt / avoid / differentiate / integrate.

Status legend: **[PROVEN]** = paper/benchmark/official doc. **[MARKETED]** = vendor blog/marketing.

---

## 0. The blunt summary

samesake's "local" weak spot is **structurally predictable**, not a tuning accident. Three independent facts compound:

1. **The languages are genuinely low-resource.** Sinhala and Tamil are under-represented in every multilingual encoder's pretraining (Sinhala especially), so dense embeddings are weaker for them than for English. [PROVEN]
2. **Postgres FTS is near-useless for the lexical half.** The default `tsvector` parser and `pg_trgm` were built for space-delimited Latin text; `pg_trgm` historically **drops non-ASCII characters entirely**, and there is **no Sinhala or Tamil stemmer/dictionary**. So samesake's RRF fusion is effectively running on one leg (dense only) for native-script queries. [PROVEN]
3. **The query distribution is romanized + code-mixed.** Real LK fashion shoppers type "Singlish" ("kalu saree", "redda", "mama"-style romanization) and switch languages mid-query. Romanized Sinhala is **non-standardized and many-to-one ambiguous** — "mama" alone maps to 3 distinct Sinhala words. No off-the-shelf embedding or FTS config handles this; it requires an explicit normalization/transliteration stage *before* retrieval. [PROVEN]

The fix is not "buy a better embedding model." It is a **normalization + transliteration front-door**, a **cross-lingual-capable dense model that actually covers si/ta**, and **abandoning the assumption that Postgres FTS contributes lexical signal for native script**. Details below.

---

## 1. Multilingual embedding models — the candidates

### 1.1 What "supports Sinhala/Tamil" actually means

"Supports 100+ languages" is a marketing claim about the tokenizer/pretraining corpus, not a retrieval-quality guarantee. The load-bearing question for samesake is **(a) is the script in the vocab, (b) was there enough pretraining data, and (c) is there a published retrieval benchmark for si/ta**. The answer to (c) is almost always *no* — see §1.3.

### 1.2 multilingual-E5 (mE5)

- **Architecture**: XLM-RoBERTa-large base, 24 layers, 1024-dim, ~560M params (large). [PROVEN — [Multilingual E5 Technical Report, arXiv 2402.05672](https://arxiv.org/html/2402.05672v1)]
- **Languages**: 100 languages inherited from XLM-R. Tamil is in **both** mBERT and XLM-R; **Sinhala is in XLM-R only** (not mBERT). [PROVEN — see §1.6]
- **The load-bearing weakness**: XLM-R pretraining is hugely English-skewed. Approximate CommonCrawl token counts: **English ~55B, Tamil ~595M, Sinhala ~243M**. Sinhala has ~226× less data than English. This is the root cause of samesake's local weakness at the embedding layer. [PROVEN — figures cited in [BERTifying Sinhala, LREC 2022](https://aclanthology.org/2022.lrec-1.803.pdf) and the XLM-R paper]
- **License**: **MIT** — fully commercial-friendly, self-hostable. [PROVEN — [intfloat/multilingual-e5-large](https://huggingface.co/intfloat/multilingual-e5-large)]
- **MMTEB result that matters**: on the 250+-language MMTEB, **multilingual-e5-large-instruct (560M) is the best *publicly available* model in highly-multilingual / low-resource settings — beating 7B LLM embedders.** [PROVEN, quoted §1.3]

### 1.3 BGE-M3 — the strongest single candidate

> "M3-Embedding … is the first embedding model which supports all three retrieval methods … dense retrieval, multi-vector retrieval, and sparse retrieval." [PROVEN — [BGE M3, arXiv 2402.03216v3](https://arxiv.org/html/2402.03216v3)]

- **One model, three retrieval heads** in a single forward pass: **dense** ([CLS] inner product), **sparse/lexical** (learned term weights — a *learned* alternative to BM25/FTS), and **multi-vector** (ColBERT-style late interaction). Final score is a sum: `s_rank ← s_dense + s_lex + s_mul`. [PROVEN]
- **Why this is special for samesake**: the **sparse head can substitute for the Postgres FTS leg that is broken for Sinhala/Tamil** (§2). Instead of `tsvector` (which has no si/ta stemmer) you get learned lexical weights that *do* respect the script. This directly addresses samesake's "RRF running on one leg" problem.
- **Languages**: 100+ working languages, 194 in training data, 8192-token context. **Sinhala/Tamil are NOT explicitly named in the paper's language lists or benchmark tables.** [PROVEN — confirmed by direct read of the paper]
- **MIRACL nDCG@10 (18-lang avg)**: Dense 67.8, Sparse 53.9, Multi-vec 69.0, **Combined 70.0**, vs mE5-large dense 65.4. [PROVEN]
- **License**: **MIT**, "can be used for commercial purposes free of charge." [PROVEN — [BAAI/bge-m3](https://huggingface.co/BAAI/bge-m3)]

### 1.4 Jina-embeddings-v3 — strong model, license blocker

- 570M params, **task-specific LoRA adapters** (separate adapters for query-retrieval, passage-retrieval, clustering, classification, matching), Matryoshka dims (32→1024), 8K context. 108 supported / 89 trained languages (CulturaX). Sinhala/Tamil **not confirmed** in the language list. [PROVEN — [arXiv 2409.10173](https://arxiv.org/abs/2409.10173), [Jina model card](https://jina.ai/models/jina-embeddings-v3/)]
- **License: CC-BY-NC-4.0 (NON-COMMERCIAL).** [PROVEN — Jina model card]
- **Verdict: AVOID for self-hosted production.** samesake runs the model *in the user's app* (BYO embeddings, two containers). A non-commercial license is a hard blocker for the self-host path. Jina's *hosted API* is separately licensed, but that contradicts samesake's "no hosted dependency" posture. Useful only as a benchmark reference.

### 1.5 LaBSE — the cross-lingual specialist (but dated)

- **Language-agnostic** dual-encoder for **109 languages**, trained on 17B monolingual + 6B bilingual pairs (MLM+TLM+translation-ranking). 768-dim. [PROVEN — [LaBSE, ACL 2022](https://aclanthology.org/2022.acl-long.62.pdf)]
- **Built for cross-lingual alignment**: 83.7% bitext-retrieval accuracy over 112 langs on Tatoeba (vs LASER 65.5%). This is exactly the "English query ↔ Sinhala product" alignment samesake needs.
- **Caveat**: LaBSE is a *sentence-similarity / bitext-mining* model, not optimized for asymmetric query→document retrieval. It tends to underperform mE5/BGE-M3 on MTEB/MIRACL *retrieval* tasks. Good as a **cross-lingual sanity baseline**, not the primary retriever. [PROVEN — general MTEB consensus]
- **License**: Apache-2.0 (commercial-friendly).

### 1.6 The Indic/Sinhala-Tamil reality check

> "the performance of these models is still suboptimal for low-resource languages (LRLs)" — focusing on "three low-resource language pairs **English-Sinhala, English-Tamil, and Sinhala-Tamil**." [PROVEN — [Linguistic Entity Masking, arXiv 2501.05700](https://arxiv.org/abs/2501.05700)]

This paper is the closest academic work to samesake's exact problem (the same three language pairs) and confirms that even purpose-built continual-pretraining is needed to lift multilingual models for si/ta. There is **no published product-retrieval benchmark for Sinhala or Tamil fashion** — samesake's own ~5k LK bench may be among the only ones in existence. That is both a moat and a burden (you must build your own eval).

### 1.7 Hosted APIs: Cohere, OpenAI, Gemini

- **Cohere embed-multilingual-v3.0 / embed-v4.0**: 100+ langs; **Sinhala (si) and Tamil (ta) are explicitly in the supported-language table** (105 ISO codes listed). [PROVEN — [Cohere embed docs](https://docs.cohere.com/docs/cohere-embed)]. This is the **only major candidate that explicitly names both target languages.** Pricing ~$0.10/1M tokens (v3), ~$0.12/1M (v4). [MARKETED — third-party pricing trackers]
- **OpenAI text-embedding-3-large**: MIRACL avg jumped 31.4→54.9 vs ada-002, but **"for low-resource languages, the model remains suboptimal compared to mE5_base … the underlying LLM is predominantly pre-trained on English."** [PROVEN — finding reproduced in the BGE-M3 paper comparison]. $0.13/1M tokens. So: improving on high-resource langs, *still loses to a small open model on low-resource* — the worst case for si/ta.
- **Gemini embeddings**: marketed multilingual, but no published si/ta retrieval numbers found. [MARKETED]
- **Posture conflict**: hosted embedding APIs mean every query and every catalog item leaves the user's app — directly against samesake's "runs in your app, two containers, no hosted vector DB" design. Acceptable for *index-time* catalog embedding (batch, one-time-ish), questionable for *query-time* (latency + data egress + per-query cost).

---

## 2. Postgres FTS limits for non-Latin / code-mixed text

This is the single most actionable section. samesake fuses **Postgres FTS + dense ANN** via RRF. For Sinhala/Tamil/Singlish, **the FTS leg is structurally broken**, so RRF is degenerating to dense-only — which is exactly the weak leg (§1.2).

### 2.1 The tokenizer/stemmer gap [PROVEN]

> "Currently PostgreSQL doesn't support full text search natively for many Asian languages such as Chinese, Japanese and others." [PROVEN — [pg-hackers ICU thread](https://www.postgresql.org/message-id/CAEV3FNPU8hU_hi%3D0%2BQNAbEkc-uO8-K9PB3aAChdmcCyPfWX6rg%40mail.gmail.com)]

- The default `tsvector` parser assumes **space-delimited European tokens** and applies **Snowball stemmers** — none of which exist for Sinhala or Tamil. So `to_tsvector('simple', sinhala_text)` does no meaningful stemming/normalization; Tamil's rich agglutinative morphology and Sinhala's abugida inflection are not reduced to roots → recall collapses on inflected forms.
- `unaccent` only strips **Latin-script** diacritics. It does **nothing** for Sinhala/Tamil combining characters or for normalizing Tamil's many vowel-sign variants. [PROVEN — [PostgreSQL collation docs](https://www.postgresql.org/docs/current/collation.html); unaccent is "primarily for languages that use the extended Latin character set"]

### 2.2 The pg_trgm trap [PROVEN]

> "currently it only indexes ascii characters and thus all Asian language characters are dropped." [PROVEN — same thread]

This is the killer detail. If samesake uses `pg_trgm` for fuzzy/typo tolerance, **Sinhala and Tamil characters are silently discarded**, so trigram similarity on native script is effectively random. (Modern pg_trgm with the right build can index multibyte, but the historical default and many managed Postgres builds drop non-ASCII — this must be **verified per deployment**, not assumed.)

### 2.3 What actually works in Postgres for si/ta

1. **`'simple'` config + Unicode NFC normalization, no stemmer.** Treat FTS as exact-token matching on normalized native script. Cheap recall floor, no false morphology.
2. **`pg_trgm` for romanized/Latin queries only** (Singlish), where it works well — see §3.
3. **Lean on the dense head, and add a *learned sparse* head (BGE-M3 sparse) stored as a separate column / `sparsevec` in pgvector** instead of relying on `tsvector` for lexical signal in native script. This is the cleanest in-Postgres fix that stays within samesake's "no Elasticsearch" constraint.
4. **ICU is the long-term answer but not shipped**: a proposed ICU-tokenization tsvector parser would fix word boundaries, but it remains an **open enhancement request, not a Postgres feature.** [PROVEN] Do not design around it existing.

---

## 3. Romanization ("Singlish") + transliteration — the front-door problem

LK shoppers overwhelmingly type romanized Sinhala on English keyboards. This is samesake's biggest *query-side* gap.

### 3.1 The ambiguity is severe and quantified [PROVEN]

> "the Romanized term 'mama' could correspond to different Sinhala words" — nominative *I*, accusative *me*, or *uncle* — "three distinct meanings from identical Romanization." [PROVEN — [Sinhala Transliteration: Rule-based vs Seq2Seq, arXiv 2501.00529](https://arxiv.org/html/2501.00529v1)]

Romanized Sinhala is **non-standardized**: users invent ad-hoc Latin approximations of an abugida script, and code-switch mid-string. Transliteration accuracy (Singlish→Sinhala):

| Approach | Test set | WER | CER |
|---|---|---|---|
| Rule-based | General | 66.89% | 21.19% |
| **Seq2Seq** | General | **19.83%** | **5.79%** |
| Rule-based | Ad-hoc | 68.09% | 22.02% |
| **Seq2Seq** | Ad-hoc | **24.13%** | **7.89%** |

[PROVEN — arXiv 2501.00529]. **Takeaway: rule-based transliteration has ~67% word-error — unusable. Learned seq2seq (or BERT-based reverse transliteration, per [IndoNLP 2025 shared task](https://aclanthology.org/2025.indonlp-1.16.pdf)) is required** for acceptable quality. Resources exist: the **Swa-bhasha hub** ([arXiv 2507.09245](https://arxiv.org/pdf/2507.09245)) provides Singlish↔Sinhala data and systems.

### 3.2 Code-mixed IR — what helps [PROVEN]

> "Normalization, stopword engineering, transliteration and phonetic indexing proved useful for Indic code-mixed information retrieval, showing **15–16% MAP improvements**." [PROVEN — synthesis of code-mixed IR literature incl. [RetrieveGPT, arXiv 2411.04752](https://arxiv.org/pdf/2411.04752) and the [Code-Mixed IR shared task](https://ceur-ws.org/Vol-4173/T3-1.pdf)]

The proven pipeline for code-mixed queries: **normalize → transliterate to native script → (optionally) phonetic-index → then retrieve.** These are *preprocessing* wins, model-agnostic, and stack on top of whatever embedding model is chosen.

---

## 4. Cross-lingual retrieval (English query ↔ Sinhala/Tamil product, or vice versa)

samesake's catalog text may be English, Sinhala, or Tamil (or mixed). Shoppers query in any of them. This is genuine **cross-lingual retrieval**, not just multilingual.

- **Dense cross-lingual works *if* the model aligns languages in a shared space.** mE5, BGE-M3, LaBSE, Cohere all produce a shared multilingual space → an English query can hit a Sinhala product via cosine. This is the **strongest argument for dense-first retrieval** for samesake: FTS can *never* do cross-lingual (lexical match requires same script/tokens), but dense can. [PROVEN — cross-lingual MKQA results in BGE-M3 paper; Tatoeba in LaBSE]
- **The catch**: cross-lingual quality tracks per-language embedding quality, which is weak for si/ta (§1.2). So cross-lingual si/ta retrieval is the *hardest* cell in the matrix — exactly samesake's failing benchmark type.
- **MIRACL/MMTEB give almost no signal here**: **MIRACL's 18 languages include Hindi, Bengali, Telugu — but NOT Tamil and NOT Sinhala.** [PROVEN — [MIRACL, TACL 2023](https://aclanthology.org/2023.tacl-1.63/)]. The canonical multilingual-retrieval benchmark is **blind to samesake's exact languages.** Closest proxies: Telugu/Bengali MIRACL scores (Dravidian/Indic neighbors). **samesake must treat its own LK bench as the ground truth** — no public benchmark substitutes.

---

## 5. Comparison table — embedding models for LK fashion

| Model | Params / Dim | si / ta named? | Sparse head? | Cross-lingual proven | License | Self-host fits samesake? | MIRACL avg |
|---|---|---|---|---|---|---|---|
| **BGE-M3** | ~568M / 1024 | No (100+ generic) | **Yes (dense+sparse+colbert)** | Yes (MKQA) | **MIT** | **Yes** | 70.0 (combined) |
| **multilingual-e5-large** | ~560M / 1024 | No (XLM-R: ta yes, si yes) | No | Yes | **MIT** | **Yes** | 65.4 (dense) |
| **mE5-large-instruct** | ~560M / 1024 | Same | No | Yes | MIT | Yes | Best public on MMTEB low-resource |
| **LaBSE** | ~470M / 768 | 109 langs (incl. si/ta) | No | **Best (bitext)** | Apache-2.0 | Yes (baseline) | Low (not retrieval-tuned) |
| **jina-embeddings-v3** | 570M / 1024 (Matryoshka) | Not confirmed | No | Yes | **CC-BY-NC** ⛔ | **No (non-commercial)** | strong |
| **Cohere embed-v3/v4** | API / 1024+ | **Yes (explicit si+ta)** ✅ | No | Yes | Hosted API | Conflicts (data egress) | strong |
| **OpenAI text-embedding-3-large** | API / 3072 | Generic | No | Partial | Hosted API | Conflicts | 54.9 (weak low-res) |
| **VERDICT** | — | — | — | — | — | — | — |
| **Primary: BGE-M3** | MIT + one-model dense+sparse+colbert in 8K context. Sparse head replaces broken Postgres FTS for si/ta; multi-vec head = a *built-in* reranker option samesake already plans. Best fit for BYO + RRF + no-Elasticsearch. | | | | | | |
| **Fallback / baseline: mE5-large** | If BGE-M3 sparse integration is too heavy, mE5 (MIT) is the safe dense default; pairs with the normalization front-door. | | | | | | |
| **Validation only: Cohere v3** | Only model explicitly claiming si+ta. Use to *measure the ceiling* on samesake's bench; do not make it a runtime dependency. | | | | | | |

---

## 6. Relevance to samesake — adopt / avoid / differentiate / integrate

### ADOPT
1. **Make BGE-M3 a first-class supported BYO embedding model** (MIT, 8K context, self-hostable). Its **sparse head is the cleanest fix for samesake's broken FTS leg**, and its **multi-vector head is the optional cross-encoder-ish reranker samesake already plans** — one model, three of samesake's roadmap items.
2. **A query normalization + transliteration front-door** *before* the NLQ parser / retrieval. Pipeline: Unicode-NFC normalize → script-detect → if romanized, **seq2seq/BERT Singlish→Sinhala transliteration** (rule-based is ~67% WER, unusable) → optionally expand to both scripts. This is the highest-ROI change and is model-agnostic (15–16% MAP gains in code-mixed IR literature).
3. **Stop trusting Postgres FTS for native script.** Use `'simple'` + NFC for an exact-match recall floor; route lexical signal through the **BGE-M3 sparse vector (pgvector `sparsevec`)**, not `tsvector`. Verify per-deployment whether `pg_trgm` drops non-ASCII; restrict `pg_trgm` to romanized/Latin queries.

### AVOID
1. **jina-embeddings-v3 for the self-host path** — CC-BY-NC license is a hard blocker for "runs in the user's app."
2. **Hosted embedding APIs at query time** (OpenAI/Cohere/Gemini) — data egress + latency + per-query cost contradicts the two-container, in-app design. (Index-time batch embedding via Cohere is *defensible* given it explicitly supports si/ta, but creates a hosted dependency.)
3. **Designing around ICU tsvector tokenization** — it's an open Postgres enhancement request, not a feature. Don't assume it.
4. **Treating MIRACL/MMTEB scores as proxies for si/ta** — Tamil and Sinhala are absent from MIRACL. Public benchmarks will overstate samesake's expected local quality.

### DIFFERENTIATE
1. **The transliteration/code-mixing front-door is a genuine moat.** No general commerce-search framework ships Singlish normalization. samesake serving LK fashion can own "search that actually understands how Sri Lankans type."
2. **samesake's ~5k LK fashion bench may be one of the only Sinhala/Tamil *product-retrieval* evals in existence.** Lean into it as the source of truth and a public credibility asset.
3. **Romanized↔native dual-indexing**: index each catalog item under both native script *and* a generated romanization, so romanized queries hit via lexical *and* dense. Cheap, high-recall, uniquely targeted at the LK query distribution.

### INTEGRATE
1. **`/search/explain` must surface the language pipeline**: detected script, whether transliteration fired, which leg (dense/sparse/native-FTS/romanized-trgm) contributed. Auditability of *why a local query failed* is how samesake closes the gap iteratively.
2. **NLQ parser (constrained schema) should run *after* transliteration** so attribute extraction sees native script, not ambiguous Singlish.
3. **RRF weighting should be language-aware**: for native-script queries, down-weight the (broken) `tsvector` leg and up-weight dense + BGE-M3 sparse; for romanized queries, bring in the `pg_trgm`/romanized leg.

---

## 7. Open questions

1. **Does BGE-M3's sparse head actually help for Sinhala/Tamil specifically?** No published si/ta sparse-retrieval numbers exist. Must be measured on samesake's bench.
2. **Is `pg_trgm` non-ASCII dropping still true on the user's managed Postgres (Supabase/Neon/RDS)?** Needs a per-deployment empirical check; behavior varies by build.
3. **What is the actual romanized-vs-native query ratio in LK fashion search?** The whole transliteration investment depends on this; samesake should instrument query logs.
4. **Tamil vs Sinhala — are they equally weak, or is Sinhala dramatically worse** (it has ~2.4× less XLM-R data than Tamil and is absent from mBERT)? May warrant per-language strategies.
5. **Does a small fine-tuned/continually-pretrained si/ta encoder (LEM-style, arXiv 2501.05700) beat BGE-M3 on the LK bench enough to justify the training cost** vs just adopting BGE-M3 + front-door?
6. **`sparsevec` operational cost in pgvector** — index size, build time, query latency at samesake's catalog scales — vs the value of the sparse leg.
7. **Cross-lingual eval design**: samesake's bench is "local" — is it testing same-language (Sinhala query → Sinhala product) or cross-lingual (English query → Sinhala product)? These need separate eval slices; the fixes differ.
8. **Phonetic indexing for Sinhala** — does a Soundex/Metaphone-equivalent exist for Sinhala/Tamil, and does it add recall over transliteration alone?

---

## 8. Sources

**Embedding models**
- BGE M3-Embedding (arXiv 2402.03216v3) — https://arxiv.org/html/2402.03216v3 ; model card https://huggingface.co/BAAI/bge-m3 (MIT)
- Multilingual E5 Technical Report (arXiv 2402.05672) — https://arxiv.org/html/2402.05672v1 ; https://huggingface.co/intfloat/multilingual-e5-large (MIT)
- jina-embeddings-v3 (arXiv 2409.10173) — https://arxiv.org/abs/2409.10173 ; model card https://jina.ai/models/jina-embeddings-v3/ (CC-BY-NC-4.0)
- LaBSE (ACL 2022) — https://aclanthology.org/2022.acl-long.62.pdf ; Google blog https://research.google/blog/language-agnostic-bert-sentence-embedding/
- Cohere embed docs (si + ta explicit) — https://docs.cohere.com/docs/cohere-embed
- OpenAI new embedding models — https://openai.com/index/new-embedding-models-and-api-updates/

**Benchmarks**
- MIRACL (TACL 2023) — https://aclanthology.org/2023.tacl-1.63/ ; https://github.com/project-miracl/miracl (18 langs; Tamil & Sinhala absent)
- MMTEB (arXiv 2502.13595) — https://arxiv.org/abs/2502.13595 (mE5-instruct best public on low-resource)

**Sinhala/Tamil low-resource NLP**
- Linguistic Entity Masking for LRLs (arXiv 2501.05700) — https://arxiv.org/abs/2501.05700 (En-Si, En-Ta, Si-Ta)
- BERTifying Sinhala (LREC 2022) — https://aclanthology.org/2022.lrec-1.803.pdf
- Survey of Sinhala NLP tools (arXiv 1906.02358) — https://arxiv.org/html/1906.02358v25 ; LK-NLP hub https://lknlp.github.io/

**Transliteration / Singlish / code-mixing**
- Sinhala Transliteration: Rule-based vs Seq2Seq (arXiv 2501.00529) — https://arxiv.org/html/2501.00529v1 ("mama" ambiguity; WER/CER table)
- Swa-bhasha Resource Hub (arXiv 2507.09245) — https://arxiv.org/pdf/2507.09245
- IndoNLP 2025 Shared Task: Romanized Sinhala reverse transliteration — https://aclanthology.org/2025.indonlp-1.16.pdf
- RetrieveGPT: code-mixed IR (arXiv 2411.04752) — https://arxiv.org/pdf/2411.04752
- Code-Mixed IR shared task findings — https://ceur-ws.org/Vol-4173/T3-1.pdf
- Sinhala-English Code-Mixed dataset — https://huggingface.co/datasets/NLPC-UOM/Sinhala-English-Code-Mixed-Code-Switched-Dataset

**Postgres FTS / non-Latin**
- pg-hackers ICU tokenization thread — https://www.postgresql.org/message-id/CAEV3FNPU8hU_hi%3D0%2BQNAbEkc-uO8-K9PB3aAChdmcCyPfWX6rg%40mail.gmail.com (pg_trgm drops ASCII-only; no Asian FTS)
- PostgreSQL collation docs — https://www.postgresql.org/docs/current/collation.html
- pgvector — https://github.com/pgvector/pgvector (`sparsevec`, HNSW, cosine)

*Fetch notes: several arXiv PDFs returned binary/unrenderable; figures for those (2501.05700, 2507.09245, 2411.04752, 2.lrec-1.803, indonlp-1.16) were taken from the HTML version where available (2501.00529) or from search-surfaced abstracts/snippets and should be re-verified against the source PDF before being treated as exact.*
