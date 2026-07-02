# Commercial Ecommerce Search & Discovery Platforms — Prior-Art Survey (2025–2026)

> Prior-art dossier for **samesake** — a TypeScript-first "search engine compiler" for visual commerce that compiles a typed catalog declaration into a Postgres + pgvector hybrid search layer running **inside the customer's own app** (Postgres + app container; no Redis / Elasticsearch / hosted vector DB). Retrieval = Postgres FTS + cosine ANN over BYO embeddings + optional typed "spaces" vectors, fused via RRF; hard filters compile to SQL predicates that gate before ranking; soft filters relax. Surfaces: constrained-schema NLQ parser, multimodal enrich pipeline, entity-resolution/dedup, `/search/explain` auditability, and `findProducts()` agentic surface that **deliberately stops at retrieval** (cart/checkout downstream). BYO embedding + generation models.
>
> This document surveys the commercial platforms samesake is implicitly competing with or differentiating from. **PROVEN vs MARKETED** is flagged throughout: vendor blog/press claims are marketing unless tied to a doc, pricing page, or independent benchmark.

Last updated: 2026-06-14.

---

## 0. Executive market read

Three structural facts dominate the 2025–2026 commercial landscape, and all three define the gap samesake targets:

1. **The entire commercial market is hosted SaaS.** Every platform below — Constructor, Algolia, Bloomreach, Coveo, Lucidworks, Athos (Klevu+Searchspring), Nosto, Kibo, Crownpeak/Attraqt, Google Vertex, Elastic Cloud — ingests the customer's catalog into the vendor's cloud and serves queries from there. Even Elastic, the most "ownable" option, pushes Elastic Cloud and a managed-inference posture. **None compiles search that runs in the customer's own two-container app over their own Postgres.** This is samesake's single sharpest differentiator.

2. **2025 was the year "agentic" became table stakes marketing — but the substance splits two ways.** (a) *Onsite conversational agents* (Bloomreach Clarity/Loomi, Google Conversational Commerce agent, Athos Conversational Assistant, Nosto Huginn, Coveo RGA, Constructor ASA) — a chat box over the vendor's retrieval. (b) *Offsite agentic distribution* — getting the catalog discoverable inside ChatGPT/Perplexity via the **Agentic Commerce Protocol (ACP)** and MCP. Almost every vendor now claims both. Very little of the agentic layer is independently benchmarked; it is overwhelmingly **MARKETED**.

3. **Consolidation is heavy.** Klevu + Searchspring + Intelligent Reach → **Athos Commerce** (Jan 2025). Crownpeak owns Attraqt/Fredhopper (2022). Kibo spun out its personalization (Monetate/Certona) in 2022 and now sells search only as an add-on. **Reflektion** has effectively disappeared as a standalone brand. The mid-market is collapsing into a few suites.

**The gap samesake targets:** a *developer-owned, in-app, typed, auditable* retrieval layer — the opposite of the "ingest your catalog into our cloud, trust our black-box relevance" model that every incumbent sells. samesake is closer to "Prisma/Drizzle for commerce search" than to "Algolia."

---

## 1. Constructor (constructor.com)

**Positioning.** Enterprise-only AI product discovery: search, browse, recommendations, autosuggest, collections — explicitly optimized for a business KPI (revenue/conversion) rather than text relevance. Markets itself as "the only product discovery and search tool built specifically for enterprise eCommerce" ([softwarefinder](https://softwarefinder.com/construction/constructor)). Deployed on AWS; JavaScript API-first.

**AI / agentic (2025–2026).**
- **AI Shopping Agent (ASA)** and **AI Product Insights Agent (PIA)** — conversational shopping + content/answer surfaces.
- **Merchant Intelligence Agent (MIA)** announced 24 Mar 2026 — a *merchandiser-facing* conversational agent: ask natural-language questions about *why* products surface, investigate campaign performance, get merchandising recommendations ([PRNewswire](https://www.prnewswire.com/news-releases/constructor-unveils-merchant-intelligence-agent-mia-bringing-instant-insight-and-faster-action-to-ecommerce-merchandising-302723004.html)). This is notable: it is an *explainability/audit* surface, conceptually adjacent to samesake's `/search/explain` — but aimed at merchandisers, hosted, and conversational rather than a deterministic audit trail.
- Pushing into **offsite channels** — ChatGPT and other conversational platforms — and ASA listed in the **AWS Marketplace AI Agents & Tools** category ([PRNewswire](https://www.prnewswire.com/news-releases/constructors-ai-shopping-agent-now-available-in-new-aws-marketplace-ai-agents-and-tools-category-302514543.html)).
- Recognized as a Leader in the **2025 Gartner MQ for Search and Product Discovery**, **Forrester Wave Q3 2025**, and **IDC MarketScape GenAI Product Discovery 2025–2026**.

**Deployment.** Hosted SaaS on AWS. API/JS integration.

**Pricing.** Custom-quoted only; no free tier ([G2](https://www.g2.com/products/constructor-io-constructor/pricing), [saasworthy](https://www.saasworthy.com/product/constructor-io/pricing)). Enterprise contract.

**PROVEN vs MARKETED.** Analyst-leader placements are real third-party signals (though analyst reports are pay-to-play in part). 82% FY26 customer growth and "322 billion shopping interactions" are self-reported ([Yahoo Finance](https://finance.yahoo.com/news/constructor-reports-82-customer-growth-121500415.html)) — MARKETED. The KPI-optimization (rank to conversion not relevance) is a genuine architectural stance, PROVEN by their product design.

---

## 2. Algolia (algolia.com)

**Positioning.** Developer-first hosted search API; the canonical "fast typo-tolerant site search" that moved up-market into AI. Now brands itself "The AI search and retrieval platform — Agentic | Generative | Search" ([algolia.com](https://www.algolia.com/)). MACH-certified, headless.

**AI / agentic (2025–2026).**
- **NeuralSearch** — single-API hybrid combining keyword + vector via "neural hashing," marketed as "the world's fastest, hyper-scalable, and cost-effective vector and keyword search API" ([Algolia news](https://www.algolia.com/about/news/algolia-launches-ai-powered-algolia-neuralsearchtm-the-world-s-fastest-hyper-scalable-and-cost-effective-vector-and-keyword-search-api)). Architecturally the closest mainstream analog to samesake's FTS+ANN hybrid — but proprietary and hosted, fusion details undisclosed.
- **Agent Studio + MCP Server** — positions Algolia as "the critical retrieval layer for the next generation of AI agents"; Agent Studio is a RAG feature for agent-driven business tasks.
- **Agentic search commerce** — sell products through third-party agentic sites (Perplexity, ChatGPT).
- **Generative Shopping Experiences** — dynamic buying guides generated on the fly.

**Deployment.** Hosted SaaS, API-first, ~2–4 week typical deployment ([netguru](https://www.netguru.com/blog/bloomreach-vs-algolia-vs-elasticsearch)). No self-hosted/in-app option.

**Pricing (PROVEN — published).** Usage-based and unusually transparent for this market:
- **Grow:** 10,000 search requests/mo included; **$0.50 per 1,000** additional; 100,000 records included; **$0.40 per 1,000** additional records.
- **Grow Plus** (added Oct 2 2025): same 10K included but **$1.75 per 1,000** additional requests; adds AI Synonyms, AI Ranking, Advanced Personalization, Query Categorization, Collections, 90-day analytics.
- **Premium / Elevate:** custom; enterprise (Elevate) annual commitments reported ~$50K/yr+.
([Algolia pricing news](https://www.algolia.com/about/news/algolia-expands-pricing-plans-to-bring-ai-search-capabilities-to-every-developer), [bigsur.ai](https://bigsur.ai/blog/algolia-pricing), [meilisearch](https://www.meilisearch.com/blog/algolia-pricing))

**PROVEN vs MARKETED.** Pricing and the existence of NeuralSearch/Agent Studio/MCP are PROVEN. "World's fastest" is MARKETED. Relevance quality vs competitors is not independently benchmarked here.

---

## 3. Bloomreach Discovery (bloomreach.com)

**Positioning.** "The agentic platform for personalization, powering autonomous search, conversational shopping, and autonomous marketing." Combines Discovery (search/merch) + Engagement (CDP/marketing) under one **Loomi AI** brand.

**AI / agentic (2025–2026).** Among the most aggressive agentic pivots:
- **Clarity** — conversational shopping agent, live on sites since 2024, now GA. Bloomreach reports early-access customers saw **avg +9% conversion, +20% AOV**; retail group TFG **+35.2% conversion** on Black Friday ([Bloomreach news](https://www.bloomreach.com/en/news/2025/bloomreach-delivers-consequential-impact-with-its-fast-growing-ai-shopping-agent-clarity/), [BusinessWire](https://www.businesswire.com/news/home/20250325044424/en/Bloomreach-Delivers-Consequential-Impact-With-Its-Fast-Growing-AI-Shopping-Agent-Clarity)).
- **Loomi Conversational Agent** — "acts like a top-performing store associate," with **Embedded Conversations** bringing chat directly onto PDPs/PLPs; explicitly grounded: "doesn't guess — it pulls directly from real-time personalization data, product catalog, and strict merchandising rules" ([Loomi product page](https://www.bloomreach.com/en/products/loomi-conversational-agent)). The grounding-to-catalog stance parallels samesake's verification/grounding intent — but hosted and black-box.

**Deployment.** Enterprise-only, **hosted SaaS, no self-hosted option** ([netguru](https://www.netguru.com/blog/bloomreach-vs-algolia-vs-elasticsearch)). Typical implementation 3–6 months; Loomi setup +4–8 weeks ([checkthat.ai](https://checkthat.ai/brands/bloomreach/pricing)).

**Pricing.** No published numbers; custom enterprise ([checkthat.ai](https://checkthat.ai/brands/bloomreach/pricing)).

**PROVEN vs MARKETED.** Clarity/Loomi existence and GA = PROVEN. The +9%/+20%/+35.2% lift figures are vendor-reported from early-access customers, not independent — MARKETED (directionally credible, not audited).

---

## 4. Coveo (coveo.com)

**Positioning.** Enterprise AI-Relevance platform spanning ecommerce, workplace, service, and website search. Public company (NYSE/TSX: CVO). Leans on RAG/generative answering across all verticals.

**AI / agentic (2025–2026).**
- **Relevance Generative Answering (RGA / CRGA)** — RAG over the customer's catalog + content using OpenAI GPT, with **source citations** for every generated answer ([velir](https://www.velir.com/ideas/2025/01/24/coveos-relevance-generative-answering-turns-search-into-a-conversation)). The cited-source grounding is conceptually aligned with samesake's "why/grounding" outputs.
- Markets "personalized, scalable, and **agentic** experiences."
- **Leader in 2025 Gartner MQ for Search and Product Discovery** (2nd consecutive year) ([Coveo IR](https://ir.coveo.com/en/news-events/press-releases/detail/440/coveo-named-a-leader-in-the-2025-gartner-magic)).
- Available via **AWS Marketplace** ([AWS](https://aws.amazon.com/marketplace/pp/prodview-fvsorznffpqc2)).

**Deployment.** Hosted SaaS (multi-tenant cloud), API + connectors.

**Pricing.** Custom enterprise; not published.

**PROVEN vs MARKETED.** RGA with citations is PROVEN (documented, GPT-backed RAG). Gartner leadership PROVEN. Revenue/lift claims in press releases = MARKETED.

---

## 5. Lucidworks (Fusion / Springboard) (lucidworks.com)

**Positioning.** Solr/Lucene-rooted enterprise search vendor (Fusion = on-prem/cloud platform). 2025 pivot to a SaaS platform, **Springboard**, plus a heavy "agentic readiness" thought-leadership push (annual State of GenAI benchmark).

**AI / agentic (2025–2026).**
- **Springboard** SaaS; first GA app **Connected Search** (search + insight engine, push-button AI, guided workflows) ([TechTarget](https://www.techtarget.com/searchenterpriseai/news/252511951/Lucidworks-releases-AI-powered-search-platform)).
- **AI App Studio** — no-code AI agent builder (June 2025); **AI Agents** that "dynamically guide users... with natural, adaptive dialogue," combining generative answers with **verifiable references** ([Lucidworks AI Agents](https://lucidworks.com/platform/ai-agents)).
- **Data Enrichment** — multimodal generative AI that analyzes product images + text to auto-generate **categories, keywords, synonyms, richer descriptions at scale** ([CMSWire](https://www.cmswire.com/digital-experience/lucidworks-adds-ai-data-enrichment-to-ecommerce-platform/)). This is the closest commercial analog to samesake's **multimodal enrich pipeline** — same goal (turn images into searchable structured attributes), but hosted/managed vs samesake's in-pipeline BYO-model enrichment.
- **Commerce Studio + Analytics Studio** (Feb 2025).

**Deployment.** Fusion: deployable on-prem or in customer cloud (the most "ownable" of the suite vendors historically). Springboard: hosted SaaS.

**Pricing.** Custom enterprise; Fusion historically license + infra.

**PROVEN vs MARKETED.** Data Enrichment and AI App Studio are PROVEN (shipped, documented). The "agentic readiness" survey content is MARKETED thought leadership. Fusion's on-prem deployability is PROVEN and the nearest thing to "ownable" — but it is full Solr ops, not a compiled Postgres layer.

---

## 6. Klevu / Searchspring → **Athos Commerce** (athoscommerce.com)

**Positioning.** **Major consolidation event:** Klevu + Searchspring + Intelligent Reach merged into **Athos Commerce** (announced Jan 2025) ([BusinessWire](https://www.businesswire.com/news/home/20250113743474/en/Klevu-Joins-Forces-with-Searchspring-to-form-Athos-Commerce-Creating-a-Leading-Comprehensive-Global-AI-Backed-Ecommerce-Optimization-Platform)). Mid-market/Shopify-heavy AI search, personalization, merchandising, product-feed management.

**AI / agentic (2025–2026).** **Intelligent Discovery Platform** (launched 2026) explicitly "built for the emerging era of agentic commerce," combining search, personalization, merchandising, feed mgmt, and **Generative Engine Optimization (GEO)** ([Yahoo Finance](https://finance.yahoo.com/sectors/technology/articles/athos-commerce-unveils-intelligent-discovery-130000074.html)). Three new agents:
- **Conversational Assistant** — onsite conversational discovery.
- **GEO Assistant** — optimize product visibility across AI answer engines / conversational commerce platforms (i.e., get found inside ChatGPT/Perplexity).
- **Channel Assistant** — cross-channel/offsite.

Klevu's legacy strengths: NLP intent understanding beyond keywords, behavior-learning ranking, recommendations, dynamic facet generation ([businesswire](https://www.businesswire.com/news/home/20250113743474/en/)).

**Deployment.** Hosted SaaS; deep Shopify app ecosystem.

**Pricing.** Tiered SaaS (Klevu historically had published-ish mid-market tiers); Athos now custom for the unified platform.

**PROVEN vs MARKETED.** The merger and the three agents' existence are PROVEN. "Built for agentic commerce" / GEO efficacy = MARKETED (GEO is a new, largely unmeasured category). **GEO is a strategically important concept for samesake to track** (see §13) even though samesake stops at retrieval.

---

## 7. Nosto (nosto.com)

**Positioning.** AI-powered **Commerce Experience Platform (CXP)** — personalization, product discovery/search (via 2022 SearchNode acquisition), merchandising, content. Shopify-Plus-heavy; 1,500+ brands incl. Kylie Cosmetics, Marc Jacobs, New Era — i.e., **fashion/beauty-forward**, directly adjacent to samesake's visual-commerce/fashion target.

**AI / agentic (2025–2026).**
- **Huginn** (Oct 2025) — "always-on AI commerce agent orchestrating a network of purpose-built agents"; continuously scans commerce data to surface opportunities (high-value segments, bundles, "smarter search terms") ([Nosto blog](https://www.nosto.com/blog/agentic-ai-commerce/)). This is a *merchant-ops* orchestration agent, like Constructor's MIA.
- Powered by **experience.AI**; advancing "conversational experiences and agentic assistants that adapt to individual customer profiles."
- Dedicated **Agentic Commerce** positioning page ([Nosto](https://www.nosto.com/agentic-commerce/)).

**Deployment.** Hosted SaaS; Shopify/headless integrations.

**Pricing.** Custom; not published.

**PROVEN vs MARKETED.** Huginn launch PROVEN. Agentic orchestration efficacy MARKETED. Relevant to samesake because Nosto owns the **fashion/beauty visual-commerce mindshare** samesake targets — but Nosto is a full hosted suite, not a developer retrieval primitive.

---

## 8. Reflektion / Kibo (kibocommerce.com)

**Positioning.** **Reflektion has effectively vanished as a standalone brand** — no current independent product presence surfaced; references are historical. **Kibo** is a unified commerce / OMS platform (B2B + B2C). Kibo spun out its personalization business (the old Monetate/Certona assets) to Centre Lane Partners in **Oct 2022**, rebranded **Monetate**, to refocus on core commerce/OMS ([BusinessWire](https://www.businesswire.com/news/home/20221028005037/en/Kibo-Spins-Out-Personalization-Business-Under-the-Monetate-Brand)).

**AI / agentic (2025–2026).** Kibo now sells search as an **AI Search add-on** (semantic search interpreting natural language, prioritizing in-stock relevant products) rather than a flagship discovery suite ([Kibo](https://kibocommerce.com/)). Some "agentic AI" positioning around the broader commerce/OMS platform ([noibu](https://www.noibu.com/blog/kibo-commerce-agentic-ai-ecommerce)).

**Deployment.** Hosted/composable SaaS (MACH).

**Pricing.** Custom enterprise.

**PROVEN vs MARKETED.** Kibo as OMS-first with search-as-add-on = PROVEN by their own positioning. Reflektion's disappearance is a notable consolidation signal. Kibo is the **weakest** pure-search competitor of the set — search is no longer its center of gravity.

---

## 9. Attraqt / Crownpeak / Fredhopper (crownpeak.com)

**Positioning.** **Crownpeak** (DXP) acquired **Attraqt** in 2022; Attraqt had earlier rolled up **Fredhopper** (2017), Early Birds, Aleph. The product line is **Fredhopper Product Discovery** — enterprise AI search, recommendations, visual merchandising; strong in **European fashion & beauty**.

**AI / agentic (2025–2026).**
- **Fredhopper Product Discovery Shopify App** — "enterprise-grade AI search, personalized recommendations, and visual merchandising, natively and without middleware" ([PRNewswire](https://www.prnewswire.com/news-releases/enterprise-merchandising-now-native-on-shopify-302526635.html)).
- **Conversational search** as an AI feature; claims merchandising automation "by 60%" ([hamari](https://hamari.agency/search/crownpeak-attraqt-fredhopper-and-xo/)).
- 2025 thought-leadership report "The State of Product Discovery in Digital Commerce 2025" (survey of 200+ retailers) ([Crownpeak](https://www.crownpeak.com/fredhopper/resources/discover/ebooks/the-state-of-product-discovery-in-digital-commerce-2025.html)).
- commercetools marketplace integration ([commercetools](https://marketplace.commercetools.com/integration/attraqt-fredhopper-discovery-platform)).

**Deployment.** Hosted SaaS; commercetools/Shopify/DXP integrations.

**Pricing.** Custom enterprise.

**PROVEN vs MARKETED.** Shopify app + conversational search = PROVEN. "60% automation" and lift claims = MARKETED. Relevant: fashion/beauty visual-merch focus overlaps samesake's domain, but again a hosted suite.

---

## 10. Google Vertex AI Search for commerce / "AI Commerce Search" (cloud.google.com/retail)

**Positioning.** Google's managed retail search + recommendations, powered by Google's query/contextual understanding and Gemini. Rebranding toward "AI Commerce Search in Gemini Enterprise."

**AI / agentic (2025–2026).** The most concrete agentic doc trail of the set:
- **Conversational Commerce agent** — GA announced 10 Sep 2025. Quote (PROVEN, doc): *"designed to engage shoppers in natural, human-like conversations to guide them from initial intent to a completed purchase."* It is explicitly **"built to sell"** with an **intent classifier** that routes simple queries to traditional search and complex/ambiguous ones to conversational flow; uses **Gemini** to suggest catalog products, answer product questions, even give store hours; **retains context across sessions/devices**; and gives merchants control to **boost/bury/restrict** products in conversation ([Google Cloud blog](https://cloud.google.com/blog/products/ai-machine-learning/introducing-conversational-commerce-agent-on-vertex-ai)).
  - **Contrast with samesake:** Google's agent goes **all the way to purchase** ("guide them... to a completed purchase"). samesake's `findProducts()` **deliberately stops at retrieval**. Different philosophy: Google bundles conversion; samesake exposes grounded retrieval and leaves checkout downstream.
- Marquee customer **Albertsons** ("Ask AI"): *"more than 85% of conversations started with open-ended or exploratory questions"* — a real signal that NL/exploratory query share is high ([Google Cloud blog](https://cloud.google.com/blog/products/ai-machine-learning/introducing-conversational-commerce-agent-on-vertex-ai)).
- **Gen AI Catalog & Content Enrichment** via Gemini 1.5 Pro/Flash + Imagen 3 — multimodal catalog enrichment (parallels samesake's enrich pipeline).
- Coming soon: image/video search, in-store locate.
- **Leader in 2025 Gartner MQ for Search and Product Discovery** (June 24 2025).

**Deployment.** Fully managed GCP service; API. Not in-app/ownable.

**Pricing (PROVEN — published, the most transparent enterprise option).**
- **Search & browse queries: $2.50 per 1,000 requests.**
- **Conversational product filtering: $6.00 per 1,000 requests** (an initial intent classifier decides conversational vs product-search; conversational costs 2.4× a normal query).
- **Recommendations predictions:** tiered — **$0.27/1,000** (first 20M), **$0.18/1,000** (next 280M), **$0.10/1,000** (after 300M).
- **Training/tuning:** $2.50 per node-hour. No charge for catalog/event import or the pretrained Recommendations LLM. $600 free recommendations credits.
([Google Cloud pricing](https://cloud.google.com/retail/pricing))

**PROVEN vs MARKETED.** Pricing, the conversational agent's mechanics, and the intent-classifier routing are PROVEN (docs + pricing page). The Albertsons "85% open-ended" and "add one or more items" stats are vendor-reported customer outcomes = MARKETED but specific.

---

## 11. Elastic / Elasticsearch (elastic.co)

**Positioning.** General-purpose search/observability/security platform; the most *infrastructure-like* and most *ownable* option. ESRE/ELSER bring semantic search; Elastic positions as "the best memory for AI agents."

**AI / agentic (2025–2026).**
- **ESRE (Elasticsearch Relevance Engine)** — toolkit for AI search: out-of-the-box semantic search, hybrid (lexical + dense + sparse), LLM integration, BYO transformer models ([Elastic ESRE](https://www.elastic.co/elasticsearch/elasticsearch-relevance-engine)).
- **ELSER** — Elastic's pretrained sparse encoder (English), zero domain-adaptation semantic retrieval ([Elastic docs](https://www.elastic.co/docs/solutions/search/semantic-search/semantic-search-elser-ingest-pipelines)).
- Positions ESRE/ELSER as the **retrieval/RAG/grounding substrate for agentic workflows** rather than shipping a packaged commerce agent. **Leader in IDC MarketScape: Worldwide General-Purpose Knowledge Discovery 2025** ([Elastic blog](https://www.elastic.co/blog/elasticsearch-idc-marketscape-leader-2025)).
- Official ecommerce hybrid (dense+sparse) reference notebooks ([elasticsearch-labs](https://github.com/elastic/elasticsearch-labs)).

**Deployment.** Self-managed (on-prem / own cloud) **or** Elastic Cloud (managed). The **most ownable** of all platforms here — but it is *its own datastore and cluster ops*, not a layer over the customer's existing Postgres. This is the key contrast with samesake: Elastic = "run our search cluster"; samesake = "compile search into the Postgres you already run."

**Pricing.** Open-source core (free, self-managed) + paid tiers/Elastic Cloud (resource-based). The only platform with a genuinely free/self-host path.

**PROVEN vs MARKETED.** ESRE/ELSER/hybrid are PROVEN (docs, code, models). "Best memory for AI agents" is MARKETED (and the linked source is a community dev.to post, not Elastic). Elastic ships *primitives*, not a commerce agent — closest in *philosophy* to samesake (BYO models, hybrid, ownable) but at a totally different altitude (general infra vs typed commerce compiler).

---

## 12. Cross-cutting: Agentic Commerce Protocol (ACP) & MCP — the offsite frontier

The whole field is converging on a shared standard for *offsite* agentic commerce:

- **ACP (Agentic Commerce Protocol)** — open standard maintained by **OpenAI + Stripe** (Meta involved); **live since Sep 2025** powering **Instant Checkout in ChatGPT** ([Stripe newsroom](https://stripe.com/newsroom/news/stripe-openai-instant-checkout), [OpenAI](https://developers.openai.com/commerce), [ACP GitHub](https://github.com/agentic-commerce-protocol/agentic-commerce-protocol)). Components: **product feed + checkout API + payment integration**; merchants push a gzip-compressed feed to an OpenAI endpoint ([Stripe docs](https://docs.stripe.com/agentic-commerce/acp)). Salesforce and commercetools announced ACP support (Oct 2025).
- **MCP (Model Context Protocol)** — Anthropic's standard for agents to access enterprise systems/tools; Algolia, Stripe and others ship MCP servers.

**Why this matters for samesake.** ACP is the *checkout/transaction* layer — exactly the part samesake **deliberately excludes** (`findProducts()` stops at retrieval). The samesake-shaped opportunity is the **discovery/retrieval feed that an agent calls *before* ACP takes over checkout**: a grounded, typed, verifiable "find products" surface (optionally exposed via MCP) that hands off to ACP for the buy. samesake's stop-at-retrieval boundary is **architecturally compatible with**, not competitive with, ACP.

---

## 13. Comparison table

| Platform | Positioning | Deployment | Agentic/conversational (2025–26) | Pricing (PROVEN where noted) | Closest to samesake on… |
|---|---|---|---|---|---|
| **Constructor** | Enterprise KPI-optimized discovery | Hosted SaaS (AWS) | ASA (shopper), PIA, **MIA** (merchant explainability), ChatGPT/offsite | Custom only | MIA ≈ explainability surface |
| **Algolia** | Dev-first AI search API | Hosted SaaS | **NeuralSearch** hybrid, **Agent Studio + MCP**, gen shopping guides, sell via Perplexity/ChatGPT | **$0.50–$1.75 / 1K searches; $0.40 / 1K records; Elevate ~$50K/yr+** | Hybrid keyword+vector; dev ergonomics |
| **Bloomreach** | Agentic personalization suite | Hosted SaaS only | **Clarity** + **Loomi Conversational** (embedded on PDP/PLP), catalog/rule-grounded | Custom only | Catalog-grounded conversation |
| **Coveo** | Enterprise AI-Relevance + RAG | Hosted SaaS | **RGA** (GPT RAG w/ **source citations**), agentic exp. | Custom only | Cited grounding |
| **Lucidworks** | Solr-rooted enterprise search → SaaS | Fusion on-prem/own-cloud **or** Springboard SaaS | **AI App Studio** (no-code agents), **Data Enrichment** (multimodal), Connected Search | Custom only | **Multimodal enrich**; ownable (Fusion) |
| **Athos** (Klevu+Searchspring) | Mid-market/Shopify discovery suite | Hosted SaaS | **Conversational / GEO / Channel** agents; **GEO** | Tiered → custom | GEO (offsite discovery) |
| **Nosto** | Fashion/beauty CXP | Hosted SaaS | **Huginn** (merchant-ops agent), conversational assistants | Custom only | Fashion/visual domain |
| **Kibo** (Reflektion gone) | Unified commerce/OMS; search add-on | Hosted/composable SaaS | Semantic search add-on; some agentic OMS | Custom only | Weakest search competitor |
| **Crownpeak/Attraqt/Fredhopper** | EU fashion/beauty discovery | Hosted SaaS | Conversational search; merch automation | Custom only | Fashion/visual merch domain |
| **Google Vertex (AI Commerce Search)** | Managed retail search + recs (Gemini) | Managed GCP | **Conversational Commerce agent** (intent-classifier routing, → purchase), Gemini/Imagen enrich | **$2.50/1K search; $6.00/1K conversational; recs $0.10–0.27/1K** | Intent routing; enrich; transparent pricing |
| **Elastic** | General search infra; ESRE/ELSER | **Self-managed or Elastic Cloud** | Retrieval/RAG substrate for agents (not a packaged commerce agent) | **OSS free + paid tiers** | **Ownable, hybrid, BYO models** (but own cluster) |
| **samesake** | Typed commerce **search compiler** | **In customer's app: Postgres + app container; no Redis/ES/vector DB** | `findProducts()` **stops at retrieval**; NLQ parser; `/search/explain`; enrich; ER/dedup | (n/a — framework, BYO models) | — |

---

## 14. Verdict — the market gap samesake targets

**1. Deployment is the whitespace.** Every commercial platform is hosted SaaS that ingests the catalog into the vendor's cloud. The only "ownable" options are **Elastic** (run your own cluster) and **Lucidworks Fusion** (on-prem/own-cloud) — and both are *separate search clusters with their own ops*, not a layer compiled into the **Postgres the team already runs**. **No incumbent ships "search that runs in your two-container app over your own pgvector."** That is samesake's defensible position: zero new datastore, zero data exfiltration, owned infra.

**2. Auditability/typing is undersold by everyone.** The incumbents' relevance is black-box; "explainability" exists only as merchant-facing chat (Constructor MIA, Nosto Huginn) or cited RAG answers (Coveo RGA). **None offers a typed catalog declaration that compiles to inspectable SQL predicates plus a deterministic `/search/explain` of how a result was retrieved and ranked.** samesake's compiler + hard-filter-to-SQL + explain trail is a genuinely differentiated developer/audit story.

**3. Agentic boundary is a deliberate, defensible choice.** The market is racing to bundle conversation *and checkout* (Google: "guide them to a completed purchase"; ACP: checkout in ChatGPT). samesake **stops at retrieval** — which is not a gap but a wedge: be the **grounded, verifiable retrieval surface that feeds agents and ACP checkout**, without owning the storefront. Position `findProducts()` as MCP-exposable retrieval that hands off to ACP.

**4. Where samesake must not pretend to compete.** It is not a merchandising suite, not a CDP, not an onsite chat widget, not analytics dashboards, not offsite GEO distribution. Incumbents (Bloomreach, Nosto, Athos, Crownpeak) win on packaged merchandiser UX and personalization data network effects. samesake should differentiate as **infrastructure for engineers**, not compete as a suite.

**5. Things to adopt / track.**
- **Adopt:** Algolia's *pricing transparency* posture; Coveo/Lucidworks' *cited grounding + verifiable references* (matches samesake's why/grounding); Lucidworks/Google's *multimodal enrich* as a first-class feature (validates samesake's enrich pipeline); Google's *intent-classifier routing* (cheap keyword path vs expensive conversational path — a cost/architecture pattern samesake's NLQ-vs-FTS split mirrors).
- **Differentiate on:** in-app/owned Postgres deployment; typed compiler; deterministic SQL hard-filter gating; `/search/explain`; BYO models; stop-at-retrieval agentic boundary.
- **Track (don't chase yet):** **GEO** (Athos, Algolia, Google) — getting catalogs found inside ChatGPT/Perplexity is the new SEO; ACP/MCP standards — the checkout rail samesake should *feed*, not build.

**6. Honest caveat on samesake's eval numbers.** samesake's reported mean grade@10 ~2.33 / P@5 0.83 on a ~5k-doc LK fashion corpus is **internal and not comparable** to any incumbent — none of the platforms above publishes independent retrieval-quality benchmarks either (all lift claims are vendor-reported conversion/AOV, not P@k). The whole market is **MARKETED on outcomes, not PROVEN on retrieval metrics.** samesake having *any* reproducible relevance benchmark + an eval gate (note: "spaces" currently off because it failed the gate) is, ironically, more rigorous than what the incumbents publish.

---

## Sources

- Constructor MIA — https://www.prnewswire.com/news-releases/constructor-unveils-merchant-intelligence-agent-mia-bringing-instant-insight-and-faster-action-to-ecommerce-merchandising-302723004.html
- Constructor FY26 growth — https://finance.yahoo.com/news/constructor-reports-82-customer-growth-121500415.html
- Constructor ASA on AWS Marketplace — https://www.prnewswire.com/news-releases/constructors-ai-shopping-agent-now-available-in-new-aws-marketplace-ai-agents-and-tools-category-302514543.html
- Constructor product discovery via AI agents — https://constructor.com/blog/enhancing-product-discovery-through-ai-agents
- Constructor pricing — https://www.g2.com/products/constructor-io-constructor/pricing ; https://www.saasworthy.com/product/constructor-io/pricing
- Algolia NeuralSearch launch — https://www.algolia.com/about/news/algolia-launches-ai-powered-algolia-neuralsearchtm-the-world-s-fastest-hyper-scalable-and-cost-effective-vector-and-keyword-search-api
- Algolia pricing expansion (Oct 2 2025) — https://www.algolia.com/about/news/algolia-expands-pricing-plans-to-bring-ai-search-capabilities-to-every-developer ; https://secure.businesswire.com/news/home/20251001837933/en/Algolia-Expands-Pricing-Plans-to-Bring-AI-Search-Capabilities-to-Every-Developer
- Algolia pricing analysis — https://bigsur.ai/blog/algolia-pricing ; https://www.meilisearch.com/blog/algolia-pricing
- Algolia AI / agentic — https://www.algolia.com/products/ai ; https://www.algolia.com/
- Bloomreach Clarity impact — https://www.bloomreach.com/en/news/2025/bloomreach-delivers-consequential-impact-with-its-fast-growing-ai-shopping-agent-clarity/ ; https://www.businesswire.com/news/home/20250325044424/en/Bloomreach-Delivers-Consequential-Impact-With-Its-Fast-Growing-AI-Shopping-Agent-Clarity
- Bloomreach Loomi Conversational Agent — https://www.bloomreach.com/en/products/loomi-conversational-agent
- Coveo RGA — https://www.velir.com/ideas/2025/01/24/coveos-relevance-generative-answering-turns-search-into-a-conversation
- Coveo Gartner Leader 2025 — https://ir.coveo.com/en/news-events/press-releases/detail/440/coveo-named-a-leader-in-the-2025-gartner-magic
- Coveo AWS Marketplace — https://aws.amazon.com/marketplace/pp/prodview-fvsorznffpqc2
- Lucidworks Springboard / Connected Search — https://www.techtarget.com/searchenterpriseai/news/252511951/Lucidworks-releases-AI-powered-search-platform
- Lucidworks AI Agents — https://lucidworks.com/platform/ai-agents
- Lucidworks Data Enrichment — https://www.cmswire.com/digital-experience/lucidworks-adds-ai-data-enrichment-to-ecommerce-platform/
- Athos Commerce formation — https://www.businesswire.com/news/home/20250113743474/en/Klevu-Joins-Forces-with-Searchspring-to-form-Athos-Commerce-Creating-a-Leading-Comprehensive-Global-AI-Backed-Ecommerce-Optimization-Platform
- Athos Intelligent Discovery Platform — https://finance.yahoo.com/sectors/technology/articles/athos-commerce-unveils-intelligent-discovery-130000074.html
- Searchspring → Athos — https://searchspring.com/
- Nosto Huginn — https://www.nosto.com/blog/agentic-ai-commerce/
- Nosto agentic commerce — https://www.nosto.com/agentic-commerce/
- Kibo personalization spin-out (Monetate) — https://www.businesswire.com/news/home/20221028005037/en/Kibo-Spins-Out-Personalization-Business-Under-the-Monetate-Brand
- Kibo agentic AI — https://www.noibu.com/blog/kibo-commerce-agentic-ai-ecommerce
- Crownpeak/Fredhopper Shopify app — https://www.prnewswire.com/news-releases/enterprise-merchandising-now-native-on-shopify-302526635.html
- Crownpeak/Attraqt/Fredhopper overview — https://hamari.agency/search/crownpeak-attraqt-fredhopper-and-xo/
- State of Product Discovery 2025 (Crownpeak) — https://www.crownpeak.com/fredhopper/resources/discover/ebooks/the-state-of-product-discovery-in-digital-commerce-2025.html
- Google Conversational Commerce agent GA — https://cloud.google.com/blog/products/ai-machine-learning/introducing-conversational-commerce-agent-on-vertex-ai
- Google AI Commerce Search pricing — https://cloud.google.com/retail/pricing
- Google retail agentic AI era — https://www.googlecloudpresscorner.com/2025-01-09-Google-Cloud-Unveils-New-Retail-Solutions-for-the-Agentic-AI-Era
- Elastic ESRE — https://www.elastic.co/elasticsearch/elasticsearch-relevance-engine
- Elastic ELSER semantic search — https://www.elastic.co/docs/solutions/search/semantic-search/semantic-search-elser-ingest-pipelines
- Elastic IDC MarketScape Leader 2025 — https://www.elastic.co/blog/elasticsearch-idc-marketscape-leader-2025
- Elastic ecommerce dense+sparse notebook — https://github.com/elastic/elasticsearch-labs/blob/main/supporting-blog-content/lexical-and-semantic-search-with-elasticsearch/ecommerce_dense_sparse_project.ipynb
- ACP (OpenAI/Stripe) GitHub — https://github.com/agentic-commerce-protocol/agentic-commerce-protocol
- Stripe Instant Checkout + ACP — https://stripe.com/newsroom/news/stripe-openai-instant-checkout
- Stripe ACP docs — https://docs.stripe.com/agentic-commerce/acp
- OpenAI commerce — https://developers.openai.com/commerce
- Salesforce ACP support — https://www.salesforce.com/news/press-releases/2025/10/14/stripe-openai-agentic-commerce-protocol-announcement/
- Bloomreach vs Algolia vs Elasticsearch deployment/pricing — https://www.netguru.com/blog/bloomreach-vs-algolia-vs-elasticsearch
- Bloomreach pricing/implementation — https://checkthat.ai/brands/bloomreach/pricing
