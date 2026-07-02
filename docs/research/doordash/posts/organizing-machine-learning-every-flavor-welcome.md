```
# Organizing Machine Learning: Every Flavor Welcome!
URL: https://careersatdoordash.com/blog/organizing-machine-learning-every-flavor-welcome/

## Key mechanisms
- **No retrieval/search ML stack described** — the post is 2020 org/process writing (Head of DS/ML charter), not a ranking/embedding architecture article. No figures beyond header/author photos; no models, dims, losses, indexes, eval harnesses, or serving latencies.
- **Six operating principles** govern *when* ML is built and *who* owns it: democracy (anyone can propose with tooling), talent, speed (buy third-party when cost-effective), sufficiency (engineering ships good-enough alone), incrementality (DS only when additive), accountability (one technical lead per solution).
- **Impact gate before ML**: ML is reserved for problems where “simple analytics or rules only get you 10–40% of the impact”; otherwise analytics/rules suffice.
- **Centralized ML platform mandate** (owned by Data Platform / ML Infrastructure): workflow, provisioning, orchestration, feature stores, common data prep, **validation, quality checks, monitoring** — explicitly *not* left to each vertical team.
- **ML Council governance loop**: cross-functional proposal (business problem, impact vs build/maintenance cost, team, single tech lead) → pod/vertical leads approve problem/priority → ML Council approves solution/infra fit → weekly transparent “ML Review” with published notes; Council tie-breaks disagreements and routes tech-lead role by blocker type (production perf → ML Engineer, statistical perf → Data Scientist).
- **Blurred DS/Eng boundaries** with hard accountability: practitioners may cross roles, but principle #6 keeps one person responsible for correctness end-to-end.

## Learnings for samesake
### L1: Platform-own validation/quality/monitoring — not per-consumer glue  [maps: G2 | G6 | NEW]
- DoorDash evidence: They fund a **central ML platform** whose scope explicitly includes validation, quality checks, and monitoring; vertical teams propose use cases but do not each reinvent lifecycle hygiene.
- Samesake action: Land the RFC’s framework-owned seams in core — `pipeline_status` / `attempt_count` / `last_error` / `next_attempt_at` (`collections-schema-gen.ts`), `compose` + `gate` on `PipelineDef` inside `enrichOne` (`enrich-pipeline.ts`), search-time exclusion of non-`ready` rows (`search.ts`), and `retryFailed` + error-rate abort (`core/retry.ts`). Delete consumer hand-rolls (`compose-embed.ts`, playground upload/sync compose calls) so quality is not optional per integrator.
- Why / caveat: samesake is one vertical and tiny vs DoorDash, but the RFC’s thesis (“nothing skippable, everything tracked”) is the same platform-vs-bespoke split — just at framework scale, not headcount scale. This post gives **organizational justification**, not implementation detail.

### L2: Single accountable owner per ML surface — collapse scattered footguns  [maps: G3 | G2 | NEW]
- DoorDash evidence: Principle #6 — every ML solution has **one technical lead** accountable for correctness, even if others execute; ML Council checks that ownership matches the real blocker (prod vs statistical).
- Samesake action: Make `PipelineDef.compose` the sole writer of `embed_doc`/`rerank_doc` and `PipelineDef.gate` the sole indexer admission control; remove fashion predicates from `embed-index.ts:339-345` and title-only fallback at `:348-349`. One hook pair owns textualization + quarantine instead of “enrich in server, compose in playground, gate hardcoded in indexer.”
- Why / caveat: DoorDash’s “lead” is a person; samesake’s equivalent is a **declared pipeline hook** with tests (`test:enrich-compose-gate`, `test:index-gate`). Strong mapping to G2/G3; zero mapping to their actual search/ranking stack (they never describe one).

### L3: Sufficiency + incrementality → BYO providers with template defaults, not bundled models  [maps: G4 | REQ-21 | N/A]
- DoorDash evidence: “Speed” = use cost-effective third parties; “Sufficiency” = let the function that can ship good-enough do so unaided; “Incrementality” = DS only when marginal value is large.
- Samesake action: Keep provider-agnostic `embed`/`generate`/`rerank` (REQ-21), but ship `fashionRerank()` + `composeFashionRerankDoc` in `templates/fashion.ts` so the **second stage exists by default** without bundling a model — consumer wires `generate`, `rerank: false` keeps pure RRF. Matches their buy/build split at library-template scale.
- Why / caveat: DoorDash’s “third party” is vendor SaaS; samesake’s is consumer-supplied inference. The pattern transfers (platform seam + optional depth), not the procurement mechanics. Default LLM rerank per query (RFC Q1) is the main cost tension their “10–40% impact” gate would force you to justify with eval.

### L4: Impact gate before expensive ML stages  [maps: G4 | NEW | N/A]
- DoorDash evidence: They explicitly avoid ML where rules/analytics capture most of the business outcome; ML headcount goes only where incremental lift is large vs maintenance cost (proposal must estimate impact vs build/maintenance cost).
- Samesake action: Treat RRF + hard filters + spaces as the “rules/analytics” baseline; enable default rerank only for collections/templates where eval shows vague-intent failure modes (fashion NLQ), and expose `rerank: false` + channel `explain` as the cheap control arm — document per-query `generate` cost in fashion template docs (RFC C14).
- Why / caveat: You lack DoorDash’s formal ML Council proposal loop; substitute **offline eval** (`search-relevance.test.ts`, fashion smokes) as the approval gate. At small catalog scale, rerank ROI may be negative — their framework says skip or defer, not default-on blindly.

## Applicability caveats
- **Not a search/ML systems post.** Zero mechanisms for embeddings, fusion, reranking, feature stores, or online serving — only org design and platform *categories*. Do not infer DoorDash retrieval architecture from this URL.
- **Scale mismatch:** Council + weekly review + dedicated ML Infrastructure make sense at multi-vertical marketplace scale; samesake’s analog is typed framework hooks and tests, not a governance committee.
- **Age (Feb 2020):** Pre-LLM, pre-vector-search boom; “centralized ML platform” here means orchestration/monitoring/feature stores in the classical DS sense — align conceptually to G6/G2, not to any specific DoorDash 2020 search stack.
- **RFC gaps this post does not address:** G1 image-byte invalidation, embedding hygiene (REQ-11b), normalized business boosts (G7), pHash/ETag revalidation — no transferable technical detail in the source.
```
