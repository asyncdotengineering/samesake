---
"@samesake/server": major
"@samesake/core": major
---

Multi-aspect retrieval major. Collections declare named aspect embeddings (`doc`, `visual`,
`facets`, ...) — each gets its own column, HNSW index, and RRF leg; evidence aspects store
row-per-claim with a MaxSim leg; NLQ routes query intent to aspects. BREAKING: the `spaces`
subsystem is removed (`SpacesChannel`, `s.*` builders, `space_vec` — destructive migration on
apply); image/`similar` queries now run through the `visual` aspect (verified parity: exact
product at rank 1). Eval-gated defaults: non-primary aspect legs are OFF for text intent
queries (C9 gate + two calibrations, artifacts in `evals/runs/`; see BENCHMARKS "Aspects
gate") and fully ON for image/`similar` mode. Per-query `weights.aspects` re-enables intent
aspects for experiments. Also: indexing gains bounded concurrency (`SAMESAKE_INDEX_CONCURRENCY`),
a per-doc watchdog, and rolling-pool processing.
