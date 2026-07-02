---
"@samesake/server": patch
---

`evaluateSearch`'s persisted judge-grade write is now awaited. The fire-and-forget write raced
process exit at the end of an eval run, silently dropping grades — the next run re-rolled the
judge on pairs it should have reused, so metric deltas stopped meaning "retrieval changed".
Proven fixed: two back-to-back eval runs are now byte-identical per query (67/67 grades + topIds).
