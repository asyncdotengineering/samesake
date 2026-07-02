# Additional Search/Discovery & Managed-Vector Vendors (Completeness Pass)

> Completeness-pass deep-dive for **samesake** — a TypeScript-first "search engine
> compiler" for visual commerce (fashion-first, Sri Lankan corpus: Sinhala/Tamil/English
> code-mixed). samesake compiles a typed catalog into a **Postgres + pgvector layer running
> inside the user's app** (two containers; no Redis/Elasticsearch/hosted vector DB).
> Retrieval = Postgres FTS + cosine ANN over **BYO embeddings** + optional typed segmented
> "spaces", fused via **RRF**. Hard filters compile to SQL predicates that **gate before
> ranking**; soft filters relax. It has an NLQ parser (constrained schema), multimodal enrich
> pipeline, entity-resolution/dedup, `/search/explain` auditability, and a `findProducts()`
> agentic surface that **STOPS at retrieval**. Bench: mean grade@10 ~2.33, P@5 0.83 on ~5k LK
> fashion docs; "spaces" currently off (failed gate). Planned: optional cross-encoder
> reranker, UCP/ACP/MCP adapters, item-to-item "more-like-this", context-vector
> personalization, score modifiers.

**Why this document exists.** The first commercial sweep (`05-commercial/`) covered the
obvious names (Algolia, Constructor, Coveo, Bloomreach, Klevu, Vantage, Elastic/OpenSearch,
Typesense/Meilisearch, Qdrant/Weaviate). This pass fills two cohorts it under-covered:

1. **Ecommerce site-search vendors** — Shopify Search & Discovery (native), Fast Simon,
   Unbxd (Netcore), Luigi's Box, Doofinder, Searchanise, Hawksearch (Bridgeline), GroupBy,
   Prefixbox, Sajari/Search.io (Algolia-owned), AddSearch.
2. **Managed vector DB / retrieval clouds positioned at commerce** — Pinecone, Vectara,
   Turbopuffer, Zilliz Cloud, Marqo Cloud, Superlinked, TwelveLabs (visual).

**Evidence convention.** **[PROVEN]** = official doc / pricing page / LICENSE / changelog.
**[MARKETED]** = vendor blog / press release / unverified third-party comparison. Almost
every relevance claim about *retrieval quality* in this cohort is **[MARKETED]** — none of
these vendors publish reproducible IR benchmarks, let alone on a Sinhala/Tamil corpus. That
asymmetry is itself a finding.

---

## Part A — Ecommerce Site-Search Vendors

These are **SaaS application layers**, not infrastructure. The defining trait of the whole
cohort: they ingest your catalog into **their cloud**, render a search/merchandising UI, and
bill on catalog size / traffic / GMV. None of them is "ownable" in the samesake sense (code +
data inside the merchant's own two containers). They compete with samesake's *outcome*
(better commerce search) but on the **opposite architecture** (hosted, opaque, BYO-nothing).

### A1. Shopify Search & Discovery (native, free)

- **Positioning.** Shopify's **first-party, free** search + filtering + recommendations app.
  Since **March 2025, semantic search is mandatory** — Shopify removed the ability to revert
  to keyword-only results. **[PROVEN]** (changelog) "Semantic Search... considers product
  descriptions, images, and contextual clues."
- **Deployment.** Fully hosted inside Shopify. Zero ownership, zero portability.
- **Hybrid.** Semantic + keyword blended natively; merchant-tunable filters/synonyms/boosts.
- **Multilingual.** A 2025 changelog announced "semantic search now supports more languages"
  but **does not enumerate them** — I fetched the changelog directly and it lists **no
  specific languages and no mention of Sinhala or Tamil**. **[PROVEN — by absence]**
- **Quality reputation.** **3.4/5 from 461 merchants** on the App Store; widely reported
  irrelevant results, which is precisely why the third-party app cohort below exists.
  **[MARKETED]** (review aggregations).
- **Pricing.** Free (bundled with Shopify).

**Verdict for samesake:** Not a competitor — it's the *baseline* the LK merchant already has
and is unhappy with. The entire third-party cohort is a market proof that "native semantic
search exists and still loses." samesake's wedge is the same wedge those vendors exploit,
minus the SaaS lock-in. **Differentiate** (ownership, LK corpus) — do not benchmark against
Shopify as a ceiling; benchmark against it as a *floor*.

### A2. Fast Simon

- **Positioning.** AI product discovery for SMB/mid-market Shopify/BigCommerce/Magento;
  strong on **visual discovery** ("hyper tagging", visual similarity, visual search) and
  "shopping agents." Launched a **"Gen AI Hybrid"** search in 2025. **[MARKETED]**
- **Deployment.** Hosted SaaS, platform-app install.
- **Hybrid.** Yes (marketed Gen-AI hybrid = keyword + vector).
- **Agentic/2026.** Markets "shopping agents"; details thin, no protocol (MCP/ACP) claim found.
- **Pricing.** **No public tiers** — custom proposal after a discovery call. **[PROVEN]**
  (their pricing page redirects to sales).

**Verdict:** Closest in *spirit* to samesake's visual-first angle, but it's a closed SaaS for
SMBs. The visual-tagging pipeline overlaps samesake's **enrich** stage conceptually. **Watch
+ differentiate** — its visual story is the one to out-execute on LK fashion.

### A3. Unbxd (Netcore Unbxd)

- **Positioning.** Enterprise AI product discovery. **Gartner Magic Quadrant leader for
  Search & Product Discovery, 2024 and 2025 (two consecutive years).** **[MARKETED]**
  (vendor citing Gartner). Strongest *2026-relevant* signal in this whole cohort:
  - **Nov 2025: "Enrichment for Agentic Commerce"** — makes catalogs "AI-discoverable across
    emerging agentic shopping channels like **ChatGPT, Google Gemini, and Alexa**."
    **[MARKETED]** (PR Newswire press release).
  - **"Agentic Multimodal Search"** — interprets visual + language intent in one experience.
- **Deployment.** Hosted enterprise SaaS.
- **Hybrid/multimodal.** Yes; markets visual, conversational, measurement, and fitment search.
- **Pricing.** Enterprise / not public.

**Verdict:** The most direct **strategic** validator of samesake's agentic thesis — a Gartner
leader is now selling "make your catalog discoverable to shopping agents." That is exactly the
demand samesake's `findProducts()` + UCP/ACP/MCP adapters target, but Unbxd does it as a
hosted enrichment service for enterprises. **Integrate the idea, differentiate the delivery**:
samesake ships the same "agent-discoverable catalog" capability *inside the merchant's app*,
typed and auditable, for the SMB/LK tier Unbxd ignores. Note: "enrichment for agents" parallels
samesake's enrich pipeline — worth a head-to-head framing in positioning.

### A4. Luigi's Box

- **Positioning.** Slovakia-based (founded 2014), AI site-search + discovery + **strong
  analytics**; +35% conversion claim. **[MARKETED]**
- **Deployment.** Hosted; integrates Shopify/WooCommerce/Magento/BigCommerce/commercetools.
  Self-integration option with a **30-day free trial**.
- **Hybrid.** Markets semantic search + AI autocomplete; under-the-hood specifics not disclosed.
- **Pricing.** Custom; self-integration free trial then quoted.

**Verdict:** Analytics-led SaaS; nothing architecturally novel vs samesake. **Avoid as
reference** beyond noting its analytics surface (search-term insights) as a feature samesake's
`/search/explain` could partly subsume for auditability.

### A5. Doofinder

- **Positioning.** SMB-focused full-text + semantic + visual + voice site search; Adobe
  Commerce / Shopify / WooCommerce. **[MARKETED]**
- **Deployment.** Hosted SaaS, "connects natively to... hosted and self-hosted" storefronts
  (the *storefront* can be self-hosted; **Doofinder itself is cloud**).
- **Hybrid.** Semantic + fuzzy + full-text; faceting; zero-result analytics.
- **Pricing.** Public tiered plans (Essential → Advanced → Intelligent → Enterprise) +
  free trial; usage-based. **[PROVEN]** (public pricing page exists; exact numbers vary).

**Verdict:** Volume SMB play. Same architecture gap as the rest. **Avoid as competitor**; it's
a different segment and ownership model.

### A6. Searchanise

- **Positioning.** Affordable Shopify/BigCommerce search; **~12,000 Shopify installs**.
- **Deployment.** Hosted app.
- **Hybrid.** Smart/instant search, filters, personalization; markets AI but lightweight.
- **Pricing.** **Public, catalog-size tiers: Free (≤25 products), then $19 / $39 / $89 /
  $139 / $209 / $349 per month.** **[PROVEN]** (pricing page). Most transparent pricing in the
  cohort.

**Verdict:** Low-end SaaS. Useful only as a **price anchor** — it shows the LK SMB's
alternative costs $19–$349/mo as pure opex with zero ownership. samesake's pitch is capex/own
vs that opex/rent. **Differentiate on TCO + ownership.**

### A7. Hawksearch (Bridgeline Digital)

- **Positioning.** Mid-market/enterprise; notably **B2B + verticals (healthcare, industrial,
  décor)**. 2025 **"Hermes" release: Unified Search** = AI **Concept Search + Image Search +
  Keyword Search** in one. **[MARKETED]** (press). Adds **Smart Response** (answers grounded in
  PDFs/docs) and **Conversational Search** (dialogue-based). **[MARKETED]**
- **Deployment.** Hosted SaaS (publicly traded parent, BLIN).
- **Hybrid.** Yes — concept (vector) + keyword unified; conversational layer on top.
- **Pricing.** Enterprise / not public.

**Verdict:** "Concept Search" = the same hybrid vector+keyword story samesake fuses with RRF;
"Conversational Search" overlaps `findProducts()` but goes past retrieval into answers. Their
PDF/doc grounding (Smart Response) is out of samesake's scope-by-design (samesake stops at
retrieval). **Differentiate** — samesake's deliberate stop-at-retrieval is a contrast point,
not a deficiency.

### A8. GroupBy (a Rezolve AI company)

- **Positioning.** Enterprise B2B/B2C discovery, **built on Google Cloud Vertex AI Search for
  Commerce** ("Discovery AI") — i.e., GroupBy is a **merchandising/UX layer over Google's
  retrieval engine.** **[MARKETED]** Strong B2B: customer-specific pricing/availability, part-
  number search, unit conversion, **year/make/model fitment**. 10 medals in 2025 Paradigm B2B
  Combine. **[MARKETED]**
- **Deployment.** Hosted SaaS on GCP.
- **Hybrid.** Inherits Google Vertex hybrid retrieval.
- **Pricing.** Enterprise / not public.

**Verdict:** Architecturally the *anti-samesake* — maximal dependency (your search runs on
Google's brain, GroupBy's UI). Relevant only as a reminder that "fitment / parametric / B2B
attribute search" is a hard, valued capability — samesake's **typed catalog + hard SQL
predicate gating** is genuinely well-suited to fitment-style exact constraints. **Differentiate
+ note strength**: samesake's compile-to-SQL gating is the honest, ownable version of B2B
attribute search.

### A9. Prefixbox

- **Positioning.** Enterprise retail search; **first AI search provider to earn "Built for
  Shopify" status (2025).** AI engine "combines **vector search, LLMs, and keywords**." Strong
  autocomplete. Revenue +10–30% / CR +7–15% / AOV +9–19% claims. **[MARKETED]**
- **Deployment.** Hosted SaaS (Shopify app + enterprise).
- **Hybrid.** Explicitly vector + keyword + LLM.
- **Pricing.** Custom / not public.

**Verdict:** Cleanest articulation of the same **hybrid (vector+lexical+LLM)** recipe samesake
runs — but hosted. Good messaging benchmark. **Differentiate on ownership/auditability.**

### A10. Sajari / Search.io → Algolia NeuralSearch

- **History.** Sajari (founded 2014, Sydney) → rebranded **Search.io** → **acquired by Algolia
  Sept 2022 for >$100M**. Flagship was **NeuralSearch**, a vector engine using **hashing on top
  of vectors** ("binary/quantized" style) for cheap-at-scale ANN. **[MARKETED]** (Algolia +
  press).
- **Current state (2025).** NeuralSearch is **not deprecated** — it is Algolia's
  hybrid keyword+vector capability, **gated behind the top "Elevate" pricing tier**.
  **[MARKETED]** (third-party pricing analyses).
- **Deployment.** Hosted (Algolia DSN).
- **Hybrid.** Yes — "keyword + vector in a single API" is the headline.

**Verdict:** This collapses into the **Algolia** entry from the first sweep — it is not a
separate competitor anymore, just the technology Algolia bought. The interesting load-bearing
detail for samesake: NeuralSearch's **hashing/binary-quantized ANN** is a cost lever samesake
could borrow at the pgvector layer (binary/halfvec quantization) without buying Algolia.
**Integrate the technique, ignore the vendor.**

### A11. AddSearch

- **Positioning.** Site search + **AI Answers** (content-grounded, "no hallucinations") +
  **AI Conversations** (multi-turn). More **content/site-search** than commerce-catalog;
  **powered by OpenAI** under the hood. **[MARKETED]**
- **Deployment.** Hosted SaaS; 14-day trial; custom enterprise pricing.
- **Hybrid.** Keyword + AI ranking + answers; less of a pure commerce-catalog tool.

**Verdict:** Adjacent (site/content search, not catalog-first). Out of samesake's lane.
**Avoid as competitor.**

---

## Part B — Managed Vector DB / Retrieval Clouds (commerce-positioned)

These are **infrastructure** — they could, in principle, be the retrieval layer samesake
*replaces*. The samesake bet is that for a fashion catalog of ~5k–500k docs, **pgvector inside
the merchant's own Postgres is sufficient**, and a separate hosted vector cloud is unjustified
operational + cost + lock-in overhead. The question for each: *does it beat in-app pgvector for
the samesake use case?* Spoiler: not at LK-fashion scale, and that's the point.

### B1. Pinecone

- **Positioning.** The default managed vector DB; "build knowledgeable AI"; heavy RAG/agentic
  framing. **[MARKETED]**
- **Deployment.** Hosted serverless + **BYOC** ("runs Pinecone in your cloud account and VPC"
  — still managed-Pinecone, not OSS self-host). **[PROVEN]** (pricing page).
- **Hybrid.** **Sparse-dense hybrid reached GA in 2026**; dense + sparse + native full-text
  (public preview). Adds **Pinecone Inference** (hosted embedding + rerank), **Assistant**,
  **Dedicated Read Nodes**. **[MARKETED/PROVEN-mix]**
- **Pricing (PROVEN, pricing page).** Starter (free): ≤2GB storage, ≤2M write units/mo,
  ≤1M read units/mo, ≤5 indexes. Standard: **$50/mo min usage**, storage **$0.33/GB/mo**,
  writes **$4–4.50/M**, reads **$16–18/M**.

**Verdict:** Capable and now genuinely hybrid, but it's exactly the "hosted vector DB" samesake
defines itself *against*. At 5k–500k fashion docs, Pinecone is over-provisioned cost + a second
network hop + lock-in. **Avoid (it is the thing we replace).** One borrowable idea: Pinecone's
sparse-dense hybrid GA validates samesake's FTS+ANN+RRF fusion as the right shape.

### B2. Vectara

- **Positioning.** RAG-as-a-service with a **hybrid-search core** + reranking; signature asset
  is the **HHEM hallucination evaluation model** and a **Hallucination Corrector** (launched
  May 2025, claims <1% hallucination on sub-7B LLMs). **[MARKETED]**
- **Deployment.** Hosted; enterprise VPC/on-prem in higher tiers. **[MARKETED]**
- **Hybrid.** Yes (hybrid + rerank baked in).
- **Pricing.** Free tier; usage-scale; **Pro ~$830/mo (83k queries)**; enterprise >$50K/yr.
  **[MARKETED]** (third-party + deal listings).

**Verdict:** RAG/answers-oriented (generation included) — samesake deliberately **stops at
retrieval** and is **BYO generation**. Different scope. HHEM is interesting only if samesake
ever ships a generated-answer surface (it doesn't plan to). **Avoid / out of scope.**

### B3. Turbopuffer

- **Positioning.** "Fast search on **object storage**" — decouples compute from storage,
  primary store is S3, SSD only as read-through cache. Powers Cursor, Notion. **[MARKETED]**
- **Deployment.** **Hosted only** (Enterprise adds single-tenancy + BYOC). **[PROVEN]**
  (pricing page).
- **Architecture (PROVEN, vendor blog).** Object-storage-first; warm queries p50 ~8ms, cold
  queries p90 ~444ms (the cold-start tax of S3-backed ANN).
- **Pricing (PROVEN, current pricing page).** Minimum-commit model: **Launch $64/mo min**,
  **Scale $256/mo min**, **Enterprise ≥$4,096/mo (35% usage premium)**. (Note: older
  third-party write-ups cite "$70/TB/mo storage, free 100k-vector tier" — that **predates** the
  current minimum-commit page; treat the $64/$256/$4096 minimums as the live numbers.)

**Verdict:** The most architecturally *interesting* entry — its object-storage-first thesis is
the cost-optimal answer for **huge, cold, low-QPS** vector sets. samesake's profile is the
opposite: **small, hot, in-app, latency-sensitive**, already co-located with the SQL gate.
For 5k–500k fashion docs, pgvector-in-Postgres wins on simplicity and zero extra hop.
**Avoid for samesake's scale, but note the pattern** — if a samesake user ever has tens of
millions of vectors, object-storage-first ANN is the escape hatch, not a Pinecone-style RAM DB.

### B4. Zilliz Cloud (managed Milvus)

- **Positioning.** Fully managed **Milvus** (Apache-2.0 OSS engine); "vector lakebase";
  enterprise compliance (SOC2 II, ISO 27001, GDPR, HIPAA-ready, 99.95% SLA). **[MARKETED]**
- **Deployment.** Serverless / Dedicated (PAYG or contract) / **BYOC** (revamped Feb 2025).
  **[PROVEN]** Underlying **Milvus is genuinely self-hostable OSS** — the one entry here with a
  real own-it path, though that path is "run Milvus yourself," not "use Zilliz Cloud."
- **Hybrid.** Milvus supports dense+sparse hybrid + filtering.
- **Pricing.** Serverless from $0; Dedicated standard ~$126/GB/mo region-dependent; enterprise
  tiers. **[MARKETED]** (pricing page figures vary).

**Verdict:** If samesake ever needed to externalize vectors, **self-hosted Milvus** is the
ideologically compatible option (OSS, ownable, in-VPC) — but it's a *second datastore* next to
Postgres, breaking the "one Postgres" simplicity. For LK-fashion scale that trade isn't worth
it. **Avoid by default; Milvus is the reference if pgvector is ever outgrown.**

### B5. Marqo Cloud

- **Positioning.** **End-to-end multimodal (text+image) vector search for ECOMMERCE** —
  embedding generation + storage + retrieval in one API, with **purpose-built ecommerce
  embedding models** ("marqo-ecommerce-L", **+17.6% MRR vs ViT-SO400M SigLIP** on a 4M-product
  eval **[MARKETED]**), plus **Marqtune** fine-tuning on your own catalog + clickstream, and
  GCL (generalized contrastive learning). **[MARKETED]**
- **Deployment.** **Marqo open source (Apache-2.0) is now DEPRECATED** — the GitHub repo states
  "Marqo's Open Source project is deprecated and will no longer receive updates," pushing users
  to the **commercial Marqo Cloud (hosted)**. **[PROVEN]** (GitHub repo). This is a meaningful
  change from the first sweep's `01-marqo/` framing: the ownable path is closing.
- **Hybrid.** Tensor/vector search; lexical+tensor hybrid supported in the engine.
- **Pricing.** Not public (pricing page redirects to "Book a Demo"). **[PROVEN — by absence]**

**Verdict:** **The single most samesake-adjacent vendor in this entire pass**, and the most
useful one to mine. Marqo's *fashion/ecommerce-specialized multimodal embeddings* are exactly
what samesake's **BYO-embedding** slot wants — and because samesake is BYO-embedding, a merchant
*could plug Marqo's open ecommerce models* (the HF weights, `Marqo/marqo-ecommerce-embeddings-L`,
Apache-2.0) into samesake's enrich pipeline **without** adopting Marqo Cloud. The deprecation of
Marqo's OSS *engine* is a competitive gift: it validates samesake's "ownable engine" position
while leaving the *embedding models* freely usable. **INTEGRATE the embedding models; AVOID the
cloud; cite the OSS-deprecation as a differentiation talking point.** Caveat to verify: the
marqo-ecommerce models' training skews Western catalogs — unproven on LK fashion / Sinhala-Tamil.

### B6. Superlinked

- **Positioning.** "The Vector Computer" — a **Python framework** that encodes structured +
  unstructured signals (text semantics, numeric ranges via min-max spaces, categorical
  attributes, recency, popularity) into **unified multi-modal vectors**, so ranking happens in
  the vector layer ("why you don't need re-ranking"). Strong **ecommerce recsys** story
  (user vectors from interacted SKUs). **[MARKETED]**
- **Deployment.** **Self-hostable, Apache-2.0** Python framework; runs in-memory or as a REST
  server in your infra; **stores vectors in your vector DB** (Redis, MongoDB, Qdrant, TopK).
  **[PROVEN]** (GitHub).
- **Hybrid.** It *is* the fusion layer — it builds the multi-attribute embedding rather than
  fusing post-hoc.

**Verdict:** Conceptually the **closest cousin to samesake's "spaces"** — Superlinked's named
"spaces" (text space, number space, categorical space, recency space combined into one vector)
are almost a one-to-one analog of samesake's typed segmented **spaces** (which are currently
*off* because they failed the gate). **This is the highest-value reference in Part B for the
spaces problem.** Superlinked is empirical proof the multi-space-into-one-vector idea works in
production ecommerce recsys, AND it's Apache-2.0 and self-hostable — so its approach (encoder
mixture, min-max numeric spaces, recency/popularity as embedding dimensions) is **studyable and
borrowable** to fix samesake's spaces. Difference: Superlinked backs onto Qdrant/Redis/Mongo,
not Postgres — but the *encoding logic* is datastore-agnostic and could inform a pgvector
implementation. **INTEGRATE the ideas (study deeply to revive samesake "spaces"); differentiate
on Postgres-native delivery.**

### B7. TwelveLabs (visual / video)

- **Positioning.** Video/multimodal **foundation models** (Marengo 3.0, GA Dec 2025) that
  "unify videos, images, audio, and text into a single representation space." **Embed API v2:
  composed text+image search — up to 10 images + optional text in one embedding request.**
  4-hour video support. **[PROVEN]** (docs/release notes).
- **Deployment.** Hosted — first-party API + **Amazon Bedrock**; no self-host. **[PROVEN]**
- **Commerce relevance.** Primarily **video understanding** (creator/brand matching, moment
  search). Image embeddings exist but the platform's center of gravity is video, not product
  stills.
- **Pricing.** Not in release notes; Bedrock-metered. **[PROVEN — by absence]**

**Verdict:** Powerful but **off-axis** for samesake today. Fashion catalog retrieval is
image+text on **product stills**, where general CLIP/SigLIP or Marqo's ecommerce models fit the
BYO-embedding slot better and cheaper. TwelveLabs becomes relevant **only if** samesake ever
indexes **fashion video** (TikTok/Reels-style product clips, runway video) — then its
video-moment embeddings are best-in-class. **Watch; integrate only for a future video corpus.**

---

## Comparison Table

| Vendor | Cohort | Deployment | Ownable? | Hybrid | Commerce/Multimodal focus | Public pricing | Agentic/2026 signal | vs samesake |
|---|---|---|---|---|---|---|---|---|
| Shopify Search & Discovery | Site-search | Hosted (in Shopify) | No | Semantic+kw (forced) | Catalog | Free | None | **Floor/baseline** to beat |
| Fast Simon | Site-search | Hosted SaaS | No | Gen-AI hybrid | Visual discovery | No (sales) | "Shopping agents" (vague) | Watch/differentiate |
| Unbxd (Netcore) | Site-search | Hosted SaaS | No | Yes | Multimodal+fitment | No | **Strong** — "Enrichment for Agentic Commerce" (ChatGPT/Gemini/Alexa) | **Strategic validator** |
| Luigi's Box | Site-search | Hosted SaaS | No | Semantic | Analytics-led | No (trial) | None | Avoid |
| Doofinder | Site-search | Hosted SaaS | No | Semantic+fuzzy | SMB catalog+visual/voice | **Yes (tiers)** | None | Avoid |
| Searchanise | Site-search | Hosted app | No | Smart search | SMB catalog | **Yes ($0–$349/mo)** | None | Price anchor |
| Hawksearch (Bridgeline) | Site-search | Hosted SaaS | No | Concept+image+kw | B2B/verticals | No | Conversational + Smart Response | Differentiate |
| GroupBy (Rezolve) | Site-search | Hosted (GCP/Vertex) | No | Inherited (Vertex) | B2B fitment/parametric | No | Vertex-driven | Anti-samesake |
| Prefixbox | Site-search | Hosted SaaS | No | **vector+LLM+kw** | Enterprise catalog | No | Built-for-Shopify | Messaging benchmark |
| Sajari/Search.io → Algolia NeuralSearch | Site-search | Hosted (Algolia) | No | **kw+vector (hashing ANN)** | Catalog | Top "Elevate" tier | Part of Algolia | = Algolia; borrow hashing |
| AddSearch | Site-search | Hosted SaaS | No | kw+AI answers | Content/site (not catalog) | Trial/custom | AI Conversations | Out of lane |
| Pinecone | Vector DB | Hosted + BYOC | No (managed) | **Sparse-dense GA 2026** | RAG/agentic | **Yes ($0.33/GB, $50 min)** | Inference, Assistant, DRN | The thing we replace |
| Vectara | Vector/RAG | Hosted + VPC | Partial | Yes + rerank | RAG/answers | ~$830/mo Pro | Hallucination Corrector | Out of scope (generation) |
| Turbopuffer | Vector DB | Hosted only | No | Yes | Object-storage-first | **Yes ($64/$256/$4096 min)** | — | Avoid at our scale; pattern noted |
| Zilliz Cloud (Milvus) | Vector DB | Serverless/Dedicated/BYOC | **Yes (OSS Milvus)** | Dense+sparse | General | Serverless $0+ | BYOC revamp | Milvus = the escape hatch |
| **Marqo Cloud** | Vector DB | Hosted (OSS **deprecated**) | No (was OSS) | tensor+lexical | **Ecommerce multimodal models** | No (demo) | Marqtune fine-tune | **Integrate embeddings; avoid cloud** |
| **Superlinked** | Vector framework | **Self-host, Apache-2.0** | **Yes** | Unified multi-attr vector | Ecommerce recsys / **spaces** | OSS free | — | **Study to revive "spaces"** |
| TwelveLabs | Visual/video | Hosted (API+Bedrock) | No | Composed text+image | **Video** understanding | No (Bedrock) | Marengo 3.0 | Future video corpus only |
| **samesake** | **In-app compiler** | **2 containers in user's app** | **Yes (own code+data)** | **FTS+ANN+spaces via RRF** | **Fashion-first / LK** | n/a (you own it) | findProducts() + UCP/ACP/MCP planned | — |

---

## Relevance to samesake — Adopt / Avoid / Differentiate / Integrate

**ADOPT (techniques to bring into the codebase):**
- **Binary/quantized ANN** as a pgvector cost lever (the Search.io/NeuralSearch "hashing on
  vectors" idea) — pgvector `halfvec`/binary quantization for larger LK catalogs without a
  hosted DB.
- **Sparse-dense fusion confidence**: Pinecone's 2026 sparse-dense hybrid GA + Hawksearch's
  "concept+keyword unified" independently confirm samesake's FTS+ANN+RRF fusion is the
  industry-correct shape. Keep it; cite it.

**INTEGRATE (BYO slots samesake already exposes):**
- **Marqo's open ecommerce embedding models** (`Marqo/marqo-ecommerce-embeddings-L`,
  Apache-2.0 on HF) as a *candidate* BYO embedding for the fashion enrich pipeline — but
  **benchmark on the LK corpus first** (likely Western-catalog-biased). The Marqo OSS *engine*
  is deprecated; the *models* are not.
- **Superlinked's encoding approach** — its production "spaces" (text + min-max numeric +
  categorical + recency/popularity combined into one vector) is the **most actionable reference
  for reviving samesake's currently-off "spaces."** Study `superlinked/superlinked` (Apache-2.0)
  for how it weights/combines spaces and why it claims rerank-free ranking, then map to pgvector.
- **TwelveLabs Marengo** only if/when a **fashion-video corpus** appears.

**DIFFERENTIATE (positioning, not code):**
- Every site-search vendor (A1–A11) is **hosted, opaque, rent-not-own, BYO-nothing**.
  samesake's wedge is the inversion: **own the engine + data in your own two containers, typed,
  auditable (`/search/explain`), BYO embedding+generation.** Make ownership/TCO the headline.
- **Marqo deprecating its OSS engine** and **Algolia gating NeuralSearch behind a top tier** are
  concrete proof the market is closing ownable paths — samesake is opening one.
- samesake's **stop-at-retrieval** discipline contrasts cleanly with Hawksearch/AddSearch/
  Vectara bolting on answers/conversation. Frame it as principled, not missing.

**AVOID (do not build toward / do not benchmark as ceiling):**
- Pinecone / Turbopuffer / Zilliz Cloud as a *retrieval backend* — they break the
  "one Postgres, in-app" thesis at LK-fashion scale. (Self-hosted **Milvus** is the only
  ideologically compatible escape hatch if pgvector is ever truly outgrown.)
- Vectara (it's generation/RAG; samesake is BYO-generation, retrieval-only).
- Treating Shopify native search or any SMB SaaS as a quality *ceiling* — they are the floor.

---

## Does this change the competitive picture from the first sweep?

**Mostly no — with three genuine deltas:**

1. **Unbxd's "Enrichment for Agentic Commerce" (Nov 2025)** is the strongest external signal
   yet that samesake's agentic/UCP-ACP-MCP roadmap is aimed at a real, Gartner-leader-validated
   demand. It **raises the urgency** of the adapters, but it does **not** change positioning —
   Unbxd serves enterprises via hosted enrichment; samesake serves SMB/LK via ownable in-app.

2. **Marqo's OSS engine deprecation** is a competitive *improvement* for samesake: the most
   ecommerce-multimodal-credible OSS engine is closing its ownable path while leaving its
   *embedding models* free — perfect for samesake's BYO-embedding slot.

3. **Superlinked** is the most useful *technical* discovery of this pass — a self-hostable,
   Apache-2.0, production-proven implementation of the exact "typed spaces fused into one
   vector" idea samesake shelved. It is a concrete reference for **fixing the failed spaces
   gate**, which is one of samesake's known weak points.

No vendor in this pass is a head-on architectural competitor (in-app, ownable, Postgres-native,
typed-compiler). The site-search cohort competes on *outcome via the opposite (hosted) model*;
the vector clouds are the *infrastructure samesake replaces*. The competitive picture from the
first sweep stands; this pass sharpens **three actionable threads** (agentic urgency, Marqo
embeddings, Superlinked spaces) rather than introducing a new rival.

---

## Open Questions

1. **Do Marqo's ecommerce embedding models survive the LK corpus?** They claim +17.6% MRR on a
   4M Western catalog — unproven on Sinhala/Tamil/English code-mixed fashion. Needs a samesake
   bench run before adoption.
2. **Can Superlinked's multi-space encoding be reimplemented over pgvector** (it ships
   Qdrant/Redis/Mongo backends, not Postgres)? Is the encoding logic truly datastore-agnostic,
   and does it explain why samesake's spaces failed the gate?
3. **At what catalog size does in-app pgvector actually lose** to a hosted vector cloud for the
   samesake latency/quality profile? Need an empirical crossover point (5k → 50k → 500k → 5M)
   to defend "no hosted vector DB" with data, not assertion.
4. **What languages does Shopify semantic search actually support** post-2025? The changelog
   hides the list; if Sinhala/Tamil are absent (likely), that's a quantifiable wedge.
5. **Is NeuralSearch's hashing-ANN equivalent to pgvector binary quantization** in recall, or
   does Algolia's approach add learned components worth replicating?
6. **Unbxd "Enrichment for Agentic Commerce" — what's the actual interface?** (feed format,
   protocol, MCP/ACP?) Determines whether samesake's adapters should mirror or diverge.

---

## Sources

Site-search vendors:
- Shopify changelog — "Semantic search now supports more languages": https://changelog.shopify.com/posts/semantic-search-now-supports-more-languages
- Shopify changelog — "Semantic search is now available on more plans": https://changelog.shopify.com/posts/semantic-search-is-now-available-on-more-plans
- Fast Simon pricing: https://www.fastsimon.com/pricing/ ; AI Search: https://www.fastsimon.com/solutions/search/
- Netcore Unbxd — "Enrichment for Agentic Commerce" (PR Newswire): https://www.prnewswire.com/news-releases/netcore-unbxd-launches-enrichment-for-agentic-commerce-to-make-retailers-visible-in-the-age-of-ai-shopping-302606898.html
- Netcore Unbxd Agentic AI: https://netcoreunbxd.com/search/agentic-ai/
- Luigi's Box AI site search: https://www.luigisbox.com/ai-powered-site-search/
- Doofinder pricing: https://www.doofinder.com/en/price
- Searchanise pricing: https://searchanise.io/pricing/
- Hawksearch / Bridgeline — Unified AI Concept/Image/Keyword Search (Hermes): https://www.hawksearch.com/news/hawksearch-revolutionizes-search-with-unified-ai-powered-concept-image-and-keyword-search
- GroupBy on Vertex AI / Paradigm B2B 2025 (Business Wire): https://www.businesswire.com/news/home/20250226505644/en/
- Prefixbox AI Search Suite: https://www.prefixbox.com/en-us/solutions/search-suite ; Built-for-Shopify: https://www.prefixbox.com/en-us/technical/prefixbox-ai-search-shopify
- Algolia acquires Search.io (NeuralSearch): https://www.algolia.com/about/news/algolia-disrupts-market-with-search-io-acquisition-ushering-in-a-new-era-of-search-and-discovery
- AddSearch: https://www.addsearch.com/ ; pricing: https://www.addsearch.com/pricing/

Managed vector / retrieval clouds:
- Pinecone pricing: https://www.pinecone.io/pricing/ ; dedicated read nodes (Blocks & Files): https://blocksandfiles.com/2025/12/01/pinecone-dedicated-read-nodes/
- Vectara enterprise RAG predictions 2025: https://www.vectara.com/blog/top-enterprise-rag-predictions ; hallucination: https://www.vectara.com/blog/category/hallucination
- Turbopuffer pricing: https://turbopuffer.com/pricing ; architecture blog: https://turbopuffer.com/blog/turbopuffer
- Zilliz Cloud pricing: https://zilliz.com/pricing ; Oct 2025 update (BYOC/tiered storage): https://zilliz.com/blog/zilliz-cloud-oct-2025-update
- Marqo ecommerce embedding models: https://www.marqo.ai/blog/introducing-marqos-ecommerce-embedding-models ; OSS repo (deprecation notice): https://github.com/marqo-ai/marqo ; ecommerce demo: https://github.com/marqo-ai/ecommerce-search
- Superlinked repo (Apache-2.0): https://github.com/superlinked/superlinked ; ecommerce recsys: https://superlinked.com/vectorhub/articles/ecomm-recys ; "why you don't need re-ranking": https://superlinked.com/vectorhub/articles/why-do-not-need-re-ranking
- TwelveLabs release notes / Marengo 3.0: https://docs.twelvelabs.io/docs/get-started/release-notes ; Marengo 3.0 GA (HPCwire/AIwire): https://www.hpcwire.com/aiwire/2025/12/01/twelvelabs-launches-marengo-3-0-video-understanding-model-on-twelvelabs-and-amazon-bedrock/

Third-party comparisons (treated as [MARKETED]):
- "Best Vector Databases in 2026" (MarkTechPost): https://www.marktechpost.com/2026/05/10/best-vector-databases-in-2026-pricing-scale-limits-and-architecture-tradeoffs-across-nine-leading-systems/
- Meilisearch — Algolia pricing/review (NeuralSearch tiering): https://www.meilisearch.com/blog/algolia-pricing
- Prefixbox — "Best Shopify Search App in 2026": https://www.prefixbox.com/blog/best-shopify-search-app-in-2026/
