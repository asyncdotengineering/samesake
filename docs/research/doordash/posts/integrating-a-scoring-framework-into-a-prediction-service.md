# Integrating a Search Ranking Model into a Prediction Service
URL: https://careersatdoordash.com/blog/integrating-a-scoring-framework-into-a-prediction-service/

## Key mechanisms
- **Scoring lived inside the search microservice** (Figure 1): store-ranking ran feature fetch, transformation, and logistic-regression inference inline on every request — causing RAM pressure (features in DB + Redis + in-memory warmup) and “hundreds of thousands” of CPU ops per request.
- **Migration pattern** (Figure 2): search sends only entity IDs (store IDs + consumer ID); a dedicated prediction service (Sibyl) owns feature lookup, online feature assembly, and model inference; search becomes a thin orchestrator.
- **Offline ETL → feature store** (Figure 3): Snowflake staging table maps every ranking feature to a consistent `(sibyl_name, feature_key, feature_value)` triple; store-only features are “offline,” store×consumer features use a composite cache key; **null / zero / false values are dropped at load** and replaced by per-feature defaults declared in model config.
- **Variable-length list features**: lists stored as a concatenated dynamic array plus an offsets matrix (lengths per feature); serving ops are `size()`, `count_matches()`, `count_matches_at()` (with a `unique` flag), covering tag/term overlap without treating lists as fixed-dim embeddings.
- **Explicit vector op in the scoring graph**: `cosine_similarity(store2vec, consumer2vec)` is a first-class compute node — personalization similarity is not pre-fused into tabular features.
- **Composite computational-graph models**: each scorer is input nodes (numerical, categorical, embedding, list) → chained compute nodes → `result`; a sidecar config declares **default values, dimensions, and sequence lengths** per input — onboarding a 23-feature logistic model dropped from ~1 week of hand-coded ops to “a few hours.”
- **Model class**: production scorer is **logistic regression** (vectors in, scalar score out); boosted trees / DL mentioned only as future work — no retrieval, no loss functions, no embedding dims, no eval methodology.

## Learnings for samesake
### L1: Keep heavy scoring off the search hot path  [maps: G4 | G7]
- DoorDash evidence: CPU/RAM saturation came from running feature materialization + LR inference inside the search service; fix was ID-in / score-out via Sibyl (Figure 2).
- Samesake action: treat `rerankHits` (`search.ts:819-856`, pool `RERANK_POOL=50`) and the G7 `rankingPolicy` hook as **explicit second-stage seams** — search returns first-stage RRF hits, then optionally calls BYO `rerank` / normalized boosts; never inline enrich-time feature assembly or ad-hoc `title ?? description` scraping in the request path (G5 `rerank_doc` via `compose`).
- Why / caveat: samesake does not need a separate prediction microservice at fashion-catalog scale; the transferable lesson is **boundary placement**, which the RFC already targets but DoorDash validates with production pain data.

### L2: Declarative graph + config defaults beat hand-wired feature lists  [maps: G3 | G5]
- DoorDash evidence: every new scorer required manually coding/abstraction for each of ~23 features; composite graphs + config-file defaults/dims cut onboarding from ~1 week to a few hours.
- Samesake action: wire `PipelineDef.compose` / `gate` in `enrich-pipeline.ts` and `templates/fashion.ts` so `embed_doc` + `rerank_doc` are emitted inside `enrichOne` — delete the scattered manual `composeFashionEmbedDoc` call sites in playground/examples (RFC C7). Model config analogue = fashion template constants (`FASHION_CONFIDENCE_FLOOR`, REQ-11b trimmed `composeFashionEmbedDoc`).
- Why / caveat: direct structural parallel to samesake’s G3 footgun (“consumer forgot compose → silent `data.title` fallback at `embed-index.ts:348-349`”). DoorDash’s LR graph is not our RRF stack, but the **declarative-vs-scattered** failure mode is identical.

### L3: Offline feature ETL with load-time validation  [maps: G1 | G2 | G6]
- DoorDash evidence: ranking inputs are **precomputed offline** (Snowflake ETL, Figure 3) with a pre-load check that null/zero/false features never enter the store; online request path only joins store + consumer keys.
- Samesake action: treat `enrich` + `compose` + `gate` as the offline ETL pass writing `enriched` JSONB; `pipeline_status` (`quarantined` / `failed` / `dead`, RFC G6) is the load gate; `revalidateImages` + `image_etag` in `stageCacheKey` (RFC G1/M1) is the catalog-drift detector analogous to refreshing stale store features.
- Why / caveat: DoorDash **defaults** bad features; samesake should **quarantine** low-confidence LLM rows (G2) — stricter and correct when enrichment is probabilistic, not tabular ETL.

### L4: Separate embedding-similarity ops from tabular score arithmetic  [maps: G7 | NEW]
- DoorDash evidence: `store2vec`×`consumer2vec` cosine is an isolated graph node; tabular features flow through separate arithmetic/Boolean ops before LR — no single fused feature blob.
- Samesake action: implement G7 by extracting `core/ranking.ts` with **normalized post-RRF composition** (`norm[h] * w.relevance + …`) instead of `fashion-search.ts:163-168` adding raw `±2` to raw RRF (~0.0–0.05); keep visual personalization as its own weighted term (today `visualCosines` only in explain mode — RFC Q1).
- Why / caveat: same commensurability bug DoorDash avoided by typed compute nodes; samesake already has the channel split (FTS / cosine / spaces / recency) — G7 finishes it for business/availability boosts.

### L5: Explicit omission semantics for low-signal features  [maps: G3 | embedding hygiene]
- DoorDash evidence: null/zero/false features are **not stored**; model config supplies per-input defaults so missing signal does not pollute inference.
- Samesake action: in `composeFashionEmbedDoc`, omit `uncertain_fields` and hard low-cardinality attrs (`category`, `gender`, `colors`, `material`, `fit`, `brand` per REQ-11b) rather than embedding guessed values; filters/spaces carry them exactly.
- Why / caveat: fashion `extract` already emits `confidence` + `uncertain_fields` (`fashion.ts:132-133`) but they are post-hoc review-only today (G2); DoorDash’s “don’t load garbage” rule maps to compose-time omission, not a feature store.

## Applicability caveats
- **Not a retrieval or enrichment post**: no two-stage retrieval, no embeddings for search, no rerankers, no eval — only **post-retrieval LR scoring infra**. Most samesake relevance work (RRF, visual spaces, NLQ, cross-encoder rerank) is out of scope here.
- **Scale mismatch**: DoorDash’s pain is Redis/RAM warmup + 100k+ ops/request across millions of stores/consumers; a single-vertical fashion catalog in Postgres+pgvector will not justify a Sibyl-like service split — only seam discipline transfers.
- **Model class mismatch**: logistic regression over hand-engineered store×consumer features ≠ samesake’s LLM enrichment + dense `embed_doc` + RRF fusion; list-feature storage tricks (offsets matrix) do not apply to JSONB `enriched`.
- **Personalization depth**: DoorDash’s `store2vec`/`consumer2vec` is a trained pairwise embedding; samesake’s `rankingPolicy.personalization` is an optional boost hook — adopting DoorDash’s embedding approach would be a new modeling project, not an RFC seam fix.
