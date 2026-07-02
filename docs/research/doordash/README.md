# DoorDash Engineering → samesake — research wiki

A `/wandering-researcher`-style deep dive: we read DoorDash's public engineering blog, delegated a per-post review against the samesake codebase + the in-flight RFC, and distilled what transfers to **samesake** (a fashion visual + intent product-search engine).

- **Main deliverable:** [LEARNINGS.md](./LEARNINGS.md) — cross-cutting themes, reinforcements to the RFC (G1–G7 + embedding hygiene), net-new recommendations, two RFC amendments, and a P0/P1/P2 backlog.
- **Per-post reviews:** [`posts/`](./posts/) — one RFC-aware review per source post (key mechanisms → samesake actions → RFC mapping).
- **Raw captures:** [`raw/`](./raw/) — cleaned article markdown + figure URLs/captions. [`figures/`](./figures/), [`shots/`](./shots/) — screenshots.
- **Scope list:** [TARGETS.md](./TARGETS.md).

## Method

1. **Enumerate** — `firecrawl_map` over `careersatdoordash.com` found **348** blog posts. (The blog index is AJAX "load-more" behind Cloudflare; `agent-browser` hit the bot wall, so the sitemap map was the reliable enumerator.)
2. **Scope** — curated **37** high-signal posts (the 2 named + search / retrieval / recsys / embeddings / personalization / LLM / multimodal / knowledge-graph / memory / assistant / ML-platform / ML-quality), excluding logistics/forecasting/dispatch/mobile-infra/culture.
3. **Fetch** — `firecrawl_scrape` (`proxy: auto` clears Cloudflare) → cleaned markdown + figure captions to `raw/`, via parallel fetcher subagents.
4. **Review** — one **cursor** agent per file (36 in parallel waves, RFC supplied as context) → `posts/`. Each extracts mechanisms and maps learnings to RFC gaps or flags net-new items.
5. **Synthesize** — a consolidation pass across all 37 reviews + the RFC → [LEARNINGS.md](./LEARNINGS.md).

## Honesty note on images

The user asked us to read the figures "as they carry more details." **Cloudflare gates both the HTML pages and the image assets** (403 to direct, browser-UA, and cursor fetches). firecrawl's stealth proxy got the **prose + figure captions** through (DoorDash writes descriptive captions), and we pulled full-page rendered screenshots for the key posts (`shots/`). Per-figure *pixel* inspection was therefore limited; diagram **intent** in this wiki comes from captions + prose + the rendered screenshots, not from reading every diagram's internal labels. Where a diagram's detail couldn't be verified visually, the per-post review says so.

## Source posts (37) — one-line takeaway each

| post | most valuable samesake takeaway |
|---|---|
| doordash-llms-to-build-content-embeddings-for-search-and-recommendations | Enriched narrative dominates encoder choice (+31% Hit@5 from LLM profiles vs +6% from a better encoder) → protect `embed_doc` with unskippable compose. |
| doordash-unified-consumer-memory-for-personalization-at-scale | Persist version lineage (model_id/prompt_hash/schema_version) so you can re-embed without re-running the LLM. |
| building-doordash-assistant-an-engineering-overview | Stale catalog state is a grounding failure → live-catalog invariants (image revalidation, no zero-vector, status-filtered search). |
| doordash-dashclip-multimodal-models-for-generating-semantic-embeddings | Query and document are different distributions → encode asymmetrically; split retrieval text from reranker text. |
| building-doordashs-product-knowledge-graph-with-large-language-models | Waterfall enrichment: cheap precise tiers before the vision LLM; per-row ANN-retrieved few-shots beat a static prompt block. |
| doordash-llms-to-evaluate-search-result-pages | Build a structured, human-calibrated LLM-as-judge eval that gates ranking changes before A/B; position-weighted NDCG. |
| doordash-simulation-evaluation-flywheel-to-develop-llm-chatbots-at-scale | Calibrate the judge against human labels (F1) before trusting it; prefer a binary judge (generator–verifier gap). |
| doordash-llms-bridge-behavioral-silos-in-multi-vertical-recommendations | Confidence as a hard pre-index filter (DoorDash ≥0.80); cache the static prompt prefix, append the dynamic suffix (~80% cost cut). |
| doordash-llm-transcribe-menu | A cheap guardrail model (LightGBM beat neural on limited labels) gates auto-vs-human; gate on cross-signal interaction. |
| doordash-llms-for-grocery-preferences-from-restaurant-orders | Amortize LLM work on deduplicated content keys (compute once, reuse everywhere). |
| how-doordash-leverages-llms-for-better-search-retrieval | NLQ = slot-fill into taxonomy enums with ANN-shortlisted candidates (<1% hallucination); explicit MUST vs SHOULD tiers. |
| doordashs-next-generation-homepage-genai | Multi-LLM jury veto before serving generated content; fuse business×relevance multiplicatively (R^α·S^β), never additively. |
| homepage-recommendation-with-exploitation-and-exploration | Two-stage funnel (wide recall → precision rerank); normalize before blending; exploration needs impression state. |
| evolving-doordashs-substitution-recommendations-algorithm | Layer taxonomy/hard-attribute gates on top of text similarity; curate a golden set before click labels exist. |
| using-twin-neural-networks-to-train-catalog-item-embeddings | Optimize the dense space for metric geometry (occasion/style/composition); keep exact attrs as relaxable filters. |
| doordash-offline-llms-online-personalization-generating-carousels | Offline-generate-then-embed in batch; deterministic confidence/min-content filters block low-quality artifacts before write. |
| doordash-kdd-llm-assisted-personalization-framework | Derived representations belong in pipeline hooks, not consumer chores; boosts tune on normalized post-fusion scores. |
| doordash-llm-chatbot-knowledge-with-ugc | Index↔query parity is a contract (same model/text shape both sides); cluster zero-result queries into an enrichment backlog. |
| five-common-data-quality-gotchas-in-machine-learning-and-how-to-detect-them-quickly | Treat sentinel fallbacks (title-only embed, zero vector, default "other") as invalid values; surface correlated-missing. |
| personalizing-the-doordash-retail-store-page-experience | Two-stage ranking + explicit MMR diversity + quality filters; import position-bias inference discipline. |
| introducing-doordashs-in-house-search-engine | Ranking/business logic as declarative, query-time, auditable operators; atomic cutover (never serve a half-built row). |
| open-source-search-indexing | Assemble the search doc from source-of-truth at index time, not a stale payload; index failures must be durable + replayable. |
| pipeline-design-pattern-recommendation | Make every load-bearing stage a named, non-bypassable DAG operator; decouple recall from ranking. |
| how-to-investigate-the-online-vs-offline-performance-for-dnn-models | URL-only stage-cache keys are "cached residuals": same URL + swapped bytes → stale enrichment; fold the validator into the key. |
| how-we-designed-road-distances-in-doordash-search-2 | Hard eligibility is a pre-ranking filter, never a score feature; precompute + cache expensive derived state offline. |
| integrating-a-scoring-framework-into-a-prediction-service | Keep heavy scoring off the search hot path; cosine is a first-class compute node, not pre-fused into tabular features. |
| powering-search-recommendations-at-doordash | Static catalog signals offline, dynamic signals at query time; pairwise query×candidate match beats flat additive nudges. |
| selecting-the-best-image-for-each-merchant-using-exploration-and-machine-learning | Cheap rule pre-filters before learned/explore logic; simulate thresholds on replay logs before A/B; optimize on conversion. |
| personalized-cuisine-filter | Hierarchical cohort priors solve cold-start; treat exploration as a first-class objective, separate from relevance. |
| taming-content-discovery-scaling-challenges-with-hexagons-and-elasticsearch | Push eligibility filters down to retrieval; cut candidate cardinality before expensive stages; tune thresholds empirically. |
| building-a-gigascale-ml-feature-store-with-redis | Heterogeneous fields need heterogeneous encoding (embed_doc vs filters vs rerank_doc); don't compress embeddings. |
| using-cockroachdb-to-reduce-feature-store-costs-by-75 | Colocate derived search text in one entity write (no merge-read); cap batch sizes; full-row-replace on state change. |
| transforming-mlops-at-doordash-with-machine-learning-workbench | Ship observability on the daily post-deploy lookup tasks (status/freshness/spot-checks) before any full ML platform. |
| 3-principles-for-building-an-ml-platform | Ship the load-bearing seam first; make quality gates default-on, not an optional review step. |
| organizing-machine-learning-every-flavor-welcome | The platform must own validation/quality/monitoring (non-optional); reserve ML for proven incremental lift. |
| ship-to-production-darkly-moving-fast-staying-safe-with-ml-deployments | Shadow the full enrich→index→search path (compute-don't-serve) before promoting; train/serve parity is an invariant. |
| beyond-single-agents-doordash-building-collaborative-ai-ecosystem | RRF (lexical+dense) is the baseline recall stack, not the ceiling; the reranker is the expected second stage. |
