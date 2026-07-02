
# Transforming MLOps at DoorDash with Machine Learning Workbench
URL: https://careersatdoordash.com/blog/transforming-mlops-at-doordash-with-machine-learning-workbench/

## Key mechanisms
- **ML Portal → ML Workbench evolution:** Started as a Flask/HTML “test model predictions in browser” portal; grew into a React/Prism internal hub integrated with Experimentation Platform and Metrics Platform (Figure 3).
- **Crawl–walk–run scoping:** Q1 user research + vision, Q2 design/build + perf, Q3 surveys + lifecycle expansion — explicitly *not* trying to cover all four ML lifecycle phases (Figure 2) on day one.
- **Jobs-to-be-done user split:** Three personas — platform admins (connectors, cross-model feature debug), end users (DS/analysts: shadow deploy, prod monitoring, test predictions), operators (PMs/leads: team metrics) — used to prioritize v1.
- **Observed usage skewed to post-deploy lookup, not training:** Highest traffic was predictor/feature lookup, “Pipeline Runs and Sensor Ticks” (often cross-checked in Dagit), and prod feature inspection *after* features land in Redis — users explicitly said they “don’t touch ML Portal during feature development work” (Figures 2, 6–10 context).
- **Feature upload freshness (v1 use case A):** Model owners run **daily** checks that fabricator uploads reached the feature store on schedule; pre-Workbench flow was a multi-hop CLI path through fabricator source → upload service tables (Figure 6 → demo Figure 7); MLW integrates directly with the feature upload service/tables in UI (Figure 10).
- **Production feature value spot-check (v1 use case B):** Validating served feature values required local-machine queries against prod feature stores; pre-Workbench multi-step CLI (Figure 8 → demo Figure 9); MLW exposes direct prod feature-store query in UI (Figure 10).
- **45-day concept-to-production cadence** for iterative capability adds (Figure 4); quarterly satisfaction surveys to steer roadmap.
- **Stated 2024 direction:** broaden personas + “improve observability” for features/models in Workbench — observability is acknowledged as incomplete at publish time.

## Learnings for samesake
### L1: Ship pipeline observability on daily lookup tasks, not a full ML platform  [maps: G6 | NEW | N/A]
- DoorDash evidence: v1 shipped only upload-status lookup + prod feature-value lookup; research showed practitioners wanted information retrieval and freshness checks, not training/tuning in the portal (quotes at lines 116–121; Figures 6–10).
- Samesake action: Treat RFC G6 (`pipeline_status`, `attempt_count`, `last_error`, `next_attempt_at`, `retryFailed`, error-rate abort in `enrich-pipeline.ts` / new `core/retry.ts`) as the “ML Workbench equivalent” — queryable row state + retry pass — instead of building dashboards for model training, shadow deploy, or experimentation. Extend the existing review endpoint (`review.ts`) to surface `pipeline_status` and `gate.reason`, not just `confidence`.
- Why / caveat: Same operator JTBD (“did my upstream artifact land correctly?”) at catalog scale; no fabricator/Redis mesh to mirror. Do not over-build UI — SQL/review API + scheduled jobs suffice.

### L2: Collapse multi-hop debug into one production lookup surface  [maps: G6 | G2 | NEW]
- DoorDash evidence: Pre-Workbench feature-value check required leaving the portal, running local scripts, and querying prod stores (Figure 8); MLW reduced this to a single UI that reads production feature stores directly (Figure 10). Testimonial: engineers share Workbench links so cross-functional partners validate feature values without local prod setup.
- Samesake action: Replace scattered consumer patterns (`for (i<10) { enrich() }` in examples, manual compose between enrich/index) with one durable status model: after compose+gate land in `enrichOne`, expose `{ id, pipeline_status, last_error, quarantine reason, enriched_at, indexed_at, image_etag }` via review/admin query so catalog owners can spot-check a SKU’s enrichment output and index eligibility without re-running playground scripts.
- Why / caveat: samesake’s “served artifact” is Postgres row state (enriched JSONB + vectors + FTS), not Redis features — but the *workflow* pain (too many hops to answer “what’s in prod for this id?”) transfers directly.

### L3: Scheduled freshness checks as a first-class operator ritual  [maps: G1 | G6]
- DoorDash evidence: “Model owners often perform **daily checks** to ensure feature freshness” before trusting downstream models (lines 147–148); upload-status UI reads upload-service tables rather than re-deriving state ad hoc.
- Samesake action: Implement RFC `revalidateImages()` (`core/revalidate-images.ts`) as a scheduled pass (conditional HEAD/`If-None-Match`, persist `image_etag`/`image_checked_at`, pHash fallback per REQ-3c) and return `{ checked, changed, failed }` — the direct analog to “Pipeline Runs / Sensor Ticks.” Pair with G6 columns so a changed image forces `indexed_at`/`enriched_at` reset and stage-cache invalidation (REQ-3b), not silent visual drift (G1).
- Why / caveat: Image-behind-stable-URL is samesake’s freshness failure mode; one bounded HTTP check per row per pass matches DoorDash’s cheap validator pattern. Scale is orders of magnitude smaller — daily or on-ingest schedule is enough.

### L4: Scope v1 to proven post-deploy validation, defer lifecycle breadth  [maps: G6 | N/A]
- DoorDash evidence: Research concluded Workbench was “most used” after features were “deployed to production and uploaded to Redis,” not during feature engineering; full lifecycle (Figure 2: build/train/tune/deploy) was explicitly deferred.
- Samesake action: Sequence RFC C1–C10 (status, compose, gate, revalidate, retry, image-fail-not-zero-vector) before C13 ranking polish or any learned ranker work (RFC non-goals). Prioritize “enrich → compose → gate → index → searchable set integrity” over new retrieval channels.
- Why / caveat: DoorDash’s lesson is product sequencing, not retrieval quality. samesake’s RFC already aligns; this post reinforces not diluting G2/G3/G6 with platform scope creep.

## Applicability caveats
- **No search/retrieval substance:** Zero models, dims, losses, fusion weights, rerankers, thresholds for relevance, or offline eval — nothing maps to G3–G5, G7, or embedding-hygiene (REQ-11b). Do not infer ML-search tactics from this post.
- **Different artifact layer:** DoorDash observability targets fabricator → feature upload service → Redis serving; samesake is ingest/enrich/index in Postgres + pgvector. Mechanisms transfer as *operability patterns*, not infrastructure copy-paste.
- **Org/UX narrative dominates:** Most of the post is design process (Prism, 45-day cycles, quarterly surveys, three personas) — useful for prioritization, not for ranking architecture.
- **Incomplete observability even for DoorDash:** Authors flag feature/model observability as future work (2024); treat their v1 as “freshness + spot-check,” not a solved MLOps stack.
