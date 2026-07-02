# YC Agentic-Commerce Segment: Channel3, Kinect, Wildcard

Competitive deep-dive for the **samesake** search-engine-compiler positioning. Profiled 2026-06-14.

samesake is a TypeScript-first "search engine compiler" for visual commerce: it compiles a typed catalog declaration into a Postgres + pgvector search layer that runs **inside the brand's own app** (two containers, no Redis/Elasticsearch/hosted vector DB), with hybrid retrieval (FTS + cosine ANN over BYO embeddings + optional segmented "spaces" vectors fused via RRF), hard/soft filter compilation to SQL, an NLQ parser, multimodal enrich, entity resolution/dedup, `/search/explain` auditability, and a `findProducts()` agentic surface that **deliberately stops at retrieval** (cart/checkout are downstream). The lens for each company below: do they **overlap** with samesake's brand-owned retrieval/ranking layer, or **complement** it?

---

## 1. Channel3 — "Database of every product on the internet"

**One-line pitch:** A universal, machine-readable product catalog + search API ("the API for agentic commerce") that lets any developer or agent search 100M+ products across 25,000+ brands and earn affiliate commission on sales.

**Batch / funding / team:** YC Summer 2025 (S25). New York. Team size 5. Founders Alexander Schiff (CEO, ex-Microsoft PM, ex-Studio.com AI lead, Duke CS) and George Lawrence (CTO, ex-Palantir, Duke CS). **$6M seed announced Dec 10, 2025**, led by **Matrix (Matrix Partners)**, with Ludlow Ventures, **Paul Graham**, Sri Batchu (former CMO of The RealReal), and Matteo Franceschetti (Eight Sleep founder).

### What they actually build
An aggregated, cross-merchant **product graph + retrieval API**. From the developer page, the surface is concrete:
- `POST /v1/search` — "Search 100M+ products via natural language **or image**." Example body: `{ "query": "running shoes" }`.
- `GET /v1/lookup?product_url=...` — "Get deep product metadata, real-time pricing, and variants."
- `POST /v1/cart` and `POST /v1/checkout` — both marked **"Coming Soon"** (cross-merchant cart + programmatic checkout).
- **Channel3 MCP server** (`https://mcp.trychannel3.com/`, no API key for free tier; one-click install in Cursor).
- **Source-available React UI components** + an installable agent "skill" (`npx skills add channel3-ai/skills`) and shadcn registry (`npx shadcn add https://ui.trychannel3.com/r/all.json`) so a coding agent can scaffold "text and image search with filters … grid … PDP with variant selection, similar products."

The data moat is **cross-merchant entity resolution**: "With the latest image classification and reasoning models, we can match products across merchants—even when listings and images differ—recognize variants, and surface the perfect matches." Catalog stated at 50M products in the Dec funding coverage; the site now claims **100M+**. SOC 2 & GDPR "in progress."

**Monetization model (important):** built-in affiliate. "Every product in the Channel3 API comes with a trackable link. We handle attribution, routing, and payouts." Developers earn commission (sample rates up to ~10%), removing the need to chase individual affiliate programs. This is the wedge — it pays developers to build on the catalog, accelerating the data/usage flywheel.

### Where they sit in the agentic-commerce stack
**Product-graph + retrieval (aggregated/horizontal) + payments-guardrail (emerging) + monetization rail.** They own the catalog layer one tier *above* a single brand: a web-scale aggregated graph, not a brand's own inventory. The `findProducts`-like surface (NL/image query → grounded products → link to merchant) is functionally close to samesake's `findProducts()`, but Channel3 is moving *down* the stack toward cart/checkout (the part samesake deliberately omits).

### Overlap vs complement with samesake
**Strong conceptual overlap, opposite axis.** Both expose an agent-facing "intent + image → grounded products" retrieval surface. The decisive difference is **ownership and data locus**:
- **Channel3** = SaaS API over a *third-party-aggregated* global catalog. The brand does not control the index; products are scraped/matched across merchants; ranking is Channel3's black box; data leaves the brand's perimeter. No `/search/explain`-style per-query auditability is exposed.
- **samesake** = a compiler that builds a *brand-owned* index running in the brand's own two containers, over the brand's own typed catalog and BYO embeddings, with hard-filter-gates-before-ranking SQL semantics and explainability.

So Channel3 is the natural foil for "why brand-owned": a brand that wants control over how it is described, ranked, and merchandised — and wants the data inside its own Postgres — is exactly the customer Channel3's model cannot serve, because Channel3's value *is* the aggregation. **Complementary in theory** (a brand could publish into Channel3 for distribution while running samesake on-site), **competitive in narrative** for any team deciding "buy a hosted product API vs. compile our own retrieval layer."

---

## 2. Kinect — "Merchant Layer for AI Native Commerce"

**One-line pitch:** An AI sales-agent + adaptive-storefront layer for DTC brands that (a) converts on-site visitors via a concierge agent that personalizes product pages in real time and (b) exposes a brand-owned "agent storefront" so external AIs (ChatGPT, Gemini, Perplexity) describe the brand the way the brand wants.

**Batch / funding / team:** YC **Spring 2026 (P26)** — the newest of the three. San Francisco. Team size 2. Founders Kratik Agrawal (CEO, ex-Google Commerce, ex-Anduril detection models, ex-Verkada, ex-Reevo Conversational Intelligence lead, UCLA CS) and Varun Kandula (ex-Reevo Context Graph lead, ex-MongoDB, ex-Capital One; advised Sephora on "Ask AI"). No external funding disclosed beyond YC.

### What they actually build
Two surfaces on **one brand-owned data layer**:
1. **On-site sales agent** — "storefronts that sell, not just show." A concierge-style conversational agent runs sales conversations, **adapts/personalizes product pages to customer segments in real time**, and picks recommendations from how the shopper asks, hesitates, compares, and what objection makes them bounce. Signals used: referral source, on-site behavior, searches, filters, order history.
2. **Off-site "agent storefront"** — a parallel, "context-rich, structured" storefront catered for external agents to read/scrape, plus the Kinect agents are callable by those external agents. Goal: when ChatGPT/Gemini/Perplexity describe the brand, the version is brand-authored, not "whatever it guessed from a public catalog scrape."

The underlying asset is an **enriched, brand-owned structured catalog**: "structured catalog, brand voice, fit notes, return reasons, segment-level nuance." Pitched as "Two surfaces. One layer. Built for scaling DTC ecommerce brands." Integrates with Shopify "without replatforming."

**Traction (from launch post / coverage):** 11 customers live (Wellness, Fashion, Sporting Goods, Consumer Goods); engaged users convert **2.4x higher**; 80% of conversations are first-time customers; **10–15% conversion gains** for beta partners (separate coverage cites 20% conversion lift, 14% AOV increase, 24% more time-on-page).

### Where they sit in the agentic-commerce stack
**Storefront-agent + catalog-enrichment + (light) CRM/personalization.** Kinect is an application-layer conversion product. It owns the *conversational selling and personalization* tier and the *brand-legibility-to-external-agents* tier, sitting on top of an enriched catalog it builds from brand data.

### Overlap vs complement with samesake
**Largely complementary, with one shared belief and one adjacency to watch.**
- **Shared belief = brand-owned enriched catalog.** Both Kinect and samesake reject "public catalog scrape" and insist the brand control its structured representation (fit notes, attributes, brand voice / typed catalog). This is strong validation of samesake's brand-owned thesis — and notably the *opposite* of Channel3.
- **Complement:** Kinect is a conversion/agent *application*; samesake is the *retrieval/ranking primitive*. A Kinect-style sales agent needs grounded, filterable, explainable product retrieval to pick "the right recommendation for the question being asked" — exactly what `findProducts()` + hard/soft filters + RRF provide. samesake could plausibly *be the retrieval engine under a Kinect-like agent*.
- **Adjacency to watch:** Kinect's enrichment ("structured catalog, fit notes, segment nuance") overlaps samesake's enrich pipeline, and its "intelligent search" claim (per third-party coverage) brushes against samesake's core. But Kinect appears to do retrieval as a means to an end (conversion) rather than as a typed, auditable, self-hosted compiled layer. samesake should differentiate on **rigor of retrieval** (RRF, hard-filter SQL gating, `/search/explain`, eval gates) vs. Kinect's **conversion outcome** framing.

---

## 3. Wildcard — "AEO/GEO for E-Commerce and Retail"

**One-line pitch:** An AI-search-optimization (GEO/AEO) platform that tracks how a brand's products appear across ChatGPT, Gemini, Google AI Overviews/AI Mode, Amazon Rufus, etc., and then uses AI agents to enrich product data and generate on-/off-site content to improve that visibility — increasingly extending into ACP/UCP instant checkout.

**Batch / funding / team:** YC **Winter 2025 (W25)**. San Francisco. Founder Kaushik Mahorker (CEO, ex-Scale AI Engineering Manager leading GenAI Allocation; "built the ecommerce enrichment engine … enriching 2.4M attributes across 400K SKUs"; ex-AWS EFS). Co-founder at launch was Yagnya Patel (NLP/Knowledge Graphs at Tesla, Amazon, Truveta); YC profile now lists team size 1 and only Mahorker as active founder. No funding figure disclosed. Hiring multiple "Founding Engineer, Agentic Commerce" roles.

### What they actually build — note the pivot
**This company has pivoted.** Its YC *launch* (`agents.json`) was developer infrastructure: "the gateway for AI agents to use APIs … agents.json files to help AI agents discover their APIs," an open-source SDK + registry of "agentic APIs" (Resend, Alpaca, etc.). `agents.json` is still open-source on GitHub (built on OpenAPI). The **current** product is entirely different: a **GEO/AEO analytics + content platform for e-commerce brands**.

Current product:
- **Tracking/analytics:** monitors how brands, categories, collections, and SKUs appear across AI search; tracks mention rank/position/context over time; query intelligence ("which shopping questions surface your products and identify gaps"); competitor tracking; customizable buyer personas/prompts.
- **Action layer (AI agents do the work):** "enrich product data, generate SEO, AEO, and GEO content, create collection and comparison pages, build FAQs, and improve off-site discoverability across Reddit, YouTube, blogs." Claims rankings move within 24–48h.
- **Stated gaps it fixes:** "67% of products lack the attributes AI needs to recommend them"; collection pages/FAQs are "the most cited sources in AI shopping results"; competitors average "43 more external mentions."
- **Emerging checkout:** "Make sales directly in ChatGPT and Gemini … instant checkout with **ACP** for ChatGPT and **UCP** for Gemini & Google AI Mode." Integrates with Shopify, BigCommerce, Magento, WooCommerce, Square/Salesforce, plus PIMs Akeneo/Salsify.

### Where they sit in the agentic-commerce stack
**Catalog-enrichment + discoverability/marketing (GEO/AEO) + payments-guardrail (ACP/UCP, early).** Wildcard optimizes for *external* AI surfaces — it is a marketing/visibility product whose unit of value is "get mentioned in ChatGPT Shopping," not "run search on the brand's own site."

### Overlap vs complement with samesake
**Complementary; minimal direct overlap, with shared enrichment DNA.**
- **Different surface entirely:** samesake powers retrieval/ranking *inside the brand's own app*; Wildcard optimizes how *third-party* AI engines rank/mention the brand. Wildcard has no on-site search/ranking engine to compete with `findProducts()`.
- **Shared DNA = enrichment.** Both build/enrich structured product attributes ("the attributes AI needs"). samesake's multimodal enrich pipeline produces exactly the kind of structured, attribute-rich catalog Wildcard says 67% of products lack — so a samesake-enriched catalog is a *better input* to a Wildcard-style GEO program. Plausible integration, not competition.
- **Strategic signal:** Wildcard's pivot from `agents.json` (horizontal agent-API infra) to vertical e-commerce GEO is evidence that **horizontal "make APIs/agents work" infra was harder to monetize than a vertical brand-facing wedge** — a useful cautionary data point for any temptation to position samesake as generic infra rather than a fashion-first vertical retrieval product. Wildcard also normalizes ACP/UCP as the checkout standards downstream of retrieval, validating samesake's choice to stop at retrieval and let those protocols own checkout.

---

## Cross-cutting synthesis for samesake

**The three companies cleanly trisect the stack around samesake's retrieval core:**

| Company | Stack position | Data locus | Relation to samesake |
|---|---|---|---|
| **Channel3** | Aggregated product-graph + retrieval API + affiliate rail | Third-party-aggregated, hosted | **Overlap (foil):** same agent-retrieval surface, opposite ownership model — the canonical "buy a hosted product API" alternative to "compile your own brand-owned index" |
| **Kinect** | Storefront sales-agent + personalization + enrichment | **Brand-owned** | **Complement:** an agent application that *needs* grounded retrieval; validates brand-owned-catalog thesis; adjacency on enrich/"intelligent search" |
| **Wildcard** | GEO/AEO visibility + enrichment + ACP/UCP checkout | Brand data, optimized for external engines | **Complement:** optimizes external discoverability; shares enrichment DNA; samesake-enriched catalog is a better GEO input |

**Three reusable talking points:**
1. **Ownership is the axis.** Channel3 (aggregated/hosted) vs. Kinect+samesake (brand-owned) is the real fault line. samesake should lead with "your index, your Postgres, your ranking, your explainability" against the hosted-API alternative.
2. **Everyone agrees enrichment matters; samesake should own retrieval rigor.** Kinect and Wildcard both enrich; Channel3 matches/dedups. samesake's differentiator is not "we enrich" but "compiled, typed, hybrid (FTS+ANN+spaces/RRF), hard-filter-gated, eval-gated, `/search/explain`-auditable retrieval that runs in your app."
3. **Stopping at retrieval is increasingly the consensus boundary.** Channel3's cart/checkout are "Coming Soon"; Wildcard hands checkout to ACP/UCP; Kinect drives to the brand's existing checkout. samesake's "stops at retrieval" line is well-aligned with where the ecosystem is drawing the seam.

---

## Sources
- Channel3 YC profile — https://www.ycombinator.com/companies/channel3
- Channel3 site (homepage) — https://trychannel3.com
- Channel3 developers page (API/MCP/UI surface) — https://trychannel3.com/developers
- Channel3 docs (search reference) — https://docs.trychannel3.com/api-reference/v1/search
- Channel3 $6M seed (SiliconANGLE) — https://siliconangle.com/2025/12/10/channel3-raises-6m-make-every-single-product-sold-web-discoverable-ai-agents/
- Channel3 $6M seed (PRNewswire) — https://www.prnewswire.com/news-releases/channel3-secures-6m-seed-funding-to-build-the-infrastructure-behind-agentic-commerce-302637193.html
- Channel3 $6M seed (AlleyWatch) — https://www.alleywatch.com/2025/12/channel3-agentic-commerce-infrastructure-universal-product-database-shopping-api-alexander-schiff/
- Channel3 launch post (YC) — https://www.ycombinator.com/launches/Nxm-channel3-a-database-of-every-product-on-the-internet
- Kinect YC profile — https://www.ycombinator.com/companies/kinect
- Kinect launch post (YC) — https://www.ycombinator.com/launches/Q1Q-kinect-personalized-storefronts-that-sell-not-just-show
- Kinect site — https://trykinect.ai/
- Kinect (HokAI tool listing, traction figures) — https://hokai.io/hub/tools/kinect
- Wildcard YC profile — https://www.ycombinator.com/companies/wildcard
- Wildcard site (current GEO/AEO product) — https://wild-card.ai/
- Wildcard original launch (agents.json) — https://www.ycombinator.com/launches/MrK-wildcard-make-apis-work-for-ai-agents
- agents.json (GitHub, open source) — https://github.com/wild-card-ai/agents-json
- agents.json docs — https://docs.wild-card.ai/agentsjson/introduction
