# #59 StorageAdapter per-op relocation — implementation notes

Goal: move every raw-driver SQL op out of `core/` into typed `StorageAdapter` methods,
so a future dialect (SQLite) is additive. Headline (`ctx.db` removed, `client`/`exec`
primitives, `facets` method) already shipped earlier. This is the long-tail per-op move.
Folding in #61 (Indic phonetic → opt-in provider) at the upsert/DDL surface.

## Scope decision (user, mid-execution)

Relocate **dialect-specific ops only** (the ones a SQLite adapter must reimplement: FTS/RRF,
pgvector, facets). Portable business-SQL (review queue, corrections, retry/enrich/revalidate
selects, projects migration DDL) **stays on the `client()` primitive** — moving it into named
methods is boilerplate for marginal gain (this issue's own caveat). The 7 business-SQL ops
already relocated below stay (done, green, harmless); no further business-SQL relocation.

## Done (this session) — suite/test-gated

| Commit | Ops | File(s) |
|---|---|---|
| `83a83e9` | recordFailure | pipeline-failure.ts |
| `f975e3a` | rowData, indexStatus, markDead, retryableRows, upsertDocument, deleteDocuments | agent-tools, retry, ingest |
| `cabd989` | facet SQL (5 queries) **moved** core/ → db/postgres/ (dialect-specific) | facets.ts |

**8 ops relocated. Full Neon suite green (233 pass / 0 fail / 53 files); facet test 4 pass.**

## Remaining — dialect-specific, COMPLEX, inline (the search engine core)

These are **inline in service closures** (not movable functions like facets), so each needs
careful byte-identical extraction into a StorageAdapter method, full-suite-gated per file:

- `embed-index.ts` — 6 pgvector ops (pending select, vector UPDATEs) inside `makeEmbedIndexService`
- `search.ts` — 4 FTS + RRF ops (the hybrid-rank query)
- `fashion-search.ts` — 4 FTS/RRF ops

**Why checkpointed here, not rushed:** I caught TWO incomplete-SQL bugs in the *simple* upsert op
(missing `enriched_at`/`indexed_at`/`enriched` resets). The pgvector/FTS/RRF ops are far more
complex and load-bearing for search quality on a live 10k-user product. They warrant dedicated,
byte-identical relocation with a full-suite gate per file + a code-quality review across the
relocation commits before go-live — not a tail-of-session grind.

## Gotchas caught (why this needs the suite gate, not eyeballing)

- **upsertDocument SQL was incomplete twice.** The real ingest upsert resets FOUR columns
  on a content-hash change (`updated_at`, `enriched_at`, `indexed_at`, `enriched`). My first
  hand-copy dropped `indexed_at`+`enriched`; the second still dropped `enriched_at`. Both
  would have silently broken re-index/re-enrich on content change. Fixed to byte-identical
  (verified: 4 resets in both adapter + original). **Lesson: copy SQL verbatim, never retype;
  gate every batch on the full suite.**

## Remaining (~31 raw ops, 8 files) — ordered by risk

Simple CRUD (lower risk, same pattern as the done batch):
- `review.ts` (3), `revalidate-images.ts` (3), `enrich-pipeline.ts` (3 — enrichment UPDATEs)

Medium (DDL application / migration):
- `projects.ts` (3 — includes `db.execute(sql.raw(stmt))` applying generated schema DDL)

High-value + highest-risk (dialect-specific — the real reason for the adapter):
- `search.ts` (4 — FTS + RRF), `fashion-search.ts` (4), `facets.ts` (5), `embed-index.ts` (6 — pgvector)

`db-utils.ts` (1) is the `getPgClient` primitive home — stays.

## #61 status (folded in)

- The phonetic compute lives in `upsert.ts` (`SELECT samesake_phonetic(...)`) — a `db.execute(sql\`\`)`
  template, relocated naturally as part of the upsert-area work.
- The remaining #61 work is the DDL extraction: pull `samesake_phonetic` (~70 lines plpgsql,
  Sinhala/Tamil/Latin) out of the default `system-ddl.ts` into an opt-in `indicPhonetic`
  PhoneticProvider, with a golden test pinning the cross-script equivalences first. Plan: issue #61.

## Recommendation before go-live (10,000 users)

The dialect-specific ops (search RRF, embed-index pgvector, facets) are the riskiest to relocate
and the most load-bearing for search quality. Relocate them in their own suite-gated commits with
byte-identical SQL, then run a full code-quality review across the relocation commits before the
release. The two upsert bugs caught here show eyeballing is insufficient.
