# GEO / AEO: Getting Products Surfaced & Ranked Inside External Buyer-Agents

> Completeness-pass deep-dive. Gap: external-agent discoverability (ChatGPT, Perplexity,
> Google AI Mode / AI Overviews / Gemini, Amazon Rufus / Alexa+, Copilot). Vendors claim it;
> the first sweep never researched the methodology. This file covers **(1)** what signals these
> engines actually use, **(2)** which AEO/GEO tactics are *measurable* vs *snake-oil*,
> **(3)** the measurement/monitoring tool category (Wildcard / Athos / Otterly / Peec …),
> and **(4)** the relationship between a brand-owned retrieval layer (samesake) and external-agent
> discoverability — what samesake can DO at the catalog / enrich / feed layer even though it
> **stops at retrieval**.

**Anchor:** samesake is a TypeScript "search engine compiler" for **LK fashion** (Sinhala/Tamil/English
code-mixed), Postgres + pgvector inside the user's app, FTS + ANN + RRF, hard SQL filters,
NLQ parser, multimodal **enrich** pipeline, entity-resolution/dedup, `/search/explain`,
`findProducts()` that stops at retrieval. It is the brand's **own** retrieval layer. GEO/AEO
is about a *different* runtime — the buyer-agent the brand does **not** own. The connective
tissue is the **catalog/feed/enrich output**: the same typed, enriched, deduped catalog that
feeds samesake's internal index is *also* the raw material for external-agent legibility.

---

## 0. TL;DR verdict

- **The signals converge across all engines** and are boringly consistent: **structured product
  data** (schema.org `Product`/`Offer`/`Review`, or a platform feed), **catalog completeness**
  (attributes/specs that let a constraint query match), **reviews/ratings**, **price &
  availability accuracy/freshness**, and **external authority** (third-party mentions, editorial,
  Reddit). Keyword stuffing is dead — it *measurably loses* in the GEO paper.
- **Two distinct delivery channels** to an engine: **(a) a first-party product feed** to a
  merchant program (OpenAI ACP feed, Perplexity/Google Merchant Center, Amazon listing) — the
  engine reads your structured data directly; and **(b) the open web** — schema.org markup +
  on-site content + off-site mentions the crawler grounds against. Most brands need both.
- **What samesake OWNS:** producing the *legible catalog* — typed attributes, normalized
  taxonomy, enrich-generated rich descriptions/specs, dedup/entity-resolution, field-level
  provenance, and a **clean export** in feed shape (CSV/JSON ACP, Google Shopping CSV,
  schema.org JSON-LD). This is a **direct extension of the enrich pipeline** and is the
  highest-leverage, lowest-snake-oil contribution it can make.
- **What samesake does NOT own (marketing if claimed):** ranking position *inside* ChatGPT/
  Perplexity, "guaranteed" surfacing, off-site authority/PR, checkout (ACP/UCP/Stripe/PayPal),
  and the monitoring layer. samesake should **integrate** with these (export adapters,
  enrich-for-feed), **not impersonate** them.
- **For LK fashion specifically:** the external-agent channel is *weaker and slower* than for
  US/Shopify brands (merchant programs are US-/PayPal-/Stripe-gated, Shopping Graph coverage is
  thinner for LK SKUs, English-dominant grounding hurts code-mixed catalogs). The *defensible*
  play is feed-legibility + clean schema.org export, **not** chasing in-agent rank.

---

## 1. What signals do external buyer-agents actually use?

Two architectures matter, and they imply different signal sets:

1. **Feed-grounded merchant programs** — the engine ingests a structured feed you submit
   (OpenAI ChatGPT, Perplexity, Google Shopping Graph, Amazon). Ranking is over *your structured
   fields plus the engine's own quality/authority signals*.
2. **Web-grounded retrieval (RAG over the open web)** — the engine crawls/searches and grounds
   its answer in pages. Here schema.org markup, page structure, and off-site authority dominate.

### 1.1 OpenAI / ChatGPT — the Agentic Commerce Protocol (ACP) feed (PROVEN: official spec)

OpenAI publishes a **Product Feed Spec** and an **Agentic Commerce Protocol**. From the official
docs (`developers.openai.com/commerce`):

- **Delivery:** merchants sign up at `chatgpt.com/merchants`; provide a structured feed.
  Key-concepts page specifies **CSV or JSON**, with **"daily snapshots"** as the baseline refresh
  (third-party guides report up to every-15-min refresh for approved partners — treat the
  15-min figure as MARKETED until confirmed in the spec).
- **Required fields** (from the spec): header — `feed_id`, `account_id`, `target_merchant`,
  `target_country`; product — `id`, `variants`; variant — `id`, `title`. Recommended:
  descriptions, media, category taxonomy, seller info, `price`/`list_price`/`unit_price`,
  availability, condition.
- **The one explicit ranking statement** (load-bearing quote, OpenAI key-concepts):
  > "recommended attributes—like rich media, reviews, and performance signals—improve ranking,
  > relevance, and user trust."

  This is the *only* first-party confirmation that **reviews + media + performance signals feed
  ranking**, but OpenAI gives **no algorithm, weights, or mechanism**. Everything finer-grained
  is inference.
- **ACP vs Instant Checkout:** ACP is the open protocol (anyone can build); **Instant Checkout**
  (in-chat purchase, PSP via Stripe) is **limited to approved partners**. So feed submission ≠
  transactability. Discovery and checkout are separable.

> **Implication:** ChatGPT product surfacing is **feed-first**. If you are not in the merchant
> feed, you rely on web-grounded fallback (schema.org + authority). The feed is the high-confidence
> path; the spec confirms reviews/media/performance matter but not how.

### 1.2 Perplexity — merchant program + Google Shopping feed shape (PROVEN: program docs)

- **Program:** free, no minimum revenue/product count, ~5-min application
  (Merchant Program ToS + multiple integrator guides).
- **Feed:** accepts **CSV in Google Shopping feed spec** (SFTP/secure delivery). Required:
  title, description, **GTIN**, real-time price, inventory status, images, category mapping.
- **Shopify** merchants get **automatic syndication** (live price/availability), no separate feed.
- **Checkout:** **PayPal**-powered one-click.
- **Ranking signals (MARKETED, integrator-stated):** structured product data, reviews, accurate
  pricing, stock availability.

> **Implication:** Perplexity deliberately **reuses the Google Shopping feed schema** — so a brand
> that produces a clean Google feed gets ChatGPT-adjacent (ACP), Perplexity, and Google coverage
> from *largely the same structured data*. This is the strongest argument for samesake to emit a
> **Google-Shopping-shaped export** as the lingua franca.

### 1.3 Google AI Mode / AI Overviews / Gemini — the Shopping Graph (PROVEN-ish)

- Google grounds product mentions in AI Mode / AI Overviews / Gemini against the **Shopping
  Graph**, built largely from **Merchant Center feeds**: **60B+ listings, ~2B updates/hour**
  (FeedOps / Appear Online citing Google).
- **Confirmed requirement:** an active Merchant Center feed with **free listings enabled** to be
  eligible.
- **Strongest matching signal: GTIN.** "wrong GTIN, missing GTIN, or made-up GTIN drops you out of
  competitive product clusters."
- **Ranking factors (MARKETED, integrator-stated):** data quality, relevance to intent, **price
  competitiveness**, **review scores**, feed health. One widely-repeated (unverified) claim:
  products with **4+ stars and 20+ reviews** get higher placement in AI product panels.
- **Caveat (PROVEN):** "Google has **not confirmed** Merchant Center as a *direct* AI Mode ranking
  signal" — but it is the shared grounding infrastructure. New Merchant Center reports now track
  brand appearance in AI Mode.

### 1.4 Amazon Rufus / Alexa+ — COSMO era (MARKETED + one pattern study)

- **Data sources:** product listings, **customer reviews**, community Q&A, browse/purchase
  history, and web content.
- **Different from A9:** Rufus reads the *full* listing — review text, Q&A, **A+ content text**,
  backend attributes — and synthesizes intent-fit. "Rufus optimization rewards **contextual
  clarity, completeness, and the structured communication of product truth**." Keyword-relevance
  (A9-style) is downweighted.
- **A+ content** has become a discovery asset; "2–3 basic modules with stock text are no longer
  enough."
- One vendor pattern-study (Amalytix, 1,300+ products) exists but Amazon publishes no spec —
  treat all Rufus ranking detail as **MARKETED/observational**, not official.
- **Relevance to samesake:** mostly out of scope — Amazon listings are managed in Seller Central,
  not via a brand feed samesake controls. The transferable lesson is **completeness + structured
  truth + review synthesis**, which is a *catalog* property samesake can improve.

### 1.5 Cross-engine synthesis — the convergent signal set

| Signal | ChatGPT (ACP) | Perplexity | Google AI Mode | Amazon Rufus | Source class |
|---|---|---|---|---|---|
| Structured feed / markup | Required (ACP feed) | Required (Google-shape CSV) | Required (Merchant Center) | Listing fields + A+ | PROVEN (specs) |
| **GTIN / identifiers** | Recommended | Required | **Strongest match signal** | ASIN/UPC | PROVEN/strong |
| Catalog **completeness** (attributes/specs) | "improve ranking" | stated | "comprehensive attributes" | "completeness" | PROVEN-ish |
| **Reviews / ratings** | "improve ranking" (OpenAI quote) | stated | review scores; 4★/20+ (unverif.) | core source | PROVEN (OpenAI) / MARKETED |
| **Price & availability freshness** | feed refresh | real-time | 2B updates/hr | live | PROVEN |
| **External authority** (3rd-party, Reddit, editorial) | web fallback | yes | yes | web content | MARKETED + 1 study |
| Rich media | "improve ranking" | images req. | quality images | A+ media | PROVEN-ish |
| **Keyword stuffing** | — | — | — | downweighted | **PROVEN it FAILS** (GEO paper) |

**The takeaway:** there is no secret. Five families — **structured data, identifiers,
completeness, reviews, freshness, authority** — recur on every engine. The only *proven-negative*
tactic is keyword stuffing.

---

## 2. AEO/GEO tactics — measurable vs snake-oil (the academic spine)

This is where the gap is genuinely fillable with **peer-reviewed evidence**, not vendor blogs.

### 2.1 GEO (Aggarwal et al., KDD 2024) — the foundational paper

- **Paper:** "GEO: Generative Engine Optimization," Pranjal Aggarwal, Vishvak Murahari, Tanmay
  Rajpurohit, Ashwin Kalyan, Karthik Narasimhan, Ameet Deshpande. **arXiv:2311.09735**, 2023,
  **accepted to KDD 2024**. **License: CC BY 4.0** (reusable with attribution).
- **Method:** black-box optimization of *content* to raise visibility in generative-engine answers;
  introduces **GEO-bench** (~10K queries, 8K/1K/1K split, tagged by intent/difficulty/domain).
- **Headline:** GEO can boost visibility **up to 40%**.
- **Per-method results** (Table 1; Position-Adjusted Word Count / Subjective Impression, % over
  baseline — quoted/derived):

| Method | Visibility change | Verdict |
|---|---|---|
| **Quotation Addition** | **~+27.8% / +24.7%** (strongest) | MEASURABLE WIN |
| Statistics Addition | ~+25.9% / +23.7% | MEASURABLE WIN |
| Fluency Optimization | ~+25.1% / +21.9% | MEASURABLE WIN |
| Cite Sources | ~+24.9% / +21.9% | MEASURABLE WIN |
| Technical Terms | ~+23.1% / +21.4% | WIN |
| Authoritative (tone) | ~+21.8% / +22.9% | WIN |
| Easy-to-Understand | ~+22.2% / +20.5% | modest |
| Unique Words | ~+20.7% / +20.4% | marginal |
| **Keyword Stuffing** | **declines ~−8% / −5%** | **SNAKE-OIL (it HURTS)** |

  Direct conclusion from the paper: traditional SEO tactics "offer little to no improvement on
  generative engine's responses." **Keyword stuffing is the proven anti-pattern.**

- **GEO's caveat for commerce:** GEO-bench is general web Q&A, not product listings. The *content*
  it optimizes is editorial prose. Apply the *direction* (add quotes/stats/citations/fluency,
  never stuff keywords) but don't assume the magnitudes transfer to a product catalog.

### 2.2 E-GEO (Bagga et al., 2025) — the e-commerce-specific testbed (MOST RELEVANT)

- **Paper:** "E-GEO: A Testbed for Generative Engine Optimization in E-Commerce," Puneet S. Bagga,
  Vivek F. Farias, Tamar Korkotashvili, Tianyi Peng, Yuhang Wu. **arXiv:2511.20867**, Nov 2025.
  **License: arXiv non-exclusive distrib.** Code/data: **GitHub `psbagga17/E-GEO`** (public).
- **What it is:** **7,000+ realistic multi-sentence consumer product queries** paired with
  listings, capturing intent + constraints + preferences. Evaluates **15 heuristic listing-rewrite
  strategies**, then formulates GEO as optimization and builds a **lightweight iterative
  prompt-optimization** algorithm.
- **Metric (important methodological upgrade over GEO):** **average rank change** of the product
  in the generative engine's output — "directly observable and reproducible through widely
  available LLM APIs," explicitly preferred over GEO's subjective "impression scores."
- **Key finding — a "universally effective" pattern.** Across 15 diverse starting heuristics, the
  *optimized* rewrites converge on a **stable, domain-agnostic pattern**:
  - emphasize/align to **buyer intent and specific needs**,
  - **highlight competitive advantages** over alternatives,
  - **incorporate external evidence — customer reviews / social proof**,
  - adopt a **persuasive, authoritative tone**,
  - **preserve factuality** (no fabrication).
- **Effect sizes (rank improvement):** best raw heuristic ("Competitive") was only **+0.71**, but
  *optimized* hit **+1.61** (±0.05 SE). Worst raw ("Storytelling") was **−4.03** raw but **+1.22**
  optimized. **10 of 15 raw heuristics were negligible/negative; all 15 optimized versions gained;
  11 improved by ≥ +1 rank position.** Lesson: *naive* rewriting often backfires; *optimized,
  intent-aligned, evidence-bearing* rewriting reliably helps.

> **This is the single most load-bearing source for samesake.** It is e-commerce-specific,
> uses a reproducible rank metric, has open code, and its "universal pattern" is *exactly* the
> kind of thing samesake's **enrich pipeline can bake into generated descriptions** —
> intent-aligned, spec-rich, review-grounded, factual. It also warns that *un-optimized* LLM
> rewriting can *hurt* rank, which argues against naive "just LLM-generate descriptions."

### 2.3 Citation Selection vs Citation Absorption (Zhang et al., 2026) — measurement rigor

- **Paper:** "From Citation Selection to Citation Absorption: A Measurement Framework for GEO
  Across AI Search Platforms," Zhang Kai, He Xinyue, Yao Jingang. **arXiv:2604.25707**, April 2026.
  **License: arXiv non-exclusive distrib.**
- **Scale:** 602 controlled prompts → 21,143 citations, 23,745 citation-level features, 18,151
  fetched pages, across **ChatGPT, Google AI Overview/Gemini, Perplexity**.
- **Core distinction:**
  - **Citation *selection*** = did the engine pick your page as a source?
  - **Citation *absorption*** = did your page's *language/evidence/structure* actually shape the
    generated answer? (the metric that matters)
- **Findings:** "citation **breadth and depth diverge**" — Perplexity/Google cite *more* sources;
  ChatGPT shows **higher citation influence per source**. **High-influence pages are longer,
  better structured, semantically aligned to the query, and contain extractable evidence
  (definitions, facts, comparisons, procedural steps).**
- **Why it matters for measurement:** counting mentions is the *wrong* KPI; **absorption** (did
  you change the answer) is the right one. This directly indicts the cheaper monitoring tools that
  only count brand mentions.

### 2.4 schema.org / structured data for AEO — measurable, with caveats

- **PROVEN-ish:** Semrush/Measured.com 2025 benchmarks (via integrator): pages with valid
  structured data (esp. FAQ/HowTo/QAPage) appear **20–30% more often** in AI summaries than
  unstructured pages. "65% of pages cited by ChatGPT include structured data" (vendor claim,
  unverified primary). **JSON-LD ~89% market share** of structured-data formats.
- **Product-specific markup:** `schema.org/Product` + `Offer` (price/availability/condition) +
  `Review`/`AggregateRating` + identifiers (`gtin`, `sku`, `brand`).
- **Honest caveat (PROVEN-ish):** schema is **necessary, not sufficient** — among sites that
  deployed structured data, "a tiny minority dominate … citations while the majority sits in a
  quiet middle getting nothing measurable." Schema gets you *eligible*; authority/quality decide
  *whether you win*.
- **`llms.txt`:** complementary to schema (site-level map vs page-level facts). Adoption exists
  but **no engine has confirmed using it**; treat as **low-cost-MARKETED**, not proven.

### 2.5 External authority / off-site mentions — measurable correlation, not samesake's lever

- Vendor study (Hexagon, 20,000+ AI product responses): brands cited in **≥5 high-authority
  third-party sources got recommended 3.1× more often** than equal-quality brands with fewer
  citations. AI engines read **Reddit, Quora, editorial roundups, review sites** to gauge brand
  authority; **high-authority placements outweigh raw mention count**.
- Wildcard's "competitors average 43 more external mentions" is **unsourced MARKETED**.
- **Verdict:** authority is a *real* signal but it is **PR/content/community work, not a catalog
  property** — explicitly **outside samesake's surface**.

### 2.6 The measurable-vs-snake-oil ledger

| Tactic | Status | Evidence |
|---|---|---|
| Submit a clean structured **feed** to the merchant program | **MEASURABLE / table-stakes** | Official specs (OpenAI/Perplexity/Google) |
| Correct **GTIN/identifiers** | **MEASURABLE** | Google "strongest match signal" |
| **Catalog completeness** (attributes/specs) | **MEASURABLE** | OpenAI ranking quote; E-GEO |
| Intent-aligned, **evidence-bearing** descriptions (quotes/stats/reviews) | **MEASURABLE** | GEO (+24–28%), E-GEO universal pattern |
| Fresh **price/availability** | **MEASURABLE** | Feed refresh requirements |
| schema.org `Product`/`Offer`/`Review` JSON-LD | **MEASURABLE (necessary, not sufficient)** | 20–30% lift studies |
| Off-site **authority** (Reddit/editorial/3rd-party) | **MEASURABLE but NOT a catalog lever** | Hexagon 3.1× |
| **Keyword stuffing** | **SNAKE-OIL (proven to hurt)** | GEO −8% |
| Naive un-optimized LLM description rewrite | **RISKY (can hurt rank)** | E-GEO 10/15 negative raw |
| "Guaranteed #1 in ChatGPT," "instant AI visibility" | **SNAKE-OIL** | No engine exposes rank control |
| `llms.txt` | **UNPROVEN (low-cost optionally)** | No engine confirmation |
| Mention-count-only dashboards as the KPI | **WEAK** (absorption ≠ selection) | Zhang 2026 |

---

## 3. The measurement / monitoring tool category

Two sub-categories have emerged; do not conflate them.

### 3.1 Pure AI-visibility monitors (track mentions/rank/sentiment)

- **Otterly.ai** — tracks brand mentions in ChatGPT, Perplexity, Google AI Overviews/AI Mode;
  pricing **from $29/mo**.
- **Peec AI** — frequency, rank, sentiment across ChatGPT/Perplexity/Gemini/AI Overviews.
- **Visiblie** — up to 8 models (ChatGPT, Gemini, Perplexity, Claude, DeepSeek, Grok, Meta AI,
  Mistral) on enterprise.
- These answer "are we mentioned and where?" — but per Zhang 2026, mention-count is the *shallow*
  KPI; **citation absorption** is the deep one few tools measure.

### 3.2 Agentic-commerce infra + GEO platforms (feed + checkout + monitoring)

- **Wildcard (`wild-card.ai`, YC)** — "GEO platform that gets e-commerce brands discovered inside
  ChatGPT Shopping, Gemini, and every AI assistant." Does **catalog optimization + real-time
  inventory sync + Instant Checkout** on **ACP + UCP**; integrates Shopify/BigCommerce/Magento/
  WooCommerce/SFCC. Monitors mention frequency, rank, context, drift across high-intent queries
  and personas. Claims: "67% of products lack the attributes AI needs"; "collection pages & FAQs
  are the most cited"; "changes reflect in rankings within 24–48h" (unverified); "competitors
  average 43 more external mentions" (unsourced). **Pricing: contact/demo (undisclosed).**
- **Athos Commerce** — "Intelligent Discovery Platform": **search + personalization +
  merchandising + product-feed management + GEO** in one. Three agents: **GEO Assistant**
  (optimize/enrich product data for AI answer engines), **Channel Assistant** (feed management
  across Google/Meta/TikTok/marketplaces/AI channels). **Notably fashion-positioned** (separate
  fashion-ecommerce AI-discovery report, June 2026 — businesswire fetch timed out; relevance is
  the *fashion* framing). This is the **closest competitor-shaped overlap to samesake**, because it
  bundles internal discovery *and* external GEO.

### 3.3 What this category tells samesake

- The **monitoring** half (mention/rank tracking) is a *separate product* samesake should
  **not** build — buy/integrate Otterly/Peec or expose data for them.
- The **feed/enrich/optimization** half is **exactly samesake's enrich-pipeline territory** —
  Athos and Wildcard's "GEO Assistant / catalog optimization" is *enrich-for-external-legibility*,
  which samesake already half-does internally. The differentiator: samesake's enrich output is
  **typed and provenance-tracked**; it can emit a *faithful* feed instead of an LLM-puffed one.
- **Beware the bundle creep.** Athos shows the gravitational pull from "search" → "GEO" → "feed
  management" → "checkout." samesake's deliberate scope (stops at retrieval) is a *feature*; the
  GEO contribution should be a **clean export boundary**, not a second product.

---

## 4. Brand-owned retrieval layer ↔ external-agent discoverability

This is the crux the gap asked for: **what is the relationship, and what can samesake DO?**

### 4.1 The shared substrate: a legible catalog

samesake already compiles a **typed catalog → enriched, deduped, attribute-rich documents** for
its internal Postgres+pgvector index. **Every signal external agents reward is a property of that
same catalog**:

| External-agent signal | samesake artifact that produces it |
|---|---|
| Structured attributes / completeness | **Typed catalog schema** + **enrich** attribute extraction |
| Clean identifiers (GTIN/SKU/brand) | Catalog fields + **entity-resolution/dedup** |
| Intent-aligned, evidence-bearing descriptions | **enrich** generation (E-GEO universal pattern) |
| Reviews / ratings in feed | If catalog carries reviews → emit in `Review`/feed |
| Field-level provenance ("waterproof ← spec.materials") | enrich provenance (already flagged in 08-rag) |
| Fresh price/availability | catalog re-compile cadence |
| schema.org JSON-LD / Google-shape CSV / ACP feed | **NEW export adapters** (the missing piece) |

**The insight:** discoverability inside an external agent is *mostly upstream of ranking* — it is
**data legibility**. samesake cannot control ChatGPT's ranker, but it can guarantee that the
catalog it compiles is the *most legible possible input* to that ranker. **Legibility is a
retrieval-layer property; rank is not.** samesake stays in scope by owning the former and
refusing the latter.

### 4.2 What samesake should DO (concrete, in-scope)

1. **Feed export adapters (highest leverage).** Emit the compiled catalog as:
   (a) **Google Shopping CSV** (lingua franca → Perplexity + Google + most aggregators),
   (b) **OpenAI ACP product feed** (CSV/JSON per spec),
   (c) **schema.org `Product`/`Offer`/`Review` JSON-LD** for on-site embedding.
   One typed catalog → three emitters. This is a *compiler target*, perfectly aligned with the
   "search engine compiler" identity. **Adopt.**
2. **Enrich-for-legibility mode.** Have the enrich pipeline optionally generate descriptions that
   follow the **E-GEO universal pattern** (intent-aligned, spec-rich, review-grounded, factual)
   *while preserving factuality via provenance*. Crucially, E-GEO shows naive rewrites *hurt* —
   so gate generated copy behind provenance/factuality checks samesake already has the bones for.
   **Adopt, carefully.**
3. **Completeness/feed-health linter.** A `/catalog/lint` that scores each product against the
   convergent signal set (missing GTIN, thin description, no attributes, stale price, no image,
   keyword-stuffed title → flag). Wildcard's "67% lack attributes" is exactly this gap; samesake
   can *measure it at compile time* with no external dependency. **Adopt — strong differentiator.**
4. **Field-level provenance in the feed.** The 08-rag finding (provenance: `waterproof ← spec`)
   doubles as GEO fuel — citation **absorption** (Zhang 2026) rewards extractable, evidence-bearing
   facts. Provenance-backed attributes are *more absorbable*. **Integrate** with the existing
   provenance work.
5. **`/search/explain` → external-legibility report.** Reuse the auditability surface to answer
   "why might/why not this product be surfaced by an external agent?" — same explain machinery,
   new lens. **Differentiate.**

### 4.3 What samesake should NOT do (out of scope / marketing)

- **Do not** claim to control or "guarantee" ranking inside ChatGPT/Perplexity/Google. No engine
  exposes that; claiming it is snake-oil. **Avoid.**
- **Do not** build off-site authority / PR / Reddit-seeding. Real signal, wrong layer. **Avoid.**
- **Do not** build checkout (ACP/UCP/Stripe/PayPal Instant Checkout). `findProducts()` **stops at
  retrieval** by design; checkout is a separate protocol surface. **Avoid** (or at most expose a
  hand-off — already in the UCP/ACP/MCP adapter plan).
- **Do not** build the mention-monitoring dashboard. Buy/integrate Otterly/Peec. **Integrate, not
  build.**
- **Do not** ship a naive "LLM-rewrite all descriptions" feature without factuality gating —
  E-GEO shows it can *reduce* rank. **Avoid the naive version.**

### 4.4 The LK-fashion reality check (anchor)

External-agent discoverability is **structurally weaker for samesake's real corpus**:

- **Merchant programs are US-/payment-gated.** OpenAI Instant Checkout = approved partners;
  Perplexity checkout = PayPal; Google = Merchant Center. LK SKUs face onboarding, currency,
  and payment-rail friction. **Feed *submission* may be possible; in-agent *transactability* often
  is not.**
- **Shopping Graph coverage is thinner** for LK-market SKUs; GTIN discipline is often weaker in
  LK fashion catalogs (handloom/artisan items frequently lack GTINs entirely) — and GTIN is
  Google's strongest match signal. Missing GTIN ≠ disqualified everywhere (ACP only *recommends*
  it) but it's a real handicap on Google.
- **Grounding is English-dominant.** The off-site authority web (Reddit/editorial) barely covers
  LK fashion in any language, and code-mixed Sinhala/Tamil product copy is *less absorbable* by
  English-tuned engines — the same weakness flagged in `multilingual-and-codemixed-retrieval.md`.
- **Therefore:** the defensible samesake play for LK is **feed-legibility + clean schema.org
  export + completeness linting** (things that work regardless of payment rails and that
  *also* improve the internal index), **not** chasing in-agent rank against US-centric grounding.
  A side benefit: producing English-normalized, attribute-rich enrich output for the feed is the
  *same* artifact that helps code-mixed internal retrieval. **One investment, two payoffs.**

---

## 5. Open questions

1. **Does the OpenAI ACP spec actually accept XML/TSV and 15-min refresh, or only CSV/JSON +
   daily?** The spec fetch and key-concepts disagreed with integrator blogs. Needs a direct
   re-read of `developers.openai.com/commerce/specs` (it was partially unparsed here).
2. **How much of E-GEO's "universal pattern" rank-lift survives on a *real* engine vs the paper's
   LLM-API harness?** The metric is reproducible but the engines drift; would need a live
   replication on a samesake LK sample.
3. **Citation absorption for *product* answers** — Zhang 2026 is general web Q&A. Is there an
   absorption metric for product *recommendation* (not citation)? Likely a research gap samesake
   could even contribute to.
4. **Does any engine read `schema.org` markup for products it can *also* get via feed, or does
   the feed dominate?** Determines whether on-site JSON-LD is redundant for feed-submitting brands.
5. **LK payment-rail path:** is there *any* route to in-agent transactability for LK merchants
   (e.g., via a Stripe-supported entity, marketplace intermediary), or is discovery-only the
   ceiling? Determines whether the feed export is "discovery theater" or actually monetizable.
6. **GTIN-less artisan/handloom items** — what is the best-practice identifier strategy
   (MPN? brand+model? custom)? Affects a large share of the LK fashion corpus.
7. **Athos overlap:** Athos bundles search + GEO + feed + fashion focus — is it a competitor, a
   reseller channel, or a partner samesake could *feed* (samesake as the compile/legibility layer
   under Athos's distribution)? Worth a dedicated competitive read (the businesswire fashion
   report timed out and should be re-fetched).

---

## 6. Relevance to samesake — adopt / avoid / differentiate / integrate

- **ADOPT — Feed export adapters** (Google Shopping CSV, OpenAI ACP CSV/JSON, schema.org JSON-LD).
  One typed catalog → three compiler targets. Perfectly on-identity ("search engine compiler"),
  directly improves external legibility, zero scope creep into ranking/checkout.
- **ADOPT — Compile-time completeness/feed-health linter** (`/catalog/lint`). Scores products
  against the convergent signal set (GTIN, attributes, description quality, freshness, image,
  anti-stuffing). Measurable, dependency-free, attacks Wildcard's "67% lack attributes" claim
  with an actual local check.
- **ADOPT (carefully) — Enrich-for-legibility mode** following the **E-GEO universal pattern**,
  *gated by factuality/provenance* (E-GEO proves naive rewrites can lower rank).
- **DIFFERENTIATE — Provenance-backed, absorbable attributes.** samesake's typed + field-level
  provenance output is *more citation-absorbable* (Zhang 2026) and more *faithful* than the
  LLM-puffed copy GEO vendors emit. "Legible without lying" is the wedge.
- **DIFFERENTIATE — `/search/explain` as an external-legibility report** ("why surfaceable?").
  Reuse existing auditability; no new infra.
- **INTEGRATE — monitoring** (Otterly/Peec/Visiblie): expose data / consume their API; don't build
  a mentions dashboard.
- **INTEGRATE — checkout** via the already-planned UCP/ACP/MCP adapters as a *hand-off*, keeping
  `findProducts()` stopped at retrieval.
- **AVOID — ranking guarantees, off-site authority/PR, building checkout, naive LLM rewrite,
  mention-count-as-KPI.** All either out of layer or proven weak/harmful.

**One-line thesis:** samesake cannot and should not chase *rank inside* external agents — but it
*owns the one thing every external agent rewards first*: a **legible, complete, identifier-clean,
evidence-bearing, faithfully-enriched catalog**, emittable as a feed. Ship the export adapters and
the completeness linter; refuse the ranking-control fantasy.

---

## Sources

**Official platform specs (PROVEN):**
- OpenAI Agentic Commerce — Key concepts: https://developers.openai.com/commerce/guides/key-concepts
- OpenAI Product Feed Spec: https://developers.openai.com/commerce/specs/spec
- OpenAI Product feeds overview: https://developers.openai.com/commerce/specs
- Perplexity Merchant Program ToS: https://www.perplexity.ai/hub/legal/merchant-program-terms-of-service

**Academic (PROVEN):**
- Aggarwal et al., "GEO: Generative Engine Optimization," arXiv:2311.09735, KDD 2024, **CC BY 4.0**:
  https://arxiv.org/abs/2311.09735 · full text https://arxiv.org/html/2311.09735v2
- Bagga et al., "E-GEO: A Testbed for GEO in E-Commerce," arXiv:2511.20867, Nov 2025 (code:
  github.com/psbagga17/E-GEO): https://arxiv.org/abs/2511.20867 · https://arxiv.org/html/2511.20867
- Zhang et al., "From Citation Selection to Citation Absorption: A Measurement Framework for GEO,"
  arXiv:2604.25707, Apr 2026: https://arxiv.org/abs/2604.25707

**Engine signal write-ups (MIXED — integrator/vendor, treat as MARKETED unless tied to a spec):**
- Google Shopping Graph (60B listings): https://feedops.com/google-shopping-graph-explained/ ·
  https://www.appearonline.co.uk/blog/google-shopping-graph-explained
- Google Merchant Center AI Mode report: https://ppc.land/googles-new-merchant-center-report-tracks-your-brand-in-ai-mode/
- Perplexity merchant setup: https://alhena.ai/blog/perplexity-shopping-merchants-setup-guide/ ·
  https://www.shopify.com/blog/perplexity-shopping · https://www.webfx.com/blog/ai/perplexity-merchant-program/
- Amazon Rufus / COSMO: https://www.zonguru.com/blog/optimize-amazon-listing-for-rufus ·
  https://www.amalytix.com/en/knowledge/ai/amazon-rufus-pattern-analysis/ ·
  https://www.bellavix.com/amazon-rufus-and-cosmo-explained-how-amazons-ai-is-changing-search-rankings-and-listing-optimization/
- Schema.org for AI search: https://alhena.ai/blog/schema-markup-ai-search-ecommerce/ ·
  https://www.digitalapplied.com/blog/schema-markup-adoption-5k-site-audit-2026
- External authority (Hexagon 3.1×): https://joinhexagon.com/blogs/how-ai-search-engines-actually-decide-which-produc-mq1ybgmu-bmb3 ·
  https://naridon.com/en/blog/ai-engines-brand-recommendations · https://www.yotpo.com/blog/ai-ranking-factors-for-ecommerce/

**Tool/vendor category (MARKETED):**
- Wildcard: https://wild-card.ai/ · https://wild-card.ai/instant-checkout · YC: https://ycombinator.com/companies/wildcard
- Athos Commerce platform: https://athoscommerce.com/products/ · launch:
  https://www.businesswire.com/news/home/20260610119791/en/Athos-Commerce-Unveils-Intelligent-Discovery-Platform-to-Help-Brands-Win-in-the-Era-of-Agentic-Commerce ·
  fashion report (fetch timed out, re-fetch): https://www.businesswire.com/news/home/20260604180849/en/
- Otterly.ai (from $29/mo): https://otterly.ai/ · monitor roundups:
  https://www.useomnia.com/blog/ai-search-monitoring-tools · https://slatehq.com/blog/ai-search-visibility-tools

**Fetch failures noted:** Athos fashion-report businesswire page (60s timeout) — re-fetch needed;
relevance is the *fashion-AI-discovery* framing, captured from search snippet only.
