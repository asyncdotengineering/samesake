# Marqo — Models & Training Deep-Dive

> Research dossier for **samesake** (TypeScript-first "search-engine compiler" for visual commerce, fashion-first; Postgres + pgvector hybrid retrieval, BYO embeddings, RRF fusion, NLQ + enrich + `findProducts()` agentic surface that stops at retrieval).
>
> Scope of this file: Marqo's **technical training / embedding work** — ecommerce embedding models, Marqtune fine-tuning, the fashion model family, "tensor search", foundation models, fine-tuning + automated query analysis, and personalization/context.

---

## 0. Important scraping caveat (read first)

Between the original publication dates (2023–2024) and the scrape date (June 2026), **Marqo rewrote or deleted most of these blog posts** and 301-redirected the technical URLs to generic marketing pages. The live site has rebranded around a new umbrella term, **"Commerce Superintelligence"**, and a conversational agent, **"Sibbi"**. Specifically:

- `introducing-marqos-ecommerce-embedding-models` → now redirects to **"What Is Marqo?"** (all model/benchmark detail removed).
- `introducing-marqtune` → now redirects to **"What Is Marqo?"**.
- `context-is-all-you-need-...` → now redirects to **"What Is Marqo?"**.
- `what-is-tensor-search` → rewritten as **"From Tensor Search to Commerce Superintelligence"** — and the rewrite literally argues that tensor/vector search "as a standalone capability has been absorbed", scrubbing the original tensor-search technical explainer.
- The remaining live pages (`fashion`, `foundation-models`, `fine-tuning + query analysis`, `ai-product-discovery`) survive with content intact.

To recover the load-bearing technical claims I pulled the **Wayback Machine** snapshots (Nov 2024 / Jan 2025) for the three deleted posts. Where I quote from the original, I label it **[2024 original]**; where from the current live page, **[2026 live]**.

**Notable artifact / flag:** the current `what-are-foundation-models-in-machine-learning` page leaked a raw **Claude Code generation transcript** into the rendered HTML — a `.jsonl` fragment containing the author's prompt, a *banned-terms list* ("no em dashes, no 'vector search,' 'tensor search,' 'open source,' 'embeddings,' 'reasoning,' 'clickstream,' 'chatbot,' 'AI-powered,' 'best-in-class'"), a self-grading checklist ("'Commerce Superintelligence' appears 5 times"), an instruction to write in "Stripe-style" tone, the author's working dir (`/Users/ana/marqo-website`), and git branch (`fix/customer-stories-updates`). This is direct, unintended evidence that Marqo's 2026 blog is **LLM-generated SEO content engineered to suppress the very technical vocabulary (embeddings, vector/tensor search, open source) that built the company's credibility**. Treat all 2026 "live" claims as marketing; treat the 2024 originals as the real engineering record.

---

## 1. Positioning & vocabulary

### 1.1 The 2024 engineering identity (what Marqo actually was)
- **"a vector search platform equipped with the machine learning capabilities and infrastructure you need to deploy next-gen AI-powered search. We handle everything from vector generation to storage and retrieval, enabling you to implement multimodal, multilingual search through a single API."** [2024 original, Marqtune]
- Self-description: **"our proprietary inference engine converts unstructured data into high-performance vectors, returning hyper-relevant search results in real time."** [2024 original]
- Open-source core (`github.com/marqo-ai/marqo`) + Marqo Cloud (managed). Docker-deployable. Default ANN = **HNSW**. Default model historically **ViT-L-14 (OpenCLIP)**.
- Vocabulary then: *vector search, tensor search, multimodal, embeddings, contrastive learning, ANN/HNSW, context vectors, score modifiers, multimodal combination objects.*

### 1.2 The 2026 marketing identity (what Marqo now claims to be)
- **"the AI-native product discovery platform that delivers Commerce Superintelligence for enterprise retailers. It trains a dedicated AI for each retailer that understands every product in their catalog, then combines that product intelligence with behavioral data and personalization."** [2026 live]
- New coinages: **Commerce Superintelligence**, **product-native intelligence**, **Sibbi** (conversational agent), **Marqo Pixel** (behavior-capture drop-in), **Zero-Shot Product Competency**, **Full-Journey Intelligence Continuity**.
- Six "architectural requirements" of Commerce Superintelligence [2026 live]: Product-Native Intelligence; Full-Journey Intelligence Continuity; Unified Cross-Modal Retrieval; Zero-Shot Product Competency; Embedded Commercial Optimization; Visual Product Reasoning Across the Full Stack.
- The rebrand explicitly **demotes embeddings/vector/tensor search to "infrastructure", not product**: *"tensor search was an infrastructure capability, not a complete solution… No modern enterprise retailer would deploy a [tensor] search platform in isolation."* [2026 live]

**Relevance flag:** Marqo's 2024 vocabulary is almost exactly samesake's vocabulary (hybrid retrieval, embeddings, ANN, multimodal, score modifiers). Marqo has since **abandoned that positioning upmarket** toward a full-funnel, behavior-trained, hosted "intelligence layer" with conversational + post-purchase. That vacated developer-infra/typed-retrieval niche is precisely where samesake sits.

---

## 2. The fashion model family — Marqo-FashionCLIP / Marqo-FashionSigLIP

Source: `search-model-for-fashion` [2026 live, content intact], plus the model cards it points to.

### 2.1 What they are
- **Marqo-FashionCLIP** and **Marqo-FashionSigLIP**: **150M-parameter** multimodal (text+image) embedding models for fashion search & recommendations.
- Fine-tuned from base models **`ViT-B-16-laion`** and **`ViT-B-16-SigLIP-webli`** respectively.
- Trained on **"over 1M fashion products with rich metadata."**
- Released **Apache 2.0**, on Hugging Face (`Marqo/marqo-fashionCLIP`, `…-fashionSigLIP`) + Marqo Cloud. Output dim **512** (ViT-B-16).

### 2.2 Method — Generalized Contrastive Learning (GCL), 7-component loss
- **"Use Generalized Contrastive Learning (GCL) to optimize over seven fashion-specific aspects: descriptions, titles, colors, details, categories, keywords, and materials."**
- **"The loss function contains seven components… This multi-part loss significantly outperformed standard text-image InfoNCE loss in contrastive learning, enabling retrieval of relevant results for both short keyword text and longer descriptive text."**
- This is the core technical bet: a **multi-field / multi-aspect contrastive loss** so one embedding space serves both head (keyword/category) and tail (long descriptive) queries.

### 2.3 Benchmarks (claimed)
Evaluated across **7 public fashion datasets**: DeepFashion In-shop (52,591 imgs), DeepFashion Multimodal (42,537), Fashion200K (201,624), KAGL (44,434), Atlas (78,370), Polyvore (94,096), iMaterialist (721,065).

Three tasks: **Text-to-Image** (long descriptive / tail), **Category-to-Product** (short keyword / head), **Sub-Category-to-Product**.

| Task | Metric | Marqo-FashionCLIP | Marqo-FashionSigLIP |
|---|---|---|---|
| Text→Image | Recall@1 vs FashionCLIP2.0 | **+22%** | **+57%** |
| Category→Product | Precision@1 | **+8%** | **+11%** |
| Sub-Category→Product | Precision@1 | **+11%** | **+13%** |

Plus: **"10% faster than existing fashion-specific models for combined text and image inference"**; FashionSigLIP claims to beat its own base `ViT-B-16-SigLIP` on *all* benchmarks.

**Defensible vs marketing:** *Mostly defensible.* Open weights (Apache 2.0), public eval datasets, an eval harness on GitHub (`marqo-ai/marqo-FashionCLIP`, `marqo-ai/GCL`) — reproducible in principle. Baselines (FashionCLIP2.0, OpenFashionCLIP, SigLIP) are real and contemporary. Caveat: "+57% Recall@1" is a relative lift off a possibly-low base; absolute Recall@1 numbers were not in the rewritten page.

---

## 3. The ecommerce embedding models — Marqo-Ecommerce-B / -L

Source: `introducing-marqos-ecommerce-embedding-models` **[2024 original, recovered via Wayback, Nov 9 2024]**. (Live URL now scrubbed.)

### 3.1 What they are
- Two **"foundation models for ecommerce"**: **Marqo-Ecommerce-B** and **Marqo-Ecommerce-L**, for multimodal product embeddings from image+text.
- **B**: embedding dim **768**, inference **5.1 ms text / 5.7 ms image** (single batch).
- **L**: **652M parameters**, embedding dim **1024**, better retrieval (up to +7.3% MRR / +7.4% nDCG@10 over B).
- Apache-style open release on Hugging Face (`Marqo/marqo-ecommerce-embeddings-B` / `-L`); usable in OpenCLIP and HF Transformers; available in Marqo OSS + Cloud.

### 3.2 Training data
- **"trained on 100s of millions of samples from ~50 million unique products across 20,000 Amazon asin categories"** spanning appliances → automotive → office → pet supplies.
- Categories drawn from **Amazon's product taxonomy**.
- Built to be fine-tunable per-customer via **Marqtune** (backed by **GCL**, arXiv:2404.08535).

### 3.3 Benchmark design (this is the genuinely good part)
Two regimes:
- **`marqo-ecommerce-hard`**: **4M products** — "the true challenge… more representative of real-world ecommerce search."
- **`marqo-ecommerce-easy`**: **200k products**, 10–30× smaller, built specifically to accommodate **rate-limited API providers** (Cohere-Embed-v3 at 0.66 rps, GCP-Vertex at 2 rps).

Three tasks: **GoogleShopping-Text2Image** (1M image-title pairs), **GoogleShopping-Category2Image** (1M, short keyword, multiple correct images), **AmazonProducts-Text2Image** (3M pairs).

Metrics: **MRR, nDCG@10, Recall@10, mAP, Precision@10**. Datasets + eval scripts published on HF + GitHub.

Baselines benchmarked: open `ViT-B-16-SigLIP`, `ViT-L-16-SigLIP`, best-open-source `ViT-SO400M-14-SigLIP`; private APIs Amazon-Titan-Multimodal, GCP-Vertex, Jina-V1-CLIP, Cohere-Embed-v3.

### 3.4 Headline claims (verbatim)
- **"outperform existing state-of-the-art solutions like Amazon Titan's Multimodal Embedding by up to 88% and the best open source model (ViT-SO400M-14-SigLIP) by up to 31%."**
- Marqo-Ecommerce-L vs best open source (`ViT-SO400M-14-SigLIP`) on the **4M (hard)** set: **+17.6% MRR, +20.5% nDCG@10** averaged over 3 tasks.
- Marqo-Ecommerce-L vs Amazon-Titan-Multimodal on hard set: **+38.9% MRR, +45.1% nDCG@10**, and **+35.9% Recall** on Text-to-Image tasks.
- The **"88%"** figure comes specifically from **GoogleShopping-Category2Image**: "+88% in mAP, +52% in Precision@10, +49.3% in nDCG@10 over Amazon-Titan."

**Defensible vs marketing:** *Defensible methodology, marketing framing.* The "easy/hard" split, the published datasets, the rate-limit disclosure, and the eval scripts are unusually honest and reproducible. But the single "88%" headline cherry-picks the best metric on the easiest-to-beat baseline (Titan's category retrieval) — classic best-number-forward. Note the **"88% over Amazon Titan"** number is the *same* one the 2026 foundation-models page recycles as a generic "Marqo's internal benchmarks show an 88% improvement over Amazon Titan" — the 2026 page strips the dataset/task context, converting a specific 2024 result into a vague evergreen claim.

---

## 4. Marqtune — the fine-tuning platform

Source: `introducing-marqtune` **[2024 original, recovered via Wayback, Jul 22 2024]**. (Live URL scrubbed.)

### 4.1 What it is
- **"the embedding model training platform that allows you to train highly specialised, billion parameter embedding models that improve search, recommendations and RAG applications."**
- Built on Marqo's **Generalized Contrastive Learning (GCL)** framework.
- Productizes per-customer fine-tuning: **"fine-tune embedding models with just a few lines of code."** Available in Marqo Cloud (request-access at launch).

### 4.2 The core argument (GCL value prop)
- **"With GCL, you can fine-tune embedding models to rank search results not only by semantic relevance but also by a ranking system defined by your search team."**
- Stated operational motivation: **"Every vector search system in production needs to have its models continuously retrained and updated. Doing this manually is simply not feasible."** Marqtune automates the retrain loop.
- Pain it claims to solve: off-the-shelf CLIP gives results that are "technically correct" but "miss the true intent" — GCL aligns relevance to *business-defined* ranking + behavioral data.

### 4.3 Customer evidence (Redbubble)
- 2023 engagement; vector search rollout improved add-to-cart, conversions, latency.
- Key claim: open-source CLIP didn't match Redbubble's intent; **"models fine-tuned with Marqtune increased add-to-cart rate by 12% for 3+ word queries (representing a third of all search volume) compared to the existing keyword search."**
- Notable generalization argument: **"previously unsold works do not require a score to be easily surfaced in search — they simply must fit the style of works that are successful"** — i.e. content-based generalization beats behavioral cold-start. (This is exactly the "zero-shot / cold-start" pitch the 2026 rebrand later inflates.)

**Defensible vs marketing:** The +12% ATC for 3+-word queries is a specific, scoped, A/B-tested claim → defensible. "Billion-parameter embedding models" is aspirational headroom, not what the shipped Ecommerce-L (652M) or Fashion (150M) models actually are.

---

## 5. Fine-tuning + automated query analysis (Marqo × BluelightAI)

Source: `optimize-ecommerce-search-with-fine-tuning-and-automated-query-analysis` [2026 live, content largely intact].

- Marqo + **BluelightAI** (their **Cobalt** product): fine-tune with Marqtune, then **automate per-query performance analysis** so teams target whole product *categories* rather than fixing one query at a time.
- Worked example: fine-tuned **`e5-base-v2`** on a **100k subset of `Marqo-GS-10M`** (Marqo's **Google Shopping 10M-product** dataset on HF), **14 training epochs**.
- Measures **impact-per-query via NDCG**; Cobalt uses **"advanced natural language clustering"** to auto-generate **group labels** over queries → analyze clusters, not individual queries.
- Pipeline: (1) fine-tune w/ Marqtune → (2) collect per-query performance on a fixed query set across model versions → (3) cluster queries (Cobalt) → (4) iterate.

**Relevance flag:** This is the missing half of any eval-driven search compiler — **automated regression analysis at the query-cluster level**. samesake already has eval (grade@10, P@5) and `/search/explain`; a Cobalt-style **per-cluster NDCG delta dashboard** would be a natural extension of samesake's eval gate (e.g., the "spaces" feature that "didn't pass eval gate" could be diagnosed by cluster, not just aggregate).

---

## 6. "Tensor search" — the concept (and its erasure)

Source: `what-is-tensor-search` → now **"From Tensor Search to Commerce Superintelligence"** [2026 live, rewritten].

The original "what is tensor search" explainer is gone; the rewrite preserves only a sanitized definition:
- **"used multi-dimensional mathematical representations (tensors) to encode the meaning of products and queries… Products that were conceptually similar ended up close together in this mathematical space."**
- It then argues tensor search "solved the retrieval problem… but did not solve the ranking problem… the commercial problem… or the journey problem," and concludes it has been **"absorbed into broader, more capable architectures."**
- Three-generation narrative: (1) keyword; (2) "semantic and behavioral ranking" (tensor + behavioral signals); (3) "Commerce Superintelligence" (product understanding + behavioral + personalization, one intelligence layer for the whole funnel).

Historically, Marqo's "tensor search" meant **multi-vector documents**: a document is represented by *multiple* embeddings (e.g. each image, each text chunk), and search scores against the best-matching sub-vector rather than a single pooled vector. The 2026 rewrite deliberately suppresses this (per the leaked banned-terms list, "tensor search" was an explicitly forbidden phrase).

**Relevance flag:** Marqo's multi-vector / "tensor" doc model is a real differentiator samesake should weigh. samesake currently does single-vector ANN + optional segmented "spaces" vectors. Marqo's framing ("ranking ≠ retrieval ≠ commercial objectives ≠ journey") is a useful decomposition — and a reminder that samesake's *deliberate* stop-at-retrieval scope is a positioning choice, not a gap, as long as it's framed that way.

---

## 7. Foundation models page (the most marketing-heavy)

Source: `what-are-foundation-models-in-machine-learning` [2026 live].

Generic, accurate explainer of foundation models (scale, transfer learning, emergent capabilities, multimodality; CRFM 2021 origin). The ecommerce turn:
- **"general-purpose foundation models like CLIP, GPT-4, or Amazon Titan… lack the specialized knowledge that product discovery demands."**
- Recycles **"88% improvement over Amazon Titan on product search relevance tasks"** (see §3.4 — context-stripped).
- Claims a **3-layer architecture**: (L1) foundation pre-training on product images/descriptions/attributes/behavior; (L2) **per-retailer adaptation** on catalog + taxonomy + historical performance; (L3) **behavioral integration** (search/click/buy/return). Justifies "results in 14 days, not months."
- A second post bled into the same page ("Search Performance at Scale") gives a genuinely solid HNSW explainer: **M / efConstruction / efSearch** params, recall-vs-latency tradeoff, multi-stage retrieval (fast ANN pass + re-rank), "sub-100ms p99", real-time index updates, catalog-aware sharding, and a strong argument that **recall matters more than latency in ecommerce** because low recall silently drops long-tail/new items.

**Defensible vs marketing:** The HNSW/recall section is technically sound and useful. The "product-native foundation" 3-layer architecture is plausible but unverified — no params, datasets, or eval given (unlike the 2024 posts). The "14 days" and per-customer-model claims are case-study-backed marketing.

---

## 8. Personalization / context — "Context Is All You Need"

Source: `context-is-all-you-need-multimodal-vector-search-with-personalization` **[2024 original, recovered via Wayback]**. (Live URL scrubbed.) Author: Jesse Clark (CTO). This is the most technically reusable post for samesake.

### 8.1 Core idea — personalization via embedding arithmetic, no retraining
- **"Curating queries with additional context allows for personalization and curation of results on a per query basis without additional models or fine-tuning."**
- **Multi-part / multimodal queries**: the query is a **weighted collection** of text and/or image components, not a single string. *"The similarity scoring will now be against a weighted collection of items rather than a single piece of text data."* This is **manual query expansion** done in vector space.

### 8.2 The techniques (all at query time, on top of plain ANN)
1. **Multimodal queries** — fuse multiple text+image components with weights → "soft / semantic filter".
2. **Negation** — negative-weighted terms move results *away* from a concept (e.g. away from `buttons`).
3. **Excluding low-quality / NSFW images** — describe the unwanted property in natural language, subtract it.
4. **Search with images** — image-only query via image embedding; extendable with text terms.
5. **Conditional search with popular/liked items (the personalization core)** — **"To avoid any extra inference at search time, we can pre-compute the set of items vectors and fuse them into a context vector."** A user's liked/purchased items → averaged/weighted into a **context vector** that steers results. Per-item contribution is tunable by popularity magnitude. Framed as **relevance feedback (Rocchio)** using items instead of words.
6. **Searching as prompting** — append style descriptors to the query (like DALL·E/Stable Diffusion prompting) to curate.
7. **Ranking with other signals (score modifiers)** — multiply/bias vector similarity by a **query-independent document scalar** (e.g. an **LAION aesthetic score 1–10**, or popularity/sales) to demote low-quality or boost commercial items.
8. **Multimodal entities** — index a document as a single combined representation over multiple images + text (a **multimodal combination object**), since CLIP puts all modalities in one latent space; helps disambiguate the subject of an image.

### 8.3 Reproducibility detail
- Dataset: **~220k ecommerce products** (clothing, watches, bags, backpacks, wallets) with images, captions, price, aesthetic score.
- Model: **ViT-L-14 OpenCLIP** (recommends ≥4GB VRAM GPU).
- Mechanics use Marqo primitives: **context vectors** (precomputed, stored), **mappings objects** for multimodal combination, **score modifiers** for scalar biasing.

**Relevance flag (high):** This is the single most directly applicable Marqo artifact for samesake.
- **Context vectors = personalization with zero retraining and zero extra inference at query time** — precompute a user's taste vector from liked/bought items, fuse into the query. samesake (BYO embeddings, pgvector) can implement this as a **weighted vector add in SQL/app before the ANN call** — no new model, no infra. This is a far cheaper personalization path than behavior-trained ranking.
- **Negation / soft semantic filters via weighted query components** map cleanly onto samesake's **soft-filter relaxation** concept — but in *vector* space rather than predicate space. Worth unifying with RRF: a negated term is a downward-weighted component in the dense leg.
- **Score modifiers (query-independent scalars)** = exactly samesake's hard/soft filter + business-signal layer (price, availability, popularity) applied as a post-similarity bias. Marqo proves the pattern works in production (aesthetic-score reranking removed low-quality images).
- **Multimodal combination objects / multi-vector docs** validate samesake's optional "spaces" segmented vectors — though Marqo fuses at index time into one entity, whereas samesake keeps spaces separate and RRF-fuses. Marqo's experience suggests the single-fused-entity route is simpler and shipped; samesake's separate-spaces route is more auditable. (samesake's spaces are off-by-default for failing eval — Marqo's fused approach is a possible fallback design.)

---

## 9. Models, datasets, benchmarks — quick index

**Models (open-weight, Hugging Face under `Marqo/`):**
- `marqo-fashionCLIP` — 150M, from `ViT-B-16-laion`, dim 512, Apache 2.0.
- `marqo-fashionSigLIP` — 150M, from `ViT-B-16-SigLIP-webli`, dim 512, Apache 2.0.
- `marqo-ecommerce-embeddings-B` — dim 768, 5.1ms/5.7ms inference.
- `marqo-ecommerce-embeddings-L` — 652M params, dim 1024.
- Default OSS retrieval model historically `ViT-L-14` (OpenCLIP); default ANN = HNSW.

**Datasets (published by Marqo):**
- `Marqo-GS-10M` — 10M Google Shopping products (HF).
- Ecommerce eval: `marqo-ecommerce-hard` (4M), `marqo-ecommerce-easy` (200k); GoogleShopping-Text2Image (1M), -Category2Image (1M), AmazonProducts-Text2Image (3M); `amazon-products-eval-100k`.
- Fashion eval: DeepFashion (In-shop + Multimodal), Fashion200K, KAGL, Atlas, Polyvore, iMaterialist.

**Training framework:** **Generalized Contrastive Learning (GCL)** — `github.com/marqo-ai/GCL`, arXiv:2404.08535. Multi-field/multi-aspect contrastive loss beyond binary relevance; 7-component loss for fashion.

**Baselines they benchmark against:** Amazon-Titan-Multimodal, GCP-Vertex, Cohere-Embed-v3, Jina-V1-CLIP, `ViT-SO400M-14-SigLIP`, FashionCLIP2.0, OpenFashionCLIP.

---

## 10. What samesake should adopt / avoid / differentiate on

**Adopt:**
- **Context vectors for personalization** (§8.2.5) — precompute a user taste vector from liked/bought items, fuse into the query vector before ANN. Zero retraining, zero query-time model calls, trivially expressible over pgvector. Highest-ROI idea in this corpus.
- **Score modifiers as a first-class concept** (§8.2.7) — query-independent document scalars (popularity, aesthetic/quality, margin) biasing similarity. samesake already gates hard filters in SQL; add a *soft* multiplicative bias leg.
- **Honest dual-regime benchmarking** (§3.3) — the easy/hard split + rate-limit disclosure + published eval scripts is a credibility model samesake's benchmarks (grade@10 2.33, P@5 0.83 on 5k LK corpus) should emulate: publish the harness, report absolute numbers, name baselines.
- **Per-query-cluster eval analysis** (§5) — extend samesake's eval gate to report NDCG deltas per query cluster, not just aggregate; this is how to diagnose *why* "spaces" failed the gate.
- **Multi-aspect contrastive intuition** (§2.2) — if samesake ever offers a fine-tune path for BYO embeddings, GCL's "optimize over titles+colors+materials+categories+keywords" multi-field loss is the proven recipe for serving head and tail queries in one space.

**Avoid:**
- **The 2026 rebrand trap.** Marqo buried its real engineering (embeddings, tensor/vector search, open source) under LLM-generated SEO and a "Superintelligence" umbrella — to the point of leaking the banned-word list. samesake's credibility *is* its typed, auditable, developer-facing precision. Do not dilute the vocabulary.
- **Single context-stripped hero metrics** ("88% over Titan"). Always ship the dataset + task + baseline next to the number.
- **Scope creep into the full funnel** (merchandising, conversational agent, post-purchase, returns). Marqo's stretch to "one agent, first query to post-purchase" is where it leaves samesake's lane. samesake's deliberate stop-at-retrieval (`findProducts()` → grounded products, cart downstream) is a *cleaner contract* — frame it as a feature.

**Differentiate on:**
- **In-app, two-container, BYO-everything.** Marqo is hosted/managed (Marqo Cloud, Marqo Pixel telemetry, per-retailer trained models). samesake runs *in the user's app* on Postgres+pgvector with BYO embedding/generation models — no hosted vector DB, no data egress, no per-tenant model training. That's the opposite trust/ops posture.
- **Auditability.** Marqo's ranking is increasingly an opaque per-retailer trained model ("commercial signals in the model, not as rules"). samesake compiles hard filters to *inspectable SQL predicates* + `/search/explain`. Marqo's own decomposition (retrieval vs ranking vs commercial vs journey) is the argument *for* samesake's explicit, typed, gated approach.
- **Typed compiler ergonomics.** Marqo's personalization tricks (context vectors, score modifiers, multimodal combos) are runtime API gymnastics. samesake can express the same behaviors as *declared, typed catalog/query constructs* compiled to SQL — safer and reviewable.

---

## 11. Open questions
- Absolute (not relative) Recall@1 / nDCG@10 numbers for the fashion + ecommerce models — the rewritten pages only kept relative lifts.
- GCL training compute, hardware, and exact loss formulation (the arXiv:2404.08535 paper would resolve this — not scraped here).
- Whether Marqo's "tensor"/multi-vector doc scoring is max-over-subvectors or learned pooling, and how it interacts with HNSW (the original tensor-search explainer is deleted).
- Real-world latency/cost of context-vector personalization at catalog scale (precompute + fuse) vs samesake's pgvector ceiling.
- Did the per-retailer fine-tuned models (the 2026 pitch) actually replace the open Ecommerce/Fashion models, or layer on top? The leaked transcript suggests the public story is now marketing-led, not engineering-led.

---

## Sources
- https://www.marqo.ai/blog/search-model-for-fashion (live, intact)
- https://www.marqo.ai/blog/introducing-marqos-ecommerce-embedding-models (live → "What Is Marqo?"; original recovered via Wayback `web.archive.org/web/20241209100258id_/…`)
- https://www.marqo.ai/blog/introducing-marqtune (live → "What Is Marqo?"; original via Wayback `…/20241211065832id_/…`)
- https://www.marqo.ai/blog/context-is-all-you-need-multimodal-vector-search-with-personalization (live → "What Is Marqo?"; original via Wayback `…/20250127213759id_/…`)
- https://www.marqo.ai/blog/what-is-tensor-search (live, rewritten as "From Tensor Search to Commerce Superintelligence")
- https://www.marqo.ai/blog/what-are-foundation-models-in-machine-learning (live; note leaked LLM-generation transcript in HTML)
- https://www.marqo.ai/blog/optimize-ecommerce-search-with-fine-tuning-and-automated-query-analysis (live, intact)
- https://www.marqo.ai/blog/ai-product-discovery-embeddings-search-explained (live, intact)
- Supporting: github.com/marqo-ai/GCL, github.com/marqo-ai/marqo-FashionCLIP, github.com/marqo-ai/marqo-ecommerce-embeddings, huggingface.co/Marqo, arXiv:2404.08535 (GCL)
