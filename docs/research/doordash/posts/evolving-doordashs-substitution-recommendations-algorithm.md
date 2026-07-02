# Evolving DoorDash's Substitution Recommendations Algorithm
URL: https://careersatdoordash.com/blog/evolving-doordashs-substitution-recommendations-algorithm/

## Key mechanisms
- **Phase 1 (unsupervised):** TF-IDF cosine similarity on item **names**, then **taxonomy heuristics** layered on top to restrict candidates to relevant categories (Figure 2: Coca-Cola 12-pack → other Coke variants).
- **Phase 2 (supervised binary classifier):** In-product **thumbs-up / thumbs-down** on suggested substitutes → labeled pairs → **LightGBM** predicting P(any catalog item is a good substitute for the ordered item); chosen for speed and minimal tuning (Figure 3: 12-pack Pepsi beats 2L Coke for a 12-pack Coke order — **quantity beats brand**).
- **Phase 3 (deep learning ranker):** **PyTorch DLRM-style** model — categorical **item embeddings** + dense-feature bottom MLP → **explicit feature interactions** → top MLP → **sigmoid** probability; reuses **twin-NN semantic item embeddings** trained on DoorDash **search behavior** (Figure 4: canned green peas beats canned corn for green beans on sparse SKUs).
- **Eval ladder:** Pre-label **golden set** (human-curated ideal subs for top sellers → % match); post-label offline **AUC**; online **approval rate** + **coverage** (% of ordered items with ≥1 rec) via experimentation platform; business outcomes (substitution rate, satisfaction).
- **Explicit future work (2022):** richer category metadata (produce/meat), attribute flags (organic/kosher), **item image embeddings**, personalization — i.e. they were still metadata+text+behavior at ship time.

## Learnings for samesake
### L1: Taxonomy gates on top of lexical similarity, not inside the dense vector  [maps: G2 | G3 | REQ-11b]
- DoorDash evidence: Phase 1 scored name TF-IDF, then **hard-restricted** recommendations with a catalog taxonomy — similarity alone was insufficient without category constraints (Figure 2).
- Samesake action: Treat DoorDash’s taxonomy heuristics as validation of the RFC’s split: **hard attrs (`category`, `gender`, `colors`, `material`, `fit`) stay in NLQ filters, categorical spaces, and `gate()` quarantine** (`templates/fashion.ts` compose/gate); **`embed_doc` carries only compositional text** (`search_document`, occasions, styles, details). First-stage retrieval = FTS + spaces + filters, not “everything in one embedding.”
- Why / caveat: Single-vertical fashion has a much smaller, cleaner taxonomy than grocery; the pattern transfers strongly even without their catalog-team investment.

### L2: Golden-set match rate before you have click labels  [maps: NEW]
- DoorDash evidence: While unsupervised, they built a **“golden” dataset** — ideal substitutions for top-selling SKUs curated by humans — and measured **% of algorithm picks that matched the golden set** before any thumbs data existed.
- Samesake action: Promote `apps/playground/lib/search-relevance.ts` from ad-hoc LLM judging to a **checked-in golden query→expected-SKU set** (top-N catalog queries × human-approved IDs); run it in CI as offline regression alongside `search-relevance.test.ts`. Use `explain` mode to assert which channel (FTS vs cosine vs spaces) broke when golden match drops.
- Why / caveat: Samesake won’t have DoorDash-scale implicit feedback soon; golden sets are the cheapest way to catch G3 silent-degradation (title-only embed) and G2 quarantine regressions without A/B infra.

### L3: Ship a default second-stage pairwise scorer on the retrieval pool  [maps: G4 | G5]
- DoorDash evidence: After TF-IDF retrieval, they moved to a **binary relevance model** (LightGBM, then DLRM sigmoid) scoring candidate pairs — not trusting first-stage text similarity as final order (Figures 3–4).
- Samesake action: Implement RFC **C11–C12** as the DoorDash Phase-2 analogue: **`fashionRerank({ mode: "llm" })`** over `RERANK_POOL=50`, feeding **`enriched.rerank_doc`** (verbose attrs via compose hook in `enrich-pipeline.ts`), with `rerank: false` preserving pure RRF. Skip training a LightGBM/DLRM — LLM judge on composed text is the BYO substitute for their supervised classifier at samesake scale.
- Why / caveat: Their model scores the **full catalog** per ordered item; samesake correctly retrieves-then-reranks. DLRM + item-ID embeddings are overkill until behavioral log volume justifies it (RFC non-goal: learned ranker).

### L4: Capture explicit substitute judgments in-product, not only enrich corrections  [maps: G4 | NEW]
- DoorDash evidence: Thumbs-up/down UI created a **closed feedback loop** that unlocked LightGBM and later DLRM; without it they stayed on TF-IDF+heuristics.
- Samesake action: Extend the existing review/correction path (`review.ts`, enrich few-shot examples) to **persist pairwise labels** `(query_or_anchor_sku, candidate_sku, label)` from search UI or merchant QA — initially as rerank few-shot prompts or enrich stage examples, later as training data if volume grows. DoorDash’s “quantity > brand” lesson maps to logging **which attr mismatch caused a reject** (e.g. wrong fit/occasion, not just wrong color).
- Why / caveat: Fashion search is open query, not 1:1 substitution; labels are query→SKU relevance, not “replace SKU A with SKU B.” Still the same loop structure.

### L5: Behavior-trained embeddings matter for sparse SKUs; enrich+visual is partial cover  [maps: NEW | G7]
- DoorDash evidence: Semantic item embeddings trained on **user search behavior** (twin NNs) let DLRM beat LightGBM on **low-purchase-volume** items where metadata/text is thin (Figure 4: peas ≈ beans, corn ≠ beans).
- Samesake action: Short term — lean on **visual space + LLM enrich** for long-tail SKUs (already beyond DoorDash’s 2022 text-only Phase 1–2). Medium term — when click/add-to-cart logs exist, add a **behavioral space segment or G7 personalization hook** (`core/ranking.ts`) rather than baking popularity into `embed_doc`. Do **not** block RFC on co-trained item embeddings.
- Why / caveat: DoorDash’s win required platform-scale search logs samesake doesn’t have; their post also lists image embeddings as “next steps” — samesake is already ahead on visual, behind on behavioral co-training.

## Applicability caveats
- **Problem shape:** DoorDash solves **pairwise substitution** (one known anchor SKU → ranked alternates in the same store). Samesake is **open NLQ product search**; their full-catalog binary scorer and pack-size heuristics don’t port literally.
- **Scale & infra:** Hundreds of thousands of SKUs, LightGBM/DLRM training pipelines, and an internal experimentation platform — none of which samesake needs or should copy for a single-retailer fashion vertical.
- **Attribute semantics:** Grocery substitution pivots on **quantity/package/brand** (Figure 3); fashion pivots on **fit, size, occasion, style** — DoorDash gives almost no guidance on visual or apparel attrs beyond naming future image embeddings.
- **Thin on serving/eval specifics:** No embedding dims, loss functions, feature lists, score thresholds, or latency numbers — most “how” is architectural narrative, not reproducible hyperparameters. Value is in the **staged retrieval → gate → supervise → rerank** pattern, not model recipes.
