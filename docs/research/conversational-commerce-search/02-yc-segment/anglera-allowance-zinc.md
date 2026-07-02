# YC Agentic-Commerce Segment — Anglera, Allowance, Zinc

Competitive profiles for the samesake competitive map. samesake is a TypeScript-first "search engine compiler" for visual commerce: it compiles a typed catalog declaration into a brand-owned Postgres + pgvector hybrid retrieval/ranking layer (FTS + cosine ANN + optional segmented "spaces", fused with RRF), with hard-filter SQL gating, an NLQ parser, a multimodal enrich pipeline, entity resolution/dedup, `/search/explain` auditability, and a `findProducts()` agentic surface that **stops at retrieval** (cart/checkout are downstream).

The three companies below sit at three different layers of the agentic-commerce stack. **None of them is a brand-owned retrieval/ranking engine** — which is exactly samesake's slot — so all three are best understood as **complements with one important overlap zone (Anglera's catalog enrichment vs. samesake's enrich pipeline)**.

---

## 1. Anglera — "AI-Powered Product Data Enrichment"

**One-line pitch:** AI agents that turn messy, incomplete product data into a complete, structured, schema-mapped catalog "optimized for discovery" — fixing the data layer underneath search/recommendation.

**Stack position:** **Catalog-enrichment** (the layer directly upstream of, and partially overlapping, samesake's `enrich` pipeline). They explicitly draw the stack as: *beautiful frontend → intelligent search & discovery algorithms → messy unstructured product data ← "We fix this."* So they deliberately position themselves **below** the search layer, not as the search layer.

**Batch / funding / team:**
- YC **Summer 2024**. Founded 2024. SF. Team ~5–6. Primary partner Aaron Epstein. SOC 2 Type II.
- Funding: reported **~$500K seed** (single round, per Tracxn/StartupHub aggregators — treat as approximate, not company-confirmed).
- Founders: **Amay Aggarwal** (Stanford BS/MS AI-ML; led Catalog AI at Uber Eats, enriching millions of SKUs) and **Ray Iyer** (Stanford BS/MS CS; launched CPG Ads at Uber Eats; prior Meta/Verkada/Microsoft). The founding wedge is literal: they built product-catalog enrichment ML at Uber Eats scale and are productizing it.

**What they actually build:**
- Input: "messy spreadsheets, PDFs, images, brand websites, supplier feeds." Output: "complete, enriched product catalogs, continuously optimized for AI discoverability." Claim: process thousands of SKUs "in seconds, not weeks"; reduce time-per-product "from 15 mins down to 5 seconds."
- Three quality axes they sell on: **Completeness** (fill missing attributes), **Correctness** (accurate specs/dimensions/features), **Consistency** ("Structure your data so AI can easily parse, understand, and retrieve it").
- **Grounding/anti-hallucination is a first-class pitch:** "Sourced, not invented — Every value is pulled from real documents... then normalized to your schema. Nothing invented." Plus continuous quality scoring per SKU, low-confidence flag/queue, and human-set guardrails ("Nothing publishes below it").
- Positioning vs. PIM: "Your PIM stores the data. Anglera does the work." Bidirectional sync with Akeneo, Salsify, inRiver, Stibo, Syndigo, Pimcore; ERP (SAP, Oracle, NetSuite, Dynamics); commerce (Shopify, Adobe Commerce, Magento, BigCommerce, WooCommerce); data (Databricks, Snowflake). Works with no PIM too.
- Traction claims on site: **22M+ products enriched, 6 Fortune 500 customers, 180%+ increase in web traffic.** Forward-deployed-engineer hiring pattern (enterprise SI motion).
- Explicit "Why Now" framing names samesake's exact world: **"AI Search Explosion"** (ChatGPT/Perplexity as discovery channels) and **"Agentic Commerce"** (agents purchasing autonomously).

**Overlap vs. complement with samesake:** **Partial overlap, mostly complement.** Anglera's enrichment (multimodal extraction from images/PDFs/web, schema normalization, dedup/reconcile during M&A migrations, grounded "sourced-not-invented" values, per-SKU quality scoring) overlaps conceptually with samesake's **multimodal enrich pipeline + entity-resolution/dedup**. The difference: Anglera produces **clean catalog data that lands back in the customer's PIM/commerce platform** — it stops at "structured data." samesake takes (already-or-self-enriched) catalog data and compiles it into a **running hybrid retrieval/ranking engine** (FTS+ANN+RRF, hard-filter SQL gating, NLQ, `findProducts()`, `/search/explain`). Anglera is upstream supply; samesake is the demand-side query engine. They could be **pipeline neighbors**: Anglera enriches → samesake indexes/ranks/serves agents. The competitive risk is scope creep — Anglera says data is "optimized for retrieval" and is enrichment-heavy, so if they extend into serving/search they would start contesting samesake's enrich+index boundary. samesake's differentiation to hold: it is the *typed, in-app, auditable retrieval compiler*, not a data-cleaning service; and it owns ranking quality (grade@10, P@5 eval gates), which Anglera does not claim to serve.

---

## 2. Allowance — "The spend control layer for AI agents"

**One-line pitch:** A consumer "agent wallet" that issues one-time, scoped virtual cards so an AI agent can complete a purchase on your behalf without ever seeing your real card number — with per-task limits, merchant locks, expiry, and human approval from your phone.

**Stack position:** **Payments-guardrail** (the checkout/authorization layer, far downstream of retrieval). This is precisely the layer samesake's `findProducts()` deliberately **stops before**.

**Batch / funding / team:**
- YC **Spring 2026** (one of the newest batches). Founded 2026. **Team size 1 (solo founder).** Primary partner Harj Taggar. Currently "live in early public beta"; iOS app shipped ("Allowance – Agent Wallet"); hiring a founding engineer.
- Funding: standard YC deal implied; no separately-confirmed round found.
- Founder: **Dasmer Singh** — ex-Head of Product, **Cash App Families** ("most popular debit card for teens in the US"); early iOS engineer at **Venmo**; also Uber, Petal; Columbia + Stanford GSB. Deep consumer-fintech/payments-controls background, which is the exact muscle this product needs.

**What they actually build:**
- "Allowance gives your AI a wallet with rules." Flow: user tells the agent what to do → sets a limit (amount, merchant, expiry) in one tap → agent completes the purchase within rules → user gets a receipt → **the permission auto-expires.**
- Mechanics: "Allowance generates scoped, one-time payment credentials designed specifically for that transaction." Controls: spending caps (per-task/daily/monthly), **merchant-locked** cards, **auto-expiring** permissions, full transaction logging, **instant revocation**, and "your AI never sees your card number." Funds route through the user's existing card (rewards preserved; demo shows "Citi Double Cash").
- Works "inside the AI tools you already use" — demo surfaces Claude and references **OpenClaw** agents; supports a desktop-agent setup path.
- Origin story is the canonical agentic-commerce gap: founder used an agent to book a reservation, the agent navigated the flow, then asked him to paste a credit card number — "That felt fundamentally wrong." Use cases span travel, recurring coffee, event/ticket drops, restaurant reservations, grocery reorders, gift buying, price-drop auto-buy.

**Overlap vs. complement with samesake:** **Pure complement, zero overlap.** Allowance is the **payment-authorization/guardrail primitive** that begins exactly where samesake hands off. samesake `findProducts()` returns "grounded products with verification/grounding/why" and intentionally does NOT do cart/checkout; Allowance is one of the things that lives in that downstream gap. In a full agent loop: samesake (retrieve/ground the right products) → agent decides → **Allowance (scoped payment + human approval)** → merchant. They never contest the same surface. Relevance for samesake: Allowance validates the thesis that **the agentic-commerce stack is unbundling into discrete, swappable layers** (retrieval ≠ checkout ≠ payment-control), which is the strategic premise behind samesake owning *just* the brand-owned retrieval/ranking layer and stopping cleanly at retrieval. It is also a candidate "downstream integration partner / reference architecture" rather than a competitor. Caveat: Allowance is consumer-side (user's wallet), not merchant-side — so it is adjacent, not a direct integration with samesake's brand-deployed engine.

---

## 3. Zinc — "The secret backbone of e-commerce" / programmable buying API

**One-line pitch:** A single API to **buy any product from major online retailers** — search products, place orders, track shipments, and handle returns programmatically — now repositioned as the "purchasing layer" for AI agents and agentic commerce.

**Stack position:** **Storefront-agent / order-execution + product-data API** (transaction fulfillment across third-party retailers). It is *cross-retailer checkout-and-fulfillment infrastructure* plus a read-side product-data API — again downstream of brand-owned retrieval, and aimed at a different buyer (developers building agents that purchase from Amazon/Walmart/Target/Best Buy, not brands serving their own catalog).

**Batch / funding / team:**
- YC **Winter 2014** — the elder of the three, now a decade-old company that has **repositioned onto the agentic-commerce wave**. SF. Team ~10. Founders **Doug Feigelson** (active) and **John Wang** (former; now CTO/co-founder of Assembled). (Historically Zinc had earlier pivots; it is now squarely a commerce-buying API.)
- Funding: no fresh round confirmed in search; treat as established/independent. Pricing is public and usage-based: product-data calls **$0.01 per call**; purchases run through a **prefunded Zinc Wallet** (Stripe top-up) or **Bring-Your-Own-Account** (item charged to your retailer account, Zinc takes only the API fee).

**What they actually build:**
- **Zinc Order:** `POST /v1/orders` to place orders at "top online stores, no checkout flows required" — Amazon (multiple regions), Walmart, Target, Best Buy, Alibaba, commercetools, etc. Plus track, return-label generation, cancel-in-flight, managed accounts, event webhooks, price-ceiling safeguards. They claim "thousands of orders per week" and "20M+ SKUs indexed."
- **Zinc Data:** real-time read API — product search by natural keywords returning structured results, multi-seller offer comparison (price/shipping/condition/reputation), full product metadata, variant mapping, normalized identifiers (UPC/MPN/EAN), low-latency `max_age`/`newer_than`/async options.
- **Zinc Agent** (new): a hosted agent that "buys anything online."
- Strong agentic-commerce content push: blog posts on "Agentic Commerce in 2026," "How to Build an AI Shopping Agent" (Claude + MCP tools + Zinc for order execution + MPP for payments), and HTTP 402 / x402 payment-protocol explainers. They frame a **3-layer agentic stack** and slot themselves as the **execution/fulfillment layer**.

**Overlap vs. complement with samesake:** **Complement, with a minor read-side adjacency.** Zinc's *order/track/return* half is pure downstream execution — completely complementary to samesake (samesake stops at retrieval; Zinc executes the buy). The minor adjacency is **Zinc Data's product search + metadata API**: it offers "search just like a shopper using natural keywords" across *third-party retailer* catalogs. But this is a fundamentally different shape from samesake: Zinc Data searches **other people's catalogs (Amazon/Walmart/...) as an aggregator over the retail web**, returning offers to compare for buying; samesake compiles a **brand's own catalog** into an **in-app, typed, auditable hybrid retrieval/ranking engine** the brand controls and runs in its own two containers. Different buyer (Zinc = developers building agents that shop *across* retailers; samesake = a brand/retailer serving *its own* visual-commerce catalog), different data ownership (aggregated web vs. brand-owned), different output (offers to purchase vs. ranked grounded results for an agentic surface). They don't contest the same slot, but Zinc is the closest of the three to "search" terminology — worth watching if it deepens semantic/visual ranking on the read side.

---

## Cross-cutting takeaways for samesake

1. **The stack is unbundling, and samesake's chosen slot is clean.** Across these three you can read the layered agentic-commerce stack: **enrichment (Anglera) → retrieval/ranking (samesake's slot — unoccupied by these three) → order execution (Zinc) → payment guardrail (Allowance).** None of the three is a brand-owned hybrid retrieval/ranking compiler. That's a positive signal: samesake's wedge is not directly contested by these YC names.

2. **Enrichment is the one true overlap to defend.** Anglera is the only direct competitive pressure, on the **enrich/entity-resolution** sub-layer. samesake's differentiation: enrich is *in service of an owned, typed, evaluable retrieval engine* (it produces vectors/segments/fields that feed FTS+ANN+RRF and are gated by grade@10/P@5), not a standalone PIM-syncing data-cleaning SaaS. samesake should be careful not to position itself as "data enrichment" head-to-head; position as "the retrieval/ranking engine you own," with enrich as a feeder.

3. **Everyone leans on grounding/verification language** ("sourced, not invented," human approval, scoped permissions, `/search/explain`). samesake's auditability (`/search/explain`, grounding/why in `findProducts()`) is on-trend and table-stakes for agent-facing trust — keep it prominent.

4. **"Stops at retrieval" is corroborated as a defensible boundary.** Allowance (payment) and Zinc (execution) are exactly the downstream layers samesake declines to build — and they are venture-funded businesses in their own right. This validates the decision to hand off cleanly and suggests reference-architecture / partnership narratives ("samesake retrieves, Zinc executes, Allowance authorizes").

5. **Differentiators to keep sharp vs. all three:** brand-**owned** + in-app (two containers, no hosted vector DB / Elasticsearch / Redis), **typed** TS catalog declaration, **hybrid** FTS+ANN+RRF with hard-filter SQL gating, **evaluated** ranking (published grade@10 ~2.33 / P@5 0.83), and a constrained NLQ parser + agentic `findProducts()` surface. None of the three offers a self-hosted, typed, eval-gated retrieval compiler — that's the moat sentence.

---

## Sources

- Anglera — YC profile: https://www.ycombinator.com/companies/anglera
- Anglera — YC launch post: https://www.ycombinator.com/launches/Nlc-anglera-ai-product-data-enrichment
- Anglera — company site: https://www.anglera.com/
- Anglera — American Bazaar coverage (Jun 2025): https://americanbazaaronline.com/2025/06/19/y-combinator-backed-anglera-debuts-with-ai-solution-for-product-data-enrichment-463930/
- Anglera — Tracxn profile: https://tracxn.com/d/companies/anglera/__Q1DycOHWE014UBHDYomjraYa0_e0uhOazKHDurtr5eo
- Anglera — StartupHub ($500K raised): https://www.startuphub.ai/startups/anglera
- Anglera — Crunchbase: https://www.crunchbase.com/organization/anglera
- Allowance — YC profile: https://www.ycombinator.com/companies/allowance
- Allowance — YC launch post: https://www.ycombinator.com/launches/QS4-allowance-virtual-cards-for-ai-agents
- Allowance — company site: https://useallowance.com/
- Allowance — New Economies, YC Spring 2026 batch: https://www.neweconomies.co/p/y-combinator-spring-2026-batch
- Zinc — YC profile: https://www.ycombinator.com/companies/zinc
- Zinc — company site: https://www.zinc.com/
- Zinc — "Agentic Commerce in 2026" guide: https://www.zinc.com/blog/agentic-commerce
- Zinc — "How to Build an AI Shopping Agent": https://www.zinc.com/blog/how-to-build-ai-shopping-agent
- Zinc — Crunchbase: https://www.crunchbase.com/organization/zinc-technologies
- Rye — Agentic Commerce Landscape 2026 (segment context): https://rye.com/blog/agentic-commerce-startups
