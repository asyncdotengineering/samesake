---
"@samesake/core": minor
"@samesake/server": minor
---

Cross-vendor offer dedup (P2-2). `CollectionDef.dedup` clusters listings of the same physical
product so search returns **one hit per product** with an `offers` array. Declare scoring channels
(`exactKey` — decisive equal-key short-circuit; `trigram`; `cosine` — weighted, normalized to
[0,1]), an `autoLink` threshold (merge automatically), an optional `suggest` threshold (queue for a
human), and `offerFields` (the declared fields copied onto each offer). Clustering is an explicit,
incremental `matcher.dedup(project, collection)` stage after `index` (`{ rebuild: true }`
re-clusters from scratch, replaying human decisions).

Search collapses on the cluster id by default (existing `variantGroup` mechanism; `diversify: false`
opts out) and each hit carries `offers` — one entry per **ready** cluster member, restricted to
`offerFields` + `id` (never raw `data`), fetched in one batched query per page (`offers: false`
skips it). Quarantined/deleted members drop out automatically.

Human loop: `dedupClusters` / `dedupSuggestions` list state; `confirmGroup` merges a suggested pair;
`splitGroup` evicts a row into a fresh cluster and records the decline so re-runs and rebuilds never
re-link it. Precision-first: an uncertain pair is a suggestion, never an auto-merge. HTTP routes
(`POST …/dedup`, `GET …/dedup/clusters`, `GET …/dedup/suggestions`, `POST …/dedup/confirm`,
`POST …/dedup/split`) and CLI (`samesake dedup`, `dedup-clusters`, `dedup-suggestions`,
`dedup-confirm`, `dedup-split`) mirror the in-process API.

Candidates are pinned to the row's tenancy scope, so a cluster can never span `scopes`. Collections
without `dedup` are completely unaffected on every surface. Note: the in-process `matcher.dedup`
binding now runs collection offer-dedup; the entity-resolution engine's dedup is unchanged and stays
reachable via `GET /v1/projects/:project/duplicates`.
