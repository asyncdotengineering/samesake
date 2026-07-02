# Marqo: Positioning, "AI-Native Ecommerce Search," and "Commerce Superintelligence"

> Competitive/technical dossier for **samesake** (TypeScript-first search-engine compiler for visual commerce, Postgres + pgvector, hybrid FTS + ANN + RRF, runs in the user's own app).
> Scope: Marqo's *positioning, vocabulary, narrative, and named technical claims* as presented across 11 blog URLs (9 unique pages after redirect dedup). Verbatim quotes are used for load-bearing claims. Marketing vs. defensible claims are flagged inline.
> Date captured: 2026-06-14.

---

## 0. TL;DR for samesake

Marqo has **repositioned** from a 2022–2024 *open-source vector search / RAG infrastructure* company into a 2026 *"AI-native product discovery platform"* selling **"Commerce Superintelligence"** to enterprise retailers. The pitch is a closed, hosted, managed SaaS: connect your catalog (Shopify/Adobe/SFCC connector + a JS "Marqo Pixel"), and Marqo auto-fine-tunes a **dedicated per-retailer embedding model** within hours, then layers behavioral data on top. The core wedge is the **cold-start / long-tail argument**: keyword search can't understand meaning, behavioral ranking can't rank what has no clicks, so a *product-native* model that understands every product from day one wins on the 70–80% of the catalog with thin behavioral signal.

This is **almost exactly samesake's thesis** ("understand products, gate hard filters, fuse signals") — but Marqo's delivery model is the **polar opposite**: hosted black-box managed service vs. samesake's BYO, in-your-app, typed-compiler, auditable approach. Marqo's strongest defensible asset is its **real embedding-model research** (GCL, marqo-fashionCLIP/SigLIP, 4.8M monthly HF downloads). Its weakest spots for an audit: the **"Commerce Superintelligence" / six-requirements framework is a marketing construct** (vendor-defined "verifiable tests" that conveniently only Marqo passes), the **architecture is described entirely in prose with zero retrieval internals**, and the **Series A "news" post is dated 2026 but describes a Feb-2024 round** (positioning theater).

---

## 1. Sources analyzed

| # | URL | Type | Note |
|---|-----|------|------|
| 1 | `/blog/what-is-marqo` | Pillar / definition | Authoritative positioning page |
| 2 | `/blog/marqo-an-introduction` | — | **Redirects to `what-is-marqo`** (identical content) |
| 3 | `/blog/what-is-ai-native-ecommerce-search` | Category-definition / SEO | Most technical of the marketing pages |
| 4 | `/blog/what-makes-a-search-platform-truly-ai-native` | AI-native vs AI-enhanced | Architecture-ceiling argument |
| 5 | `/blog/commerce-superintelligence` | "Blueprint" | The six-requirements manifesto |
| 6 | `/blog/what-is-commerce-superintelligence` | — | **Redirects to `commerce-superintelligence`** (identical) |
| 7 | `/blog/ai-native-vs-behavioral-ranking-...` | Thought-leadership | Short opinion piece |
| 8 | `/blog/legacy-ecommerce-search-is-dead-...` | FUD / problem-framing | Revenue-loss framing |
| 9 | `/blog/marqo-raises-seriesa-to-accelerate-ai-product-discovery` | Funding announcement | See §7 timeline caveat |
| 10 | `/blog/what-does-dedicated-llm-mean` | Explainer | Best source on the "dedicated model" mechanics |
| 11 | `/blog/getting-started-with-marqo` | Builder guide | Deployment/onboarding |

All pages are tagged `robots: noindex, nofollow` and share a `State of AI in Consumer & Retail 2026` banner — i.e., these are recent (Apr–May 2026) SEO/positioning assets, not the developer docs of the open-source `marqo` engine.

---

## 2. Positioning & vocabulary (the lexicon Marqo is trying to own)

Marqo is deliberately **minting category language**. The controlled vocabulary, with verbatim definitions:

- **"AI-native product discovery platform"** — the master self-description. Repeated on nearly every page: *"Marqo is the AI-native product discovery platform that delivers Commerce Superintelligence for enterprise retailers."*
- **"Commerce Superintelligence"** — the flagship coined term (capitalized, trademark-style). *"Commerce Superintelligence is a new standard for how AI operates in retail. It describes an AI system's ability to understand products at the depth an expert merchant would, and to act on that understanding across every touchpoint in the shopping journey, from search through post-purchase."*
- **"Product-native intelligence"** / **"product-trained vs behavior-trained"** — the central technical dichotomy. *"There are two architectures for ecommerce AI. Behavior-trained systems learn what shoppers do. Product-trained systems learn what products are. Both use behavioral data. The difference is the starting point."*
- **"AI-native vs AI-enhanced (AI-layered)"** — the competitive wedge against incumbents. *"AI-native means that intelligence is the foundational architecture of the platform... It does not mean a platform that uses AI somewhere in its stack. It means a platform where AI is the stack."*
- **"Dedicated AI / dedicated LLM per retailer"** — *"a dedicated AI trained for each retailer that derives its core understanding from product content."*
- **"Sibbi"** — branded conversational-commerce agent. *"the first conversational commerce agent built on Commerce Superintelligence... Every response is grounded in real inventory. No hallucinations. No phantom products."*
- **"Marqo Pixel"** — JS behavioral-capture snippet ("similar to installing Google Analytics").
- **"Zero-shot product competency,"** **"cold-start problem,"** **"long-tail gap,"** **"the keyword ceiling,"** **"the modality gap,"** **"full-journey intelligence continuity,"** **"embedded commercial optimization,"** **"unified cross-modal retrieval,"** **"visual product reasoning across the full stack."**

**Memorable slogans** (designed for repetition): *"Ranking is not intelligence. Understanding is."* / *"Behavioral ranking learns from the past. AI-native systems understand the present."* / *"Results in 14 days, not months."* / *"One agent, one conversation, from first query to post-purchase."*

**Three-generation narrative** (a classic category-creation device, from `/commerce-superintelligence`):
1. **Gen 1 — keyword search**: document index, exact-token matching, synonym tables, *"armies of merchandisers."*
2. **Gen 2 — behavioral ranking**: clickstream-ranked, *"backward-looking by definition,"* cold-start, optimizes click-probability ≠ business value.
3. **Gen 3 — Commerce Superintelligence**: product understanding first, behavior layered on to "sharpen."

---

## 3. The "Commerce Superintelligence" framework — the six requirements

This is the intellectual centerpiece (`/commerce-superintelligence`). Marqo frames it as an *objective, testable standard* — *"Each requirement includes a verifiable test so that the standard can be evaluated objectively, not claimed through marketing language."* (Flag: a vendor defining the spec **and** the pass/fail tests is itself a marketing move — see §8.)

| # | Requirement | Verbatim "verifiable test" |
|---|-------------|----------------------------|
| 1 | **Product-Native Intelligence** | *"Remove all behavioral data from the system. Can it still understand what a product is...? If yes... product-native. If no, it is a behavioral filter with product metadata as input, regardless of how it is marketed."* |
| 2 | **Full-Journey Intelligence Continuity** | Same AI answers *"where is my order?", "how do I return this?", "what pairs well with what I bought?"* without handoff to a separate support stack. |
| 3 | **Unified Cross-Modal Retrieval** | *"Can the system process a query that combines an image with a text modifier in a single step?"* (e.g., upload photo + "but in a warmer tone"). If text/image processed separately and merged after → fails. |
| 4 | **Zero-Shot Product Competency** | Add a product from a never-sold category, no behavioral history, no attribute overlap. Does it rank for relevant queries without accumulating clicks? |
| 5 | **Embedded Commercial Optimization** | Remove all merchandising rules. Does it still prefer high-margin products when two are equally relevant, accounting for inventory/promo calendars? |
| 6 | **Visual Product Reasoning Across the Full Stack** | Text-search *"quiet luxury"* → returns *"unbranded cashmere, understated leather goods, tailored neutrals"* even with no description containing the phrase; metadata-gaming ("Quiet Luxury Vest Top") should not win. |

What it claims to power when all six are met: **search, merchandising, recommendations, conversational commerce (Sibbi), post-purchase** — *"from a single intelligence layer."*

**samesake mapping**: Requirements 1, 3, 4, 6 are *directly* what samesake's hybrid (FTS + cosine ANN over BYO embeddings + segmented "spaces") and multimodal enrich pipeline target. Requirement 5 (embedded commercial optimization *in the model objective*) is where samesake **deliberately differs** — samesake compiles commercial constraints to **SQL hard/soft filters that gate before ranking**, which is more auditable but is exactly what Marqo dismisses as *"merchandising rules applied after ranking."* Requirement 2 (post-purchase, order tracking, returns) is **out of samesake's scope by design** (findProducts() stops at retrieval). This is a defensible differentiation line, not a gap to apologize for.

---

## 4. Concrete technical architecture & claims

The marketing pages are **architecturally thin** — they assert "the model does retrieval and ranking" but never describe the index, the vector store, ANN method, hybrid fusion, or filtering. The genuinely concrete technical content lives in `/what-is-ai-native-ecommerce-search`, `/what-does-dedicated-llm-mean`, and the funding post.

### 4.1 The retrieval claim (vector-first, keyword-replacing)
- *"Products are indexed as high-dimensional embeddings that capture their full semantic meaning. Retrieval happens through vector similarity, not keyword matching."* (`/what-is-ai-native-ecommerce-search`)
- *"the vector-based architecture scales well because retrieval happens through approximate nearest neighbor search on embeddings."* — the only explicit mention of ANN.
- **No mention of hybrid retrieval, BM25/FTS fusion, or RRF.** Marqo's *public marketing* posture is "replace the keyword stack," not "fuse with it." (Note: the underlying open-source `marqo` engine *does* support lexical/tensor hybrid search and Vespa-backed indexing — but the 2026 positioning pages suppress that nuance in favor of the "AI is the stack" message.)
- The legacy-search post is the one place that hints at hybrid + learning-to-rank: *"Marqo handles all three by combining dense vector retrieval with real-time click-stream learning that improves rankings based on actual shopper behavior."*

### 4.2 The "dedicated model" pipeline (most concrete, from `/what-does-dedicated-llm-mean`)
Step-by-step as Marqo describes it:
1. Connect product feed (Shopify / Adobe Commerce / Salesforce Commerce Cloud / direct API).
2. Ingest titles, descriptions, images, attributes, categories, pricing.
3. *"The platform automatically fine-tunes an embedding model on your specific catalog using Marqo's proprietary training pipeline."*
4. *"Within hours, you have a dedicated AI."*
5. Marqo Pixel captures clicks / ATC / purchases.
6. *"The model continuously improves as behavioral data accumulates, but it works from day one without any behavioral data at all."*

Key mechanics claims:
- **Fine-tuning, not from-scratch**: dedicated models start from Marqo's foundation models and are fine-tuned per retailer. *"The foundation is already world-class. The fine-tuning makes it yours."*
- **Per-retailer data isolation**: *"Your catalog data and behavioral data are used exclusively to train your model. They are not shared across retailers."*
- **No ML team required**: positioned against both "out-of-the-box generic shared model" vendors and "months-long ML project" fears.
- **Continuous auto-retraining**: *"You do not need to trigger retraining... or worry about model drift."*

### 4.3 The named technical foundation: **GCL**
- *"Marqo's dedicated models are built on GCL (Generalized Contrastive Learning), Marqo's open-source research framework. GCL enables efficient fine-tuning of large embedding models on retailer-specific data."*
- **DEFENSIBLE / VERIFIED**: GCL is real and public — GitHub `marqo-ai/GCL`, Hugging Face "Generalised Contrastive Learning" collection. External sources confirm GCL *"goes beyond binary relevance and leverages fine-grained rankings for multimodal retrieval tasks"* and trains on *"categories, style, colors, materials, keywords and fine-details,"* not just text descriptions. This is the one place where Marqo's marketing is backed by genuine, citable research.

### 4.4 Multimodal / cross-modal
- *"An AI-native system processes both text and images in the same model, in a unified vector space."*
- Cross-modal compositional query as the differentiator: *"upload a photo and add 'but in a warmer tone' in a single query... processed together in one inference step."* (Requirement 3.)
- Visual attributes named: *"silhouette, texture, pattern, color palette."*

### 4.5 Deployment & time-to-value
- **Marqo Pixel** (JS snippet) + **pre-built connectors** (Shopify, Adobe Commerce, Salesforce Commerce Cloud).
- *"Results in 14 days, not months."* / SwimOutlet *"went live with Marqo in 5 days."*
- Model training *"typically completes within hours of catalog ingestion."*

---

## 5. Models, datasets & benchmarks named

| Asset | Claim (verbatim where load-bearing) | Status |
|-------|-------------------------------------|--------|
| **GCL (Generalized Contrastive Learning)** | Open-source fine-tuning framework, foundation of dedicated models | **Verified** (GitHub `marqo-ai/GCL`) |
| **Ecommerce + fashion embedding models** | *"the world's most popular ecommerce embedding model and the most popular fashion embedding model on Hugging Face, with over 4.8 million monthly downloads."* | Partially verifiable — `marqo-fashionCLIP`, `marqo-fashionSigLIP`, `marqo-ecommerce-embeddings-B/L` exist on HF. "Most popular" superlative is marketing; download count not independently audited here. |
| **Relevance benchmark** | *"In benchmarks across 4M+ products, Marqo's purpose-built models showed 73 to 78% relevance improvement compared to generic models."* | **Marketing claim** — no methodology, baseline, or metric definition given. "vs generic models" is an unspecified baseline. Treat as directional, not reproducible. |
| **Training corpus** | Models *"trained on hundreds of millions of ecommerce products."* | Marketing-scale claim, unverified. |

**Customer-result benchmarks** (repeated across pages, *"validated through controlled production A/B tests"*):

| Retailer | Result | Vertical |
|----------|--------|----------|
| Fashion Nova | **$130M attributed incremental revenue** | Fashion |
| Mejuri | +19.8% search-driven conversion; +14.72% purchase conversion; +19.84% search revenue/user | Jewelry |
| KICKS CREW | +17.7% conversion rate; +28% cart value | Footwear |
| Kogan | $10.1M incremental revenue | General/electronics |
| Redbubble | $11M incremental; +21% search conversion on **descriptive queries** | Marketplace |
| SwimOutlet | +10.6% search ATC rate; live in 5 days | Sporting goods |
| General | *"Conversion rates improve by 10–30%... Zero-results queries drop by more than half."* | Aggregate |
| FUD stat | *"The average ecommerce site loses between 15% and 30% of potential revenue every month to poor search."* | Unsourced |

**Flag**: case-study numbers are A/B-attested (defensible-ish, vendor-reported, no public report links in these posts). The "10–30% conversion lift," "15–30% revenue loss," and "73–78% relevance" figures are **uncited marketing aggregates**.

---

## 6. Methods & the argument structure (how Marqo wins the rhetorical frame)

1. **Problem inflation** (`/legacy-ecommerce-search-is-dead`): keyword search is *"dead,"* losing 15–30% of revenue/month; zero-results spike; *"shoppers who could have converted in two clicks are lost after five."*
2. **The keyword ceiling** (`/what-makes-a-search-platform-truly-ai-native`): the cleverest argument. Even a perfect AI reranker is capped by what the keyword candidate-set retrieved: *"If the keyword index did not surface a product, the AI never sees it... The ceiling is architectural, not computational."* This reframes *all* hybrid/rerank competitors as fundamentally limited.
3. **The behavioral-ranking trap** (`/ai-native-vs-behavioral-ranking`): behavioral systems are *"backward-looking by definition"* — can't handle new products, trends-this-week, or vague/visual intent. *"Ranking is not intelligence. Understanding is."*
4. **Cold-start + long-tail as the killer stat**: *"70–80% of the catalog has insufficient behavioral signal"* (repeated 3×). This is the load-bearing number for the whole thesis.
5. **The "single intelligence layer" consolidation play**: search + merchandising + recs + conversational + post-purchase all from one model → attacks the "fragmented stack" of point solutions.
6. **The buyer's checklist** (`/what-is-ai-native-ecommerce-search`): "questions that separate AI-native from AI-layered" — *"What does the retrieval layer actually run on?"*, *"Were the models trained on ecommerce product data?"*, *"Does the system handle images natively?"*, *"Can the model be fine-tuned to your catalog?"*, *"What is the realistic go-live timeline?"* This is a **competitive-displacement script** handed to buyers.

---

## 7. Funding & market narrative

From `/marqo-raises-seriesa-to-accelerate-ai-product-discovery`:
- *"The round, led by Lightspeed with participation from Blackbird VC, January Capital, and Chronosphere co-founder Rob Skillington, brings Marqo's total funding to **$17.8 million**."*
- Company: founded **San Francisco, 2022**, by **Tom Hamer (CEO)** and **Jesse Clark (CTO)**. Backed by **Lightspeed Venture Partners** and **Blackbird Ventures**.
- Narrative arc explicitly stated: *"From the Most Advanced Ecommerce AI Models to a Full Discovery Platform"* — i.e., models → platform.
- Macro framing: discovery is moving off-site to *"AI assistants, conversational interfaces, and intelligent agents,"* and discovery infrastructure is becoming *"an intelligent layer"* rather than a standalone search engine.

### Timeline caveat (IMPORTANT — flag for the dossier)
The post is **dated April 14, 2026**, but external reporting confirms this **Series A actually closed February 2024**: a **$12.5M Series A** (led by Lightspeed) that brought total funding to $17.8M. At that time Marqo described itself as a **"vector search company"** selling **RAG + end-user search infrastructure**, with **Redbubble and Temple & Webster** as named customers — *not* "Commerce Superintelligence." So:
- The 2026-dated "funding news" is **re-published/re-skinned positioning**, not a new raise.
- It documents a **major repositioning**: open-source vector-DB / RAG infra (2022–2024) → enterprise ecommerce "Commerce Superintelligence" SaaS (2026). The same $17.8M, two completely different stories.
- Note also a sourcing wrinkle: at least one outlet reported the round as "$19.3 million" — figures vary across press, reinforcing that funding numbers here are positioning artifacts, not audited.

*Sources for this caveat: thesaasnews.com, finsmes.com, globenewswire (GlobeNewswire 2024-02-13), itbrief.com.au — all from the external search, not Marqo's own 2026 post.*

---

## 8. Defensible vs. marketing claims (audit ledger)

**Defensible / verifiable**
- GCL is a real, open-source contrastive-learning framework (`marqo-ai/GCL`).
- Marqo publishes genuine, widely-used ecommerce/fashion embedding models on Hugging Face (fashionCLIP, fashionSigLIP, ecommerce-embeddings-B/L).
- Founders, founding year, lead investor (Lightspeed), and ~$17.8M total funding are externally corroborated.
- The cold-start critique of behavioral ranking is technically sound and a real failure mode.
- The "keyword ceiling" argument (rerankers capped by candidate-set recall) is a legitimate architectural point.

**Marketing / unverified (flag)**
- **"Commerce Superintelligence"** and its **six "architectural requirements" with "verifiable tests"** — a vendor-authored spec whose tests are gerrymandered so that only Marqo's architecture passes (e.g., Req. 5 "remove all merchandising rules and it still prefers high margin" defines out any rules-based or filter-based competitor by fiat). The word "superintelligence" is borrowed AGI hype applied to product ranking.
- **"73–78% relevance improvement vs generic models across 4M+ products"** — no metric, baseline, or methodology.
- **"World's most popular ecommerce embedding model," "4.8M monthly downloads," "hundreds of millions of products"** — superlatives / scale claims, not audited here.
- **"10–30% conversion lift," "15–30% monthly revenue lost to poor search," "zero-results drop by more than half"** — uncited aggregates.
- **"No hallucinations. No phantom products."** (Sibbi) — an absolute guarantee no grounded LLM system can truthfully make; marketing absolute.
- **Architecture opacity**: "the model does retrieval and ranking" is asserted with no index/ANN/fusion/filtering detail. The "AI is the stack, no keyword ceiling" framing also *omits* that the open-source engine itself supports lexical/hybrid search — a convenient simplification.
- **"Results in 14 days, not months"** — best-case (SwimOutlet, 5 days) generalized to a headline promise.

---

## 9. Relevance to samesake — adopt / avoid / differentiate

**Shared thesis (validating)**: Marqo's entire wedge — *understand the product first, don't depend on click history, the long tail (70–80% of catalog) is where behavioral systems fail, multimodal/visual understanding must flow into text search* — is **the same bet samesake is making** for visual/fashion commerce. A well-funded, Lightspeed-backed company building the exact category narrative is strong market validation that "product-native, multimodal, cold-start-proof" is a real buyer need.

**Where samesake should DIFFERENTIATE (its structural advantages vs. Marqo):**
- **Deployment model**: Marqo = hosted black-box SaaS, your catalog and behavior trained into *their* per-tenant model on *their* infra. samesake = **runs in the user's own app, two containers (Postgres + app), BYO embeddings, no hosted vector DB**. This is the sharpest contrast: data residency, no vendor lock-in of your trained model, no per-tenant model you can't inspect.
- **Auditability**: samesake's **`/search/explain`** and **typed compiler** directly answer the trust gap Marqo's "no hallucinations, trust us" framing papers over. Marqo offers *zero* explainability surface in any of these posts. samesake should weaponize "explainable, hard-filter-gated, deterministic" against Marqo's "the model decided."
- **Hard filters / correctness**: Marqo *attacks* rules ("merchandising rules applied after ranking," "fighting the algorithm") and wants margin/inventory **in the model objective**. samesake compiles `price<=X`, `available=true` to **SQL predicates that gate before ranking** — provably correct, never "the model deprioritized your out-of-stock item." Position this as *correctness vs. vibes*: hard business constraints must be guaranteed, not learned probabilistically. (Marqo's own Req. 5 is the weakest, least-credible of the six.)
- **Agentic surface boundary**: Marqo's "full-journey continuity" / Sibbi extends into cart, checkout, returns, order tracking. samesake's **findProducts() deliberately stops at retrieval with verification/grounding/why**. Frame this as *do one layer excellently and stay composable*, vs. Marqo's monolith. Marqo's post-purchase scope is also a heavier integration/lock-in burden for the buyer.
- **BYO models vs. mandatory per-tenant fine-tune**: Marqo forces a per-retailer trained model (their pipeline, their IP). samesake's **BYO embedding + generation** lets teams use/swap their own models. For buyers wary of training their catalog into a vendor's weights, this is a real lever.

**What samesake should ADOPT / borrow:**
- **Vocabulary discipline**: Marqo's coined, repeated lexicon (cold-start, long-tail %, "keyword ceiling," "product-native") is *effective*. samesake should crisply name its own primitives (RRF fusion, hard/soft filters, typed spaces, grounded findProducts) and repeat them.
- **The cold-start / long-tail stat** as a buyer-education hook — but cite it properly (Marqo doesn't).
- **The buyer-checklist play** (§6.6): publishing "questions to ask an AI search vendor" is a great displacement asset. samesake could publish one whose answers favor *in-app, auditable, BYO, hard-filter-correct* — exactly the axes Marqo can't win.
- **Benchmark transparency as a differentiator**: Marqo's "73–78%" is uncited. samesake already has **published, reproducible eval discipline** (mean grade@10 ~2.33, P@5 0.83, ~5k-doc LK fashion corpus, "spaces" off because it didn't pass the eval gate). *Publishing methodology + honest negative results* (spaces failing the gate) is a credibility moat Marqo conspicuously lacks. Lean into it.

**What to AVOID:**
- Don't adopt "superintelligence"-grade hype or absolute guarantees ("no hallucinations"). samesake's honest, eval-gated posture is the opposite brand and a stronger one for technical buyers.
- Don't try to match Marqo's full-journey scope (post-purchase, returns, order tracking) — that's a different (CX/agent) product and dilutes the retrieval-compiler focus.
- Don't get drawn into Marqo's "rules are bad / model objective is good" frame — samesake's hard-filter gating is a *feature*, not the "legacy" weakness Marqo paints it as.

---

## 10. Open questions / follow-ups
- What ANN + index does the hosted platform actually run (Vespa? HNSW? the OSS `marqo` engine internals)? The marketing pages never say; the OSS repo / docs would.
- Is the 2026 platform still built on the open-source `marqo` engine, or a separate closed stack? (The narrative "models → platform" implies a rebuild.)
- Methodology behind "73–78% relevance" — which metric (nDCG? P@k?), which "generic" baseline, which 4M-product corpus?
- Pricing / contract model for the enterprise platform (not disclosed in any post).
- How "dedicated per-retailer model" handles multi-tenant cost at scale, and whether it's truly a fine-tune per retailer or a shared backbone + adapters.
- Independent verification of the customer A/B results (Fashion Nova $130M, etc.) — all are vendor-reported.

---

## Sources

**Marqo (primary, scraped 2026-06-14):**
- https://www.marqo.ai/blog/what-is-marqo
- https://www.marqo.ai/blog/marqo-an-introduction (redirects → what-is-marqo)
- https://www.marqo.ai/blog/what-is-ai-native-ecommerce-search
- https://www.marqo.ai/blog/what-makes-a-search-platform-truly-ai-native
- https://www.marqo.ai/blog/commerce-superintelligence
- https://www.marqo.ai/blog/what-is-commerce-superintelligence (redirects → commerce-superintelligence)
- https://www.marqo.ai/blog/ai-native-vs-behavioral-ranking-the-future-of-ecommerce-product-discovery
- https://www.marqo.ai/blog/legacy-ecommerce-search-is-dead-and-its-costing-you-sales
- https://www.marqo.ai/blog/marqo-raises-seriesa-to-accelerate-ai-product-discovery
- https://www.marqo.ai/blog/what-does-dedicated-llm-mean
- https://www.marqo.ai/blog/getting-started-with-marqo

**External corroboration (funding timeline & models):**
- https://www.thesaasnews.com/news/marqo-closes-12-5-million-in-series-a
- https://www.finsmes.com/2024/02/marqo-raises-12-5m-in-series-a-funding.html
- https://www.globenewswire.com/news-release/2024/02/13/2828211/0/en/Marqo-Raises-12-5M-to-Make-AI-powered-Vector-Search-Seamless.html
- https://itbrief.com.au/story/australian-ai-startup-marqo-secures-12-5m-in-funding
- https://huggingface.co/Marqo/marqo-fashionCLIP
- https://huggingface.co/Marqo/marqo-fashionSigLIP
- https://huggingface.co/collections/Marqo/generalised-contrastive-learning-66b9446dea6dc68db8dc0c2e
- https://github.com/marqo-ai/GCL
