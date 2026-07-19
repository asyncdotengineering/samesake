---
"@samesake/server": major
"@samesake/sdk": minor
---

Grounded query understanding (rfc-grounded-query-understanding v2). Scoped per-collection
vocabulary tables with trigger-maintained deltas ground open-vocab NLQ filters (map-or-drop:
every accepted value matches a live visible row); the parse exposes a corrected
`lexical_query` used by all FTS branches, protected by a deterministic edit-distance guard
(no added/translated/expanded terms); LLM-derived hard enum filters apply only when
corroborated by the user's own tokens (query-side taxonomy guesses cannot silently delete
the relevant pool); NLQ now runs on every text query (BREAKING: the short-query token skip
is removed); zero-LLM deterministic enum-token filters; progressive soft-filter relaxation
with declared `relaxOrder` priority (SDK: new `search.relaxOrder`); typed honest-zero
rewrites; truthful `constraintTrace`/`searchExplain`. Gate record in RFC §13: typo mean
2.05→2.083, overall 1.871→1.916, OOD honest zeros unchanged.
