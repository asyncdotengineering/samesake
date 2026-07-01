# Zepto search engineering — notes (blog.zepto.com, read incl. diagrams)

Status: Research notes · Date: 2026-07-01 · Read directly (article text + architecture diagrams viewed
as images): "Building Search for a 10-Minute World" (Jun 2026, flagship overview), "How We Built
High-Precision Low-Latency Semantic Search" (Feb 2026), "From Bottleneck to Breakthrough: Product
Enrichment at Scale" (Apr 2026). Zepto = India quick-commerce (10-min grocery delivery); scale
**>1M search requests/min**, sub-~200ms budget. Their series has 6 planned parts (indexing, autosuggest,
browse/merch, feature store, observability).

> Terminology nuance: Zepto's **"product enrichment"** means **read-time assembly** of a product card
> from 15+ services (catalog/pricing/inventory/tags), NOT LLM attribute extraction. samesake's
> "enrichment" = attribute extraction. Same word, different layer — don't conflate.

## 1. The flagship architecture (from the diagrams)

**Query-resolution chain** (diagram, query "amul doodh 1l"):
`query → query understanding → retrieval (always live, parallel) → candidate scoring/ranking →
Product Assortment Service → relevancy buckets · ads · filters · response`.

- **Query understanding** = Phonetic correction → Categorical prediction (**KNN** vector search, 3-level
  hierarchy L1/L2/L3) → Segmentation (brand · type · volume · attributes). Split by **query-volume tier**:
  **top-N head queries = pre-computed & served static** (correction+intent+segmentation cached, because
  head distributions are stable); **long tail = live semantic routing** to the nearest top-N query to
  reuse its accumulated understanding (fully-live tail understanding is WIP).
- **Retrieval** = lexical (OpenSearch, custom scoring) + semantic (vector store, custom bi-encoder), each
  producing **exploit + explore** streams → **4 candidate streams** (exploit/explore × lexical/semantic).
- **Ranking** = **Mixture of Experts** (gating over cohort embeddings) + secondary rerank from a **feature
  store** (store×pvid, query×city signals) + post-ranking **rules** (boost/deboost/bury, no code deploy).
- **Product Assortment Service** = authoritative inventory/price/store resolution (the index is a fast
  approximation; ground truth resolved here).

**Full architecture** (diagram): two surgically-separated services —
- **search-platform** (pure retrieval; knows nothing about users; input = query + city + eligible hub IDs
  → candidate product IDs + base scores). Evolves independently of ranking.
- **Search Orchestrator** (ranking · enrichment · response; feature store, ads, session state).
- Supporting: Vector store (city-pvid, bi-encoder), Search index (OpenSearch), Vector ETL, product event
  consumers (inventory/pricing), fallback KV store, Feature store, ML platform, data pipelines.

**Ranking evolution** (diagram): heuristics → classical LTR → deep learning → **cohort-specific models**
→ **Mixture of Experts** (current: one model, learned gating weights experts by cohort/context, no hard
cohort assignment). Plus a **Tail Ranker** (sparse queries → lean on semantic relevance + generalized
cohort patterns) and **Overall Ranker** (new users → platform-level signals).

## 2. Semantic search (the data-science deep-dive) — most on-point for us

- **Framing:** retrieval as a **learning problem** — two-tower encoders in a shared space; decouples
  retrieval from ranking; trained on weak supervision; optimizes semantic alignment not proxy metrics.
- **Training data = weak supervision from event logs** (Add-to-Cart, clicks) → positive query–product
  pairs, cleaned (min-interaction thresholds, session dedup, near-duplicate query collapse). Treated as
  "high-precision but incomplete," NOT ground truth.
- **Product representation = name + product_type + brand + LLM-extracted highlight attributes.** i.e.
  **enrichment feeds the embedding** — "helps the model understand what a product actually is, not just
  how it's titled." (Direct validation of samesake's `search_document`/enrichment-first thesis.)
- **Synthetic data for the tail (non-negotiable):** flag low-signal queries (≤5 interactions); retrieve
  candidates with a strong external model → **LLM labels them highly/somewhat/irrelevant**; only
  **highly-relevant used as training positives** (with in-batch negatives); **3-grade labels kept for
  eval**. Also **generate synthetic queries from product descriptions** (vary specificity/phrasing).
  Synthetic downweighted vs real events.
- **Loss = InfoNCE with in-batch negatives** (scales with batch size, auto-surfaces hard negatives).
  Deferred triplet loss (unstable without a clean human gold set).
- **Model = all-MiniLM-L6** chosen for **latency/stability/robustness under noisy input**, not peak
  offline accuracy. Custom bi-encoder **bootstrapped**: a large external model generated the first
  signals → trained the production bi-encoder on them.
- **Staged training:** warm-up (all data, rising LR, avoids embedding collapse) → cascade (progressively
  tighten ATC/click thresholds toward cleaner signal).
- **Evaluation (multi-pronged):** event-based forward eval (biased, for regression detection) +
  **multi-model retrieval pooled + LLM-as-judge** + Precision@K model-as-judge. No single metric trusted.
- **Impact:** **up to 35% uplift** on impacted query segments; strongest on **tail / noisy / misspelled /
  transliterated**. "Retrieval quality sets the ceiling for everything that follows." Same embedding
  space now also powers **ads retrieval** (one retrieval layer compounds across surfaces).

## 3. Query correction (from flagship + linked post)
LLM-based (**Llama-3-8B**, self-hosted on Databricks, instruct-tuned), **grounded in the catalogue via
RAG** — embed the noisy query, retrieve top-K similar product/brand names, pass as context to prevent
hallucinating non-existent products. Handles phonetic Indian-vernacular typed in Latin script
("kothimbir"→coriander, "paal"→milk) where edit-distance correctors fail entirely. Output = structured
JSON (corrected query + canonical translation); corrected form → retrieval, raw form → search bar.

## 4. Product-enrichment/assortment (read-assembly service)
Rebuilt from a denormalized MongoDB model (1 doc per product-per-store → write amplification: one catalog
update → 1000s of writes; WiredTiger dirty-cache >20% → eviction → read-latency spikes) to:
(1) **Normalized storage** (product master once + per-store availability-only records) → **99.9% fewer
writes**, 85% less infra; (2) **read-through aggregated cache + client-side cache**; (3) **selective
enrichment** — callers declare which views they need (catalog/pricing/inventory/attributes/variants),
runs only those → **50–70% latency cut**. Pipeline = directed graph of small stateless processors
(Fetcher/Filter/Transformer) + Response Mapper, plugin model (new enrichment = write a processor,
register, update view config). **"Index as approximation, assortment service as ground truth."**

## 5. Their stated design principles (worth internalizing)
- **Separate retrieval from ranking** (different data, teams, deploy lifecycles).
- **Index as approximation; a downstream service resolves ground truth** (inventory/price).
- **Pre-compute everything that can be** (feature store; head-query understanding served static).
- **Exploit AND explore are both first-class retrieval objectives** (4-stream architecture counters
  rich-get-richer).
- **Ops as a first-class concern** (rules engine, synonyms, index templates — relevance fixes without
  eng deploys).
- **Design for experimental velocity** (every component toggleable via experiment config, no deploy).

## 6. Mapped to samesake

**Validates us:**
- **Enrichment feeds retrieval** — Zepto's product embedding = name+type+brand+LLM attributes; "retrieval
  quality sets the ceiling." Exactly our `search_document`/enrichment-first bet.
- **Hybrid lexical + semantic, parallel, then fuse/rank** — our architecture.
- **Custom/compact bi-encoder over a giant model for latency** — matches our BYO-compact posture.
- **LLM-as-judge + pooled multi-model eval + graded relevance** — our eval spine (and their 3-grade
  "keep for eval, only top grade for training" is exactly our gold-vs-training split instinct).
- **LLM query correction grounded in the catalog via RAG** — directly relevant to our red-team
  multilingual finding (Sinhala/Tamil); the catalog-grounded RAG correction is the fix pattern.

**Steal-this (concrete adoptions), highest-value first:**
1. **Query-volume tiers: pre-compute NLQ for head queries (static), live for tail.** Head query
   distributions are stable — caching correction/intent/segmentation for the top-N is a big latency+cost
   win and pairs with our existing NLQ parse-cache. Long-tail → route to nearest head query.
2. **Product representation for embeddings = title + product_type + brand + enriched attributes** — make
   sure our embed doc composition includes the enriched attributes (we do; confirm it's the full set).
3. **Synthetic tail data + query generation** to bootstrap/strengthen the semantic leg and grow the eval
   gold: LLM-grade candidates (highly/somewhat/irrelevant), train on top grade only, keep grades for eval;
   generate queries from product descriptions. Cheap way to expand our 50-query gold set.
4. **Catalog-grounded LLM query correction** (RAG over product/brand names) for multilingual/phonetic —
   the concrete answer to our deferred multilingual gap.
5. **Explore stream** alongside exploit to counter rich-get-richer for new/low-engagement SKUs (we only
   exploit).
6. **Ops rules layer** (boost/deboost/bury by query, no deploy) — our L3 merchandising gap.

**Differs / do NOT copy (quick-commerce specifics that are over-engineering at our scale):**
- **Hyperlocal city-pvid index with nested per-store metadata + eligible-hub filtering** — Zepto's
  inventory changes per-second per-hub; a fashion catalog per store is far stabler. We don't need this.
- **"Full-page caching is impossible"** — true for them (inventory×cohort×experiment cardinality); for a
  fashion store, result caching is more viable.
- **MoE cohort-gated ranking, Tail/Overall rankers, 1M req/min infra** — warranted at their scale/traffic;
  premature for us. Our BYO cross-encoder + boosts is right for now.
- **Product Assortment Service as a separate ground-truth resolver** — their index/inventory lag is
  seconds; for us, price/availability freshness is a lighter concern.

**Net:** Zepto independently confirms the samesake spine — hybrid retrieval, enrichment-feeds-embeddings,
compact custom encoder, LLM-judge eval, retrieval-quality-sets-the-ceiling. The transferable ideas are
**head/tail query-understanding tiers, synthetic tail data, and catalog-grounded LLM correction**; the
divergences (hyperlocal per-hub inventory, MoE, no-caching) are quick-commerce-specific and would be
premature scaling for a fashion catalog.

## Sources
blog.zepto.com/building-search-for-a-10-minute-world · /how-we-built-high-precision-low-latency-semantic-search-in-production
· /from-bottleneck-to-breakthrough-how-we-rebuilt-product-enrichment-at-scale · (linked)
blog.zeptonow.com/lost-in-translation-...(query correction) · /personalized-search-ranking-the-zepto-way (ranking).
