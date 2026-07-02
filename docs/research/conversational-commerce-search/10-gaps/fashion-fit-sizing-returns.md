# Fashion Fit / Sizing / Returns — Completeness-Pass Deep Dive

> **Scope.** This fills a gap the first research sweep under-covered: size & fit recommendation as it touches a *retrieval* layer. It surveys (1) the vendor landscape (True Fit, Fit Analytics, Bold Metrics, EasySize, Secret Sauce, 3DLOOK, etc.) and their methods; (2) returns reduction via better fit; (3) how size/fit becomes a retrieval **constraint** or **signal**; (4) the academic literature on size recommendation (Amazon, Zalando, McAuley/UCSD). It ends with an explicit **adopt / avoid / differentiate / integrate** verdict for samesake.
>
> **Anchor.** samesake is a TypeScript "search engine compiler" for visual commerce, fashion-first, real corpus = Sri Lankan (Sinhala/Tamil/English code-mixed) fashion. Compiles a typed catalog into Postgres + pgvector running *in the user's app*. Retrieval = FTS + cosine ANN over BYO embeddings + optional typed "spaces", fused via RRF. Hard filters compile to SQL predicates that gate **before** ranking; soft filters relax. NLQ parser (constrained schema), enrich pipeline, ER/dedup, `/search/explain`, `findProducts()` that **stops at retrieval**. It is *not* a fit-rec vendor and should not become one. The question is: **what should a fashion-first retrieval compiler expose for size/fit without owning the fit-prediction problem?**
>
> **Evidence labels.** `[PROVEN]` = peer-reviewed paper, public benchmark, or primary doc. `[MARKETED]` = vendor blog / PR claim, directionally useful but not independently verified.

---

## 0. TL;DR / verdict up front

- Fit/size is **the** dominant apparel return reason — commonly cited at ~**53%** of returns (size/fit) and "up to 70%" in some vendor framings. `[MARKETED]` This makes it the highest-leverage commerce-search problem samesake is currently silent on.
- The fit-recommendation problem (given a person + a garment, predict S/Fit/L) is a **well-studied, vendor-saturated, data-hungry** problem. The canonical academic framing is a **latent-factor "true size" model learned from purchase + return outcomes** (Amazon, RecSys 2017), with cold-start handled by **visual** signals (Zalando SizeNet, 2019) and label-imbalance handled by **metric learning** (McAuley, RecSys 2018). samesake should **not** rebuild any of this.
- **What samesake *should* own** is the **retrieval surface around fit**, not the fit model itself:
  1. **Size availability as a first-class hard filter** that gates before ranking (compile `size ∈ {…} AND in_stock` to SQL predicates). This is squarely in samesake's existing "hard filters compile to SQL" model and is the single highest-value, lowest-risk addition.
  2. **`true-to-size` / `runs small` / `runs large` as a typed *soft* signal / score-modifier** derived from enrich (reviews/returns), used to relax or boost — never to gate.
  3. **A typed "fit profile" input on the query side** (a constrained context object: usual size per category, fit preference) that the NLQ parser can populate and that hard/soft filters can read — *carrying* a fit signal, not *computing* one.
  4. **A BYO fit-recommender adapter** (the same posture as BYO embeddings / BYO rerankers): if the user plugs in True Fit / Bold Metrics / a custom model, samesake consumes its output as a per-(user,SKU) signal in RRF / score modifiers, and `/search/explain` shows it.
- **For the LK corpus specifically**, the vendor approaches *fail*: True Fit / Fit Analytics / EasySize derive accuracy from massive Western purchase-return graphs (80M+ shoppers, 15k–91k brands) that have ~zero LK coverage, and from size charts that assume vanity-sized Western/EU/US/UK/JP systems. LK fashion is heavily un-charted, mixed-system, often body-measurement-driven (tailoring culture). samesake's differentiator is to make fit **a typed, explainable, BYO-pluggable retrieval signal** that works *without* a 20-year purchase graph — exactly where the incumbents are weakest.

---

## 1. The problem: fit is the return tax on apparel

### 1.1 Returns are large and fit-dominated

- Average e-commerce return rate heading into 2026 is **~20%** of online orders; **apparel runs 20–40%**, and specific categories/brands reach **up to 75%**. `[MARKETED]` (3DLOOK, Richpanel.)
- **Size/fit is the #1 return reason.** A widely repeated figure: **53%** of apparel returns are size/fit, then color (16%), then damage (10%); some vendor framings push fit's share "up to 70%". `[MARKETED]`
- Directionality is asymmetric and gendered: menswear returns skew **"too small" (~23%)**; womenswear skews **"too big" (~22%)**. `[MARKETED]` This matters because it implies a *signed* fit signal ("runs small" vs "runs large"), not just a binary "fits/doesn't".
- Vendor-reported return-reduction from fit tools clusters at **30–40%**: True Fit cites a Retail TouchPoints study claiming AI fit tools improved size accuracy for 81% of users and reduced returns "up to 40%"; EasySize claims **92% size accuracy → 35–40% fewer returns**; 3DLOOK claims **30% YoY return reduction + 4× conversion + 30% AOV**. `[MARKETED]` Treat all of these as marketing; the *direction* (fit tools reduce returns) is well-corroborated, the *magnitude* is self-reported.

> **Load-bearing caveat.** Every magnitude number above is vendor-sourced. The *robust, non-marketed* claim is narrower: **fit/size is the single largest apparel return reason, and reducing fit uncertainty at the point of discovery measurably reduces returns.** That is enough to justify treating fit as a retrieval concern.

### 1.2 Why this is a *search* problem and not only a PDP problem

Most fit tooling lives on the **product detail page** (PDP) — a "Find your size" widget after the shopper has already chosen the item. But fit also belongs **upstream in retrieval**:

- A shopper who can never wear size 3XL should not have size-XS-only items ranked #1. **Size availability is a relevance gate.**
- "Show me dresses that run true to size" is a *query constraint*, not a PDP interaction.
- An agent (`findProducts()`) asked "find me a shirt that'll fit a 42" chest" needs fit to be a **filterable/queryable attribute**, not a post-hoc widget.

This is the wedge for a retrieval compiler: fit tools own *prediction on a chosen item*; samesake can own *fit-aware candidate selection and gating*.

---

## 2. Vendor landscape (size & fit recommendation)

### 2.1 The two big methodological families

1. **Outcome-graph / behavioral** — learn from millions of purchase+return events ("people like you who bought your usual size kept size M in this style"). Needs scale; suffers cold-start; this is True Fit, Fit Analytics, EasySize, Secret Sauce.
2. **Body-measurement / anthropometric** — capture/estimate body dimensions (questions, photos, 3D scan) and map to garment measurements ("digital twin"). Needs garment measurements per SKU; this is Bold Metrics, 3DLOOK, Zalando's body-measurement flow.

Most mature vendors blend both. The key dependency for *either* is **garment-level data**: behavioral models need a stable per-SKU "true size" latent; anthropometric models need per-SKU **point-of-measure** garment specs (chest, waist, inseam at SKU level), which most catalogs lack.

### 2.2 Vendor profiles

**True Fit** `[MARKETED]`
- Positioning: "AI Fit & Sizing Intelligence Platform." Behavioral family.
- Claimed data ("Fashion Genome"): **80M+ active shoppers, 60M+ unique products, 91,000+ brands, $616B+ transactions, ~20 years** of purchase/return outcomes. Newer pages: 82M+ shoppers.
- Mechanism: brand-specific size charts + historical behavior + AI; cross-network signal ("what similar shoppers kept across the connected network, not just this site"). Has "Shopper Insights" (age/height/bra-size cohorts) and generative-AI "Fit Hub" (TechCrunch, 2024).
- Explicit anti-reviews stance: claims ratings/reviews fail at sizing — e.g. "only 56% of aggregated review rollups indicated the item was True to Size" while 70% of shoppers bought their usual size. `[MARKETED]`

**Fit Analytics / "Fit Finder"** `[PROVEN acquisition / MARKETED product]`
- Berlin-based; product "Fit Finder"; **18,000+ retailers/brands** (North Face, ASOS, Calvin Klein, Patagonia, Puma).
- **Acquired by Snap (Snapchat) in March 2021 for ~$124.4M** (TechCrunch filing) to power social-commerce sizing. `[PROVEN]` This is a notable signal: a major platform paid nine figures for fit-rec IP — fit-rec is strategic, not a feature.

**Bold Metrics** `[MARKETED]`
- Anthropometric family. Claims **50+ body measurements from 4–6 questions**, "digital twin", "tailor-level accuracy." SaaS body-data platform.
- Most relevant artifact for samesake: their blog **"How Fit Recommendation Platforms Standardize Sizing Data for AI Shopping Agents."** Argues AI shopping agents fail at fit because "the data it has access to is broken" — catalogs lack "a structured, machine-readable mapping between a specific human body and a specific garment." They prescribe four things agents need: (1) **structured garment data at SKU level — actual measurements, not just size labels, machine-readable**; (2) **standardized, persistent shopper body profiles across sessions/brands**; (3) a **recommendation layer that returns fit context** ("Size M. Fits true at the chest, slightly long in the torso, roomy through the hips") rather than a bare size label; (4) **real-time inventory awareness.** They explicitly say expose this via an **API intermediary** that returns "structured data, including size, confidence, and fit notes" — *not* raw data to the LLM — and that "retailer API credentials must never touch the agent." **No MCP mention.** `[MARKETED]` — This is essentially a spec for the *interface* samesake should consume, validating the "fit as structured signal + inventory gate + explainability" framing below.

**EasySize ("Fit Quiz")** `[MARKETED]`
- Behavioral; no body measurement required — answers "what size do you usually wear / how tall." Claims **92% accuracy**, **35–40% return reduction**, database across **15,000 brands**, API + Shopify/WooCommerce plugins.

**Secret Sauce Partners ("Fit Predictor")** `[MARKETED]`
- "Finds best fit in seconds using existing data, without physical measurements." Claims **100M+ active users/month.** Behavioral family. Also Style Finder / Outfit Maker.

**3DLOOK ("YourFit")** `[MARKETED]`
- Anthropometric + virtual try-on. **86+ points of measure** from two phone photos in <1 min; generates 3D avatar; combines VTO with size/fit rec; recommendation engine factors body shape, fit preference, inventory, best-sellers. Claims 30% YoY return reduction.

**Adjacent / smaller:** Sizebay, Kiwi Sizing, Fit Quiz, Sizer, Unsize, Shaku, sizeez — mostly size-chart + quiz tooling for Shopify SMBs.

### 2.3 Vendor comparison table

| Vendor | Family | Core input | Data moat (claimed) | Output shape | Fit notes/signed signal? | Return-reduction claim | License / access |
|---|---|---|---|---|---|---|---|
| **True Fit** | Behavioral | Past purchases + brand charts | 80M+ shoppers, 91k brands, ~20yr | Size rec + cohort insights | Partial (cohort) | "up to 40%" `[MARKETED]` | Closed SaaS |
| **Fit Analytics** | Behavioral | Quiz + photo | 18k retailers | Size rec | Limited | n/a (Snap-owned) | Closed SaaS |
| **Bold Metrics** | Anthropometric | 4–6 Q → 50+ measures | Body-data ML | Size + **confidence + fit notes** | **Yes (fit notes)** | n/a | Closed SaaS / API |
| **EasySize** | Behavioral | Usual size + height | 15k brands | Size rec | Limited | 35–40% `[MARKETED]` | Closed SaaS / API |
| **Secret Sauce** | Behavioral | Existing data | 100M MAU | Size rec | Limited | n/a | Closed SaaS |
| **3DLOOK YourFit** | Anthropometric + VTO | 2 photos → 86+ measures | CV body model | Size + 3D avatar + VTO | Partial | 30% YoY `[MARKETED]` | Closed SaaS |
| **samesake (target)** | **Neither — retrieval layer** | Typed catalog + BYO signals | **In-app Postgres + typed catalog** | **Fit-aware candidate set + gate + explain** | **Yes, as typed soft signal** | **n/a — reduces returns indirectly via better candidate selection** | **OSS-style, in your app** |

> **Verdict row.** No vendor is a competitor to samesake; they are **potential plug-ins**. The one whose *interface* samesake should mirror is **Bold Metrics' agent spec** (structured garment measures + persistent body profile + fit notes + inventory + API intermediary). samesake's unique seat is the **gate-before-rank + explainability + BYO** layer none of them own.

---

## 3. The academic literature (PROVEN)

This is where the *real, replicable* methodology lives. Four anchor papers.

### 3.1 Amazon — latent "true size" factor model (the canonical baseline)
**"Recommending Product Sizes to Customers"** — Vivek Sembium, Rajeev Rastogi, Atul Saroop, Srujana Merugu. **RecSys 2017** (ACM). `[PROVEN]`
- Idea: each customer and each product gets a scalar **latent "true size"**; the model scores fit as a **linear function of the difference** between customer and product true size, learned from **past purchases + returns**.
- Reduces ordinal regression {Small, Fit, Large} to **multiple binary classification** problems (Hinge / Logistic loss), with **linear-time** algorithms.
- Results: on Amazon shoe data, latent-factor models with **personas + return codes** show **17–21% AUC improvement** over baselines; online A/B showed **+0.49% Fit transactions**. `[PROVEN]`
- Follow-up: **"Bayesian Models for Product Size Recommendations"** (WWW 2018) extends this to a Bayesian treatment. `[PROVEN]`
- PDF: https://cseweb.ucsd.edu/classes/fa17/cse291-b/reading/p243-sembium.pdf ; Amazon Science: https://www.amazon.science/publications/recommending-product-sizes-to-customers

### 3.2 McAuley/UCSD — metric learning for fit, + the public datasets everyone uses
**"Decomposing Fit Semantics for Product Size Recommendation in Metric Spaces"** — Rishabh Misra, Mengting Wan, Julian McAuley. **RecSys 2018** (ACM, 10.1145/3240323.3240398). `[PROVEN]`
- Idea: learn customer/product **embeddings** from transactions with fit feedback via **ordinal regression preserving label order**, then **project to a metric space** and sample representations per class to fix **label imbalance** (the "Fit" class dominates).
- Contributes **two public datasets** that became the field's de-facto benchmarks:
  - **ModCloth** (~28k+ fit feedback over ~2.7k items)
  - **RentTheRunway** (~192k fit feedback over ~5.2k dresses)
- Verbatim problem framing (from the paper): modeling fit feedback is "*challenging due to its subtle semantics, arising from the subjective evaluation of products, and imbalanced label distribution.*" `[PROVEN]`
- PDF: https://cseweb.ucsd.edu/~jmcauley/pdfs/recsys18e.pdf
- **Why it matters to samesake:** these two datasets are the cheapest way to *prototype and benchmark* a fit-signal feature without LK return data — and they reinforce that fit feedback is **subjective + imbalanced**, i.e. a *soft signal*, not a hard truth.

### 3.3 Zalando — hierarchical Bayesian over purchase+return outcomes
**"A Hierarchical Bayesian Model for Size Recommendation in Fashion"** — Romain Guigourès, Abdul-Saboor Sheikh, Yuen King Ho, Urs Bergmann, Evgenii Koriagin, Reza Shirvany (Zalando SE / Zalando Research). **RecSys 2018**; arXiv **1908.00825**. `[PROVEN]`
- Idea: **jointly model the purchased size and its return event** — one of {no return, returned too small, returned too big} — as a **multinomial** parameterized by a joint probability built from a **hierarchy of priors** (handles sparse customer/article data via shrinkage).
- The explicit modeling of *signed return reason* (too small / too big) is the academic basis for samesake's "signed soft signal" recommendation.
- arXiv: https://arxiv.org/abs/1908.00825 ; author PDF: https://rguigoures.github.io/pdf/hierarchical-bayesian-model_final.pdf

### 3.4 Zalando — SizeNet, the cold-start / visual answer
**"SizeNet: Weakly Supervised Learning of Visual Size and Fit in Fashion Images"** — Nour Karessli, Romain Guigourès, Reza Shirvany. **CVPR 2019 Workshops**; arXiv **1905.11784**. `[PROVEN]`
- Abstract (verbatim): "*Most approaches addressing this problem are based on statistical methods relying on historical data of articles purchased and returned to the store. Such approaches suffer from the cold start problem for the thousands of articles appearing on the shopping platforms every day, for which no prior purchase history is available. We propose to employ visual data to infer size and fit characteristics… SizeNet, a weakly-supervised teacher-student training framework that leverages the power of statistical models combined with the rich visual information from article images to learn visual cues for size and fit characteristics, capable of tackling the challenging cold start problem.*"
- **Directly relevant to samesake's multimodal enrich pipeline**: visual cues from product images can produce a *cold-start fit prior* per item even with zero LK purchase history. This is the one academic technique samesake could *enrich* toward (extracting a "runs small/large" prior from imagery/text) without becoming a fit-rec vendor.
- arXiv: https://arxiv.org/abs/1905.11784

### 3.5 Reviews-based fit (cheap signal source)
**"Incorporating Customer Reviews in Size and Fit Recommendation Systems for Fashion E-Commerce"** — Oishik Chatterjee, Jaidam Ram Tej, Narendra Varma Dasaraju. **2022**; arXiv **2208.06261**. `[PROVEN]`
- Uses customer **review text** alongside customer/product features; reports **+1.37%–4.31% macro-F1** over baselines across four datasets. `[PROVEN]`
- Relevant because reviews ("runs small", "true to size") are a signal samesake's **enrich pipeline already touches**, and a defensible source for a *soft* fit signal even where structured return data is missing.

> **Synthesis of the literature.** The field converged on: latent "true size" diff models from **purchase+return outcomes** (Amazon), **signed return events** (Zalando Bayesian), **metric learning for imbalance** (McAuley), **visual cold-start** (SizeNet), and **reviews** as auxiliary signal. Every method that *works well* needs an outcome graph samesake's LK corpus does not have. The **transferable** insights for a retrieval layer are: (a) treat fit as **soft, subjective, imbalanced**; (b) the useful unit is a **signed per-item fit prior** (true/small/large) + **confidence**; (c) **visual + review** signals are the cold-start-friendly sources; (d) the **hard, objective** part is **size availability**, which is not a model at all — it's a SQL predicate.

---

## 4. Size as a retrieval constraint vs. signal

This is the part samesake actually builds. Decompose "fit" into three retrieval primitives:

### 4.1 Hard constraint — size availability gate `[design recommendation]`
- **What:** "only items available in size L" / "in my size" / "fits a 42 chest given this brand's chart."
- **How it maps to samesake:** this is *exactly* samesake's existing "hard filters compile to SQL predicates that gate **before** ranking." A `variants` table with `(sku, size, in_stock)` → predicate `EXISTS (variant WHERE size = ANY($sizes) AND in_stock)`.
- **Why hard:** an out-of-your-size item is irrelevant regardless of similarity score. Gating before RRF is correct. Best-practice UX research corroborates: show **in-stock sizes only**, allow **multi-size** select (M & L), and surface availability in the facet. `[MARKETED]`
- **Soft-relax path:** samesake's "soft filters relax" model is the graceful-degradation answer — if nothing is in your exact size, relax to adjacent sizes rather than returning empty (critical for a thin 5k-doc LK catalog).

### 4.2 Soft signal — "true to size" / "runs small/large" `[design recommendation]`
- **What:** a **signed, per-item** fit prior in {runs_small, true_to_size, runs_large} with a **confidence**, derived by **enrich** from reviews/returns/visual (per §3.4–3.5).
- **How it maps to samesake:** a typed catalog field (e.g. `fit_signal: { direction: 'small'|'true'|'large', confidence: number }`) that feeds a **soft filter** or a **score modifier** (samesake already plans score modifiers). "Prefer true-to-size" boosts; "I'm between sizes, show forgiving fits" can bias toward `runs_large`.
- **Why soft, never hard:** the literature is explicit that fit feedback is **subjective and imbalanced** (§3.2) and reviews are **noisy** (True Fit's own "56% rollup accuracy" critique). A signed prior is a *bias*, not a gate.

### 4.3 Query-side context — a typed fit profile `[design recommendation]`
- **What:** a constrained context object the **NLQ parser** can populate and the **personalization context-vector** can carry: `{ usualSize: {top:'M', bottom:'32'}, fitPreference: 'relaxed'|'fitted', bodyMeasures?: {...} }`.
- **How it maps to samesake:** this is the **context-vector personalization** surface samesake already plans, specialized for fit. The retrieval layer **carries and reads** this; it does not **compute** a size from a body — that's the vendor's / BYO model's job.
- **`/search/explain` payoff:** "ranked above because in your usual size (M), in stock, and reviews say true-to-size (confidence 0.7)." Fit becomes **auditable**, which no closed vendor offers.

### 4.4 The BYO fit-recommender adapter `[design recommendation]`
- Mirror the **BYO embeddings / BYO reranker** posture: define a thin interface `FitRecommender.predict(user, sku) -> { size, confidence, fitNotes }`. If the user wires True Fit / Bold Metrics / a custom model, samesake consumes the per-(user, SKU) output as **another RRF input or score modifier**, and `/search/explain` shows the provenance. samesake stays a **compiler/orchestrator**, not a **predictor**.
- This matches Bold Metrics' own prescription (§2.2): an **API intermediary returning structured size + confidence + fit notes**, credentials never touching the model. samesake is well-placed to *be* that orchestration layer inside the user's app.

---

## 5. Relevance to samesake — adopt / avoid / differentiate / integrate

### ADOPT
- **A.1 Size availability as a hard filter that gates before ranking.** Highest value, lowest risk, lands squarely in the existing hard-filter→SQL model. Requires a `variants(sku,size,in_stock)` shape in the typed catalog. **Ship this first.**
- **A.2 A typed, signed `fit_signal` field** (`{direction, confidence}`) as a **soft filter / score modifier**, populated by enrich from reviews/visual. Grounded in the academic consensus that fit is soft+signed+subjective.
- **A.3 Soft-relax on size** (adjacent sizes when exact size empty) — essential for a thin LK catalog where exact-size+exact-style is often empty.
- **A.4 Use the public ModCloth / RentTheRunway datasets to prototype/benchmark** the fit-signal feature before any LK return data exists.

### AVOID
- **V.1 Do not build a fit-prediction model.** It needs a purchase+return outcome graph samesake doesn't have, especially for LK. Every paper confirms the data dependency.
- **V.2 Do not ingest body scans / photos / anthropometrics.** That is a heavy, privacy-laden, vendor-owned capability (3DLOOK, Bold Metrics). Out of scope for a retrieval compiler.
- **V.3 Do not treat any fit signal as a hard truth/gate** except *availability*. Reviews and predicted fit are noisy.
- **V.4 Do not hardcode a single sizing system.** LK fashion mixes UK/EU/US/JP/numeric/body-measure conventions; a fixed enum will break (§6).

### DIFFERENTIATE
- **D.1 Fit as an *explainable* retrieval signal.** `/search/explain` exposing "in your size + in stock + true-to-size (conf 0.7)" is something no closed vendor provides. This is samesake's auditability story applied to fit.
- **D.2 Cold-start-first, graph-free.** Incumbents are weakest exactly where samesake lives (no 20-year purchase graph, no LK coverage). Lean on **visual (SizeNet-style) + review** cold-start priors via enrich.
- **D.3 LK-native size normalization** as a typed catalog concern (map heterogeneous LK size labels → a normalized internal scale) — a localization win that compounds samesake's "local queries are the weakest benchmark" focus.

### INTEGRATE
- **I.1 `FitRecommender` BYO adapter interface** consumed as an RRF input / score modifier. Lets enterprise users keep True Fit / Bold Metrics and still get fit-aware *retrieval*.
- **I.2 Agent surface:** `findProducts()` should accept a `fitProfile` and a `sizes` constraint so an agent can ask "find a shirt that fits a 42 chest, in stock." samesake **stops at retrieval** (consistent with its charter) — it returns fit-aware candidates, it does **not** tell the shopper which size to buy.
- **I.3 Mirror Bold Metrics' agent data spec** (SKU-level garment measures + persistent fit profile + fit notes + inventory) as the *shape* of what the catalog exposes to agents, since that is becoming the de-facto interface for agentic commerce fit.

---

## 6. The LK-corpus wrinkle (why incumbents don't transfer)

1. **No outcome graph.** True Fit/Fit Analytics/EasySize accuracy comes from tens of millions of Western purchase+return events and 15k–91k *Western* brands. LK brands are essentially absent → cold-start everywhere → the behavioral family degrades to its weakest mode.
2. **Mixed, un-charted sizing systems.** LK retail mixes UK/EU/US/JP labels, raw numeric (waist in inches), and a strong **tailoring/body-measurement** culture where "size" may be a set of body measures, not a label. Vanity sizing varies by brand. Normalization is non-trivial and *local*.
3. **Code-mixed fit language.** Review/return fit signals appear in Sinhala/Tamil/English mixing — "හරියට" (fits right), "ලොකුයි" (too big), transliterated, etc. samesake's enrich + multilingual handling is the natural place to extract a `fit_signal`, and it's a place no Western vendor invests.
4. **Implication.** The *availability gate* (A.1) and *normalization* (D.3) are universal and immediately useful; the *signed soft signal* (A.2) is best sourced from **visual + code-mixed reviews** (D.2) rather than a non-existent return graph.

---

## 7. Open questions

1. **Catalog shape:** does samesake's typed catalog already model SKU-level **variants with size + stock**? If not, that's the prerequisite for A.1 and should be specced first.
2. **Normalization target:** what internal normalized size scale should LK labels map to — body-measure-based (chest/waist cm), a normalized ordinal, or per-brand-only? (EN 13402 / ISO measurement-based sizing exist but adoption is low.)
3. **Where does `fit_signal` get computed** — purely in enrich (offline), or also at query time from the fit profile? Offline-per-item is simpler and matches the soft-signal framing.
4. **RRF vs. score-modifier vs. soft-filter** for fit: which fusion point gives the cleanest `/search/explain` and avoids double-counting when a BYO recommender is also present?
5. **Benchmark:** can we add a fit-aware slice to the existing LK bench (P@5 / grade@10) — e.g. "in-my-size" queries — to prove the availability gate improves grade without tanking recall on the thin catalog?
6. **Agent boundary:** confirm `findProducts()` returns fit-aware candidates but never a "buy size X" recommendation — keep the stop-at-retrieval charter intact even when a BYO fit recommender is wired in.
7. **Privacy:** if a BYO recommender needs a body profile, does that profile ever transit samesake's in-app Postgres, and what's the data-residency story for LK users? (Bold Metrics' "credentials/profile never touch the model" guidance applies.)

---

## 8. Sources

**Academic (PROVEN):**
- Sembium, Rastogi, Saroop, Merugu — *Recommending Product Sizes to Customers* — RecSys 2017. https://cseweb.ucsd.edu/classes/fa17/cse291-b/reading/p243-sembium.pdf · https://www.amazon.science/publications/recommending-product-sizes-to-customers · https://dl.acm.org/doi/10.1145/3109859.3109891
- *Bayesian Models for Product Size Recommendations* — WWW 2018. https://dl.acm.org/doi/fullHtml/10.1145/3178876.3186149
- Misra, Wan, McAuley — *Decomposing Fit Semantics for Product Size Recommendation in Metric Spaces* — RecSys 2018. https://cseweb.ucsd.edu/~jmcauley/pdfs/recsys18e.pdf · https://dl.acm.org/doi/10.1145/3240323.3240398
- Guigourès et al. (Zalando) — *A Hierarchical Bayesian Model for Size Recommendation in Fashion* — RecSys 2018 / arXiv 1908.00825. https://arxiv.org/abs/1908.00825 · https://rguigoures.github.io/pdf/hierarchical-bayesian-model_final.pdf
- Karessli, Guigourès, Shirvany (Zalando) — *SizeNet: Weakly Supervised Learning of Visual Size and Fit in Fashion Images* — CVPR-W 2019 / arXiv 1905.11784. https://arxiv.org/abs/1905.11784
- *A Deep Learning System for Predicting Size and Fit in Fashion E-Commerce* — arXiv 1907.09844. https://arxiv.org/abs/1907.09844
- Chatterjee, Tej, Dasaraju — *Incorporating Customer Reviews in Size and Fit Recommendation Systems for Fashion E-Commerce* — 2022 / arXiv 2208.06261. https://arxiv.org/abs/2208.06261
- Zalando Research — Personalized Size Recommendation project page. https://research.zalando.com/project/personalized_size_recommendation/personalized_size_recommendation/

**Vendors (MARKETED):**
- True Fit — How it works / Fashion Genome. https://www.truefit.com/how-it-works · https://www.truefit.com/post/how-fit-finder-tools-work · https://www.truefit.com/sizing-by-reviews · TechCrunch (gen-AI Fit Hub, 2024) https://techcrunch.com/2024/06/04/true-fit-generative-ai-feature-fit-hub/
- Fit Analytics / Snap acquisition — TechCrunch (Mar 2021, $124M) https://techcrunch.com/2021/04/23/filing-snap-paid-124m-for-fit-analytics-as-it-gears-up-for-a-bigger-e-commerce-push/ · CNBC https://www.cnbc.com/2021/03/17/snap-acquires-fit-analytics-in-e-commerce-push.html
- Bold Metrics — *How Fit Recommendation Platforms Standardize Sizing Data for AI Shopping Agents.* https://blog.boldmetrics.com/how-fit-recommendation-platforms-standardize-sizing-data-for-ai-shopping-agents · https://boldmetrics.com/technology · *From Vanity Sizing to True Size Inclusivity* https://blog.boldmetrics.com/from-vanity-sizing-to-true-size-inclusivity-solving-online-fit
- EasySize. https://www.easysize.me/
- Secret Sauce Partners — Fit Predictor. https://www.secretsaucepartners.com/fitpredictor
- 3DLOOK YourFit. https://xyz.3dlook.me/yourfit/ · https://3dlook.ai/content-hub/apparel-return-rates-the-stats-retailers-cannot-ignore/ · https://3dlook.ai/content-hub/the-true-cost-of-apparel-returns/

**Returns / sizing / UX context:**
- Richpanel — *Ecommerce Return Rates in 2026.* https://www.richpanel.com/learn/ecommerce-return-rates
- Sizebay — *Why clothing sizes are inconsistent across brands* / *Vanity sizing.* https://sizebay.com/en/blog/why-clothing-sizes-are-inconsistent-across-brands/
- Wikipedia — *Vanity sizing.* https://en.wikipedia.org/wiki/Vanity_sizing
- Hypotenuse / Experro — ecommerce size & availability filter best practices. https://www.hypotenuse.ai/blog/the-ultimate-guide-to-ecommerce-filters

**Failed fetches (noted, not load-bearing):** ACM DOI page (403); ResearchGate Bayesian-paper page (403) — both corroborated via author/UCSD PDFs and search snippets instead.
