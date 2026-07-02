```
# 3 Principles for Building an ML Platform That Will Sustain Hypergrowth
URL: https://careersatdoordash.com/blog/3-principles-for-building-an-ml-platform/

## Key mechanisms
- **Dream big, start small via a single wedge service (Sibyl):** Rather than building a full ML platform sequentially, DoorDash shipped one core online prediction service first—high throughput, low latency, with batch predictions, model shadowing, and feature fetching—onboarding logistics dispatch ML, then search & discovery. Figure 1 tracks ~4× models and ~5× weekly predictions as adoption grew.
- **Strategic bets over generic platform completeness:** Three explicit bets—platform velocity (automation), ML platform-as-a-service (cohesive artifact + pipeline management), and observability (detect model/feature decay fast)—used to prioritize roadmap vs. building every Michelangelo/TFX capability at once.
- **Measure-at-scale, then benchmark optimizations:** When feature-store volume spiked (billions of features/day), they benchmarked storage alternatives and landed Redis + binary serialization + string hashing + compression → ~3× cost cut and ~38% lower feature-fetch latency (detailed in their gigascale feature-store post).
- **Observability with zero onboarding friction:** Feature-quality monitoring v1 required an explicit onboarding step → low adoption; v2 turned monitoring on for all features by default (“french fry moment”), removing the step that blocked the value.
- **Anticipatory tooling to kill manual glue:** Sibyl migration exposed a manual Python+gRPC model-test script; they replaced it with a browser UI before users asked—cut support load and sped iteration. Model-deployment automation similarly dropped deployment support volume.
- **Customer one-pagers + support telemetry for prioritization:** Internal “one-pager” per use case (success metrics, business impact) feeds stack-ranked platform work; weekly support-volume reviews drive automation (FAQ, group onboarding, deployment self-service).

## Learnings for samesake
### L1: Ship the load-bearing seam first, not “platform completeness”  [maps: G3 | G2 | N/A]
- DoorDash evidence: Sibyl was one focused prediction-service wedge (online infer + shadowing + feature fetch) for logistics before expanding to search; full training portal/observability came later in “Future Work.”
- Samesake action: Land RFC spine **C1–C7** (`PipelineDef.compose`/`gate` inside `enrich-pipeline.ts`, remove manual `compose-embed.ts` call sites, fashion template wires `embed_doc`/`rerank_doc` + quarantine) before G6 retry workers or G7 ranking refactor—treat compose/gate as samesake’s “Sibyl wedge,” not a docs-only nice-to-have.
- Why / caveat: Same “start small” shape fits a single-vertical SDK; deferring compose/gate while building retry/observability repeats DoorDash’s mistake of platform surface area without fixing the path every consumer must walk.

### L2: Quality controls must be default-on, not a separate review/onboarding step  [maps: G2 | G3]
- DoorDash evidence: Feature monitoring only helped after they **eliminated the onboarding step** and enabled monitoring for all features automatically; v1’s opt-in gate suppressed adoption despite clear value.
- Samesake action: Wire `gate()` in `fashionEnrichPipeline()` to set `pipeline_status='quarantined'` for non-apparel / `category==='other'` / `confidence < FASHION_CONFIDENCE_FLOOR`; run `compose()` in `enrichOne` so `$enriched.embed_doc` is always populated—never rely on post-hoc `review.ts` or consumer-remembered compose. Remove title-only fallback in `embed-index.ts:348-349`.
- Why / caveat: samesake already captures `confidence` and has a review endpoint—exactly DoorDash’s v1 pattern. Index-time quarantine + in-pipeline compose is the v2 “always on” equivalent at catalog scale.

### L3: Treat pipeline glue as product bugs, not documentation  [maps: G3 | G6]
- DoorDash evidence: Manual gRPC test scripts generated repeat support questions; they built a self-service web tester unprompted. Deployment automation cut support volume after DS headcount grew.
- Samesake action: Delete standalone compose steps (`examples/fashion-search/compose-embed.ts`, playground upload/sync compose calls per RFC C7); add a single `run-pipeline.ts` / matcher smoke that proves enrich→index→search with no manual steps; surface `pipeline_status`, `last_error`, `attempt_count` in playground or docs (RFC C14) instead of `for (i<10){enrich()}` loops in examples.
- Why / caveat: At fashion-catalog scale you won’t have DoorDash’s support desk, but the failure mode is identical—silent manual steps become permanent operational debt.

### L4: Observability should include shadow/compare paths, not only failure counters  [maps: G6 | G4 | NEW]
- DoorDash evidence: Sibyl ships **model shadowing** alongside production predict; observability is a strategic bet tied to decay detection, not optional metrics.
- Samesake action: Extend G6 metrics (`enrich_quarantined_total`, per-run failure-rate abort) with **shadow comparisons** in existing `explain` mode: log side-by-side RRF order vs default `fashionRerank()` order and per-channel ranks (`search.ts` explain path)—cheap regression signal before making rerank default-on (RFC G4/Q1).
- Why / caveat: No billion-QPS serving layer to shadow; but samesake already has multi-channel explain—use it as the shadow surface instead of building Sibyl-style infra.

### L5: Benchmark the expensive cache/store before scaling enrichment  [maps: G1 | NEW]
- DoorDash evidence: Alarm on feature-volume growth → objective benchmarks → 3× cost / 38% latency win on feature store.
- Samesake action: Before scaling enrich, **measure** 90-day stage cache (`stage-cache.ts`, URL-keyed `stageCacheKey` in `enrich-pipeline.ts:15-25`) hit rate vs stale-enrichment risk; RFC M1 requires folding `image_etag`/pHash into cache keys—benchmark one conditional-GET `revalidateImages` pass cost vs accidental stale vision enrichments after CDN image swaps (G1).
- Why / caveat: Fashion catalogs are tiny vs gigascale features; the learning is “instrument then fix the keying invariant,” not copy Redis serialization.

## Applicability caveats
- Post is **ML platform org/process**, not search/retrieval: no embedding dims, losses, retrieval indexes, rerankers, eval sets, or ranking thresholds—almost nothing transfers directly to RRF/spaces/rerank design (G4/G5/G7).
- Scale assumptions don’t transfer: billions of predictions/day and gigascale feature stores justify Redis micro-optimizations; samesake’s bottleneck is enrich/index **correctness seams** (G1–G3), not feature-fetch latency.
- DoorDash’s “platform-as-a-service for many data-science teams” differs from samesake’s **BYO `embed`/`generate`/`rerank` SDK**—their deployment portal/DS onboarding playbook is process inspiration only, not a component to build.
- Model shadowing/monitoring examples target **online prediction drift**, not catalog image URL drift or LLM enrichment confidence—analogous in spirit (G1/G2/G6) but different failure modes and fixes.
```
