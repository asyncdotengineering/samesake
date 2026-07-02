# Recommendation Systems — OSS and Commercial Prior-Art Dossier

**Scope:** Survey of open-source and commercial *recommendation* systems usable as components or competitors, evaluated against samesake — a TypeScript-first "search engine compiler" for visual commerce that today does **retrieval, not generation and not recommendations**. samesake runs in the user's own app (Postgres + pgvector, two containers, no Redis/Elasticsearch/hosted vector DB), with hybrid retrieval (FTS + cosine ANN over BYO embeddings + typed "spaces" vectors fused via RRF), hard/soft filters compiled to SQL, an NLQ parser, multimodal enrich, entity resolution, `/search/explain` auditability, and a `findProducts()` agentic surface that deliberately **stops at retrieval**.

**Core decision this dossier informs:** Should samesake add a recommendation surface, or stay retrieval-pure and integrate with recommenders downstream?

**Method note:** Facts marked **[verified]** were confirmed by directly fetching the source (repo LICENSE/README, docs, pricing page). Facts marked **[marketed]** come from vendor marketing or secondary sources and should be treated as claims, not proven behavior. Recommendation quality numbers from vendors are universally **[marketed]** (no independent benchmark exists across these systems).

---

## 0. The fundamental architectural distinction

Recommendation and retrieval are different problems with different data dependencies:

- **Retrieval (samesake today):** Given a *query* (text, filters, image, intent), return matching products. Stateless w.r.t. the user. Needs only the catalog + embeddings.
- **Recommendation:** Given a *user* (or a *seed item*, or a *session*), return products they are likely to want **without an explicit query**. Needs an **interaction log** (clicks, carts, purchases, views) — the behavioral signal is the entire product. No interactions → no collaborative recommendations (the "cold-start" problem).

This distinction is the spine of the verdict: samesake's deployment model (in-app, two containers, BYO models) is excellent for retrieval but recommendation's defining asset — the cross-user interaction graph — is something most early samesake adopters will not yet have, and which the **store owner**, not samesake, controls.

A useful sub-taxonomy of recommendation "approaches" recurs across every candidate:
1. **Item-to-item / content similarity** — "similar products" from embeddings/attributes. *This is the one form samesake can already nearly do* (cosine ANN over an item's embedding ≈ "more like this").
2. **Collaborative filtering (CF)** — co-occurrence in user behavior ("frequently bought together", "customers also viewed"). Requires interaction logs.
3. **Sequential / session-based** — predict the *next* item from the current session sequence (transformer/RNN over the click stream).
4. **Personalized ranking** — re-rank a candidate set per user from their history.

---

## 1. Open-Source Candidates

### 1.1 Gorse
- **Approach:** Out-of-the-box recommender engine. Multi-source: popular, latest, user-based, item-based, collaborative filtering; AutoML model search; and (recent) **classical + LLM rankers and multimodal content via embedding (text/image/video)**. **[verified]**
- **Deployment:** Self-hosted / in-app. Single-node training + distributed prediction; master / worker / server node roles. Storage in MySQL/MariaDB, **MongoDB, Postgres, or ClickHouse**, with **Redis** caching for intermediate results. Docker deploy; dashboard at `:8088`. **[verified]**
- **Data requirements:** Users, items, and **feedback/interaction events** via REST. This is its raison d'être — without feedback it falls back to popular/latest only.
- **License:** **Apache-2.0**. **[verified]** Commercially usable, no copyleft.
- **Maintenance:** Active — 9.7k stars, latest release v0.5.9 (June 2026). **[verified]**
- **Verdict for samesake:** The closest OSS "drop-in recommender." Apache-2.0 makes it integrable. BUT it brings its own storage topology (Redis + a separate DB) — directly **violating samesake's two-container, no-Redis constraint** if embedded. Best treated as a **downstream integration target**, not an internal dependency. Notably overlaps samesake's multimodal-embedding ambition, so it is also a partial *competitor* if samesake ever expands.

### 1.2 RecBole / RecBole 2.0
- **Approach:** Unified research library. **94 recommendation algorithms** across general, sequential, context-aware, and knowledge-based categories; **44 benchmark datasets**. RecBole 2.0 adds packages for GNN-based, transformer-based, debiasing, fairness, cross-domain, meta-learning. **[verified]**
- **Deployment:** Python/PyTorch library, GPU-accelerated. **Not a service** — a training/evaluation toolkit. **[verified]**
- **Data requirements:** Atomic interaction files (user-item-rating-timestamp style). Offline training datasets.
- **License:** **MIT**, but README states materials are **"only to be used for academic purposes."** **[verified]** This academic-use language is a **commercial red flag** despite the MIT header — the intent statement creates ambiguity. Avoid as a shipped dependency.
- **Paper:** *RecBole: Towards a Unified, Comprehensive and Efficient Framework for Recommendation Algorithms* (CIKM 2021, arXiv:2011.01731); *RecBole 2.0* (CIKM 2022).
- **Verdict for samesake:** Research/benchmarking tool, **not a production component**. Useful only if samesake wanted to *prototype/benchmark* a recommendation algorithm before building. Not integrable into the runtime. **Avoid as dependency.**

### 1.3 Microsoft Recommenders (now under Linux Foundation AI & Data)
- **Approach:** Best-practices collection — **40+ algorithms** (CF: ALS, NCF, SAR, BPR, LightGCN, SVD, VAE, SASRec, GRU, Caser; content-based: DKN, NAML, NRMS, LightGBM, TF-IDF). Mixed library + Jupyter notebooks. **[verified]**
- **Deployment:** Python library + notebooks; runs CPU/GPU/PySpark. **Not a service** — you assemble your own pipeline. **[verified]**
- **Data requirements:** Interaction datasets; per-algorithm formats.
- **License:** **MIT**. **[verified]** Cleanly commercial-friendly (unlike RecBole, no academic-only caveat).
- **Verdict for samesake:** A **reference cookbook**, not a deployable engine. If samesake builds recommendations, this is the best OSS *learning/algorithm source* (MIT, broad, maintained under LF). But it ships nothing runnable in samesake's container model. **Reference, not integrate.**

### 1.4 NVIDIA Merlin / Transformers4Rec
- **Approach:** Merlin = end-to-end GPU recsys pipeline (NVTabular preprocessing → training → Triton serving). Transformers4Rec = **sequential & session-based** recommendation, bridging HuggingFace Transformers (BERT, XLNet, 64+ architectures) to next-item prediction. Won the WSDM 2021 (Booking.com) and SIGIR eCommerce 2021 (Coveo) session-based challenges. **[verified / marketed for the wins]**
- **Deployment:** Self-hostable but **GPU-centric**; designed around NVIDIA stack (NVTabular, Triton). Heavyweight.
- **Data requirements:** **Session/sequence interaction logs** — the click stream. Strong fit for anonymous users where intra-session context dominates.
- **License:** **Apache-2.0** (Transformers4Rec); active (v23.12 / Jan 2024). **[verified]**
- **Verdict for samesake:** The **most technically interesting** for *visual commerce sessions* (anonymous shoppers, contextual intra-session intent — exactly samesake's `findProducts()` world). But the GPU + Triton + NVTabular footprint is the **antithesis of samesake's two-container, BYO-model, CPU-friendly Postgres ethos**. Inspiration for *what session-based could look like* if samesake ever expands; **not** an embeddable component. **Differentiate / note as inspiration.**

### 1.5 TensorFlow Recommenders (TFRS)
- **Approach:** Keras-based library for the canonical **two-tower retrieval + ranking** split — query tower (user) and candidate tower (item) joined by a scoring function; retrieval narrows millions → thousands, ranker scores the shortlist. **[verified]**
- **Deployment:** Python/TF library; pairs with an ANN index (e.g., ScaNN / Vertex Matching Engine) for serving. **Not a service.**
- **Data requirements:** User + item features and interactions to train the towers.
- **License:** **Apache-2.0**; actively maintained (v0.7.7, Jan 2026). **[verified]**
- **Verdict for samesake:** Architecturally **adjacent to samesake's own retrieval** (two-tower retrieval is a learned analogue of samesake's ANN-over-embeddings). The *concept* — separately embedding "user/intent" and "item," then ANN — is something samesake could implement natively in pgvector with BYO embeddings, **without TF**. So TFRS is best read as **validation of samesake's architecture** rather than a dependency. **Reference, not integrate.**

### 1.6 Vector DB "recommendation APIs" (Qdrant, Weaviate, Vespa)
These are not recommenders; they are **vector primitives** that expose recommendation-shaped APIs. Most relevant because samesake *already is* a vector retrieval layer (pgvector).

- **Qdrant Recommendation/Discovery API:** Find items similar to **positive** examples and dissimilar to **negative** examples; accepts IDs and/or raw vectors; `average_vector` default strategy; positive examples no longer required (can recommend from dislikes alone). Discovery API splits space into positive/negative zones. **[verified]** License: Apache-2.0 (Qdrant core). Deployment: self-host or cloud.
- **Weaviate Ref2Vec (`ref2vec-centroid`):** Vectorize an object (e.g., a User) as the **centroid of its cross-referenced objects** (e.g., liked Products); use that centroid as a query over Products. Characterizes a user from actions/relationships, refines over time. **[verified]** License: BSD-3 (Weaviate core). Deployment: self-host or cloud.
- **Vespa (recommendation):** Tensor framework storing user embeddings; retrieve a user's embedding by `user_id`, then ANN to nearest items; parent-child + tensor multi-phase ranking; deploy ONNX/XGBoost rankers **inside** the serving layer. **[verified]** License: **Apache-2.0**; self-host (Docker/K8s) or Vespa Cloud. **[verified]**
- **Verdict for samesake:** **Highly instructive — this is the pattern samesake should copy if it adds any recommendation surface.** The "centroid of liked items → ANN query" (Weaviate Ref2Vec) and "positive/negative example vectors → similarity" (Qdrant) approaches are **directly implementable in pgvector** with zero new infrastructure: averaging the embeddings of a user's liked/seed items and running the existing cosine ANN. This is **content-based / item-to-item recommendation that requires no interaction graph and no new container** — the only form of recommendation that fits samesake's constraints natively. Vespa is the architectural "north star" of unified retrieval+ranking but is a **competitor** to samesake's whole-engine positioning, not a component.

---

## 2. Commercial Candidates

All are **hosted SaaS** (data leaves the merchant's app to the vendor cloud, except where noted), the inverse of samesake's in-app model. They are **competitors to a hypothetical samesake recommendation surface**, and **integration targets** for a retrieval-pure samesake.

### 2.1 Algolia Recommend
- **Approach:** Pre-built models — **Related Products**, **Frequently Bought Together** (co-conversion within the same user/day), Trending, "Looking Similar." **[verified]**
- **Deployment:** Hosted SaaS (Algolia cloud).
- **Data:** Catalog + click/conversion events sent to Algolia.
- **Pricing:** **$0.60 per 1,000 Recommend requests/month.** **[verified]**
- **Note:** Algolia is also samesake's most direct *search* competitor, so Recommend is the bolt-on a samesake adopter might otherwise reach for.

### 2.2 Constructor
- **Approach:** AI product-discovery platform purpose-built for ecommerce; recommendations include **complementary** (bought-with), **bundles** (add-to-cart sets), and **alternative/similar**; uses NLP + ML + **reinforcement learning across touchpoints** optimized to a KPI you set. **[marketed]**
- **Deployment:** Hosted SaaS; enterprise.
- **Data:** Catalog + behavioral stream; optimizes to revenue/conversion KPI.

### 2.3 Bloomreach
- **Approach:** Unified product + content personalization; recommendations **balance personalization with business goals (margin, inventory sell-through)**. **[marketed]** Strong merchandising.
- **Deployment:** Hosted SaaS; enterprise (90–180 day implementations typical). **[marketed]**

### 2.4 Nosto
- **Approach:** Personalized recommendations, upsell, bundling; merchant-editable rules **without coding**; strongest on **Shopify**. **[marketed]** Mid-market.
- **Deployment:** Hosted SaaS.

### 2.5 Dynamic Yield (Mastercard-owned)
- **Approach:** ML-driven recommendation strategies with built-in **A/B testing framework** to measure lift. **[marketed]** Quote-based, enterprise.
- **Deployment:** Hosted SaaS.

### 2.6 Klevu → Athos Commerce
- **Approach:** AI search + category merchandising + product recommendations, mid-market. **Merged with Searchspring to form Athos Commerce (Jan 2025).** **[verified, secondary]**
- **Deployment:** Hosted SaaS.

### 2.7 AWS Personalize
- **Approach:** Managed recipes; v2 (User-Personalization-v2, Personalized-Ranking-v2) are **transformer-based**; trains on up to 5M items. **[verified]** Real-time recommendations that adapt to evolving interest.
- **Deployment:** Hosted (AWS), but **inside your own AWS account** — a middle ground (your cloud, AWS-managed service). Catalog/user data not shared cross-tenant.
- **Data:** Users/items/interactions to S3 + schema; real-time event stream. **[verified]**
- **Pricing:** Data ingestion ($/GB) + training ($/interactions) + inference ($/request); 2-month free trial (≤50k req/mo). **[verified]** *Widely reported as easy to run up large bills* — see practitioner cost-control threads.

### 2.8 Google Recommendations AI / Vertex AI Search for Commerce
- **Approach:** "Frequently Bought Together," "Recommended for You," "Others You May Like"; ML models trained on the merchant's catalog + user events; goal stated as **cart expansion**. Part of Vertex AI Search for Commerce (search + browse + recommendations + conversational agent). **[verified/marketed]**
- **Deployment:** Hosted (Google Cloud). **Product catalog & user-event data not shared with Google.** **[verified per docs]**
- **Data:** Catalog + user events to Google Cloud.

### 2.9 Coveo
- **Approach:** Enterprise AI search + personalization + recommendations; for large retailers with complex requirements and substantial budgets. **[marketed]**
- **Deployment:** Hosted SaaS; enterprise.

### 2.10 Recombee
- **Approach:** "Recommender-as-a-Service," RESTful API + SDKs; usage-based. **[marketed]**
- **Deployment:** Hosted SaaS (dedicated instance per customer on enterprise plans). **[marketed]**
- **Pricing:** Free / Standard $99 / Plus $899 / Pro $1499 / Premium $2499 per month; usage-based across ingested interactions, requests, MAU. **[verified, secondary]**

---

## 3. Comparison Table

| System | Type | Primary approach | Deployment | Data needs | License / Commercial verdict |
|---|---|---|---|---|---|
| **Gorse** | OSS engine | Multi-source CF + LLM/multimodal rankers | Self-host (Redis + DB, master/worker/server) | Interaction feedback | **Apache-2.0** — usable, but Redis+DB topology breaks samesake's 2-container rule |
| **RecBole** | OSS research lib | 94 algos, benchmarking | Python/PyTorch toolkit | Offline datasets | **MIT but "academic purposes only"** → avoid commercially |
| **MS Recommenders** | OSS cookbook | 40+ algos, notebooks+lib | Python (CPU/GPU/Spark) | Interaction datasets | **MIT** — clean; reference only, not deployable |
| **Merlin / Transformers4Rec** | OSS lib | Session/sequential (transformer) | Self-host, **GPU + Triton** | Session click streams | **Apache-2.0** — heavyweight; inspiration not component |
| **TFRS** | OSS lib | Two-tower retrieval + ranking | Python/TF + ANN | User/item features + interactions | **Apache-2.0** — validates samesake's arch; not a dep |
| **Qdrant** | Vector DB API | Positive/negative example similarity | Self-host / cloud | Item vectors (+seed items) | **Apache-2.0** — pattern to copy in pgvector |
| **Weaviate Ref2Vec** | Vector DB API | Centroid-of-liked-items → ANN | Self-host / cloud | Item vectors + user→item refs | **BSD-3** — pattern to copy in pgvector |
| **Vespa** | OSS engine | Tensor ranking + ANN, in-serving rankers | Self-host / cloud | Embeddings + rankers | **Apache-2.0** — architectural north star; whole-engine competitor |
| **Algolia Recommend** | Commercial | Related / FBT models | Hosted SaaS | Catalog + events | $0.60/1k req — integration target / search competitor |
| **Constructor** | Commercial | Complementary/bundle/alt + RL | Hosted SaaS | Catalog + behavior | Quote — enterprise competitor |
| **Bloomreach** | Commercial | Personalization + margin/inventory goals | Hosted SaaS | Catalog + content + behavior | Quote — enterprise competitor |
| **Nosto** | Commercial | Recs/upsell/bundles, rule-editable | Hosted SaaS | Catalog + behavior | Quote — Shopify mid-market |
| **Dynamic Yield** | Commercial | ML recs + A/B testing | Hosted SaaS | Catalog + behavior | Quote — enterprise |
| **Klevu/Athos** | Commercial | Search + recs, mid-market | Hosted SaaS | Catalog + behavior | Quote — merged 2025 |
| **AWS Personalize** | Commercial (your cloud) | Transformer recipes, real-time | AWS-managed (your account) | Users/items/interactions to S3 + stream | Usage-based — best "BYO-cloud" integration target |
| **Google Rec AI / Vertex** | Commercial | FBT/RFY, cart expansion | Hosted (GCP) | Catalog + events (not shared) | Usage-based — integration target |
| **Coveo** | Commercial | Enterprise search+recs | Hosted SaaS | Catalog + behavior | Quote — enterprise |
| **Recombee** | Commercial | Recommender-as-a-Service | Hosted SaaS | Interactions + MAU | $99–$2499/mo — integration target for SMB |
| **VERDICT ROW → samesake** | — | **Item-to-item is native-able in pgvector; CF/sequential needs an interaction graph samesake doesn't own** | **Stay in-app retrieval; integrate hosted recommenders downstream** | **Recommendation = behavioral data the store owner controls, not samesake** | **Stay retrieval-pure; ship one optional "more-like-this" item-to-item surface only** |

---

## 4. Verdict — Should samesake add a recommendation surface?

**Recommendation: Stay retrieval-pure as the core posture, with ONE narrow, native exception.**

### 4.1 Why staying retrieval-pure is right
1. **Data ownership mismatch.** Real recommendation (CF, sequential, personalized ranking) is *built from the interaction log*. That log belongs to the **store** and accrues over time; an early samesake adopter has little of it. A recommendation surface would be empty or popularity-only at exactly the moment of adoption — a bad first impression for a "compiler" product.
2. **Infrastructure mismatch.** Every serious OSS recommender (Gorse needs Redis + a DB; Merlin needs GPU + Triton; TFRS/RecBole need a Python training stack) **breaks samesake's two-container, no-Redis, CPU-friendly, BYO-model contract.** Embedding any of them dilutes the single clearest differentiator: "two containers, runs in your app."
3. **Crowded, mature competition.** Algolia Recommend, Constructor, Bloomreach, Nosto, Dynamic Yield, AWS Personalize, Google Rec AI, Coveo, Recombee all offer turnkey FBT/personalization with years of tuning. samesake competing here from zero is a losing fight; integrating is a winning one.
4. **The `findProducts()` design principle already commits to this.** It "deliberately stops at retrieval (cart/checkout downstream)." Recommendation lives in the *same downstream zone* as cart/checkout — it is a behavioral/business-goal layer, not a query-answering layer. Adding it would contradict the framework's own stated boundary.

### 4.2 The one exception worth shipping: native item-to-item ("more like this")
- The **vector-DB recommendation pattern** (Qdrant positive/negative examples; Weaviate Ref2Vec centroid) is **implementable in pgvector with zero new infrastructure**: average the embeddings of N seed/liked items, run the *existing* cosine ANN, gate with the *existing* hard/soft SQL filters, fuse with FTS via the *existing* RRF.
- This needs **no interaction graph**, **no new container**, **no new model** — it is literally samesake's current retrieval pipeline pointed at an item vector instead of a query vector.
- It is **content-based recommendation**, which is exactly what visual/fashion commerce values most ("similar styles," "complete the look" as a vector neighborhood), and it inherits samesake's `/search/explain` auditability for free — a genuine differentiator no hosted recommender offers.
- **Boundary discipline:** ship *only* item-to-item similarity. Do **not** ingest interaction events, do **not** build a user model, do **not** add CF/sequential. The moment samesake stores click/cart logs to power recommendations, it inherits the data-pipeline and infra burden it was designed to avoid.

### 4.3 Integration story for everything beyond item-to-item
Position samesake as the **grounded-candidate generator** that *feeds* a downstream recommender:
- samesake's hard-filtered, deduped, verified candidate set is a **cleaner input** to AWS Personalize / Algolia Recommend / Recombee than a raw catalog dump.
- Best integration target by deployment-model affinity: **AWS Personalize** (runs in the customer's own cloud account, closest to samesake's "your infra" ethos) and **Recombee** (simple REST, SMB-friendly). Hosted-SaaS recommenders (Algolia, Constructor, Bloomreach, etc.) integrate via event forwarding from the merchant app, not samesake.
- Document a reference pattern: *"samesake retrieves and grounds; your recommender personalizes."* This keeps samesake's surface area small and its differentiation sharp.

### 4.4 One-line answer
**Stay retrieval-pure. Ship one optional native item-to-item "more-like-this" surface (free in pgvector, auditable, fits fashion) and integrate — do not rebuild — every interaction-driven recommender downstream.**

---

## 5. Sources

OSS:
- Gorse — repo & README: https://github.com/gorse-io/gorse ; site: https://gorse.io/
- RecBole — repo: https://github.com/RUCAIBox/RecBole ; RecBole 2.0: https://github.com/RUCAIBox/RecBole2.0 ; paper (CIKM 2021, arXiv:2011.01731): https://arxiv.org/abs/2011.01731
- Microsoft / Linux Foundation Recommenders — repo: https://github.com/recommenders-team/recommenders
- NVIDIA Transformers4Rec — repo: https://github.com/NVIDIA-Merlin/Transformers4Rec ; overview: https://medium.com/nvidia-merlin/transformers4rec-4523cc7d8fa8 ; session-based docs: https://nvidia-merlin.github.io/Transformers4Rec/stable/examples/tutorial/index.html
- TensorFlow Recommenders — repo: https://github.com/tensorflow/recommenders ; two-tower retrieval docs: https://www.tensorflow.org/recommenders/examples/basic_retrieval
- Qdrant Recommendation/Discovery API — https://qdrant.tech/articles/new-recommendation-api/ ; https://qdrant.tech/documentation/search/explore/ ; https://qdrant.tech/articles/discovery-search/
- Weaviate Ref2Vec — https://weaviate.io/blog/ref2vec-centroid
- Vespa — repo: https://github.com/vespa-engine/vespa ; recommendation tutorial: https://docs.vespa.ai/en/learn/tutorials/news-5-recommendation.html ; tensor retrieval: https://blog.vespa.ai/beyond-vector-search/ ; vector DB: https://vespa.ai/vector-database/

Commercial:
- Algolia Recommend — https://www.algolia.com/doc/guides/algolia-recommend/overview ; FBT: https://www.algolia.com/developers/code-exchange/frequently-bought-together ; pricing (secondary): https://www.saasworthy.com/product/algolia-recommend/pricing
- Constructor — https://constructor.com/solutions/recommendations ; guide: https://constructor.com/blog/ecommerce-recommendations-guide
- Bloomreach / Nosto / Dynamic Yield comparison — https://www.algolia.com/blog/ecommerce/ecommerce-personalization-platforms-a-buyers-guide ; https://kumo.ai/resources/learn/retail-ai-personalization-tools/
- Klevu → Athos Commerce — https://www.addsearch.com/blog/klevu-alternatives/
- AWS Personalize — recipes: https://docs.aws.amazon.com/personalize/latest/dg/native-recipe-user-personalization-v2.html ; pricing: https://aws.amazon.com/personalize/pricing
- Google Vertex AI Search for Commerce / Recommendations AI — https://docs.cloud.google.com/retail/docs/what-is-it ; intro: https://medium.com/google-cloud/an-introduction-to-google-clouds-vertex-ai-search-for-commerce-and-the-4-features-of-that-help-9e7641d1cd5f
- Coveo — https://www.coveo.com/en/solutions/ecommerce-search-platform
- Recombee — https://docs.recombee.com/api ; pricing (secondary): https://softwarefinder.com/artificial-intelligence/recombee

**Verification caveats:** RecBole license language ("academic purposes only" alongside an MIT header) is contradictory and should be confirmed with the maintainers before any commercial use. All commercial recommendation-quality claims and conversion-lift figures are vendor-**marketed**, not independently benchmarked. Commercial pricing for Constructor/Bloomreach/Dynamic Yield/Coveo is quote-based and unverified here.
