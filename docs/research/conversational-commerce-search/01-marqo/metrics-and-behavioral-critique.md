# Marqo: Evaluation Philosophy & the Behavioral/Cold-Start Critique

> Competitive/technical dossier mined from 10 Marqo blog posts (scraped 2026-06-14).
> Anchored to **samesake** — the TypeScript-first "search engine compiler" for visual commerce
> (Postgres + pgvector hybrid retrieval: FTS + cosine ANN over BYO embeddings + optional typed
> "spaces" vectors, fused via RRF; hard filters gate before ranking; NLQ parser; multimodal enrich;
> `/search/explain`; `findProducts()` agentic surface that stops at retrieval).
>
> **Reading note on provenance.** These posts are Marqo marketing collateral (each ends with a
> "Book a demo" CTA, `robots: noindex,nofollow`, and a customer-logo wall). The metric *definitions*
> are textbook-correct and reusable. The *benchmark numbers and customer ROI figures* are
> self-published, uncontrolled, and unaudited — treated as marketing unless otherwise noted. One
> scrape (`why-behavioral-search-fails-for-resale`) even names a competitor ("Constructor") in its
> meta description, confirming the competitive-positioning intent.

---

## 1. Metric Definitions (as Marqo frames them)

Marqo's four "Growth Metrics" primers (all authored by Ellie Sleightholm, Head of DevRel, dated
April 14 2026) are clean, correct IR primers wrapped in ecommerce framing. The definitions are
defensible technical substance; the surrounding revenue claims are marketing.

### 1.1 Precision

- **Definition (verbatim):** "Precision = (Relevant results retrieved) / (Total results retrieved)".
  Example given: 14 of 20 relevant → 0.70.
- **Precision@K:** "Precision@5 asks: of the top 5 results, how many are relevant?" Marqo names
  **Precision@10** as "the most commercially relevant cutoff" for ecommerce ("the products visible
  without scrolling on a desktop results page").
- **Interpretation bands (Marqo's published rubric):**
  - Precision@10 > 0.80 = "Strong"
  - 0.60–0.80 = "Moderate" ("Two to four irrelevant results per page")
  - < 0.60 = "showing more irrelevant results than relevant ones ... actively damaging conversion"
  - Claim: "Most sites score between 0.55 and 0.75 when measured honestly across all query types,
    not just manually curated head queries."
- **Framing angle:** precision is positioned as the *conversion/trust* metric. "Trust erosion,"
  "cognitive load," "perceived catalog quality," and "bounce acceleration" are the four named harms
  of irrelevant results. The bounce effect is claimed to be **non-linear** ("The first irrelevant
  result ... has a moderate impact. The third has a severe impact").

### 1.2 Recall

- **Definition (verbatim):** "Recall = (Relevant items retrieved) / (Total relevant items in the
  collection)". Example: 12 of 45 jackets → 0.267.
- **Recall@K:** "Recall@10 asks: of all relevant products, how many appear in the top 10 results?"
  Marqo names **Recall@20 / Recall@50** as "typical evaluation points" for ecommerce (one to two
  pages).
- **Interpretation bands:**
  - Recall@20 > 0.70 = "Strong"
  - 0.40–0.70 = "Moderate"
  - < 0.40 = "missing the majority of relevant products ... major revenue leakage"
- **Framing angle:** recall is "the most underappreciated metric" precisely because its failures are
  **invisible**: "No shopper complains about a product they do not know exists." This is the
  rhetorical core of the whole dossier — Marqo argues you can have perfect precision and perfect
  ranking and still bleed revenue if recall is low. "No results" is framed as "the most extreme
  recall failure: recall of zero."
- **Honest methodological caveat (worth crediting):** Marqo concedes recall is hard to measure
  because "Measuring recall requires knowing the total number of relevant products for each query."
  Their recommended protocol: pick 100–300 queries, define relevance per query (manual for small
  catalogs; "category filtering, attribute matching, and human judgment on samples" for large),
  capture top 20–50, average.

### 1.3 MRR (Mean Reciprocal Rank)

- **Definition (verbatim):** "MRR = (1/N) × Σ (1 / rank_i)" where rank_i is the position of the
  *first* relevant result. Worked example: positions 1, 3, 2 → (1.0 + 0.33 + 0.50)/3 = **0.61**.
- **Semantics:** "An MRR of 1.0 means the best product is always in position one. An MRR of 0.5
  means the best product is typically in position two."
- **Interpretation bands:** > 0.80 "Excellent"; 0.60–0.80 "Good but with clear room"; < 0.60
  "failing on first-result accuracy." Claim: "most sites score between 0.45 and 0.65."
- **Stated limitations (technically sound):**
  - MRR "only cares about the single best result and ignores everything else."
  - "MRR does not penalize missing products. If only one relevant product appears in the entire
    result set, MRR can still be 1.0 as long as that product is in position one."
  - Distinguished correctly from MAP: "MRR only considers the first relevant result. MAP considers
    all relevant results and their positions."
- **Click power-law claim (marketing-flavored but plausible):** "position one receives 30 to 40
  percent of all clicks. Position two receives 15 to 20 percent ... By position five, click
  probability drops below 5 percent." No source cited — treat as directional, not citable.

### 1.4 NDCG (Normalized Discounted Cumulative Gain)

This is the most technically detailed primer and the one Marqo positions as its **headline eval
metric**.

- **Build-up (verbatim):**
  - Cumulative Gain: sum of graded relevance scores; "[4, 3, 0, 1, 2] has a cumulative gain of 10"
    — and critically "[0, 1, 2, 3, 4] also scores 10," exposing CG's order-blindness.
  - **DCG = Σ (relevance_i / log₂(i + 1))**. Worked: position 1 divisor log₂(2)=1; position 2
    log₂(3)≈1.58; position 10 log₂(11)≈3.46 ("a perfect-relevance product in position 10 contributes
    less than a third of what it would in position 1").
  - **NDCG = DCG / IDCG**, normalized 0–1 against the ideal ordering.
- **Why NDCG for ecommerce (the key argument):** it captures the **gradient of relevance** that
  binary metrics collapse. "A bright red cocktail dress is somewhat relevant. A burgundy formal gown
  is more relevant. A red chiffon wedding guest dress in the shopper's size and price range is highly
  relevant. Binary relevance ... collapses these distinctions. NDCG preserves them." Uses a 0–4 graded
  scale (0 irrelevant → 4 perfect match).
- **Recommended cutoff:** NDCG@10.
- **Interpretation bands:** "Most ecommerce sites score between 0.45 and 0.65 on NDCG@10." > 0.70
  "strong"; > 0.80 "exceptional"; "Marqo customers consistently achieve scores in the 0.75 to 0.90
  range" (marketing claim, uncontrolled).
- **Anti-gaming property (correct):** "NDCG is evaluated at a fixed cutoff ... so reducing the number
  of results does not help. The normalization against the ideal ranking means you cannot score well
  simply by hiding bad results."
- **NDCG vs CTR (a genuinely sharp point):** "Click-through rate measures what shoppers clicked, not
  what they should have clicked. CTR is influenced by product images, prices, and promotions, not just
  relevance. NDCG measures ranking quality independent of those factors." — This is the cleanest
  articulation in the corpus of *why offline graded eval beats behavioral signal as a quality gate.*
- **Stated self-justification for benchmarking on NDCG:** "Marqo publishes NDCG benchmarks because it
  is the most honest measure of search quality. It is easy to cherry-pick metrics that make any system
  look good. High recall does not mean good search. High precision at position one does not mean the
  rest of the results are useful."

### 1.5 Metric Cross-Comparison (Marqo's own framing)

From the MRR post — "The strongest ecommerce search evaluation combines all four":

| Metric | Question it answers | Named blind spot |
| --- | --- | --- |
| **MRR** | "did we nail the first result?" | ignores everything below first relevant hit; ignores missing products |
| **NDCG** | "right products in right order across the page?" | needs graded human judgments (labor-intensive) |
| **Recall** | "is anything relevant missing?" | says nothing about ranking/order |
| **Precision** | "how many shown results are relevant?" | says nothing about order or coverage |

Marqo's stated discipline: "Marqo benchmarks across all four because optimizing one at the expense of
others creates blind spots." **This is the single most adoptable idea for samesake's eval gate** (see §6).

---

## 2. Concrete Numbers Cited (defensible vs marketing)

| Figure | Source post | Classification |
| --- | --- | --- |
| Precision/recall/MRR/NDCG **formulas + worked examples** | all 4 primers | **Technical substance** — textbook-correct, reusable |
| Score-band rubrics (e.g. NDCG@10 0.45–0.65 "typical") | primers | **Soft benchmark** — plausible industry lore, no citation |
| "**88% improvement in NDCG over Amazon Titan**" | NDCG post | **Marketing** — self-published, "blended score across all query types," no methodology link |
| "**17.6% improvement in MRR over the best-performing proprietary model**" | MRR post | **Marketing** — unnamed baseline, no methodology |
| "**73–78% relevance improvement** vs generic embedding models on 4M+ products" | semantic-vs-keyword + best-practices | **Marketing** — repeated across posts; no benchmark def or holdout disclosed |
| Click power law (pos 1 = 30–40% clicks) | MRR post | **Industry lore** — directional, uncited |
| Precision↔conversion: "each 10-pt Precision@10 gain → 4–8% conversion gain" | precision post | **Marketing** — "well-documented" but no citation |
| **Median conversion lift 31%** (range 12%→55%) across customers | how-ai-boosts-conversion | **Marketing** — self-reported aggregate |
| Zero-results rate **drops 58%** post-migration | how-ai-boosts-conversion | **Marketing** — self-reported |
| Personalization adds **15–25% incremental conversion** in A/B | how-ai-boosts-conversion | **Marketing** — self-reported |
| "70–80% of catalog sits in the long tail with insufficient behavioral signal" | clickstream-fails + semantic-vs-keyword | **Plausible/marketing** — recurring claim, no source |
| Legacy zero-result rate **10–25%** (keyword) vs **< 2%** (AI-native) | semantic-vs-keyword | **Marketing** — comparison table, self-defined |
| Resale market **$350B by 2027** | resale post | **Third-party-style stat**, uncited here (broadly circulated figure) |
| **Customer ROI:** Fashion Nova $130M; Kogan $10.1M; Redbubble $11M (+21% on descriptive queries); Mejuri +19.84% search rev/+14.72% purchase conv; KICKS CREW +17.7% conv/+28% cart value; SwimOutlet +10.6% ATC, live in 5 days | multiple | **Marketing** — customer-attributed, uncontrolled attribution |

**Bottom line on numbers:** none of the comparative benchmark claims are independently verifiable from
these posts (no linked methodology, holdout sets, or third-party audit). Use the *metric definitions and
score bands* as a reference; discount the *deltas*.

---

## 3. The Clickstream / Behavioral-Only Critique (the core competitive argument)

Three posts carry this: `why-clickstream-only-systems-fail-on-new-products` (the strongest, by Ana
Martinez, Head of Growth), `why-behavioral-search-fails-for-resale`, and the behavioral sections of
`semantic-vs-keyword`. The argument is genuinely well-constructed and is the most directly relevant
material to samesake.

### 3.1 The framing: "the behavioral information bottleneck"

> "For the last decade, ecommerce discovery has been built on a single, unchallenged premise: that the
> shopper knows best ... a world where search engines and recommendation carousels are powered by a
> massive, reactive loop of behavioral data. If a product is clicked, it is relevant."

The named cost is the **"behavioral tax"**: "lost revenue from undiscovered inventory and the high cost
of manual merchandising." Behavioral data was "a necessary workaround for a time when computers could
not see or read product catalogs at scale" — i.e., framed as a legacy crutch now obsolete.

### 3.2 Three structural failure modes

1. **The Invisibility of the New (cold-start).** "In a system that requires a threshold of click data
   to determine relevance, a new arrival is essentially invisible." Workarounds (boosting attribute-similar
   past winners, manual overrides, synthetic interaction data) "are patches, not solutions. They rely on
   the assumption that a new item behaves like an old one. A genuinely novel product ... has no past
   winners to resemble." Quantified: "70-80% of the catalog sits in the long tail with insufficient
   behavioral signal ... The products a retailer most wants to move are the ones with the least click
   history."

2. **The Homogenization of Curation.** "When discovery is driven by aggregate behavior, the storefront
   begins to drift toward the median ... burying the niche, high-margin, or stylistically unique products
   that define a brand's identity ... A curated boutique and a discount outlet, both optimizing for
   click-through rate, will converge toward the same discovery patterns ... The AI creates work instead of
   reducing it" (merchandisers forced into perpetual rule-writing to counter drift).

3. **The Contextual Gap.** "Behavioral data tells you that a shopper clicked, but it rarely tells you
   why ... Was it the material? The silhouette? The price point? The occasion? ... It is playing a game of
   probability rather than a game of understanding." Breaks on intent queries with "no clean keyword match
   and no behavioral template" (e.g., "Waterproof hiking boots that don't look like hiking boots").

### 3.3 The cold-start trap stated precisely

> "In behavior-dependent systems, a new product cannot rank until enough shoppers have clicked on it to
> generate signals. This creates a cold-start problem: the product needs exposure to generate data, but it
> cannot get exposure without data." (recall post)

### 3.4 Five scenarios where the bottleneck is most expensive

New product launches / seasonal drops; long-tail & niche inventory ("not 1% of the catalog falling
through the cracks. It is 99%"); fast-changing/high-turnover catalogs; **resale & recommerce**; emerging
categories / market expansion.

### 3.5 Resale as the "hardest test case"

The resale post is the sharpest articulation of cold-start-as-permanent-state:

- "**Every item is one-of-a-kind.** A pre-owned Gucci bag is not the same as another pre-owned Gucci bag."
- "**Items sell fast** ... By the time a behavioral search engine accumulates enough clicks to learn that
  a product is relevant, it has already been purchased."
- "**Zero behavioral history per item** ... A behavioral search engine has literally nothing to learn from."
- "**User-generated descriptions are inconsistent**" — '"vintage denim jacket, light wash, excellent
  condition"' vs '"jean jacket, worn twice, like new"' must be understood as similar "even though they
  share almost no keywords."
- "**Visual condition matters**" — scratches, patina, fading are visual attributes "that text-based search
  cannot capture."
- Conclusion: "A behavioral engine in a resale environment is **perpetually in cold-start mode**. Every
  single listing is a new product with zero history. The engine never accumulates enough data to improve
  because the inventory turns over before learning can happen."
- Generalization claim: "The resale problem is actually a preview of where all of ecommerce is heading."

### 3.6 Marqo's proposed answer (the architectural pivot)

> "Behavior-dependent systems start with clicks and use product data to supplement. Commerce
> Superintelligence starts with product understanding and uses behavioral data to sharpen. Both use
> behavioral data. The difference is the starting point."

Their stance is explicitly *not* "kill behavioral data" — it's **invert the dependency order**: content
understanding is the day-one floor; behavioral signal is a refinement layer on top, not the prerequisite
for intelligence. They also push a **single intelligence layer** thesis (one model for search +
recs + category pages + conversational agent) to avoid fragmentation where "a shopper's visual search for
a 'boho summer dress' does not match the results in the recommendation carousel."

---

## 4. Semantic-vs-Keyword Argument

The `semantic-vs-keyword` post reframes the debate for 2026:

> "The old framing was keyword search vs semantic search. That debate is over ... The relevant comparison
> today is [Legacy Keyword] vs [AI-Layered Search] vs [AI-Native Search]."

Their three-column taxonomy:

| Capability | Legacy Keyword | AI-Layered (generic embeddings bolted on) | AI-Native (purpose-built) |
| --- | --- | --- | --- |
| Architecture | BM25 / TF-IDF token match | generic embeddings on keyword infra | models trained on ecommerce data |
| New-product handling | text-match dependent | **needs behavioral data to rank** | zero-shot from day one |
| Long-tail zero-result | 10–25% | fewer, but relevance degrades | < 2% |
| Visual | none | rare (text-only) | multimodal (text + image, one space) |

**Crucially, Marqo does NOT claim keyword search is dead** — a point samesake's hybrid design should
note as validation:

> "Keyword search is not dead and should not be. It remains the best approach for ... SKU and model number
> lookups ... Brand-specific navigational queries ... Exact product name searches. ... If a shopper types
> an exact SKU and gets semantically similar products instead, the system is broken in the other direction.
> The right architecture **blends keyword precision for exact matches with AI understanding for everything
> else.** This is table stakes in 2026, not a differentiator."

Their three named structural limits of "AI-layered" generic-embedding search: (1) generic models don't
understand product-specific vocabulary ("pump" = heel type in footwear; "running low" ≠ "running shoes"),
(2) behavior-dependent ranking creates new-product/long-tail blind spots, (3) text-only models miss visual
intent. The post includes a useful **evaluation cookbook** — query archetypes that "expose the
architecture": conceptual/intent queries, style/visual queries, a new-product test (add a product with no
click history, search by description), synonym-consistency test (couch/sofa, sneakers/trainers should
return near-identical results), and a zero-result audit (re-run your zero-result log; "> 2-3% still
zero = the AI is not doing its job").

---

## 5. Best-Practices & UX Prescriptions

### 5.1 From `ecommerce-search-engine-best-practices`

- **Framing:** "Search is a Revenue Problem, Not a UX Problem." "Shoppers who use search convert at 2 to
  4x the rate of browsers." Five common mistakes: keyword-only matching; ignoring zero-result queries
  ("Most retailers have zero-result rates between 10 and 15%, and many don't even track it"); no search
  merchandising strategy; desktop-only thinking ("More than 70% of ecommerce traffic is mobile");
  set-and-forget config (relevance "degrades over time").
- **Relevance:** move beyond lexical; understand images+text together; fine-tune per catalog.
- **Merchandising:** boost/bury rules accessible to non-technical users; search data feeds category pages;
  align merchandising to business calendar.
- **UX:** autocomplete that predicts products (not just completes words); **filters that adapt to the
  query** (running shoes → cushioning/pronation/terrain; cocktail dresses → neckline/sleeve/occasion);
  graceful misspelling/synonym handling; mobile-first.
- **Measurement (the named KPI set):** search conversion rate (the "north star"), revenue per search,
  zero-result rate (target **< 5%**; "above 10% ... urgent"), CTR on first result, search exit rate.
  **"Run A/B tests on search ... Many retailers make search changes based on qualitative review alone,
  which is how regressions go undetected for months."**
- **Vendor-eval questions** (lightly self-serving but reusable): how does the relevance model work; can it
  fine-tune on my catalog; realistic go-live timeline; how do I measure impact (native A/B); is it a point
  solution or full platform.

### 5.2 From `ai-native-ecommerce-search-ux-design`

The thinnest, most generic post (no metrics, no customers). UX interaction patterns proposed for
AI-native discovery:

- **Semantic filtering** — adjust the *interpretation of the query* rather than applying explicit metadata
  filters ("a shopper searching for a green shirt does not necessarily need to apply a manual color
  filter"). Useful "even when catalog metadata is incomplete or inconsistent."
- **Query enrichment through prompt templates** — inject context to shape interpretation (e.g., emphasize
  "illustration, pixel art, or futuristic" styles).
- **Multiple query inputs** — separate fields for primary query + attributes to *emphasize* + attributes to
  *minimize* (a positive/negative-prompt-style UX).
- **Inter- and intra-category recommendations** from the *same* discovery engine ("without building a
  separate recommendation system").
- **Personalized discovery** ranked by individual preference/behavior/history.

### 5.3 Conversational UX thread (Sibbi)

Across posts, Marqo positions "Sibbi" as a conversational agent that "guides shoppers from discovery
**through post-purchase**" (order tracking, returns) — i.e., it deliberately goes *past* retrieval into
transaction and support. Notable framing for precision: in conversation "every product recommendation must
be precise. There is no results page where the shopper can scan past irrelevant options ... A search
results page showing three irrelevant products out of ten is tolerable. A conversational agent
recommending one irrelevant product out of three feels like a failure." (Higher precision bar in chat.)

---

## 6. Relevance to samesake

### 6.1 Adopt for the eval gate

- **Benchmark on all four metrics, not one.** Marqo's strongest reusable idea: MRR + NDCG@10 + Recall@K +
  Precision@K together, because "optimizing one at the expense of others creates blind spots." samesake
  already reports mean grade@10 (~2.33) and P@5 (0.83). Add **NDCG@10** (Marqo's argument that graded NDCG
  is the most honest single ranking metric is sound) and **Recall@20/@50** (catches the invisible-misses
  failure mode that P@5 cannot see). The "spaces"-off-by-default decision was made on an eval gate —
  adding NDCG@10 + Recall as gate criteria would make that gate more defensible.
- **Use graded relevance, not binary.** samesake's "grade@10" already implies graded labels — this aligns
  with Marqo's 0–4 NDCG scale. Keep graded labels and compute NDCG from them rather than collapsing to
  binary P@K.
- **NDCG-over-CTR is the philosophical anchor.** Marqo's cleanest point: CTR is confounded by image/price/
  promo; graded NDCG measures *ranking quality independent of those factors*. This is the formal
  justification for samesake's content-first eval-gate posture and for *not* gating "spaces" on click data.
- **Score bands as a sanity reference (not a target):** NDCG@10 0.45–0.65 "typical," >0.70 strong; P@10
  >0.80 strong; Recall@20 >0.70 strong; MRR >0.80 excellent. samesake's P@5 0.83 sits in/above Marqo's
  "strong" precision band — a usable external sanity check, with the caveat that the bands are uncited lore.
- **Track zero-result rate as a first-class gate metric.** Marqo's "< 5% target, > 10% urgent" and the
  "re-run your zero-result log" audit map directly onto something samesake can compute deterministically
  from its corpus + query set. This is a recall-floor proxy that needs no human labels.

### 6.2 samesake's content-retrieval sidesteps the behavioral cold-start trap — by design

This is the dossier's most important strategic finding. **Marqo's entire competitive thesis is an argument
for exactly the architecture samesake already has, against the clickstream incumbents samesake is not.**

- samesake retrieves over **BYO content embeddings (cosine ANN) + FTS**, fused by RRF, with *no dependence
  on clickstream/behavioral ranking*. By Marqo's own framing this means samesake is "**zero-shot from day
  one**" — a new product is rankable the moment it is enriched and embedded, with no exposure-to-generate-
  data chicken-and-egg.
- The **cold-start trap** ("needs exposure to generate data, but cannot get exposure without data") simply
  **does not occur** in a content-first retrieval layer. samesake's enrich pipeline + embeddings ARE the
  day-one understanding floor Marqo sells as "Commerce Superintelligence."
- The **resale/one-of-a-kind/fast-turnover** worst case — Marqo's "hardest test case," "perpetually in
  cold-start mode" — is the case samesake handles natively: every item is understood from its content/image
  enrich at index time. samesake should explicitly claim this in positioning. (Fashion-first + resale-
  adjacent is squarely in samesake's lane.)
- **Homogenization / median-drift** critique is an argument *for* samesake's design: content-driven RRF
  retrieval doesn't collapse toward bestsellers, so niche/high-margin/editorial items aren't buried.
- **One caveat to internalize:** Marqo's nuanced position is "content-first, behavior-as-refinement" — they
  don't discard behavioral signal, they reorder the dependency. samesake currently has *no* behavioral
  layer at all. That is the correct, simpler default (and matches samesake's "stops at retrieval" posture),
  but the dossier flags an optional future refinement vector (a re-ranking bias layer) **if and only if it
  passes the same eval gate** — never as a prerequisite for relevance.

### 6.3 Validation of the hybrid (keyword + semantic) design

Marqo explicitly says keyword/lexical precision must be preserved for SKUs, model numbers, exact names —
"blend keyword precision for exact matches with AI understanding for everything else ... table stakes in
2026." **samesake's FTS-+-ANN-fused-via-RRF is precisely this blend.** The hard-filters-gate-before-ranking
design also directly answers Marqo's "partial attribute matching" precision failure ("blue waterproof
hiking boots size 10" returning a brown boot) — samesake's hard filters compile to SQL predicates that gate
*before* ranking, enforcing all attributes simultaneously, which is exactly the failure Marqo says rules-
based keyword systems can't fix at scale.

### 6.4 UX patterns worth lifting

- **Semantic filtering** (re-interpret the query instead of forcing metadata filters) maps naturally onto
  samesake's **NLQ parser** (constrained schema) + soft filters that relax — adopt as a UX affordance over
  the existing soft-filter mechanism.
- **Positive/negative attribute inputs** (emphasize / de-emphasize) is a clean UX over a fused vector +
  soft-filter system; cheap to expose given samesake's typed catalog.
- **Query-adaptive filters** (show cushioning/pronation for shoes, neckline/sleeve for dresses) leverage
  samesake's typed catalog declaration — the type system already knows which facets exist per category.
- **`/search/explain` is a differentiator Marqo lacks.** None of these posts mention auditability or
  explainability; Marqo's whole pitch is opaque "understanding." samesake's `/search/explain` (showing FTS
  vs ANN vs spaces contribution + RRF fusion + filter gating) is a concrete trust/debuggability advantage
  to lead with, especially against a black-box "superintelligence" narrative.
- **Conversational precision bar:** if samesake's `findProducts()` agentic surface ever feeds a chat UX,
  Marqo's point holds — the tolerable-irrelevance threshold in conversation is far stricter than on a grid.
  samesake's choice to **stop at retrieval** (not auto-recommend a single answer) is actually a hedge
  against exactly the "one bad rec out of three feels like failure" risk.

### 6.5 What to discount

Treat every comparative delta (88% NDCG vs Titan, 73–78% relevance, 31% median conversion lift, all
customer $ figures) as **unverified marketing**. They are not citable in samesake's own benchmarking and
should not anchor samesake's targets. The reusable assets are the **definitions, the four-metric
discipline, the score bands (as lore), the zero-result audit, and the cold-start/behavioral critique
logic** — which independently validate samesake's content-first architecture.

---

## Sources

1. What Is Precision — https://www.marqo.ai/blog/what-is-precision-in-machine-learning
2. What Is Recall — https://www.marqo.ai/blog/what-is-recall-in-machine-learning
3. What Is MRR — https://www.marqo.ai/blog/what-is-mrr-in-machine-learning
4. What Is NDCG — https://www.marqo.ai/blog/what-is-normalized-discounted-cumulative-gain-ndcg
5. Why Clickstream-Only Systems Fail on New Products — https://www.marqo.ai/blog/why-clickstream-only-systems-fail-on-new-products
6. Why Behavioral Search Fails for Resale — https://www.marqo.ai/blog/why-behavioral-search-fails-for-resale
7. How AI Boosts Conversion by Over 50% — https://www.marqo.ai/blog/how-ai-boosts-conversion-by-over-50-percent
8. Semantic Search vs Keyword Search (Ecommerce) — https://www.marqo.ai/blog/semantic-search-vs-keyword-search-ecommerce
9. Ecommerce Search Engine Best Practices — https://www.marqo.ai/blog/ecommerce-search-engine-best-practices
10. AI-Native Ecommerce Search UX Design — https://www.marqo.ai/blog/ai-native-ecommerce-search-ux-design

_Scraped 2026-06-14 via Firecrawl (markdown, main-content only). All posts: `robots: noindex,nofollow`,
authored Apr–May 2026, Marqo marketing collateral._
