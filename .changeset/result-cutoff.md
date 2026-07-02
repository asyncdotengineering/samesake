---
"@samesake/core": minor
"@samesake/server": major
---

Honest zero-results: pluggable result-cutoff strategies on the search path
(`CollectionSearchDef.cutoff`). Default ON for every collection as `{ strategy: "score-drop" }`
— when no hit has lexical (FTS) evidence and even the best semantic cosine is below `minAnchor`,
the list is honestly empty instead of nearest-neighbour padding; a steep relative cosine cliff
(`maxDrop`) ends a semantic tail mid-list. Also available: `category-coherence` (unanchored
results scattered across a declared field → zero) and `none` (opt out). FTS-anchored hits are
never cut; hard-filtered queries (explicit or NLQ-derived) bypass the cutoff so filtered recall
stays total. Search responses gain `cutoff_dropped`; `/v1/metrics` gains
`search_cutoff_dropped_total`. Proven by an adversarial eval: "laptop" against a clothing
catalog returns zero, not the three least-irrelevant handbags.
