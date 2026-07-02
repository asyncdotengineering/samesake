# StorageAdapter Refactor (issue #59) — Scratchpad

Mode: autonomous-stand + start-refactor (tiny commits, each green). Executing issue #59 incrementally.

## Backlog (sequenced in #59 — remaining op-migrations)
- Migrate: bootstrap/migrate, schema DDL, upsert, embed-index, search+explain, fetch+variants, enrich persistence, failure/retry, match/dedup, eval.
- Final: remove `ctx.db` (raw handle private to PostgresAdapter).

## Doing
(empty)

## Done
- **ctx.db removed (commit e59105d).** StorageAdapter is the sole DB contract: db + client() + exec() + facets(). All 17 core services + cache/migration modules + app-builder route through ctx.storage. MatcherCtx.db deleted. Full suite 232/0, tsc clean.
- **Remaining (Backlog): per-op method relocation** for 18 files still building dialect SQL in core (hybridQuery, applyCollection DDL, upsert, match*, variantGroups, explain*, indexDocuments) — each its own commit, facets is the template.

## Earlier Done
- **C1 — the seam.** `db/storage-adapter.ts`: `StorageAdapter` interface + `PostgresAdapter` (owns connection lifecycle). `MatcherCtx` gains `storage`; `createMatcher` builds `PostgresAdapter(built)`, `ctx.db = storage.db` (escape hatch during migration), `close()` routed through the adapter. Fixed two test ctx literals (record-failure, retry-failed). tsc clean; 4/4 createMatcher tests green.

## Scope note
A 15-commit whole-DB relocation is not safely completable + verifiable in one turn right after the 2.1.0 search ship. Shipping the seam (C1) + one proven op-migration (C2 facets) as the verified foundation; remaining mechanical migrations sequenced in #59 for incremental review. Research (workflow) confirmed: keep FTS/RRF raw inside PostgresAdapter; only pgvector schema/DDL could later use drizzle-native helpers (separate, out of #59).
