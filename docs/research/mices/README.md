# MICES (MIx-Camp E-commerce Search) — Talk Synthesis

Source: 11 talks from youtube.com/@mix-campe-commercesearch2961 (MICES 2023–2026), transcripts
pulled 2026-07-02. Practitioner talks from idealo, Zalando, dm-drogerie markt, Digitec Galaxus,
Delivery Hero, Shopify, OTTO, MediaMarktSaturn, Coveo, Qdrant, and Doug Turnbull.

## Per-talk load-bearing lessons

### idealo — Journey into Hybrid Search (2026)
8M products + 500M offers ≈ 600M embeddings; 25 years of hand-tuned Lucene + LTR.
- 20–40% of queries are new every day — the real justification for vector search is the long tail, not "semantics" in the abstract.
- Hybrid = keyword top-n ∪ vector top-m → one LTR reranker. Vector buys **recall**; "set a small similarity threshold and let LTR handle precision." RRF is their sanctioned no-LTR alternative.
- MTEB rank ≠ your rank: of 6 benchmarked models, **multilingual-E5-small** won on their data (cost/latency included).
- Fine-tuning: MNR loss, positive = highest-CTR item, negative = zero-CTR item on the same SERP. **LLM-filtering false negatives (GPT-4o-mini, ~25% eliminated) produced their best NDCG**; LLM-*generated* negatives failed completely.
- Rollout: vector only for zero/few-result queries first → LTR learns the new feature from that traffic → retrain → all queries. Production: HNSW for 8M products, FAISS IVF-PQ for 500M offers, 72 GB in RAM, ~60 ms avg. Global cosine cutoff 0.6 found by manual inspection.

### Zalando — Search Platform Architecture (2026)
- **One search backend serves search bar, browse, and the conversational assistant.** Chat is a front-end, not a second search system.
- Query understanding is a pipeline: normalize → NER (dictionary + LLM with pre-generated answers for weak queries) → classification/redirects → enrichment → explicit "unmapped" fallback flag.
- Never show zero results (A/B-proven); 5 intents generated per query, top-scored wins.
- Reranking extracted into a **config-defined computational graph** (cheap model over 1K → heavy model over top 100) so A/B tests don't require re-architecture.
- p99 latency budgets are cascade-strict: over-budget features are **dropped, not waited for**.
- Continuous retraining; UI layout changes silently poison click-training data.

### dm-drogerie markt — Semantic Search in Omnichannel Retail (2026)
2M searches/day; multilingual-E5 via ONNX in Kotlin services; Qdrant; **end-to-end P95 < 50 ms**. Five iterations, deliberately easy→hard:
1. Guardrails: model-specific similarity cutoff (E5 lives in 0.7–1.0), largest-score-drop detector, category-coherence restriction.
2. Business signals: score-band grouping, rank by sales within band, purchasable first.
3. **Attribute extraction → native ANN filters** ("sulfate-free shampoo"), brand as *boost* not filter — boost-vs-filter decided empirically per attribute.
4. Cross-encoder rerank (~100 candidates, 64–128 tokens, domain-fine-tuned, drop negative-scored).
5. Bi-encoder fine-tune last (biggest win): clickstream pairs graded 0–3, MNR. Counterintuitive: **full noisy training data beat every curated variant** — don't over-clean.
- Shipped as zero-results fallback first, then as the chatbot/MCP retrieval engine (they run a **public MCP server** over semantic search). ~20% higher interaction on low-performer queries.
- Eval stack: offline NDCG@10/@30 from bias-corrected clickstream on every change → **LLM-judge for queries lacking behavioral data** → production A/B.

### Digitec Galaxus — Vector Search Journey (2025)
- **Bad vector results are worse than an honest zero-results page** — click-probability-over-time proved their first fine-tuned model *lost* to the zero-results control.
- Taxonomy is the load-bearing asset: taxonomy-adjacent hard negatives (iPhone → phone-case as label-0), taxonomy de-biasing of click positives, and a runtime quality gate (too much taxonomic diversity in results = model didn't understand → show zero-results UI). Global thresholds "didn't really work."
- Custom metric for zero-result segments: any product click site-wide within 30s of the search.
- Pipeline: model factory → deliberately light offline eval → human "safe to A/B?" gate → **A/B is the only decision-maker**. Offline metrics didn't predict user preference. Now correlating LLM-judge verdicts against A/B before trusting the judge.
- Start with the technology your engineers know (they stayed on Elasticsearch).

### Delivery Hero (Grebennikov) — How Semantic Search Projects Fail (2024)
20M products, 20 languages.
- **"Embed with OpenAI → vector DB → done" does not work.** Stock E5 returns ketchup for "tomato"; bigger models don't fix intent. Relevance = query + document + audience.
- Semantic tuning = labels + fine-tuning, exactly like lexical. Implicit labels need Bayesian CVR smoothing; remaining bias toward head/exposed/English.
- Multilingual embeddings are English-fine-tuned; out-of-language can be **worse than BM25**. Concatenating all-language titles into one string worked best; title-only beat title+description (garbage descriptions).
- **Semantic search never says no.** Threshold distributions shift per model/fine-tune/query-length/language — they landed on a per-language/query-shape lookup table (~0.6–0.7). Production hybrid = "RRF + business rules, nothing fancy."
- Biggest A/B win came in the country with the *worst* catalog data — uplift is inversely proportional to baseline quality.

### Shopify — Offline Eval with Model-Based Judgments (2024)
- **Implicit-feedback offline eval structurally punishes new retrieval arms** (unseen product = judgment 0 → eval always says "keep lexical"). This is *the* reason for model-based judgments.
- Separate the binary relevance judge from the ranking judge.
- **A fine-tuned cross-encoder with ~1,000 hand-labeled samples beat fine-tuned LLaMA-3-8B** at orders-of-magnitude lower cost. Judge = cross-encoder + CLIP text×image side features.
- 3 days of manual golden-set annotation is worth it; sample by traffic but over-index on strategic query classes. **ESCI** (~2M Exact/Substitute/Complement/Irrelevant pairs) is the free bootstrap.
- Use the judge to *read* per-query diffs between algorithms, not just compute aggregates.

### OTTO — Precision vs Recall (2026)
18M+ products, ~2M queries/day.
- Recall rollout ladder (zero-results → <20 → <100 → <400 → all, each A/B'd) delivered **>5% cumulative conversion uplift**.
- **Every precision intervention moved nothing** (thresholds, query-specific precise mode, even filtering men's shoes from "women's sneakers") — no metric responded. Walmart published the same null.
- "Irrelevant" products get bought and *not returned more*: substitutes serve consideration-set builders and explorers. Query ≠ intent; optimize user-need fit, not query-product fit.
- Acknowledged blind spot: 2–6-week A/B windows can't see slow trust erosion from precision complaints.

### Coveo — Search vs Chat: Ockham's Razor (2026)
- **Don't run two parallel discovery interfaces.** Similar results = redundant; divergent = confusing; either way you maintain and measure two systems.
- Make the *search box* conversational: NLQ constraints in the bar, optional grounded advice above results, **keep facets and sort-by-price** (chat-first UIs that dropped them feel broken).
- Chat belongs late-funnel: narrow, grounded PDP Q&A — as an API consumer of the same search backend.
- Be skeptical of chatbot-uplift PR (Amazon's "35% from recommendations" was largely cannibalized search revenue).

### MediaMarktSaturn — Vectorizing Consumer Electronics (2024)
- Taxonomy your zero-results first: misspellings ~11%, **series/model numbers ~32%** (embeddings tokenize them to garbage), semantics, synonyms, multilingual, and assortment gaps vector search *cannot* fix.
- **Embedding source text is the highest-leverage lever**: per-category attribute-dense descriptions composed from NER-mined user queries + merchandiser knowledge. "The biggest boost came from product descriptions and triplet curriculum — with those two, even public models would have been an MVP."
- Negative curriculum: random = too easy, globally-hardest = training collapse; in-batch semi-hard→hard ramp worked (+0.30 on their metric).
- Category-based offline eval when clicks are missing; slice by query type.
- **Libraries before databases**: model + hnswlib + logic in one container, serverless, reindex = redeploy. Classical search stays forever — 60–70% of retail queries are simple browse intents.

### Qdrant — Fine-Tuning Sparse Neural Retrievers (2026)
- SPLADE = learned term weights + expansion on inverted-index mechanics — keeps match explainability. Off-the-shelf SPLADE is MS-MARCO-trained and wrong for catalogs; vocabulary-bound (model numbers!).
- Avoid inference-free (query-frozen) SPLADE for ecommerce — intents need query-side encoding.
- ANCE-style hard-negative mining loop (index with current checkpoint → high-ranked unlabeled = negatives); false-negative risk needs a judge.
- Fine-tuning causes catastrophic forgetting — fine for single retailers, use multi-domain data for marketplaces. LLM-generated eval queries are too lexical; you need real click-log queries or your numbers lie.

### Doug Turnbull — AutoResearch: Coding Agents Optimizing Retrieval (2026)
- Coding agents can hill-climb NDCG by editing your ranking function — but **agents cheat**: query-specific hacks, overfit monstrosities. Guards: held-out validation where the agent sees only aggregate deltas, LLM overfit check, **small-patch-size limits**. With guards: WANDS 0.54 → ~0.59.
- LLMs converge on prior art (the agent reinvented RRF) — auto-research automates known techniques, not novelty.
- Layered optimization beats joint: freeze the learned hybrid as an opaque `search()` and optimize only the new layer on top.
- **"95% of the effort should go into offline evaluation and 5% into model building."**

## Cross-talk synthesis for samesake

**Convergent architecture:** two-retriever hybrid → one reranking layer. Fusion = learned LTR where
behavioral data exists, **RRF + business rules where it doesn't** (samesake's exact position).
Vector buys recall; precision comes from downstream. Lexical never goes away (model numbers, browse
intents, speed, debuggability). Rollout is universally staged by query segment. Latency targets:
dm P95 < 50 ms end-to-end; cross-encoders only over ~100 candidates; over-budget features are shed.

**Bet verdicts:**

| Samesake bet | Verdict |
|---|---|
| RRF hybrid FTS+vector | Validated as the pre-LTR standard. Design the fusion seam so a learned reranker can replace RRF later; expose per-arm provenance + vector similarity as output features now. |
| NLQ → hard filters | Strongly validated (dm ships it; Zalando's NER pipeline is it at scale). Adopt: per-attribute boost-vs-filter configurability, brand as boost, explicit "unmapped" fallback. |
| LLM-judge evals | Validated as the layer for tail/zero-behavior queries. Upgrades demanded: **ESCI-style 4-class grading (Substitute = soft positive)**, judge-vs-online correlation tracking, plan to distill to a cross-encoder (~1k labels beat an 8B LLM). |
| Postgres/pgvector-only | Directionally supported: "start with what your engineers know", "libraries before databases", exotic infra only at 600M vectors. Risk to verify: **filtered-ANN recall** (dm leans on native ANN filters; NLQ hard filters + pgvector collide exactly there). |
| LLM enrichment as core | **Strongest validation in the corpus.** MediaMarkt's biggest win was constructed embedding text; dm's filters need extracted attributes; Digitec's training/gating needs taxonomy. Enrichment is upstream of retrieval, filtering, negatives, and eval. |
| Intent/similar modes | Validated by OTTO's user-intent framing; warning: query-level intent auto-detection *failed* at OTTO — keep modes caller-declared. |
| BYO models | Validated (model rankings reshuffle per domain) **with a caveat: un-tuned models are the #1 failure mode.** BYO must ship with the guardrail suite (cutoff strategies, category coherence, judge gating) and a fine-tuning-data export path, or every new install reproduces "ketchup for tomato". |
| MCP surface | Direct precedent: dm runs a public MCP server over semantic search; one retrieval stack, assistants as thin clients. |

**Net-new roadmap items from the talks:**
1. **Pluggable result-cutoff strategies** (threshold table / score-drop / category-diversity / judge gate) + a designed zero-results experience. A single config float is known-insufficient (Delivery Hero, Digitec).
2. **Zero-result query taxonomy tooling** — classify an installation's failures (misspellings / model numbers / semantics / language / assortment) so adopters know what semantic search will and won't fix.
3. **Staged-rollout routing primitive** — per-query-segment switch (zero-results → low-results → all); every team shipped this way.
4. **Training-pair export as a first-class artifact** (click positives + taxonomy/same-SERP negatives, with de-biasing hooks) so BYO users can fine-tune and plug back in.
5. **Precision as guardrail, not objective** — judge-scored precision floors and complaint-rate style metrics; don't chase precision conversion uplift that repeatedly measures as null.
