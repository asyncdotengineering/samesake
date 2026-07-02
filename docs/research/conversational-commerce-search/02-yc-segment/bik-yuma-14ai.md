# YC Agentic-Commerce Segment — BIK, Yuma AI, 14.ai

Competitive deep-dive profiling three Y Combinator companies in/near the agentic-commerce segment, mapped against **samesake** — a TypeScript-first "search engine compiler" for visual commerce (fashion-first) that compiles a typed catalog declaration into a Postgres + pgvector hybrid retrieval layer running *inside the brand's own app*, exposing a `findProducts()` agentic surface that deliberately stops at grounded retrieval (cart/checkout downstream).

The single most important lens for this cluster: **samesake owns the brand's product-graph / retrieval / ranking layer. None of these three companies sell that as their core product** — but two of the three (BIK/Manifest and Yuma's Sales AI) have drifted *into* on-site product discovery and recommendation as conversion features, which is exactly the surface samesake's retrieval layer would power. That makes them partial overlaps at the UI/agent layer and natural complements at the infrastructure layer.

---

## 1. BIK (a.k.a. Bikayi / Manifest AI)

**One-line pitch:** "Agentic AI CRM for ecommerce" — a marketplace + no-code studio of "AI commerce agents" that brands spin up across acquisition, retention, and support.

### What they actually build
BIK has had two lives. It launched (2019, YC S20) as **Bikayi**, a Shopify-alternative storefront/commerce builder for Indian SMBs that raised a $10.8M Series A led by Sequoia Capital India in Sep 2021 and was in talks for a ~$50M Series B at a unicorn valuation in early 2022 (which did not materialize; the company was later hit by fraud allegations and a seller exodus per Inc42). It has since **pivoted and rebranded to BIK / "Manifest AI"**, repositioning as US-based (San Francisco, ~55 people) and selling AI agents to e-commerce brands.

Current product (per its YC page and getmanifest.ai):
- A self-described **"World's First AI Commerce Agents Marketplace"** — "500+ eCommerce AI agents, plus a no-code studio to craft your perfect ones."
- An **Agent Studio builder**: brands type a Goal ("reduce support load, increase revenue by xx%"), Instructions, and Success criteria, and spin up an agent.
- Deploy targets: "Train it once. Deploy it everywhere (email, text, Instagram, messenger, whatsapp) or on website."
- Named agents include a **"Size Guide AI" agent** (claims to reduce returns ~40%), an **influencer-shortlisting DM agent**, and **"Jack the seller"** for product matching and cross-selling.

Critically for samesake, Manifest AI's on-site assistant now does **product discovery and search**: it "uses natural language processing to understand customer intent beyond simple product names," analyzes "details, features, and benefits customers care about," and recommends "only the top 5 most relevant products" — "PDPs that behave like top sales reps."

> "instead of investing heavily on multiple tools and plugins to handle your acquisition, support, retention, [brands] can now just spin off **AI commerce agents** for their Brand. No tools. No humans." — BIK YC launch post

### Stack position
Primarily **storefront-agent + CRM + catalog-enrichment (support/marketing automation)**, with a growing **retrieval/discovery** footprint via the NLQ shopping assistant and recommendation agents. It is a broad horizontal suite, not a retrieval primitive.

### Batch + funding
YC **Summer 2020**. Founded 2019. Founders Sonakshi Nathani & Ashutosh Singla. ~55 employees, San Francisco. Funding: $10.8M Series A (Sequoia Capital India, Sep 2021) under the Bikayi name; no fresh round publicly confirmed under the BIK/Manifest rebrand as of mid-2026.

### Overlap vs. complement with samesake
**Partial overlap, shallow.** Manifest AI's NLQ shopping assistant ("understand intent → top 5 relevant products") is exactly the *consumer-facing* layer samesake's `findProducts()` is designed to ground. But BIK's retrieval is almost certainly an LLM-over-catalog widget, not a typed, hybrid (FTS + ANN + RRF), hard-filter-gated, auditable retrieval engine. BIK competes for the *agent UI / merchant relationship*; samesake competes for the *retrieval correctness underneath it*. BIK is a **SaaS widget bought by merchants**; samesake is a **library compiled into the brand's own app**. They could in principle complement (BIK as the conversational front-end, samesake as grounded retrieval), but BIK's "no tools, no humans, all-in-one" positioning makes it more likely a competitor for mindshare than an integration partner. Differentiator for samesake: typed catalog, hard filters that gate before ranking, `/search/explain` auditability, BYO models, runs in-app (no data leaves) — none of which a horizontal agent marketplace offers.

---

## 2. Yuma AI

**One-line pitch:** "The AI Support Agent for Ecommerce" — autonomous AI agent orchestration that automates customer service for large Shopify brands, now expanding into on-PDP sales.

### What they actually build
Yuma is the **CX-automation incumbent** of this cluster. It integrates directly with help desks (Zendesk, Kustomer, Gorgias) and Shopify, and runs autonomous support agents that "fetch information from external services and take actions in other apps" to resolve tickets end-to-end. Founder Guillaume Luccisano is a three-time YC founder (Socialcam W12, Triplebyte S15). The platform has "processed millions of customer conversations for 100+ commerce brands since" late 2022.

Product surface (from YC launches + yuma.ai):
- **Autonomous support agents** — top merchants automate 60–80% of tickets; "best merchants automate 93% of their customer conversations."
- **Flows** — a deterministic/visual step-by-step workflow builder for reliable support automation.
- **Deep Search / ticket analytics** — "ChatGPT-style interface that turns your support ticket history into instant insights."
- **Social AI** — automated social-media comment/DM moderation across FB/IG/TikTok.
- **Ask Yuma** (latest launch) — "Think Claude Code, but for your entire CX operation"; a conversational ops layer that builds automations from SOP docs, diagnoses mishandled tickets, generates reports, and is adding **MCP integration** so it runs inside Claude and other AI tools.
- **Sales AI** (Sep 2025) — a PDP widget that began as a product Q&A/FAQ widget but has expanded into **product discovery and recommendation**: "Smart Recommendations" that "suggest items that match their style, color preferences, or past interests," a "Next-Best Buy" engine using cart/history/preferences, and "Affinity Nudges." It claims RPV +~18% and AOV +~4%.

> "Yuma isn't just another RAG chatbot. Our platform provides autonomous AI agents dedicated to support and ecommerce… powered by knowledge, follow processes, and are managed by our in-house AI orchestration technology." — Yuma YC page

### Stack position
Core: **support + CRM + storefront-agent (CX orchestration)**. Adjacent and growing: **retrieval/discovery** via Sales AI's recommendation engine. This is the company whose roadmap is drifting closest to samesake's territory — but from the *support* side, using behavioral signals (browsing, cart, history) rather than a typed catalog retrieval engine.

### Batch + funding
YC **Winter 2023**. Founded 2023, Boston (+ Barcelona eng). ~26 employees. Funding: **$5M round announced Oct 2024**, backed by Gradient Ventures, Pioneer Fund, Altman Capital, and ~50 angels (plus YC).

### Overlap vs. complement with samesake
**Overlap is real but oblique; mostly complement.** Yuma's *core* (ticket automation, help-desk integration) is fully disjoint from samesake — it sits downstream/post-purchase, exactly where samesake explicitly stops. The collision point is **Sales AI's recommendation engine**, which now does style/color/preference-based product suggestion on PDPs. However, Yuma's recommender appears **behavioral/personalization-driven** (visitor browsing, cart, purchase history) rather than **query/constraint-driven catalog retrieval** — a different mechanism than samesake's hybrid FTS+ANN+RRF over a typed catalog with hard SQL filters. Yuma is a **multi-tenant SaaS the merchant subscribes to**; samesake is **compiled into the brand's own two-container app**. Best framing: Yuma is a *complement and a potential consumer* of a grounded retrieval layer — its Sales AI widget needs exactly the kind of constraint-aware, explainable product retrieval samesake produces, and its MCP-forward Ask Yuma direction suggests it would happily call an external `findProducts()`-style tool. samesake should watch Sales AI as the one feature that could, over time, build a competing in-house retrieval stack.

---

## 3. 14.ai

**One-line pitch:** "AI engine powering autonomous brands" — started as an AI-native customer-service agency, now building software to run entire consumer brands autonomously, beginning with its own brand GloGlo.

### What they actually build
14.ai is the **odd one out and the most strategically interesting**. Founders Marie Schneegans and Michael Fester (Fester previously co-founded Snips, the on-device AI voice platform acquired by Sonos in 2019; the company appears to have evolved out of/absorbed **Markprompt**, an earlier AI-customer-support product). Two intertwined offerings:

1. **AI-native customer service agency** — a full-service, done-for-you CX agency where "after our customers hand over their existing integrations, we tell them to stop answering tickets." Differentiators vs. BPOs: goes live in hours ("inbox zero on day zero"), agentic resolution ("autonomously verifying purchases, generating shipping labels, and triggering refunds in a single, seamless flow"), and a human-AI feedback loop where SF-based AI engineers handle every edge case and feed it back. Customers named include Brilliant (AI glasses), Yon-Ka (luxury skincare), Creative Lighting.

2. **Autonomous brand operator** — the bigger thesis. "14.ai operates brands autonomously. Our software runs the core machinery of a modern company, from demand generation to fulfillment to customer relationships." They built and own **GloGlo** (rapid glucose gummies for Type 1 diabetics/athletes) as "the world's first autonomous consumer brand" — a blueprint/dogfood for the system.

> "The next iconic brands will run with far fewer people, tighter software loops, and much more operational intelligence. Our system connects acquisition, operations, support, and decision-making across the brands we build into one intelligent layer." — 14.ai YC page

### Stack position
Currently **support + storefront-agent (services)**, evolving toward an **end-to-end brand-operations layer** (acquisition → ops → fulfillment → support → decisioning). It is *not* a retrieval/product-graph product; product search is, at most, an implicit sub-component of "running a brand."

### Batch + funding
YC **Winter 2024**. Founded 2024, San Francisco. Tiny team (3 on YC profile; heavily intern/ops-staffed). Funding: **$3M seed** (closed ~March 2026), led by Y Combinator with General Catalyst, Base Case Capital, SV Angel, and founders of Dropbox, Slack, Replit, and Vercel.

### Overlap vs. complement with samesake
**No direct overlap today; strongest long-run philosophical alignment.** 14.ai sells outcomes (an operated brand / handled support), not a retrieval primitive — so there is zero head-to-head competition on samesake's product. But 14.ai is the clearest embodiment of the *thesis samesake is betting on*: brands running on "tighter software loops" with AI orchestrating the funnel. An autonomous brand operator that owns acquisition + storefront + ops is precisely the kind of buyer that needs a **typed, in-app, verifiable product-retrieval engine** as a component — they would never want a black-box SaaS widget for their own brands; they'd want a library they compile and control, which is samesake's exact shape. Net: **complement / ideal future customer or reference design**, not competitor. The risk is only that a vertically-integrated operator like 14.ai eventually builds retrieval in-house rather than adopting it.

---

## Cross-cluster synthesis

| | BIK / Manifest AI | Yuma AI | 14.ai |
|---|---|---|---|
| **YC batch** | S20 | W23 | W24 |
| **Core stack layer** | Storefront-agent + CRM + support | Support + CX orchestration | Support agency → autonomous brand operator |
| **Touches retrieval/discovery?** | Yes — NLQ shopping assistant, "top 5 relevant products" | Yes — Sales AI recommendations (behavioral) | No (implicit only) |
| **Delivery model** | Multi-tenant SaaS widget | Multi-tenant SaaS | Done-for-you agency + owned brands |
| **Funding** | $10.8M (2021, as Bikayi) | $5M (Oct 2024) | $3M seed (Mar 2026) |
| **vs. samesake** | Partial overlap (UI), competes for merchant mindshare | Complement; watch Sales AI | Complement; ideal-customer thesis match |

**The pattern:** all three are **agents-over-commerce** companies that begin at *support/CX* and creep toward the *funnel* (discovery, recommendation, conversion). None of them builds the retrieval/ranking *substrate* — they all assume product data is "just there" and let an LLM or behavioral model improvise over it. That is the gap samesake fills. The competitive risk is not that one of them ships a "search engine compiler"; it is that as their conversational front-ends mature, they bolt on an *in-house, low-rigor* retrieval layer (LLM-over-catalog) that is "good enough" for SMBs and never reaches for a real hybrid, hard-filtered, auditable engine. samesake's defensibility against that is precisely the rigor these companies skip: typed catalog, hard filters gating before ranking, RRF hybrid retrieval, `/search/explain` auditability, BYO models, and in-app deployment (no data exfiltration) — features that matter most to exactly the kind of premium/fashion brands and autonomous operators (14.ai-style) who can't tolerate a black-box widget.

---

## Sources
- BIK YC profile: https://www.ycombinator.com/companies/bik
- BIK / Manifest AI launch — "World's First AI Commerce Agents Marketplace": https://www.ycombinator.com/launches/OfM-bik-ai-world-s-first-ai-commerce-agents-marketplace
- Manifest AI product site: https://getmanifest.ai/ and https://getmanifest.ai/ai-commerce-agents
- Bikayi $10.8M Sequoia round (Inc42, Sep 2021): https://inc42.com/buzz/yc-backed-b2b-startup-bikayi-raises-10-8-mn-led-by-sequoia-capital-india/
- Bikayi ~$50M Series B talks (TechCrunch, Jan 2022): https://techcrunch.com/2022/01/18/sequoia-capital-india-tiger-global-in-talks-to-back-commerce-startup-bikayi/
- Bikayi fraud allegations / seller exodus (Inc42): https://inc42.com/features/bikayi-in-disarray-startup-hit-by-fraud-allegations-seller-exodus/
- Yuma AI YC profile: https://www.ycombinator.com/companies/yuma-ai
- Yuma "Ask Yuma" launch: https://www.ycombinator.com/launches/Pts-ask-yuma-the-ai-that-runs-your-entire-support-operation
- Yuma Sales AI (FAQ → recommendations): https://yuma.ai/blogs/yuma-ai-expands-beyond-cx-with-sales-ai-a-new-faq-widget-driving-revenue-growth-for-e-commerce-brands
- Yuma $5M raise (Oct 2024): https://yuma.ai/news-announcements/yuma-ai-raises-5-million-to-transform-e-commerce-customer-support-with-advanced-ai-agents
- Yuma Crunchbase: https://www.crunchbase.com/organization/yuma-c2b6
- 14.ai YC profile: https://www.ycombinator.com/companies/14-ai
- 14.ai launch — "The AI-Native Customer Service Agency": https://www.ycombinator.com/launches/PaA-14-ai-the-ai-native-customer-service-agency
- 14.ai $3M seed + autonomous-brand thesis (TechCrunch, Mar 2026): https://techcrunch.com/2026/03/02/a-married-founder-duos-company-14-ai-is-replacing-customer-support-teams-at-startups/
- 14.ai seed coverage (Complete AI Training): https://completeaitraining.com/news/yc-backed-14ai-runs-startup-support-as-an-ai-first-agency/
- GloGlo (14.ai's owned brand): https://gloglo.com/
