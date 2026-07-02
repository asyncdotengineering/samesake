# S0 — pipeline framework columns + recordFailure

## Decisions

- **Backoff formula:** `LEAST(3600, power(2, attempt_count))` seconds using pre-increment `attempt_count` (first failure → 1s, second → 2s, capped at 1h). Matches RFC §6 exponential shape.
- **`recordFailure` export:** Exposed on `makeEnrichPipelineService` return for direct REQ-16 testing; not added to public `Matcher` surface (internal pipeline primitive).
- **Backfill guard:** `pipeline_status='pending'` prevents re-apply from clobbering `failed`/`quarantined`/`dead` rows.
- **No existing DDL snapshot updates:** Additive columns did not break any column-list assertions in `collections-ddl.test.ts`, `migrations.test.ts`, or `vector-dim.test.ts`.

## Root cause fixed (record-failure test)

- Postgres driver returns `timestamptz` as ISO strings, not `Date` — test compares via `new Date(...)`.
