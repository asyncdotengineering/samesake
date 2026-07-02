# Visual Late-Interaction & Multimodal-LLM Retrieval/Rerank — Completeness Pass

> Gap fill for **samesake** (TypeScript-first "search-engine compiler" for visual commerce, fashion-first, Sri Lankan LK corpus, Postgres + pgvector, two-container deploy, RRF fusion, BYO embeddings). The first sweep covered plain CLIP single-vector ANN. This pass goes deep on what sits *beyond* plain CLIP ANN: late-interaction multi-vector image retrieval (ColPali/ColQwen), multimodal-LLM rerankers, region/object localization for visual product search, and image preprocessing for product embeddings.

**Scope discipline:** Each candidate is judged against three samesake invariants it must not break:
1. **Two-container promise** — Postgres + pgvector running *in the user's app*; no Redis/Elasticsearch/hosted vector DB.
2. **BYO embedding/generation models** — samesake does not ship or host a model.
3. **`findProducts()` stops at retrieval** — retrieval/rerank is in-scope; generation is not.

Labels used: **PROVEN** (paper/benchmark/doc with a number), **MARKETED** (vendor blog / unquantified claim).

---

## 1. ColPali / ColQwen — late interaction over image patches

### 1.1 What it is (PROVEN)

ColPali (*"ColPali: Efficient Document Retrieval with Vision Language Models"*, Faysse et al., **ICLR 2025**, arXiv:2407.01449) is a VLM trained to emit **multi-vector** embeddings from a *page image*, scored with a ColBERT-style **late-interaction MaxSim** operator instead of a single cosine. It was designed for **visually-rich document/PDF retrieval** (ViDoRe benchmark), explicitly to avoid an OCR/layout pipeline.

Load-bearing specs (from the HTML full text, arXiv:2407.01449v2):

- **1024 patch embeddings per page** (a 512-patch variant was also tested).
- Each PaliGemma vector projected to **D=128**: *"we project each PaliGemma vector to a lower dimensional space (D=128)."*
- **Storage: 256 KB per page.** *"ColPali's embedding size is an order of magnitude larger than BM25 and two orders of magnitude larger than BGE-M3."*
- Late-interaction operator: `LI(q,d) = Σᵢ maxⱼ ⟨E_q^(i) | E_d^(j)⟩` — sum over query vectors of the max dot product against all document vectors.
- **ViDoRe nDCG@5 = 81.3** average vs Unstructured+Captioning 67.0, BiSigLIP 58.6, SigLIP 51.4.
- **License is the catch:** ColPali (on PaliGemma) is **Gemma Research license**; only ColIdefics2 is **Apache-2.0**. ColQwen2 inherits Qwen2-VL licensing.

ColQwen2 swaps the backbone to Qwen2-VL (variable resolution, often more patches/page), generally the stronger ViDoRe scorer and the one most blog tutorials use.

### 1.2 The two costs the paper itself flags (PROVEN)

1. **Storage blow-up.** 256 KB/page is ~100× a single BGE-M3 vector. For a 5k-doc fashion catalog this is "fine" (~1.3 GB raw before compression); for a multi-tenant compiler shipped into arbitrary user apps it is a real footprint question.
2. **Inference inefficiency + no native infra.** *"Late interaction yields considerable improvements in retrieval effectiveness; however, it also introduces computational inefficiencies during inference."* And, decisively for samesake: *"Many widely used vector retrieval frameworks do not propose native multi-vector support, and some engineering infrastructure efforts may be required to adapt them."* The paper notes the footprint *"can be drastically improved through compression and clustering."*

### 1.3 Does the *document-retrieval* pattern transfer to *product* images? (partly PROVEN, partly UNTESTED)

ColPali's whole reason to exist is that **document pages carry dense, spatially-localized text/tables/figures** that a single global embedding smears out. A fashion product photo is the *opposite*: it is usually one garment, photographed clean, with a short attribute set. The marginal value of "let each query token find its best-matching patch" is highest when the image is information-dense and multi-region — exactly *not* a clean PLP product shot.

- **Where it could transfer:** multi-garment lifestyle/lookbook shots ("the striped shirt the model is wearing, not the bag"), or LK catalog images that bake text overlays (price, brand, "SALE") into the photo — those text-in-image cases are literally what ColPali is best at, and would otherwise be lost by global CLIP.
- **Where it likely does *not* pay:** single-item, white-background product shots — the dominant case — where global CLIP/SigLIP already captures the whole garment.
- I found **no peer-reviewed benchmark of ColPali/ColQwen on a pure product-image retrieval task** (only document/PDF ViDoRe, plus marketed e-commerce mentions). The MDPI piece *"Transforming Product Discovery and Interpretation Using Vision–Language Models"* (mdpi.com/0718-1876/20/3/191) and the analyticsvidhya ColQwen+Vespa tutorial are **MARKETED / illustrative**, not benchmarks on product retrieval. Treat product-image ColPali as **promising-but-unproven for fashion**.

### 1.4 Can it live in Postgres/pgvector? (the load-bearing question)

**pgvector alone: no native multi-vector / MaxSim.** Confirmed by pgvector issue #640 ("Late interaction embedding support") and ParadeDB's "pgvector Limitations": ColBERT/ColPali-style retrieval on bare pgvector requires **multiple rows per document, application-side MaxSim aggregation, or a separate index** — i.e., you hand-roll it. That is doable but adds an aggregation layer samesake does not have today.

**VectorChord (vchord): yes, but it changes the stack and the license.**
- VectorChord 0.3 (blog.vectorchord.ai) implements MaxSim by *"multiple single-vector searches—one for each query vector—using…IVF combined with RaBitQ"* then aggregating. FiQA: **NDCG@10 34.1** (vs WARP 33.6) at *"just 35 milliseconds per query."*
- Its ColBERT-rerank docs expose a `max_sim(document vector[], query vector[])` SQL function over a `vchordrq` (RaBitQ) index — *"combine sentence-level vector search with token-level late interaction rerank."* fiqa 0.232 → 0.303 NDCG@10. It openly states the tradeoff: *"Token-level late interaction requires more computing power and storage…making ColBERT search in large datasets challenging, especially when low latency is important."*
- **It supports ColPali/ColQwen conceptually but the docs do not demonstrate image-patch implementation** — only text ColBERT is shown end-to-end.
- **License is the dealbreaker for samesake's deploy model: VectorChord is AGPLv3 (dual-licensed with Elastic License v2)** (pgxn.org/dist/vchord). samesake ships *into the user's app* as a compiler output — pulling an AGPLv3 extension into that two-container image is a copyleft exposure most commercial users will reject. This is the single biggest reason ColPali-in-Postgres is **integrate-cautiously, not adopt**.

### 1.5 The escape hatch: MUVERA (PROVEN, and it preserves pgvector)

MUVERA (*"Multi-Vector Retrieval via Fixed Dimensional Encodings"*, Dhulipala et al., **NeurIPS 2024**, arXiv:2405.19504, Google) collapses a multi-vector set into a **single fixed-dimension vector (FDE)** whose inner product *approximates* MaxSim. Reported: *"average of 10% improved recall with 90% lower latency"* vs prior multi-vector SOTA, retrieving *"2–5× fewer candidates."* Google's blog frames it as *"making multi-vector retrieval as fast as single-vector search."* It has been applied to ColPali embeddings (Qdrant/Milvus tutorials).

**Why this matters for samesake:** an FDE is just a single vector — it indexes in **plain pgvector cosine ANN with zero new extension and no AGPL**. The expensive exact MaxSim can then run only as an optional rerank over the top-k (application-side, on the BYO model's raw multi-vectors). MUVERA is the bridge that lets samesake taste late-interaction recall *without* breaking the two-container/pgvector promise.

---

## 2. Multimodal-LLM (VLM) rerankers — query × (product image + text)

### 2.1 The pattern (PROVEN, nascent)

A VLM scores each retrieved candidate against the query as a second stage. Two shapes:
- **Pointwise True/False / relevance**: prompt the VLM "does this product image+text satisfy the query?" and use the score to reorder top-k.
- **Listwise**: feed several candidates and ask for a ranking ("When Vision Meets Texts in Listwise Reranking", arXiv:2601.20623).

Evidence base:
- *"VLM Is a Strong Reranker…Knowledge-enhanced Reranking and Noise-injected Training"* (RagVL, **EMNLP 2025 Findings**, aclanthology 2025.findings-emnlp.432): instruction-tune a VLM *"to induce its ranking ability and serve it as a reranker to precisely filter the top-k retrieved images."* Effective on 4 datasets — **but the paper reports no latency/cost numbers** (a real gap for production reasoning).
- *MM-R5* (arXiv:2506.12364): RL-trained multimodal reranker for document retrieval.
- *MM-Embed* (NVIDIA, arXiv:2411.02571): multimodal-LLM as universal retriever/reranker.
- The honest framing from the survey results: *"VLMs have begun preliminary explorations into multimodal reranking…still nascent compared to unimodal,"* and zero-shot MLLM rerankers *"mainly improve tasks where queries contain both text and images"* (composed image retrieval, VQA) — i.e. exactly the **multimodal/composed query** case, which is where samesake's conversational + image-in-query surface lives.

### 2.2 Industrial reality check (PROVEN it exists; numbers proprietary)

*Pailitao-VL: Unified Embedding and Reranker for Real-Time Multi-Modal Industrial Search* (**Alibaba/Taobao, 2026**, arXiv:2602.13704) is a production two-stage embed→rerank multimodal search system targeting *"real-time…subsecond"* e-commerce search, benchmarked against CLIP/VLM2Vec/E5-V. It confirms the embed-then-VLM-rerank topology is what large fashion-heavy marketplaces actually deploy — but lift/cost specifics are proprietary in the abstract.

### 2.3 Fit with samesake

This is the **cleanest architectural fit** of the whole gap:
- It is a **rerank-only** stage over an already-retrieved top-k — it does not touch storage, the pgvector index, or the two-container shape.
- samesake **already plans a cross-encoder reranker (optional)** — a VLM reranker is the multimodal generalization of that exact slot.
- It is **BYO-model-native**: the user brings the VLM; samesake just defines the rerank contract (query + candidate image+text → score) and fuses into the existing RRF/score-modifier pipeline.
- It respects `findProducts()` stopping at retrieval: scoring candidates is retrieval-side; it does not generate an answer.

**Caveats:** latency and $/query are the open risk (a VLM call per candidate is far more expensive than cosine); keep it as an **optional, top-k≤~20, off-by-default** stage, exactly like the planned cross-encoder. For LK code-mixed Sinhala/Tamil/English queries — samesake's weakest benchmark — a VLM reranker that *reads* the garment and the multilingual query text together is plausibly the single highest-leverage quality lever, but **must be measured on the LK bench, not assumed.**

---

## 3. Region / object localization for visual product search

### 3.1 The capability (PROVEN)

- **OWL-ViT** (*"Simple Open-Vocabulary Object Detection with Vision Transformers"*, Google) — CLIP backbone + box head; *"given an image and a free-text query, OWL-ViT finds objects matching that query."* Critically it also supports **image-conditioned one-shot detection** (use an image crop as the query). This is the textbook way to return a **bounding-box "highlight"** of *which region matched* a query — query-conditioned reranking that explains itself.
- **Grounding DINO / DINO / YOLOX** patching — detect garment regions, crop, embed the crop instead of the whole frame.

### 3.2 Why fashion wants it

For lifestyle/lookbook/multi-garment imagery, "more-like-this on the *shoes*, not the dress" requires region grounding. OWL-ViT's query-conditioned scoring can both (a) rerank by "best-matching region similarity" and (b) **return the bbox for UI highlighting** — directly useful for samesake's `/search/explain` auditability story (show *where* in the image the match came from) and for "more-like-this" item-to-item.

### 3.3 Fit with samesake

- This is **preprocessing + an optional rerank signal**, computed by a BYO detector, stored as extra columns (region embeddings, bbox) — it does **not** break the two-container promise.
- The bbox "highlight" output is a strong **differentiator** that plugs into `/search/explain` and the planned item-to-item surface.
- **Cost is at index time** (detect+crop once per product) — cheap to amortize, unlike per-query VLM reranking.

---

## 4. Image preprocessing for product embeddings (background removal, garment cropping, VL-CLIP)

### 4.1 Background removal — modest, and can *hurt* (PROVEN)

*"The Impact of Background Removal on Performance of Neural Networks for Fashion Image Classification and Segmentation"* (arXiv:2308.09764, 2023):
- *"It can improve model accuracy by up to 5% on the FashionStyle14 dataset when training models from scratch."*
- But: *"Background removal does not perform well in deep neural networks due to incompatibility with other regularization techniques like batch normalization, pre-trained initialization, and data augmentations."*
- And the explicit caveat: *"The loss of background pixels invalidates many existing training tricks…adding the risk of overfitting for deep models."*

**Implication:** for a BYO *pretrained* CLIP/SigLIP (samesake's normal case), naive `rembg`-style background removal is **not reliably worth it** and may degrade — because pretrained encoders were trained on natural backgrounds. Garment **cropping/region-grounding** (keep context, isolate the item) is the safer preprocessing than wholesale background deletion.

### 4.2 VL-CLIP — the production win that ties §3 and §4 together (PROVEN, strong numbers)

*"VL-CLIP: Enhancing Multimodal Recommendations via Visual Grounding and LLM-Augmented CLIP Embeddings"* (**RecSys 2025**, arXiv:2507.17080):
- *"Visual Grounding refines image representations by localizing key products, while the LLM agent enhances textual features by disambiguating product descriptions."*
- Deployed on *"one of the largest e-commerce platforms in the U.S."* across *"tens of millions of items"*, reporting: **CTR +18.6%, ATC +15.5%, GMV +4.0%.**
- (The abstract does not name the specific grounding model or give latency.)

This is the most directly transferable, *quantified* commerce result in this gap. The recipe — **ground/crop the product region, then embed; enrich the text with an LLM, then embed** — is precisely a **BYO-model enrich-pipeline preprocessing step**, which samesake already has the surface for (multimodal enrich pipeline). It improves the embedding *before* it ever hits pgvector, so it is **index-time, two-container-safe, and model-agnostic.**

---

## 5. Comparison table

| Candidate | What it adds | Where cost lands | Breaks 2-container? | Proven for fashion? | License risk | Verdict for samesake |
|---|---|---|---|---|---|---|
| **ColPali/ColQwen raw multi-vector in pgvector** | Late-interaction recall on text-in-image / multi-region shots | 256KB/page storage + app-side MaxSim | Yes (no native pgvector MaxSim) | No (doc-only benchmarks) | Gemma Research / Qwen license on model | **Avoid as default** |
| **ColPali via VectorChord (vchordrq + max_sim)** | Native MaxSim in Postgres, 35ms/query | Storage + compute; new extension | **Yes — adds AGPLv3 extension** | No (text-ColBERT demoed, not product images) | **AGPLv3 / Elastic v2 — copyleft in user's app** | **Avoid (license)** |
| **MUVERA FDE → plain pgvector cosine** | ~MaxSim recall as a *single* vector; +10% recall / −90% latency vs multi-vec SOTA | Encode-time only; no new infra | **No** | Doc benchmarks; product untested | None (algorithm) | **Differentiate / pilot** — the only late-interaction path that keeps the promise |
| **VLM reranker (pointwise/listwise) over top-k** | Quality on composed/multilingual queries; reads image+text+query jointly | Per-query VLM calls (expensive) | No (rerank stage) | Industrial precedent (Pailitao-VL); no public fashion lift number | None (BYO model) | **Adopt as optional, off-by-default** — generalizes planned cross-encoder |
| **OWL-ViT region localization + bbox highlight** | "Which region matched"; region-level more-like-this; explainability | Index-time detect/crop | No (preprocessing + columns) | Detection proven; retrieval-lift not benchmarked here | Apache-2.0 (OWL-ViT) | **Integrate (selective)** — strong `/search/explain` + item-to-item differentiator |
| **Background removal (rembg/U2-Net)** | Up to +5% from-scratch; can hurt pretrained deep nets | Index-time | No | Mixed (PROVEN it can degrade pretrained) | Permissive | **Avoid as blanket default** |
| **VL-CLIP (ground+crop → embed; LLM-enrich text → embed)** | Better embeddings pre-index | Index-time | No | **PROVEN in production: +18.6% CTR, +4% GMV** | None (BYO) | **Adopt (highest ROI)** — fits existing enrich pipeline |

---

## 6. Relevance to samesake

**Adopt**
- **VL-CLIP-style enrich preprocessing** (visual grounding/crop before image embedding; LLM text enrichment before text embedding). It is index-time, model-agnostic, fits the existing multimodal enrich pipeline, and is the only candidate here with a *quantified production commerce lift*. Highest ROI, lowest architectural risk.
- **Optional VLM reranker** as the multimodal generalization of the already-planned cross-encoder slot: off by default, top-k ≤ ~20, BYO VLM, fused via RRF/score-modifiers. Likely the strongest lever for LK code-mixed queries — *but gate it on the LK bench*.

**Differentiate / pilot**
- **MUVERA FDE on top of ColPali/ColQwen multi-vectors**, indexed as a *single* vector in plain pgvector, with exact MaxSim only as an optional app-side rerank over top-k. This is the one way to get late-interaction recall *without* a new extension or AGPL — a genuine architectural differentiator if a fashion ablation shows lift.

**Integrate (selective)**
- **OWL-ViT region grounding + bbox "highlights"** for lifestyle/multi-garment imagery and region-level "more-like-this," surfaced through `/search/explain`. Apache-2.0, index-time cost, explainability differentiator.

**Avoid**
- **Raw ColPali/ColQwen multi-vector retrieval as a default** — no fashion benchmark, 256KB/page storage, no native pgvector MaxSim.
- **VectorChord-backed MaxSim** — **AGPLv3/Elastic-License-v2 copyleft is incompatible with shipping into arbitrary commercial user apps** (the two-container deploy puts the extension inside the customer's image). This is a hard licensing stop, independent of the technical merits.
- **Blanket background removal** — can degrade pretrained BYO encoders; prefer cropping/grounding that preserves context.

---

## 7. Open questions

1. **Does ColPali/ColQwen multi-vector beat global SigLIP on *product* (not document) retrieval, and specifically on LK fashion with text-in-image overlays?** No public benchmark exists — samesake would have to ablate on its own 5k LK corpus.
2. **MUVERA FDE quality on product images:** how much MaxSim recall survives the FDE compression for short, single-item garment vectors (vs the long token sequences MUVERA was validated on)? Needs a measurement on the LK bench.
3. **VLM reranker $/query and p95 latency** at top-k 10–20 with a realistic BYO VLM — none of the rerank papers report it. What is the break-even vs the planned text cross-encoder?
4. **Does a VLM reranker actually close samesake's "local query" gap** (Sinhala/Tamil code-mixed)? Hypothesis only; must be measured against mean grade@10 ~2.33 / P@5 0.83 baselines.
5. **OWL-ViT retrieval lift (not just detection accuracy)** — does region-conditioned reranking improve P@5 on multi-garment LK imagery, and what fraction of the corpus is multi-garment enough to matter?
6. **Is there a permissively-licensed (non-AGPL) Postgres MaxSim path?** Watch pgvector issue #640 and ParadeDB; if pgvector gains native multi-vector, the ColPali calculus changes.
7. **Storage budget per tenant** if multi-vectors are stored at 256KB/page — acceptable for 5k docs, but what is the ceiling for the compiler's larger users?

---

## 8. Sources

**Late interaction / multi-vector**
- Faysse et al., *ColPali: Efficient Document Retrieval with Vision Language Models*, ICLR 2025 — https://arxiv.org/abs/2407.01449 ; full text https://arxiv.org/html/2407.01449v2 (1024 vectors/page, D=128, 256KB/page, ViDoRe nDCG@5 81.3, Gemma Research license, "computational inefficiencies during inference")
- *Reproducibility…Visual Document Retrieval with Late Interaction*, arXiv:2505.07730 — https://arxiv.org/abs/2505.07730
- Dhulipala et al., *MUVERA: Multi-Vector Retrieval via Fixed Dimensional Encodings*, NeurIPS 2024 — https://arxiv.org/abs/2405.19504 ; Google blog https://research.google/blog/muvera-making-multi-vector-retrieval-as-fast-as-single-vector-search/ ("10% improved recall with 90% lower latency")
- illuin-tech/colpali (ColPali, ColQwen2, ColSmol) — https://github.com/illuin-tech/colpali

**pgvector / Postgres MaxSim**
- VectorChord 0.3 multi-vector late interaction — https://blog.vectorchord.ai/vectorchord-03-bringing-efficient-multi-vector-contextual-late-interaction-in-postgresql (FiQA NDCG@10 34.1, 35ms/query)
- VectorChord ColBERT rerank docs (`max_sim`, `vchordrq`) — https://docs.vectorchord.ai/vectorchord/use-case/colbert-rerank.html
- VectorChord license (AGPLv3 / Elastic v2) — https://pgxn.org/dist/vchord/ ; https://github.com/tensorchord/VectorChord
- pgvector issue #640 (no native late interaction) — https://github.com/pgvector/pgvector/issues/640
- ParadeDB, *pgvector Limitations* — https://www.paradedb.com/learn/postgresql/pgvector-limitations

**Multimodal-LLM rerankers**
- *VLM Is a Strong Reranker (RagVL)*, EMNLP 2025 Findings — https://aclanthology.org/2025.findings-emnlp.432/
- *MM-R5: MultiModal Reasoning-Enhanced ReRanker via RL*, arXiv:2506.12364 — https://arxiv.org/pdf/2506.12364
- *Pailitao-VL: Unified Embedding and Reranker for Real-Time Multi-Modal Industrial Search* (Alibaba/Taobao, 2026), arXiv:2602.13704 — https://arxiv.org/pdf/2602.13704
- *MM-Embed: Universal Multimodal Retrieval with Multimodal LLMs* (NVIDIA), arXiv:2411.02571 — https://arxiv.org/pdf/2411.02571
- *When Vision Meets Texts in Listwise Reranking*, arXiv:2601.20623 — https://arxiv.org/html/2601.20623v1

**Region localization**
- OWL-ViT, *Simple Open-Vocabulary Object Detection with Vision Transformers* (Google) — https://huggingface.co/docs/transformers/en/model_doc/owlvit

**Preprocessing / fashion embeddings**
- *VL-CLIP: Enhancing Multimodal Recommendations via Visual Grounding and LLM-Augmented CLIP Embeddings*, RecSys 2025, arXiv:2507.17080 — https://arxiv.org/abs/2507.17080 (CTR +18.6%, ATC +15.5%, GMV +4.0%)
- *The Impact of Background Removal on…Fashion Image Classification and Segmentation*, arXiv:2308.09764 (2023) — https://arxiv.org/abs/2308.09764 (up to +5% from scratch; hurts deep pretrained nets)

**Fetches that failed / partial**
- arXiv:2507.17080 PDF exceeded fetch size limit; used the abstract page instead (numbers confirmed there).
- arXiv:2407.01449 abstract page returned metadata only; used the v2 HTML full text for specs.
