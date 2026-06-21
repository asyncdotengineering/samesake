# StorageAdapter Refactor (issue #59) — Implementation Notes

Mode: autonomous-stand + start-refactor. Executing #59 in tiny, individually-verified commits.

## What shipped this turn
- **C1 `f3362ad` — the seam.** New `db/storage-adapter.ts`: `StorageAdapter` interface + `PostgresAdapter` (owns the connection lifecycle). `MatcherCtx.storage` added; `createMatcher` builds the adapter and routes `close()` through it. `ctx.db` retained as the explicit escape hatch for not-yet-migrated operations. Pure/additive — no behaviour change.
- **C2 `a8d631e` — first operation migrated.** Facets moved behind `ctx.storage.facets(...)`; the search service no longer reaches into `ctx.db` for facets, and `computeFacets` becomes a `PostgresAdapter` internal. Proves the op-migration template a future dialect would re-implement.

Verified at each commit: server `tsc` clean; targeted suites green; full server suite **232/232**.

## Scope decision (and why I did not do all 15 commits)
#59 is a ~15-commit, whole-DB-layer relocation. Two reasons to ship the seam + one proven op-migration now, and sequence the rest for incremental review rather than blast 14 files in one turn:
1. **Risk.** The remaining migrations relocate complex SQL (the RRF hybrid-search builder, upsert, schema DDL, match/dedup) — immediately after the 2.1.0 search work. Each deserves its own verified commit + review; a single sweeping change is exactly what start-refactor's "smallest working step" guards against.
2. **Verification cost.** The 37 `describeIf(DATABASE_URL)` suites take ~4.5 min against Neon; 15 commits × full verification is not safely completable in one session.

The pattern is now established and templated; each remaining operation is a mechanical, low-risk follow-on commit. They are listed in #59 and in the scratchpad backlog.

## Research that informed the design (workflow `wf_35a521fc`)
How the community uses drizzle for pgvector/tsvector (gh + web, cited in the #59 comment):
- **pgvector is substantially native in drizzle**: the `vector` column type, `cosineDistance`/`l2Distance`/`innerProduct`, and `.using('hnsw'/'ivfflat', col.op('vector_cosine_ops'))` index builders.
- **FTS is almost entirely raw**: drizzle has no native `tsvector` type (use `customType` + `generatedAlwaysAs`), and **all querying (`@@`, `ts_rank`, `websearch_to_tsquery`) must be raw `sql`**. RRF/hybrid fusion and multi-leg CTEs also stay raw.
- **Verified perf trap**: ordering by `desc(1 - cosineDistance(...))` bypasses the HNSW/IVFFlat index (built on raw distance) — ~12s vs ~100ms. **samesake already does the index-correct thing** (`embedding <=> vec` ASC rank), so no bug here.
- **Implication for #59**: confirms "relocate but keep raw" is correct. The FTS query side and RRF fusion stay raw inside `PostgresAdapter`. A *separate, later* enhancement could express the vector **schema/DDL** (column type, HNSW index) via drizzle-native helpers for type-safety — out of #59's scope.

## Things to know
- **Layering**: `db/storage-adapter.ts` currently delegates `facets` to `core/facets.ts` (a db→core import; no runtime cycle since core/facets never imports the adapter). As more ops migrate, the Postgres-specific impl files should relocate under `db/postgres/` and the adapter own them outright — noted as later cleanup, not done now.
- Two test ctx literals (`record-failure`, `retry-failed`) gained the `storage` field.
- This work sits on top of the already-shipped 2.1.0 (relevance floor + NLQ + reranker); nothing here changes 2.1.0 behaviour.

---

## Milestone (turn 2): `ctx.db` removed — StorageAdapter is the sole DB contract

**Commit `e59105d`.** The headline of #59 is done + verified (full server suite **232/232**, tsc clean).

What changed:
- `StorageAdapter` gained execution methods: `client(context)` (raw parameterized `.unsafe()` client) and `exec<T>(sql)` (Drizzle `sql` template), alongside `db` (portable query-builder) and `facets()`.
- Every `ctx.db` / `getPgClient(ctx.db)` / `ctx.db.execute` across **17 core services**, the cache/migration db modules (`migrations`, `parse-cache`, `stage-cache`), and the app-builder `/healthz` route now routes through `ctx.storage.*`.
- **`MatcherCtx.db` deleted.** The core no longer holds a raw postgres-js driver. (Internal type — not consumer-facing; `createMatcher`/the matcher object are unchanged.)

### Design decision: primitives + per-op methods, not 40 boilerplate methods at once
The strict #59 criterion ("no `sql.raw`/`getPgClient` outside the adapter") implies relocating every dialect SQL op into a typed adapter method (~40 across 17 mixed orchestration+SQL services). Doing all of that in one pass — right after the 2.1.0 search ship — is high-risk churn for low marginal return on a Postgres-only engine. Instead:
- **Done now:** the field is gone, the adapter is the single DB contract, and the major self-contained op (`facets`) is a real method. Raw dialect SQL executes through the adapter's `client`/`exec` (a legitimate adapter-mediated-execution pattern — PayloadCMS's drizzle base likewise exposes the drizzle instance to its ops — **not** a workaround).
- **Remaining (the per-op deepening):** 18 files still *build* dialect SQL in core (executed via the adapter). Relocating each into a typed `StorageAdapter` method — `hybridQuery`, the DDL `applyCollection`, `upsert`, `match*`, `variantGroups`, `explain*`, `indexDocuments` — is the long tail, to be done op-by-op (each its own verified commit, `facets` is the template). A future SQLite adapter needs these as methods; today's Postgres-only engine does not block on them.

### Drizzle version finding (answers "is there a newer drizzle that helps?")
Installed **drizzle-orm 0.45.2** — already well past 0.31, so the **native pgvector helpers are already available** (`vector` column type, `cosineDistance`/`l2Distance`/`innerProduct`, `.using('hnsw', col.op('vector_cosine_ops'))`). Nothing newer to adopt. samesake currently hand-writes the vector SQL; when the dialect ops are relocated into adapter methods, the **vector schema/DDL + cosine ordering** can use these native helpers for type-safety (FTS `@@`/`ts_rank` and the RRF fusion stay raw — drizzle has no native FTS). This is a clean-up opportunity *inside* the future adapter methods, not a blocker.
