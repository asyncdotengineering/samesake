# Large-Retailer & Marketplace Product Search — Prior-Art Dossier

> Survey of **published** product-search research from large retailers and marketplaces, built as prior art for **samesake** (a TypeScript "search-engine compiler" for visual commerce: typed catalog → Postgres + pgvector hybrid search running in the user's own app; FTS + cosine ANN over BYO embeddings + optional segmented "spaces" vectors fused via RRF; hard filters compile to SQL gates; NLQ parser; multimodal enrich; entity-resolution/dedup; `/search/explain`; `findProducts()` agentic surface stopping at retrieval).
>
> **Scope rule for this doc:** for each retailer we give *paper title, year, core method, headline result, link*, and we **explicitly separate what is PROVEN (peer-reviewed metric, online A/B with a number, public dataset) from what is MARKETED (blog claim, no numbers, or system-description without a controlled comparison).**
>
> Compiled 2026-06-14. Load-bearing facts were fetched directly from arXiv abstracts / publisher pages and are quoted verbatim where they carry weight. Two fetches failed (eBay innovation-blog timeout; eBay Visual Search PDF was binary-corrupt) and are flagged inline — facts for those come from the arXiv abstract page and search snippets, not the full text.

---

## 0. The single most reusable asset: the Amazon ESCI "Shopping Queries" dataset

This is the most important item in the whole survey for samesake, because it is a **public, licensed, multilingual relevance benchmark** that maps almost exactly onto samesake's own eval problem (grade@10, P@5 on a fashion corpus).

- **Title:** *Shopping Queries Dataset: A Large-Scale ESCI Benchmark for Improving Product Search* (a.k.a. the KDD Cup 2022 "ESCI Challenge" dataset)
- **Authors:** Chandan K. Reddy, Lluís Màrquez, Fran Valero, Nikhil Rao, Hugo Zaragoza, Sambaran Bandyopadhyay, Arnab Biswas, Anlu Xing, Karthik Subbian (Amazon)
- **Year:** 2022 — arXiv:2206.06588 (submitted 14 Jun 2022)
- **Link:** https://arxiv.org/abs/2206.06588 · Competition: https://amazonkddcup.github.io/
- **Size (verbatim):** *"The dataset contains around 130 thousand unique queries and 2.6 million manually labeled (query,product) relevance judgements."* Queries are in **English, Japanese, and Spanish**, with **up to 40** candidate products per query.
- **Label scheme (the "ESCI" in the name):** each (query, product) pair is graded **E**xact / **S**ubstitute / **C**omplement / **I**rrelevant — a *four-grade* relevance scale, not binary.
- **Three tasks:** (i) **ranking** the result list, (ii) **classifying** products into the E/S/C/I relevance categories, (iii) **identifying substitute** products for a query.
- **License (load-bearing):** **CC BY-NC-SA 4.0** (Creative Commons Attribution-NonCommercial-ShareAlike). → **Non-commercial.** samesake can use it for internal eval/benchmarking and published research, but **not** ship a model trained on it inside a commercial product without checking the ShareAlike/NC terms. Treat as eval-only.
- **Scale of the competition:** Amazon reports the KDD Cup 2022 ESCI challenge drew **9,200+ submissions** (https://www.amazon.science/blog/amazon-product-query-competition-draws-more-than-9200-submissions), so leaderboard solutions are a rich source of method ideas.

**PROVEN vs MARKETED:** entirely PROVEN — it's a public dataset with stated size and license, and a competition with published leaderboard papers (e.g. ZhichunRoad multi-task pre-training; the "Semantic Alignment System for Multilingual Query-Product Retrieval", arXiv:2208.02958).

**Relevance to samesake:** This is the closest external analog to samesake's eval harness. Two concrete takeaways: (1) the **E/S/C/I four-grade scale** is a battle-tested relevance taxonomy — samesake's `grade@10` (mean ~2.33) is already graded rather than binary, which aligns; consider adopting ESCI's *substitute vs complement* distinction explicitly so the eval can reward "right category, wrong exact item" instead of treating it as a miss. (2) There is also an image-enriched extension, **SQID (Shopping Queries Image Dataset)**, arXiv:2405.15190 — directly relevant to samesake's multimodal/visual-commerce angle if a public fashion-image relevance set is ever needed.

---

## 1. Amazon

### 1a. Semantic Product Search (the foundational two-tower paper)
- **Title:** *Semantic Product Search* — **Year:** 2019, **Venue:** KDD 2019
- **Authors:** Priyanka Nigam, Yiwei Song, Vijai Mohan, Vihan Lakshman, Weitian Ding, Ankit Shingavi, Choon Hui Teo, Hao Gu, Bing Yin (Amazon)
- **Links:** https://www.amazon.science/publications/semantic-product-search · https://dl.acm.org/doi/10.1145/3292500.3330759
- **Core method:** Deep two-tower-style model trained on **customer behavior data**; a custom loss with *"an inbuilt threshold to differentiate between random negative examples, impressed but not purchased examples, and positive examples"* (i.e. three-way negatives: random / impressed-not-purchased / positive); **average pooling + n-grams** to capture linguistic patterns; **hashing for out-of-vocabulary tokens**; model-parallel training across 8 GPUs.
- **Headline result (verbatim):** *"at least 4.7% improvement in Recall@100"* and *"14.5% improvement in mean average precision (MAP)"* over baseline semantic search methods, with online A/B confirmation.
- **PROVEN vs MARKETED:** PROVEN (peer-reviewed; concrete offline metrics + online A/B).

### 1b. Multimodal Semantic Retrieval for Product Search (recent, fashion-relevant)
- **Title:** *Multimodal semantic retrieval for product search* — **Year:** 2025, **Venue:** WWW 2025 Companion (EReL@MIR workshop)
- **Authors:** Dong Liu (Amazon Luxembourg, `liuadong@amazon.com`), Esther Lopez Ramos (Amazon Spain)
- **Links:** https://arxiv.org/abs/2501.07365 · https://dl.acm.org/doi/10.1145/3701716.3717567
- **Core method:** Build a **multimodal product representation** (text + image) and contrast it against pure-text representation for semantic retrieval; dense-vector relevance between query and product.
- **Headline result (verbatim):** *"a multimodal representation scheme for a product can show improvement either on purchase recall or relevance accuracy in semantic retrieval."*
- **PROVEN vs MARKETED:** PROVEN-but-soft — peer-reviewed, but the headline is a directional claim ("either … or") rather than a single hard number in the abstract. Read the full paper before quoting a specific lift.

**Relevance to samesake:** 1a is the canonical justification for samesake's **hybrid FTS + ANN** design — the 2019 paper's whole premise is that lexical inverted indexes miss *"hypernyms, synonyms, antonyms, morphological variants, and spelling errors,"* which is exactly the gap samesake's cosine-ANN leg fills. The three-way negative loss (random / impressed-not-purchased / positive) is a concrete recipe samesake could surface as guidance for users who do have behavior logs. 1b validates samesake's **multimodal enrich pipeline** for fashion — but note the lift is modest/conditional, supporting samesake's pragmatic stance that visual signals help *selectively*, not universally.

---

## 2. Walmart — *Semantic Retrieval at Walmart*
- **Title:** *Semantic Retrieval at Walmart* — **Venue:** KDD 2022 (Applied Data Science track); also on arXiv as 2412.04637 (posted Dec 2024).
- **Authors:** Alessandro Magnani, Feng Liu, Suthee Chaidaroon, Sachin Yadav, Praveen Reddy Suram, Ajit Puthenputhussery, Sijie Chen, Min Xie, Anirudh Kashi, Tony Lee, Ciya Liao (Walmart Global Technology)
- **Links:** https://arxiv.org/abs/2412.04637 · https://dl.acm.org/doi/10.1145/3534678.3539164
- **Core method:** **Hybrid** system combining a *"traditional inverted index and embedding-based neural retrieval"* to answer **tail queries**. Notable engineering: advanced negative sampling using **in-batch + offline hard negatives**; a **6-layer DistilBERT** that *"significantly boost[s] recall while reducing computational overhead"*; deployed *"with little impact on response time."*
- **Headline result (verbatim):** the system *"significantly improved the relevance of the search engine, measured by both offline and online evaluations."*
- **PROVEN vs MARKETED:** PROVEN as a system (peer-reviewed, deployed, offline+online eval), but the **public abstract states the win qualitatively** ("significantly improved") — the hard numbers live in the paper body, not the abstract. Distinguish: "deployed hybrid, peer-reviewed" = proven; "exact % lift" = needs body read.

**Relevance to samesake:** This is the **single strongest architectural precedent** for samesake's core thesis. Walmart independently arrived at samesake's exact shape — *inverted index (FTS) + neural embedding ANN, fused, gated for tail queries* — at hyperscale and got it through a relevance review. Two adoptions worth flagging: (1) **hard negatives (in-batch + offline) are non-optional** for tail-query recall — samesake's docs/eval should make hard-negative mining a first-class concern for BYO-embedding users. (2) Walmart's choice of a *small* distilled encoder (6-layer DistilBERT) for latency-sensitive serving validates samesake's "runs in your own two containers, no Redis/ES" posture — you don't need a giant cross-encoder in the retrieval leg.

---

## 3. eBay

### 3a. Visual Search at eBay
- **Title:** *Visual Search at eBay* — **Year:** 2017, **Venue:** KDD 2017
- **Authors:** Fan Yang, Ajinkya Kale, Yury Bubnov, Leon Stein, Qiaosong Wang, Hadi Kiapour, Robinson Piramuthu (eBay)
- **Link:** https://arxiv.org/abs/1706.03154  *(full-PDF fetch failed — binary-corrupt; facts below are from the arXiv abstract page.)*
- **Core method:** DNN for **category prediction + compact binary signatures** (semantic hashing) over a large image collection, deployed on distributed cloud infra. Powers **eBay ShopBot** and **Close5**.
- **Headline result (verbatim, from abstract):** method is *"faster and more accurate than several unsupervised baselines"* on ImageNet.
- **PROVEN vs MARKETED:** PROVEN as a deployed system; the *quantitative* relevance claim in the abstract is comparative-but-vague ("faster and more accurate than several unsupervised baselines"), so treat the relevance number as needing the body.

### 3b. eBay Sequence-Semantic-Embedding (SSE) — open source
- **Repo:** https://github.com/eBay/Sequence-Semantic-Embedding
- **What it is:** eBay-released tooling/recipes to train deep models for semantic search **ranking and recall fetching**, cross-lingual IR, classification, QA. For IR, *"for each relevant pair of (query, document), the SSE of query is close to the SSE of relevant document."*
- **PROVEN vs MARKETED:** Code artifact (real, runnable) but **not** a benchmarked paper — no headline metric. Treat as engineering reference, not evidence.

### 3c. eBay's billion-scale vector similarity engine
- **Link:** https://innovation.ebayinc.com/stories/ebays-blazingly-fast-billion-scale-vector-similarity-engine/ *(fetch timed out — claims below from search snippet only.)*
- **Claim:** an internal ANN/vector engine serving **billion-scale** embedding retrieval at low latency; argues exact kNN is too slow for production, ANN is the answer.
- **PROVEN vs MARKETED:** **MARKETED** (engineering blog, no controlled relevance numbers in what we could verify).

**Relevance to samesake:** eBay is the **caution flag on scale**. samesake's design choice — pgvector ANN inside the user's own Postgres, no dedicated billion-scale vector engine — is the *right* default for the SMB/mid-market commerce catalogs samesake targets (samesake's own corpus is ~5k docs). eBay's billion-scale engine is a different regime; samesake should *differentiate* explicitly: "we are not trying to be a billion-vector engine; we are a compiler for catalogs that fit comfortably in Postgres+pgvector." 3a's binary-hash approach is a latency trick samesake doesn't need at its scale but could mention as a future lever.

---

## 4. Alibaba (Taobao) — *Embedding-based Product Retrieval in Taobao Search* (MGDSPR)
- **Title:** *Embedding-based Product Retrieval in Taobao Search* — **Year:** 2021, **Venue:** KDD 2021
- **Authors:** Sen Li, Fuyu Lv, Taiwei Jin, Guli Lin, Keping Yang, Xiaoyi Zeng, Xiao-Ming Wu, Qianli Ma (Alibaba)
- **Link:** https://arxiv.org/abs/2106.09297
- **Method name:** **MGDSPR** (Multi-Grained Deep Semantic Product Retrieval).
- **Core method:** Fixes **two** classic EBR failure modes — (1) the *"inconsistency between the training and inference stages"* (resolved via softmax cross-entropy loss) and (2) **low query relevance**, via two relevance-enhancement tricks: *"smoothing noisy training data and generating relevance-improving hard negative samples without requiring extra knowledge and training procedures."* Multi-grained = product info processed at multiple granularities. Deployed into Taobao's **multi-channel retrieval** system (i.e. EBR sits *alongside* lexical retrieval, not replacing it).
- **Headline result (verbatim):** *"significant metrics gains observed in offline experiments and online A/B tests"* and successful production deployment.
- **PROVEN vs MARKETED:** PROVEN as system + deployment; **the abstract gives the win qualitatively** ("significant metrics gains") — exact numbers are in the body.
- **Note / correction:** "Mobius" is **Baidu's** sponsored-search query-ad matching framework (KDD 2019), *not* Alibaba's e-commerce retrieval — a common conflation. The right Alibaba EBR paper is MGDSPR above.

**Relevance to samesake:** MGDSPR's two named problems are *exactly* the two samesake must manage. (1) **Train/inference mismatch** — samesake uses BYO embeddings, so the analog is "the embedding model the user indexed with must match the one used at query time" — worth making a hard invariant / checked at compile time. (2) **Relevance erosion from pure EBR** — Taobao's answer (hard negatives + multi-channel fusion) is precisely samesake's RRF-of-FTS-and-ANN. Their emphasis that EBR is one *channel* among several, fused, not a replacement, is the strongest external endorsement of samesake's RRF design. The "smoothing noisy training data" point is also a reminder that BYO-embedding quality is the user's risk — samesake's `/search/explain` is the right surface to expose when ANN is dragging relevance down.

---

## 5. JD.com — *Towards Personalized and Semantic Retrieval* (DPSR)
- **Title:** *Towards Personalized and Semantic Retrieval: An End-to-End Solution for E-commerce Search via Embedding Learning* — **Year:** 2020, **Venue:** SIGIR 2020
- **Authors:** Han Zhang, Songlin Wang, Kang Zhang, Zhiling Tang, Yunjiang Jiang, Yun Xiao, Weipeng Yan, Wen-Yun Yang (JD.com)
- **Link:** https://arxiv.org/abs/2006.02282
- **Method name:** **DPSR** (Deep Personalized and Semantic Retrieval).
- **Core method:** Two-tower embedding retrieval with a **multi-head** query tower (to capture multiple query intents) and **personalization** signals, served via ANN at industry scale. Tackles two problems: retrieving semantically-relevant-but-not-lexically-matching items, and personalizing results for the same query across users.
- **Headline result (verbatim):** *"+1.29% conversion rate"* overall and *"+10.03%"* improvement *"especially for long tail queries."* Deployed in JD.com production since 2019.
- **PROVEN vs MARKETED:** **PROVEN — strongest in the survey for hard numbers** (explicit conversion-rate deltas, online, plus the tail-query breakout).

**Relevance to samesake:** DPSR is the cleanest quantitative proof that **semantic retrieval's payoff concentrates in the long tail** (+10% on tail vs +1.3% overall). For samesake this argues: the ANN leg earns its keep mostly on rare/ambiguous queries, so eval should be **stratified by query frequency** (head vs tail) rather than reporting a single mean — samesake's mean grade@10 ~2.33 / P@5 0.83 could be hiding a much bigger tail win or a head-query regression. The **multi-head query tower** is also a useful idea for the NLQ surface: a single fashion query ("summer wedding guest dress under 5000") carries multiple intents (occasion + category + constraint) that one embedding flattens — worth considering whether samesake's NLQ parser + multiple "spaces" vectors is the right factoring of that same idea.

---

## 6. Instacart (grocery; Postgres-native — most architecturally aligned)
Instacart publishes engineering blogs, not peer-reviewed metrics, but the **architecture** is the closest public match to samesake.

- **An Embedding-Based Grocery Search Model at Instacart** (ITEMS) — arXiv:2209.05555 / SIGIR eCom 2022 — https://arxiv.org/abs/2209.05555. *"Instacart Transformer-based Embedding Model for Search"*: a unified dense representation projecting queries and products into the same vector space for direct comparison. **PROVEN** (peer-reviewed workshop paper).
- **How Instacart Built a Modern Search Infrastructure on Postgres** (May 2025) — https://www.instacart.com/company/tech-innovation/how-instacart-built-a-modern-search-infrastructure-on-postgres. Key claim (verbatim-ish): keyword retrieval best serves a specific query like *"pesto pasta sauce 8oz"* while *"a more ambiguous query like 'healthy foods' is better served by semantic search."* **MARKETED** (blog).
- **Optimizing Search Relevance at Instacart Using Hybrid Retrieval** (May 2025) — https://tech.instacart.com/optimizing-search-relevance-at-instacart-using-hybrid-retrieval-88cb579b959c. **MARKETED** (blog, hybrid FTS+semantic).
- **Building the Intent Engine: Revamping Query Understanding with LLMs** (Nov 2025) — https://www.instacart.com/company/tech-innovation/building-the-intent-engine-how-instacart-is-revamping-query-understanding-with-llms. Three-step LLM pipeline: retrieve top-K converted categories as candidates → LLM re-rank with injected Instacart context → post-processing guardrail. **MARKETED** (blog).

**Relevance to samesake:** Instacart is the **mirror**. They independently (a) built search **on Postgres**, (b) concluded **hybrid FTS + semantic** is the right shape, with the *exact* same "specific query → keyword, ambiguous query → semantic" intuition samesake encodes via RRF, and (c) moved query understanding to an **LLM that emits constrained categories with a guardrail** — structurally identical to samesake's **constrained-schema NLQ parser**. The Intent Engine's "retrieve candidates → LLM re-rank → guardrail" is a near-exact description of a disciplined NLQ-to-constraints flow. samesake should **adopt** the guardrail/verification framing (matches `findProducts()` grounding/verification) and can **cite Instacart as external validation** that Postgres-native hybrid commerce search is a real production architecture, not a toy.

---

## 7. Etsy — *Unified Embedding Based Personalized Retrieval in Etsy Search*
- **Title:** *Unified Embedding Based Personalized Retrieval in Etsy Search* — **Year:** 2023 (rev. 2024), **Venue:** FMLDS 2024 (also IEEE)
- **Authors:** Rishikesh Jha, Siddharth Subramaniyam, Ethan Benjamin, Thrivikrama Taula (Etsy)
- **Link:** https://arxiv.org/abs/2306.04833
- **Core method:** **Two-tower** query/item embedding + ANN, but the item embedding is a **unified** model fusing **graph + transformer + term-based** embeddings, trained **end-to-end**; plus hard-negative sampling and personalization for popular vs tail queries.
- **Headline result (verbatim):** *"5.58% increase in search purchase rate and a 2.63% increase in site-wide conversion rate"* across live A/B tests.
- **PROVEN vs MARKETED:** PROVEN (peer-reviewed; concrete online business metrics).

**Relevance to samesake:** Etsy is the closest peer in **product type** (long-tail, visually-driven, hand-made/fashion-adjacent — same flavor as samesake's LK fashion corpus) and gives the survey's most useful **fusion blueprint**: combine **term-based + transformer + graph** signals into one item embedding. samesake already fuses FTS + ANN + optional "spaces" via RRF; Etsy's win suggests the **"spaces"/segmented vectors** idea (currently off by default because it failed samesake's eval gate) is *directionally validated by a hyperscaler* — the gap is likely in how they're trained/fused, not the concept. The headline **+5.58% purchase rate** is also a reminder that samesake's eval is currently offline-only (grade@10/P@5); the durable proof everyone else publishes is an **online conversion/purchase delta**, which samesake cannot show until it's embedded in a live store — worth flagging as the eventual proof bar.

---

## 8. Pinterest — *OmniSearchSage*
- **Title:** *OmniSearchSage: Multi-Task Multi-Entity Embeddings for Pinterest Search* — **Year:** 2024, **Venue:** TheWebConf (WWW) 2024 Industry Track
- **Authors:** Prabhat Agarwal, Minhazul Islam Sk, Nikil Pancha, Kurchi Subhra Hazra, Jiajing Xu, Chuck Rosenberg (Pinterest)
- **Link:** https://arxiv.org/abs/2404.16260 · Code: https://github.com/pinterest/atg-research/tree/main/omnisearchsage
- **Core method:** Jointly learn **one query embedding** coupled with **pin and product** embeddings (multi-task, multi-entity). Entity representations are enriched with *"diverse text derived from image captions from a generative LLM, historical engagement, and user-curated boards."* Predecessor baseline = **SearchSage** (fixed PinSage/ItemSage embeddings).
- **Serving scale (verbatim):** *"300k requests per second at low latency."*
- **Headline result (verbatim):** *">8% relevance, >7% engagement, and >5% ads CTR in Pinterest's production search system."*
- **PROVEN vs MARKETED:** PROVEN (peer-reviewed; concrete online relevance/engagement/CTR deltas + serving scale).

**Relevance to samesake:** The load-bearing idea for samesake is **"use a generative LLM to caption product images, then embed the captions as text"** — a cheap, robust way to inject visual signal into a *text* embedding without a true multimodal model. This is directly applicable to samesake's **multimodal enrich pipeline** for fashion: LLM-generated structured captions (silhouette, neckline, fabric, occasion) become enrich fields that feed both FTS and the embedding, and they're auditable in `/search/explain`. It's arguably a **better fit than raw CLIP** for samesake's BYO-model + Postgres-FTS world. The multi-entity/multi-task framing is overkill at samesake's scale, but the captioning trick is a direct steal.

---

## 9. Coupang — *Embedding Based Deduplication in E-commerce AutoComplete*
- **Title:** *Embedding Based Deduplication in E-commerce AutoComplete* — **Year:** 2024, **Venue:** SIGIR 2024 (pp. 2955–2959)
- **Affiliation:** Coupang
- **Link:** https://dl.acm.org/doi/10.1145/3626772.3661373
- **Core method:** Industry framework for **deduplicating query-autocomplete suggestions** that are *semantically* duplicate (derived from noisy user logs), using embeddings + data-augmentation to improve dedup accuracy.
- **PROVEN vs MARKETED:** PROVEN as a peer-reviewed system; headline metric not captured in our search snippet (read paper body for the dedup-accuracy number).

**Relevance to samesake:** Coupang is the **entity-resolution / dedup precedent**. samesake explicitly ships entity-resolution + dedup; Coupang shows that **embedding-based semantic dedup** is a real, publishable production problem — and that the same query/title embeddings used for retrieval can be reused for dedup. samesake should **adopt** the reuse idea: the catalog's product embeddings (already computed for ANN) are the natural substrate for near-duplicate detection, no separate model needed. Their domain (autocomplete suggestions) differs, but the technique (embedding cosine + augmentation to catch semantic dupes) transfers to product-record dedup.

---

## 10. Wayfair (furniture; query-intent + LTR — blog-only)
- **Primary source:** Wayfair Tech Blog, *How We Use Machine Learning and NLP to Empower Search* — https://www.aboutwayfair.com/tech-innovation/how-we-use-machine-learning-and-natural-language-processing-to-empower-search · tag: https://tech.wayfair.com/tag/query-intent/
- **Core method (as described):** An in-house **Query Intent Engine** classifies a large share of incoming queries and routes users *"directly to the right page with filtered results"*; a **Learning-to-Rank (LTR)** model (in Solr) scores individual products, trained on **clickstream + search logs**; NLP entity/sentiment extraction over reviews, catalog, clickstream.
- **PROVEN vs MARKETED:** **MARKETED** — engineering blog, **no published metrics or controlled comparison** found. System description only.

**Relevance to samesake:** Wayfair's **Query Intent Engine → route to filtered results** is conceptually the same move as samesake's **NLQ parser → hard SQL filter predicates** (e.g. detect "under 5000" → `price <= 5000`, gate before ranking). It's external evidence that *intent-to-structured-filter* is a mainstream production pattern. But because Wayfair publishes no numbers, samesake should treat it as **direction, not evidence** — and can *differentiate* by pointing out that samesake makes the intent→filter step **typed, compiled, and auditable** (`/search/explain`) rather than an opaque in-house service. Adopt the pattern; don't cite it as proof.

---

## 11. Mercari — *Zero-Shot Retrieval for Scalable Visual Search in a Two-Sided Marketplace*
- **Title:** *Zero-Shot Retrieval for Scalable Visual Search in a Two-Sided Marketplace* — **Year:** 2025, **Venue:** KDD 2025 Workshop (TSMO)
- **Authors:** Andre Rusli, Shoma Ishimoto, Sho Akiyama, Aman Kumar Singh (Mercari)
- **Link:** https://arxiv.org/abs/2508.05661
- **Core method:** **Zero-shot** visual search using an off-the-shelf **multilingual SigLIP** vision-language model + **dimensionality reduction** for real-time inference and background indexing — i.e. *no task-specific fine-tuning*.
- **Headline result (verbatim):** *"a 13.3% increase in nDCG@5 over the baseline"* (offline); and in production, *"up to a 40.9% increase in transaction rate via image search."*
- **PROVEN vs MARKETED:** PROVEN (peer-reviewed; offline nDCG@5 + online transaction-rate deltas).
- **Companion:** Mercari also published *Towards Better Search with Domain-Aware Text Embeddings for C2C Marketplaces* (arXiv:2512.21021) — fine-tuning Japanese text embeddings on purchase-driven query-title pairs with role-specific prefixes for query/item asymmetry.

**Relevance to samesake:** Mercari is the **strongest endorsement of samesake's BYO-embedding, no-fine-tune default.** They got a **+13.3% nDCG@5 and up to +40.9% transaction rate** in production using a *pretrained off-the-shelf* model (SigLIP) with **zero fine-tuning** — exactly samesake's "bring your own embedding model, we compile the search layer" stance. Two adoptions: (1) **dimensionality reduction on embeddings** is a real lever for keeping pgvector ANN fast/cheap inside a single Postgres — worth exposing as a samesake option. (2) The companion paper's **role-specific prefixes** (different prompt prefix for query vs item to model asymmetry) is a free, model-agnostic trick samesake could pass through to BYO embedding calls. Mercari proves you can ship a strong visual-commerce retriever without training anything — which is precisely samesake's promise.

---

## 12. Cross-cutting synthesis for samesake

| Retailer | Paper / artifact | Year | Method core | Headline (PROVEN unless noted) |
|---|---|---|---|---|
| Amazon | Shopping Queries / ESCI (KDD Cup 2022) | 2022 | Public 4-grade (E/S/C/I) benchmark, 130k queries / 2.6M judgements, EN/JA/ES, CC BY-NC-SA | Dataset (eval asset) |
| Amazon | Semantic Product Search | 2019 | Two-tower, 3-way negatives, OOV hashing | +4.7% Recall@100, +14.5% MAP |
| Amazon | Multimodal Semantic Retrieval | 2025 | Text+image product representation | Improves purchase recall *or* relevance (soft) |
| Walmart | Semantic Retrieval at Walmart | KDD 2022 | **Hybrid** inverted-index + DistilBERT EBR, hard negatives | "significantly improved" (qual.) |
| eBay | Visual Search at eBay | 2017 | DNN category + binary hash, ShopBot/Close5 | "faster & more accurate" (qual.) |
| eBay | Billion-scale vector engine (blog) | — | ANN at billion scale | MARKETED (no numbers) |
| Alibaba | Taobao MGDSPR | KDD 2021 | Multi-grained EBR, fixes train/infer gap + relevance via hard negs | "significant gains" (qual.) |
| JD.com | DPSR | SIGIR 2020 | Multi-head query tower + personalization, ANN | **+1.29% CVR overall, +10.03% tail** |
| Instacart | ITEMS + Postgres/hybrid/LLM-intent blogs | 2022–25 | Postgres-native hybrid FTS+semantic; LLM constrained-category intent | ITEMS proven; infra blogs MARKETED |
| Etsy | Unified Embedding Personalized Retrieval | 2023 | Graph+transformer+term unified two-tower | **+5.58% purchase rate, +2.63% CVR** |
| Pinterest | OmniSearchSage | WWW 2024 | Multi-task multi-entity; **LLM image captions as text** | **>8% relevance, >7% engagement, >5% ads CTR**; 300k rps |
| Coupang | Embedding Dedup in Autocomplete | SIGIR 2024 | Embedding + augmentation semantic dedup | Proven (number in body) |
| Wayfair | Query Intent Engine + LTR (blog) | — | Intent classify → route to filtered results | MARKETED (no numbers) |
| Mercari | Zero-Shot Visual Search (SigLIP) | KDD 2025 wksp | **Zero-shot** pretrained VLM + dim-reduction | **+13.3% nDCG@5, up to +40.9% txn rate** |

### What samesake should ADOPT
1. **Hybrid FTS + ANN fusion is the industry consensus** (Walmart, Taobao, Instacart, Etsy all converge on it). samesake's RRF-of-FTS-and-ANN is squarely in the mainstream — lead with this, citing Walmart + Instacart.
2. **Hard-negative mining is the universal recall lever** (Amazon, Walmart, Taobao, Etsy all stress it). Make it a first-class concern in samesake's BYO-embedding guidance.
3. **LLM image captions → text embeddings** (Pinterest) is a cheaper, Postgres-FTS-friendly path to visual signal than raw CLIP — a strong fit for samesake's enrich pipeline + `/search/explain` auditability.
4. **Zero-shot / no-fine-tune off-the-shelf embeddings can win in production** (Mercari +40.9% txn) — validates samesake's BYO, compile-don't-train stance. Add **dimensionality reduction** as a pgvector cost lever.
5. **Intent → constrained structured filters with a guardrail** (Instacart Intent Engine, Wayfair Query Intent Engine) is exactly samesake's NLQ → SQL-predicate gating; adopt the verification/guardrail framing for the NLQ parser and `findProducts()`.
6. **Reuse retrieval embeddings for dedup** (Coupang) — the vectors already in Postgres are the dedup substrate.

### What samesake should DIFFERENTIATE on
- **Scale honesty:** eBay's billion-vector engine is a different regime. samesake should explicitly position as *catalog-fits-in-Postgres* commerce search, not a hyperscale vector DB.
- **Typed + auditable:** Wayfair/Instacart intent engines are opaque in-house services; samesake's edge is a **typed, compiled, `/search/explain`-auditable** intent→filter path. That auditability + `findProducts()` grounding/verification is something none of these papers expose to downstream consumers.

### What samesake should be CAUTIOUS about / open questions
- **Offline vs online proof gap.** Every PROVEN win above is ultimately an *online* metric (CVR, purchase rate, transaction rate, CTR). samesake's grade@10 ~2.33 / P@5 0.83 are offline-only. The eventual credibility bar is an online conversion delta in a live store — flag this as the real proof, and stratify offline eval **head vs tail** (per JD.com's +1.3% vs +10% split) so the tail win isn't averaged away.
- **"Spaces" (segmented vectors) failing samesake's eval gate** is interesting given Etsy's unified graph+transformer+term embedding *succeeded* (+5.58%). The concept is validated externally; the open question is whether samesake's failure is a **training/fusion** problem (how the segmented vectors are produced and RRF-weighted) rather than the idea being wrong. Worth a targeted re-investigation.
- **ESCI is non-commercial (CC BY-NC-SA).** Eval-only; do not train a shipped commercial model on it without legal review.

---

## Sources
- Amazon ESCI / Shopping Queries Dataset — https://arxiv.org/abs/2206.06588 · https://amazonkddcup.github.io/ · https://www.amazon.science/blog/amazon-product-query-competition-draws-more-than-9200-submissions
- Amazon SQID (image-enriched ESCI) — https://arxiv.org/pdf/2405.15190
- Amazon Semantic Product Search (KDD 2019) — https://www.amazon.science/publications/semantic-product-search · https://dl.acm.org/doi/10.1145/3292500.3330759
- Amazon Multimodal Semantic Retrieval (WWW 2025) — https://arxiv.org/abs/2501.07365 · https://dl.acm.org/doi/10.1145/3701716.3717567
- Walmart Semantic Retrieval (KDD 2022 / arXiv) — https://arxiv.org/abs/2412.04637 · https://dl.acm.org/doi/10.1145/3534678.3539164
- eBay Visual Search (KDD 2017) — https://arxiv.org/abs/1706.03154
- eBay Sequence-Semantic-Embedding (repo) — https://github.com/eBay/Sequence-Semantic-Embedding
- eBay billion-scale vector engine (blog; fetch timed out) — https://innovation.ebayinc.com/stories/ebays-blazingly-fast-billion-scale-vector-similarity-engine/
- Alibaba Taobao MGDSPR (KDD 2021) — https://arxiv.org/abs/2106.09297
- JD.com DPSR (SIGIR 2020) — https://arxiv.org/abs/2006.02282
- Instacart ITEMS (SIGIR eCom 2022) — https://arxiv.org/abs/2209.05555
- Instacart Postgres search infra (blog, 2025) — https://www.instacart.com/company/tech-innovation/how-instacart-built-a-modern-search-infrastructure-on-postgres
- Instacart hybrid retrieval (blog, 2025) — https://tech.instacart.com/optimizing-search-relevance-at-instacart-using-hybrid-retrieval-88cb579b959c
- Instacart Intent Engine / LLM query understanding (blog, 2025) — https://www.instacart.com/company/tech-innovation/building-the-intent-engine-how-instacart-is-revamping-query-understanding-with-llms
- Etsy Unified Embedding Personalized Retrieval (FMLDS 2024) — https://arxiv.org/abs/2306.04833
- Pinterest OmniSearchSage (WWW 2024) — https://arxiv.org/abs/2404.16260 · https://github.com/pinterest/atg-research/tree/main/omnisearchsage
- Coupang Embedding-Based Dedup in Autocomplete (SIGIR 2024) — https://dl.acm.org/doi/10.1145/3626772.3661373
- Wayfair ML/NLP search (blog) — https://www.aboutwayfair.com/tech-innovation/how-we-use-machine-learning-and-natural-language-processing-to-empower-search · https://tech.wayfair.com/tag/query-intent/
- Mercari Zero-Shot Visual Search (KDD 2025 wksp) — https://arxiv.org/abs/2508.05661
- Mercari Domain-Aware Text Embeddings for C2C — https://arxiv.org/pdf/2512.21021
- (Correction) Baidu MOBIUS (KDD 2019, *not* Alibaba) — https://www.semanticscholar.org/paper/76ea5ca2f98f0c5b09bd8611366a0fc7604f852c
