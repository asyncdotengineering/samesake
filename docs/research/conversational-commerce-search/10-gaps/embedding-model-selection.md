# Embedding Model Selection for Commerce + Cost Levers

> Completeness-pass deep dive. samesake says "BYO embeddings" but never said *which*, *what dimensionality*, *at what cost*, or *how to compress them in pgvector*. This fills that gap end-to-end: the MTEB/MMTEB leaderboard state (2025-2026), the commercial API pricing/dims landscape, Matryoshka Representation Learning, int8/binary quantization in pgvector, the dimensionality vs recall vs storage tradeoff, and image/multimodal models for fashion. It ends with an opinionated default for a BYO fashion-commerce stack.
>
> **Scope anchor:** samesake is fashion-first, the real corpus is Sri Lankan (LK) fashion — Sinhala/Tamil/English code-mixed — retrieval = Postgres FTS + cosine ANN over BYO embeddings fused by RRF, hard filters gate before ranking. The embedding model choice is *the* lever for both the ANN half of retrieval and the storage/cost profile of the pgvector layer that runs inside the user's app.
>
> **Evidence tags:** **[PROVEN]** = paper / benchmark / official doc. **[MARKETED]** = vendor blog / launch post. Dates reflect what sources state; current date for this pass is 2026-06-14.

---

## 0. TL;DR verdict (read this first)

For a BYO fashion-commerce default on Postgres + pgvector, samesake should ship **two reference recipes**, not one model:

1. **Open-weights, self-hosted, privacy-first (recommended default):**
   **Text → Qwen3-Embedding-0.6B** (Apache-2.0, MRL down to 32 dims, multilingual) stored as `halfvec`, truncated to 512-768 dims. **Image/multimodal → Marqo-FashionSigLIP** (fashion-finetuned SigLIP, the proven fashion SOTA on public benchmarks). This keeps everything inside the two-container deployment, no per-token API spend, and is the cleanest license story.

2. **Managed-API, quality-ceiling (for users who accept egress + cost):**
   **Text → Gemini Embedding (`gemini-embedding-001`)** ($0.15/1M tokens, MRL, 100+ languages, MTEB-English #1 class) **or Voyage-3.5 / voyage-4** (int8+binary native, flexible dims, cheap). **Multimodal → Cohere Embed v4** (single model embeds text *and* images, Matryoshka, int8/binary).

Both recipes lean hard on the same two cost levers: **Matryoshka truncation** (fewer dims) and **pgvector quantization** (`halfvec` always; `bit` + rescoring when corpus grows). On a ~5k-doc LK catalog these levers are about *future-proofing and clean defaults*, not survival — 5k vectors fit in RAM at any dimensionality. They become load-bearing the moment a tenant catalog crosses ~10^6 vectors.

---

## 1. Leaderboard state 2025-2026 (text retrieval)

### 1.1 What the benchmarks actually are

- **MTEB** = Massive Text Embedding Benchmark; the canonical English board. **MMTEB** = the massive *multilingual* extension. Multilingual ranking on the official MMTEB board is by **Borda count** across tasks, not a single average. **[PROVEN]** (MMTEB methodology, awesomeagents leaderboard mirror.)
- Caveat that matters for samesake: **MTEB/MMTEB contain almost no fashion-commerce retrieval and effectively no Sinhala/Tamil code-mixed retrieval.** A high MMTEB score is *necessary but not sufficient* evidence for LK fashion. Treat leaderboard rank as a prior, then re-rank on samesake's own ~5k LK bench (mean grade@10 ~2.33, P@5 0.83 today).

### 1.2 Current leaders (state as reported across 2025 → 2026)

| Model | Params / type | MTEB-Eng | MMTEB (multi) | License | Notes |
|---|---|---|---|---|---|
| **Gemini Embedding** (`gemini-embedding-001`) | API | ~73.3 (claimed) / #1-class on Eng board April 2026 (68.32 on the v2 board) | ~67.7 | Proprietary API | 100+ langs, MRL, the managed quality ceiling. **[PROVEN doc / MARKETED scores]** |
| **Qwen3-Embedding-8B** | 8B open | 75.22 (claimed) | 70.58 → **#1 MTEB-multilingual as of 2025-06-05** | **Apache-2.0** | Top open multilingual; MRL; instruction-tunable. **[PROVEN/MARKETED]** |
| **Qwen3-Embedding-4B / 0.6B** | open | high | high | **Apache-2.0** | Smaller siblings; 0.6B is the deployable one. **[PROVEN]** |
| **Llama-Embed-Nemotron-8B** | 8B open | — | **Rank 1 MMTEB Borda (39,573 votes), 2025-10-21**, ahead of gemini-embedding-001 #2 | NVIDIA license (check) | Newest top multilingual entrant. **[PROVEN arXiv 2511.07025]** |
| **NV-Embed-v2** | 8B (Llama-3.1-8B FT) | ~69.8 | ~65.0 | Non-commercial (CC-BY-NC) | Strong but license blocks commercial BYO default. **[PROVEN/MARKETED]** |
| **Voyage-4-large / voyage-3.5** | API | top-tier (vendor) | top-tier (vendor) | Proprietary API | int8+binary native, flexible dims, cheap. **[MARKETED]** |
| **Cohere Embed v4** | API multimodal | strong | strong, 100+ langs | Proprietary API | text+image one model, MRL, int8/binary. **[MARKETED/doc]** |
| **OpenAI text-embedding-3-large** | API | 64.6 | — | Proprietary API | Older; MRL via `dimensions`; now mid-pack. **[PROVEN doc]** |
| **BGE-M3** | 568M open | — | strong multilingual | **MIT** | Dense+sparse+ColBERT multi-vector; great hybrid fit. **[PROVEN/MARKETED]** |
| **multilingual-e5-large** | 560M open | — | solid | **MIT** | Reliable multilingual baseline. **[PROVEN]** |
| **GTE-Qwen2 / gte-multilingual** | open | strong | strong | **Apache-2.0** | Good open alternatives. **[PROVEN]** |
| **Nomic-embed-text-v1.5 / v2-moe** | 137M / MoE open | mid | v2 strong multilingual | **Apache-2.0** | The canonical *open MRL* model; v2-moe ~100 langs. **[PROVEN]** |

> Verbatim, on positioning: *"For production quality-focused applications, Gemini Embedding 2 or Voyage 4 Large are recommended, while for privacy-critical use cases, Qwen3-Embedding-8B (Apache 2.0) is suggested."* — Modal MTEB write-up. **[MARKETED]**

**Reading for samesake:** the *open* multilingual frontier (Qwen3, Nemotron, BGE-M3, mE5, Nomic-v2) is now genuinely competitive with the managed APIs on benchmarks while keeping data in-container — which is exactly samesake's deployment story (no hosted vector DB, runs in the user's app). The managed APIs win on convenience and the very top of the quality curve.

---

## 2. Commercial API pricing + dimensions (the BYO-managed path)

All prices are per **1 million input tokens** (embeddings have no output tokens). Batch APIs discount 33-50%.

| Model | Default dims | Flexible dims (MRL) | Max context | Quantization output types | Price /1M tok | License | Source |
|---|---|---|---|---|---|---|---|
| **OpenAI text-embedding-3-small** | 1536 | yes (`dimensions`, truncate) | 8191 | float only | **$0.02** ($0.01 batch) | API | OpenAI docs |
| **OpenAI text-embedding-3-large** | 3072 | yes (`dimensions`) | 8191 | float only | **$0.13** ($0.065 batch) | API | OpenAI docs |
| **Gemini `gemini-embedding-001`** | 3072 | **128-3072**, rec. 768/1536/3072 (MRL) | 2048 input | float | **$0.15** (50% batch) | API | ai.google.dev |
| **Voyage-4-large** | 1024 | 256/512/1024/2048 (MRL) | 32K | **float/int8/uint8/binary/ubinary** | **$0.12** | API | docs.voyageai.com |
| **Voyage-4** | 1024 | 256/512/1024/2048 | 32K | int8/binary native | **$0.06** | API | Voyage |
| **Voyage-4-lite / voyage-3.5-lite** | 1024 | 256/512/1024/2048 | 32K | int8/binary native | **$0.02** | API | Voyage |
| **voyage-3.5** | 1024 | 256/512/1024/2048 | 32K | int8/binary native | **$0.06** | API | Voyage/MongoDB |
| **Cohere Embed v4** | 1536 | **256/512/1024/1536** (MRL) | **128K** | **float/int8/uint8/binary/ubinary** | **$0.12** | API | Cohere docs |

**Load-bearing facts (verbatim):**
- OpenAI: *"developers can shorten embeddings (i.e. remove some numbers from the end of the sequence) without the embedding losing its concept-representing properties."* — OpenAI embeddings guide. **[PROVEN]**
- Gemini dims: *"Flexible, supports: 128 - 3072, Recommended: 768, 1536, 3072"* and uses *"Matryoshka Representation Learning (MRL) technique."* — ai.google.dev. **[PROVEN]** Input token limit **2,048** (short — chunking matters for long product descriptions).
- Voyage: *"voyage-4-large, voyage-4, voyage-4-lite, voyage-3-large, voyage-3.5, voyage-3.5-lite, and voyage-code-3 support int8, uint8, binary, and ubinary output types in addition to standard float."* — docs.voyageai.com. **[PROVEN]** Free tier: first **200M tokens** free on the voyage-4 family.
- Cohere: *"Embed 4 supports a 128k context length"*, multimodal (interleaved text+image), MRL dims `[256, 512, 1024, 1536]`, int8/binary. **[MARKETED/doc]** Marketing claim: *"Matryoshka embeddings let you slash vector storage costs by up to 96%."* **[MARKETED]**

**Cost intuition for an LK catalog:** embedding ~5k product docs at ~300 tokens each ≈ 1.5M tokens ≈ **$0.03 (small) to $0.23 (gemini)** for a full re-index. Embedding cost is **negligible at catalog scale**; the real recurring cost is **query-time embedding** of every NLQ + every enrich call, which scales with traffic. For high-QPS storefronts this flips the math toward a self-hosted open model (zero marginal token cost) — a strong argument for samesake's default being open-weights.

---

## 3. Matryoshka Representation Learning (the dimensionality lever)

### 3.1 What it is

Matryoshka Representation Learning (**MRL**), Kusupati et al., NeurIPS 2022 — *"Matryoshka Representation Learning"* (proceedings.neurips.cc/.../c32319f4868da7613d78af9993100e42). **[PROVEN]** The training-time loss is applied to *nested prefixes* of the embedding, so a single 768-d (or 2048-d, 3072-d) vector can be **truncated to a much smaller prefix and still be a usable embedding**.

Verbatim: *"earlier dimensions store more information than dimensions later on in the vector, which simply add more details"* and *"MRL proposes a solution to train embedding models whose embeddings are still useful after truncation to much smaller sizes."* — SBERT / Weaviate summaries. **[PROVEN]** The original paper reports *"up to a 14× smaller representation size at the same accuracy"* on ImageNet-1K adaptive classification. **[PROVEN]**

### 3.2 Why it matters for pgvector cost specifically

pgvector storage and ANN index size scale **linearly with dimensions**. A `vector(3072)` is 4× the bytes (and roughly 4× the index RAM and distance-compute) of a `vector(768)`. MRL lets you:
- Embed once at full dimensionality, then **truncate at write-time** to the dimension your recall budget tolerates — no re-embedding, no second model.
- Run a **two-stage retrieve**: ANN on a short prefix (cheap, in-RAM), rescore the top-K on the full vector (accurate). This is the dimension-space analogue of binary→full rescoring (§4.3).
- **Re-normalize after truncation** (cosine requires unit-norm; truncated prefixes are not unit-norm — this is the #1 MRL footgun).

### 3.3 Which models support it (relevant to BYO)

- **Open:** Nomic-embed-text-v1.5 (64-768, canonical open MRL), Nomic-v2-moe (64-768), Qwen3-Embedding (from 32 up), Jina-v3 (32-1024), Jina-v4 (128-2048), Jina-CLIP-v2 (64-1024), mxbai/Snowflake families.
- **API:** Gemini (128-3072), OpenAI (`dimensions`), Voyage (256/512/1024/2048), Cohere v4 (256-1536).

**Caveat [PROVEN]:** truncation is not free past a point. SMEC (arXiv 2510.12474, *"Rethinking Matryoshka Representation Learning for Retrieval Embedding Compression"*) exists precisely because naive MRL truncation degrades retrieval more than ideal at aggressive compression — recall is a curve, not a cliff. Validate the chosen prefix on samesake's own bench, do not assume "768→256 is free."

---

## 4. Quantization in pgvector (the bytes-per-dimension lever)

pgvector **0.7.0** added two compressed column types beyond `vector` (4-byte float32): **`halfvec`** (2-byte float16, scalar quantization) and **`bit`** (1-bit binary quantization, Hamming distance). Both are **indexable** (HNSW/IVFFlat). **[PROVEN — pgvector README / Jonathan Katz benchmark]**

### 4.1 `halfvec` — scalar quantization (the free win)

> *"Scalar Quantization (SQ) uses half-precision vectors halfvec to represent floats in 16 bits instead of 32 bits."* — and on recall: at `ef_construction=256`, recall was **"nearly identical"** between full and half (e.g. **77.5% vs 77.7%, 95.4% vs 95.4%**). — Katz benchmark. **[PROVEN]**

Storage reduction (Katz, real ANN datasets): **1.46×** (sift-128), **3.00×** (gist-960), **2.00×** (dbpedia-openai-1000k). QPS equal or slightly better. The Neon post puts it bluntly: *"Don't use vector. Use halfvec instead and save 50% of your storage cost."* **[MARKETED but consistent with PROVEN recall]**

**Verdict: `halfvec` is a near-free 50% storage + index-RAM cut with negligible recall loss. It should be samesake's default column type, full stop.**

### 4.2 `bit` — binary quantization (the aggressive lever, needs rescoring)

> Storage reduction is dramatic on high-dim data: **19.29×** (gist-960), **16.35×** (dbpedia-openai). But recall *without rescoring* is poor for low-dim (2.18-2.52% on sift-128) and only "acceptable" on high-dim (60.1% on dbpedia at ef_search=10). — Katz. **[PROVEN]**

Binary quantization is `sign(x)`: each dim → 1 bit, 32× smaller than float32. It is only viable on **high-dimensional** vectors (≥768, ideally ≥1536) and **only with a rescoring pass**.

### 4.3 Rescoring — the pattern that makes `bit` usable

The proven pattern: ANN-search on the binary vector to get a wide candidate set, then **re-order that candidate set by the original (full-precision) distance**:

```sql
SELECT i.id FROM (
  SELECT id, embedding <=> $1 AS distance
  FROM items
  ORDER BY binary_quantize(embedding)::bit(3072) <~> binary_quantize($1)
  LIMIT 800
) i ORDER BY i.distance LIMIT 10;
```

With rescoring on dbpedia (Katz): recall **66.8% → 91.6%** at ef_search=40, and **99.0%** at ef_search=200. And it can be *faster*: *"1.34x boost in QPS"* with *"29% reduction in p99 latency"* while *"sacrificing only 5% in recall"* at ef_search=40. **[PROVEN]**

The catch for samesake: rescoring on the **full** float vector requires keeping the full vector around. The standard play is **store `bit` index + `halfvec` payload column** — search the bit index cheaply, rescore against the halfvec. (Or store full `vector` only if RAM is plentiful.)

### 4.4 int8 / `(u)int8` — the middle ground

pgvector does **not yet have a first-class int8 vector type** (open issue #521). But the API providers (Voyage, Cohere) emit **int8/uint8 natively**, and you can store those in pgvector via `bit`-style packing or as `smallint[]`-adjacent workarounds — clunky today. **Practical stance:** until pgvector ships int8, the clean two-tier in-database story is **`halfvec` (default) → `bit` + rescore (at scale)**; int8 is mainly relevant if you adopt a provider that returns int8 and do your own custom storage. **[PROVEN — pgvector issue #521]**

---

## 5. Dimensionality × recall × storage — the joint tradeoff in pgvector

Three knobs interact: **dimension count** (MRL §3), **bytes per dimension** (quantization §4), and **ANN params** (`ef_construction`, `ef_search`, `m`). They compound multiplicatively on storage:

Per-vector storage ≈ `dims × bytes_per_dim`:

| Config | dims | bytes/dim | bytes/vec | vs vector(3072) |
|---|---|---|---|---|
| `vector(3072)` (OpenAI-large full) | 3072 | 4 | 12,288 | 1.0× |
| `halfvec(3072)` | 3072 | 2 | 6,144 | 2× smaller |
| `halfvec(1024)` (MRL→1024) | 1024 | 2 | 2,048 | 6× smaller |
| `halfvec(768)` (Qwen3/Nomic) | 768 | 2 | 1,536 | 8× smaller |
| `bit(1024)` (binary) | 1024 | 1/8 | 128 | 96× smaller |

The compounding: **MRL truncation + halfvec = ~8× smaller** with small, validate-able recall cost; **MRL + binary + rescore = ~50-90× smaller** with recall recoverable to >95% via rescoring on high-dim vectors. (See also arXiv 2505.00105, *"Optimization of embeddings storage for RAG systems using quantization and dimensionality reduction techniques."* **[PROVEN]**)

**The recall-budget rule for samesake:** recall is a curve in all three knobs. Lower dims AND lower precision AND lower `ef_search` each shave recall; their effects stack. The discipline is to **fix a recall floor on samesake's own LK bench** (e.g. "ANN recall@50 ≥ 0.95 so RRF fusion isn't starved") and then choose the *cheapest* (dims, quant, ef) point that clears it — not chase max recall, and not blindly take vendor "96% savings" claims.

**At 5k docs none of this matters for survival** — 5k × 12KB = 60MB, trivially in RAM. It matters because samesake compiles a *typed catalog per tenant* and some tenants will be large; the default recipe should already be on the efficient frontier so scaling is a config change, not a migration.

---

## 6. Image & multimodal models (fashion-critical)

samesake is **visual commerce, fashion-first**. The image tower is not optional — "more-like-this", visual NLQ ("red floral midi like this"), and the enrich pipeline all want image embeddings. Generic CLIP underperforms badly on fashion; domain-finetuned models win decisively.

### 6.1 The fashion-specific evidence (the part that matters most)

**Marqo-FashionSigLIP** and **Marqo-FashionCLIP** (Marqo, Aug 2024, ~150M params, finetuned via Generalised Contrastive Learning on category/style/color/material signals) are the **proven public-benchmark SOTA for fashion**, beating both generic OpenCLIP and prior FashionCLIP. **[PROVEN — Marqo LEADERBOARD.md, 7 datasets: Atlas, DeepFashion-InShop, DeepFashion-Multimodal, Fashion200k, iMaterialist, KAGL, Polyvore]**

Verbatim leaderboard (averaged across datasets):

| Model | Text→Image AvgRecall | Category→Product AvgP | Sub-Category→Product AvgP |
|---|---|---|---|
| **Marqo-FashionSigLIP** | **0.231** | **0.737** | **0.725** |
| Marqo-FashionCLIP | 0.192 | 0.705 | 0.707 |
| ViT-B-16-SigLIP-webli (generic) | 0.212 | 0.688 | 0.643 |
| FashionCLIP 2.0 | 0.163 | 0.684 | 0.657 |
| OpenFashionCLIP | 0.132 | 0.646 | 0.598 |

Marqo's own claim: *"up to 57% [improvement] on benchmarks while delivering 10% faster inference."* **[MARKETED]** but consistent with the PROVEN table above. **License caveat: the Marqo fashion models' license must be confirmed per-checkpoint on HuggingFace before commercial BYO default — not asserted here.**

### 6.2 The generic/multilingual image backbones

| Model | Params | Multilingual | Dims / MRL | License | Notes |
|---|---|---|---|---|---|
| **SigLIP 2** (Google, Feb 2025) | B/L/So variants | **109 languages** | fixed per ckpt | **Apache-2.0** | Strong multilingual backbone; ImageNet ZS up to 79.1% (B/16); XM3600 avg R@1 40.7%. Best *open multilingual* base to finetune for LK fashion. **[PROVEN arXiv 2502.14786]** |
| SigLIP (v1) | — | mostly EN | fixed | Apache-2.0 | superseded by SigLIP 2 |
| CLIP (OpenAI) / OpenCLIP | — | EN | fixed | MIT / open | baseline; weak on fashion |
| **Jina-CLIP-v2** | 0.9B | **89 languages** | **1024→64 MRL** (text+image) | check (Jina) | Multilingual multimodal w/ Matryoshka; 512×512 images. **[PROVEN/MARKETED]** |
| **Jina-embeddings-v4** | (Qwen2.5-VL-3B base) | multilingual | **2048→128 MRL** | **Qwen Research License** (NOT cc-by-nc; was mislabeled) | multimodal; license restricts some commercial use — verify. **[PROVEN — arXiv 2506.18902 + HF license note]** |
| **Cohere Embed v4** | API | 100+ langs | 256-1536 MRL | proprietary | **one model embeds text AND images** — interleaved; int8/binary. Simplest unified multimodal path. **[doc/MARKETED]** |
| **Voyage-multimodal-3** | API | — | flexible | proprietary | multimodal API alternative. **[MARKETED]** |
| Nomic-embed-vision-v1.5 | open | — | aligned to nomic-text-v1.5 (768) | Apache-2.0 | text+image share one space — nice for hybrid. **[PROVEN]** |

### 6.3 Fashion multimodal verdict

**Adopt Marqo-FashionSigLIP as the default image tower** — it is the only candidate with *published fashion-benchmark wins*, it is small (150M, fits the two-container budget), and its training signal (color/material/style/category) is exactly samesake's facet vocabulary. **Differentiator for LK specifically:** none of these are trained on Sinhala/Tamil fashion text or LK garment vocabulary (saree, redda-hatte, osariya, lungi). The image tower is language-agnostic so Marqo-FashionSigLIP's *visual* strength transfers; but **text→image queries in Sinhala/Tamil will be weak** — route those through the multilingual *text* model + FTS, not the fashion-CLIP text encoder. For the managed path, **Cohere Embed v4** collapses the text+image tower into one model and is the lowest-integration multimodal option.

---

## 7. Recommendation table — BYO fashion-commerce default

Verdict rows marked ✅ default, 🟡 alternative, ❌ avoid-as-default.

### Text embedding (the ANN half of RRF)

| Model | License | Multilingual (LK-relevant?) | MRL | pgvector fit | Cost | Verdict |
|---|---|---|---|---|---|---|
| **Qwen3-Embedding-0.6B** | **Apache-2.0** | yes (broad) | yes (≥32) | halfvec, self-host, $0/query | self-host compute | ✅ **default (open)** |
| Qwen3-Embedding-4B/8B | Apache-2.0 | yes, stronger | yes | bigger RAM | self-host | 🟡 if quality > footprint |
| BGE-M3 | **MIT** | yes + sparse/ColBERT | partial | great hybrid (dense+sparse) | self-host | 🟡 strong hybrid alt |
| multilingual-e5-large | MIT | yes | no | halfvec | self-host | 🟡 safe baseline |
| Nomic-embed-text-v2-moe | Apache-2.0 | ~100 langs | yes (768-64) | halfvec/binary | self-host | 🟡 light footprint |
| **Gemini `gemini-embedding-001`** | proprietary | 100+ langs | yes (128-3072) | float→halfvec | $0.15/1M + egress | ✅ **default (managed quality ceiling)** |
| voyage-3.5 / voyage-4 | proprietary | yes | yes | **int8/binary native** | $0.06/$0.12; 200M free | 🟡 cheapest managed w/ quant |
| Cohere Embed v4 | proprietary | 100+ | yes | int8/binary | $0.12/1M | 🟡 if also using its image tower |
| OpenAI text-embedding-3-large | proprietary | weak-ish multi | yes | float only | $0.13/1M | ❌ no native quant, mid multilingual |
| NV-Embed-v2 | **CC-BY-NC** | yes | — | — | — | ❌ non-commercial license |

### Image / multimodal (the visual half)

| Model | License | Fashion-proven? | MRL | Verdict |
|---|---|---|---|---|
| **Marqo-FashionSigLIP** | verify per-ckpt | **✅ public SOTA** | no | ✅ **default image tower** |
| Marqo-FashionCLIP | verify | ✅ (2nd) | no | 🟡 |
| SigLIP 2 (Apache-2.0) | Apache-2.0 | generic, multilingual | no | 🟡 base to finetune for LK |
| Jina-CLIP-v2 | check | generic | yes (1024-64) | 🟡 multilingual multimodal |
| Cohere Embed v4 | proprietary | generic | yes | 🟡 unified text+image (managed) |
| Jina-embeddings-v4 | Qwen Research | generic | yes | ❌ license-restricted as default |
| OpenCLIP / CLIP | MIT | weak on fashion | no | ❌ |

### Quantization recipe (applies to both paths)

| Stage | Column type | When |
|---|---|---|
| Default | **`halfvec`** (MRL-truncated to 512-768) | always — free 50% win |
| At scale (>~10^6 vec/tenant) | **`bit` index + `halfvec` payload + rescore** | when index RAM is the constraint |
| int8 | provider-native int8 + custom storage | only if pgvector ships int8 (issue #521) |

---

## 8. Relevance to samesake (adopt / avoid / differentiate / integrate)

**ADOPT:**
- **Ship a default, stop saying only "BYO".** A framework that says "bring your own embeddings" with *no* opinionated default forces every adopter to re-run this analysis. Ship the two reference recipes above as documented presets (open-default = Qwen3-0.6B + Marqo-FashionSigLIP; managed-default = Gemini/Voyage + Cohere v4).
- **`halfvec` as the default pgvector column type.** Proven ~50% storage/RAM cut, negligible recall loss. There is no reason for `vector` (float32) to be the default. This is the single highest-leverage, lowest-risk change.
- **Marqo-FashionSigLIP as the default image tower** — it is the only fashion-benchmark-proven option and its training vocabulary mirrors samesake's facet model.

**AVOID:**
- **NV-Embed-v2 / Jina-v4 as *defaults*** — non-commercial / restrictive licenses are wrong for a framework others embed in their own apps. Keep them as "advanced, license-at-your-own-risk" options only.
- **Defaulting to 3072-d float32 OpenAI-large** — 4× the storage/RAM of a halfvec(768) open model, no native quantization, mediocre multilingual, and per-query token cost. Worst-of-all-worlds as a default.
- **Trusting MMTEB rank for the LK decision.** No fashion, no Sinhala/Tamil code-mix in the benchmark. Rank is a prior; samesake's own 5k bench is the judge.

**DIFFERENTIATE:**
- **LK code-mixed is the moat and the weakness.** The text model choice is where samesake's weakest benchmark type lives. Pair the multilingual *text* embedding (Qwen3/BGE-M3/Gemini) with samesake's existing Postgres FTS in RRF — the embedding handles cross-lingual semantics, FTS handles exact LK tokens/transliterations the embedding never saw. This is already samesake's architecture; the embedding choice should *amplify* it (pick the most multilingual model that fits), not replace it.
- **`/search/explain` should expose the embedding config** (model id, dims, quantization, recall floor). Auditability of *why a result ranked* must include *what space it was ranked in*. This is a differentiator no hosted vector DB offers.
- **MRL truncation as a per-tenant knob.** Because samesake compiles a typed catalog per tenant, the dims/quant point on the recall-cost frontier can be tuned per catalog size — small catalogs keep full dims, large catalogs truncate + binarize. Expose it; don't hardcode.

**INTEGRATE:**
- **Embedding adapter must be model-agnostic but dimension-aware.** The compiler needs to know dims + whether MRL truncation + re-normalization is safe for the chosen model (truncating a non-MRL model silently destroys recall). Encode "is MRL-truncatable" as a property of the registered embedding model.
- **Two-tower for fashion:** text tower (multilingual) + image tower (Marqo-FashionSigLIP) are *different spaces*; fuse via RRF (samesake already fuses FTS + ANN). Do **not** average vectors across towers. This slots cleanly into the existing "spaces" + RRF design — and note "spaces" is currently *off* (failed gate); a proper two-tower fusion may be exactly what makes a segmented space pass.
- **Binary + rescore needs the full/half vector retained** — the compiler's storage plan must co-locate the `bit` index and a `halfvec` payload column from day one, or the rescore path is impossible to add later without a re-index.

---

## 9. Open questions

1. **What is the actual license on the Marqo fashion checkpoints?** Must be confirmed per-checkpoint on HuggingFace before declaring it a commercial BYO default. (Not resolved in this pass.)
2. **How do top text models actually do on Sinhala/Tamil code-mixed fashion retrieval?** No benchmark covers this. samesake must build a small LK eval set and rank Qwen3 / BGE-M3 / mE5 / Gemini on it directly — leaderboards won't answer it.
3. **At what tenant catalog size does `bit`+rescore beat `halfvec`?** Needs an empirical crossover on samesake's own infra (RAM, QPS, p99) — the Katz numbers are on different datasets/dims.
4. **Does MRL truncation of Qwen3-0.6B to 512/256 hold recall on LK fashion**, or does it fall off the SMEC-style cliff earlier than English? Validate the prefix length on-corpus.
5. **Is a single multilingual multimodal model (Cohere v4 / Jina-CLIP-v2) good enough to collapse the two towers,** or does the fashion-specific image tower's edge (Marqo) justify keeping two? Likely two for now (fashion edge is large), but re-test as unified models improve.
6. **int8 in pgvector:** track issue #521 — first-class int8 would change the §4 recipe (better recall/byte than binary without rescoring complexity).
7. **Query-side cost model:** for managed APIs, what's the QPS break-even where self-hosting an open model becomes cheaper? Depends on traffic; needs a per-tenant calculator.
8. **Long product descriptions vs short context models:** Gemini's 2,048-token input limit forces chunking for rich LK product copy — does chunk-then-pool beat truncate? Open.

---

## 10. Sources

**Leaderboards / model families:**
- Modal — Top embedding models on the MTEB leaderboard: https://modal.com/blog/mteb-leaderboard-article
- Qwen3-Embedding (GitHub): https://github.com/QwenLM/Qwen3-Embedding ; paper arXiv 2506.05176: https://arxiv.org/pdf/2506.05176 ; HF 0.6B: https://huggingface.co/Qwen/Qwen3-Embedding-0.6B
- Llama-Embed-Nemotron-8B, arXiv 2511.07025: https://arxiv.org/html/2511.07025v1
- Embedding Model Leaderboard MTEB April 2026 (mirror): https://awesomeagents.ai/leaderboards/embedding-model-leaderboard-mteb-april-2026/
- BGE / GTE / E5 / Nomic guide: https://www.bentoml.com/blog/a-guide-to-open-source-embedding-models
- nomic-embed-text-v1.5 (HF): https://huggingface.co/nomic-ai/nomic-embed-text-v1.5 ; v2-moe: https://huggingface.co/nomic-ai/nomic-embed-text-v2-moe ; Nomic Matryoshka: https://www.nomic.ai/news/nomic-embed-matryoshka

**Pricing / dims (APIs):**
- OpenAI embeddings guide: https://developers.openai.com/api/docs/guides/embeddings ; pricing: https://tokenmix.ai/blog/openai-embedding-pricing
- Gemini embeddings: https://ai.google.dev/gemini-api/docs/embeddings ; GA blog: https://developers.googleblog.com/gemini-embedding-available-gemini-api/ ; paper arXiv 2503.07891: https://arxiv.org/pdf/2503.07891
- Voyage models: https://docs.voyageai.com/docs/embeddings ; pricing: https://docs.voyageai.com/docs/pricing ; Voyage-3.5 (MongoDB): https://www.mongodb.com/company/blog/product-release-announcements/introducing-voyage-3-5-voyage-3-5-lite-improved-quality-new-retrieval-frontier
- Cohere Embed v4: https://docs.cohere.com/changelog/embed-multimodal-v4 ; https://docs.cohere.com/docs/embeddings

**Matryoshka:**
- Kusupati et al., MRL, NeurIPS 2022: https://proceedings.neurips.cc/paper_files/paper/2022/file/c32319f4868da7613d78af9993100e42-Paper-Conference.pdf
- SBERT Matryoshka docs: https://www.sbert.net/examples/sentence_transformer/training/matryoshka/README.html
- SMEC (rethinking MRL compression), arXiv 2510.12474: https://arxiv.org/pdf/2510.12474

**Quantization / pgvector:**
- Jonathan Katz — scalar & binary quantization for pgvector: https://jkatz05.com/post/postgres/pgvector-scalar-binary-quantization/
- pgvector (GitHub): https://github.com/pgvector/pgvector ; int8 issue #521: https://github.com/pgvector/pgvector/issues/521
- Neon — use halfvec, save 50%: https://neon.com/blog/dont-use-vector-use-halvec-instead-and-save-50-of-your-storage-cost
- Storage optimization (quant + dim reduction), arXiv 2505.00105: https://arxiv.org/pdf/2505.00105

**Image / multimodal:**
- Marqo-FashionCLIP/SigLIP leaderboard: https://github.com/marqo-ai/marqo-FashionCLIP/blob/main/LEADERBOARD.md ; collection: https://huggingface.co/Marqo/marqo-fashionSigLIP ; blog: https://www.marqo.ai/blog/search-model-for-fashion
- SigLIP 2, arXiv 2502.14786: https://arxiv.org/pdf/2502.14786 ; HF blog: https://huggingface.co/blog/siglip2
- Jina-CLIP-v2: https://jina.ai/news/jina-clip-v2-multilingual-multimodal-embeddings-for-text-and-images/
- Jina-embeddings-v4, arXiv 2506.18902: https://arxiv.org/pdf/2506.18902 ; HF: https://huggingface.co/jinaai/jina-embeddings-v4

**Caveats on this pass:** All vendor MTEB/MMTEB scores are vendor-reported unless tied to the MTEB board; treat as MARKETED where so tagged. Marqo fashion-model licenses and some Jina licenses were *not* fully resolved (see Open Questions). gemini-embedding "2" and voyage-4 references appear in 2026-dated secondary sources; primary docs at fetch time described gemini-embedding-001 and the voyage-4 family.
