# Refactor plan: migrate samesake to the `indexing` DSL (breaking)

**Type:** breaking refactor (alpha, no compat — [[embrace-breaking-changes]]).
**Design (end-state):** `docs/design/indexing-dsl.md`.
**Contract / acceptance IDs:** `rfcs/rfc-pipeline-integrity-seams.md` G2/G3/G5 + REQ-8..11, REQ-11b (this refactor supersedes that RFC's §7 blueprint + WBS C3–C7 for the compose/gate seam).
**Baseline:** 172/172 server tests green at `ad21a9a` (`bun test packages/server/test`).

## Problem Statement

A developer wiring a samesake collection today has to: write `embeddings.doc.source = "$enriched.embed_doc"` (a stringly template), separately remember to call `composeFashionEmbedDoc(...)` between `enrich` and `index`, and trust that the generic indexer's hardcoded fashion skip + a silent `data.title` fallback do the right thing. Forget the compose step or mis-order it and search silently degrades to title-only embeddings with no error. There is no single place that guarantees a collection's retrieval text and index gate are produced. (`embed-index.ts:339-345` apparel skip, `:348-349` title fallback; `resolveEmbedTemplate` `$`-token engine; manual `composeFashionEmbedDoc`, `fashion.ts:238`.)

## Solution

A collection declares one **required** `indexing` block: `{ surfaces: Record<key, {kind, build, embedding?}>, gate }`. Each retrieval surface (dense/rerank/fts) is a first-class derived column with a required `build` function; `gate` is a required generic predicate returning `{index, reason}`. Builders + gate are in-process functions (like `enrich.stages[].prompt`); the serializable def carries an `indexingManifest`. Surface text + `pipeline_status` are built and **persisted at enrich time**; the indexer consumes persisted typed text. No string template, no fallback, no optional hook, no fashion semantics in the generic indexer. Breaking — every collection config must declare `indexing`.

## Commits

Tiny, each leaving the build green and `bun test packages/server/test` runnable. The new path is added first and consumers are moved before the old path is deleted; **any coexistence is transient within this branch — nothing dual-shape ships** (the final commits delete the old path entirely).

1. **Add `indexing` types (additive).** In `@samesake/core` types: `DerivedDocContext`, `DerivedDocDef` (`dense`/`rerank`/`fts` + required `build`, `embedding?`), `IndexGate`, `IndexingDef`, `AuthoredCollection` (= `CollectionDef & { indexing: IndexingDef }`), `CollectionDef.indexingManifest?`. Export `gates.always`. No behavior change; nothing consumes them yet. Verify: typecheck + existing tests green.

2. **Add collection columns (additive DDL).** In `collections-schema-gen.ts` CREATE: add `rerank_doc text`, `fts_src text`, `pipeline_status text NOT NULL DEFAULT 'pending'`, `gate_reason text`. Change the generated `fts` column to derive from `coalesce(fts_src,'')` (was searchable-fields+doc). Add `ensureCollectionSystemColumns()` (idempotent `ADD COLUMN IF NOT EXISTS`) and call it on apply, separate from `planCollectionMigration`'s field diff. Backfill `pipeline_status='ready'` where `indexed_at IS NOT NULL`. Verify: a fresh + an existing table both have the columns (migration test); existing tests green (fts still populated for current rows via backfill of `fts_src` = old expression in this commit).

3. **Persist surfaces + gate in `enrichOne` (when `indexing` present).** After the inference stages, if `def.indexing` exists: run each `surfaces[].build(ctx)` and `gate(ctx)`; persist built texts into `doc`/`rerank_doc`/`fts_src`, and `pipeline_status` (`ready`|`quarantined`) + `gate_reason`, alongside `enriched`/`enriched_at`. A throwing build/gate → enrich failure path (no `enriched_at`). A `build` returning `""` → `quarantined`, reason `empty:<surface>`. Collections without `indexing` keep the old path for now. Verify: new `enrich-pipeline.test.ts` case — a collection with `indexing` persists surfaces + status.

4. **Indexer consumes persisted text (when `indexing` present).** In `indexCollection`: for `indexing` collections, select `pipeline_status='ready'` rows, embed the persisted `doc` (dense surface) into the embedding column, write nothing via `resolveEmbedTemplate`; set `pipeline_status='ready'` already set at enrich, so index just embeds. Quarantined rows excluded. Verify: `embed-index.test.ts` — quarantined never indexed; ready indexed from persisted `doc`.

5. **Search excludes non-ready (parent RFC REQ-6b).** `search()` adds `pipeline_status NOT IN ('ready')` exclusion across FTS/cosine/spaces/recency candidate selection. Verify: `test:search-excludes-quarantined`.

6. **`fashion.indexing()` builder.** Add to `templates/fashion.ts`: `fashion.indexing()` returning the three builders (`embed_doc` = graded-only `composeFashionEmbedDoc` per REQ-11b; `rerank_doc` = new `composeFashionRerankDoc`; `fts_doc`) + `gate` (apparel/other/confidence-floor + `uncertain_fields` + `crossSignalAgrees`). Trim `composeFashionEmbedDoc` to graded signal (drop category/gender/colors/material/fit/brand). Keep the old `composeFashionEmbedDoc`/`FASHION_EMBED_DOC_SOURCE` exports for one more commit. Verify: `fashion-template.test.ts` — `indexing()` builds non-empty graded `embed_doc`; gate quarantines non-apparel/low-confidence.

7. **Cut over the fashion example config.** `examples/fashion-search/fashion.ts` + `samesake.config.ts`: declare `indexing: fashion.indexing()`, drop `embeddings.doc.source`. Verify: `template-smoke.ts` runs enrich→index→search with no manual compose; emits non-title embeddings.

8. **Cut over playground.** `apps/playground/lib/samesake.ts` declares `indexing`; delete `apps/playground/lib/embed-doc.ts` and its calls in `app/api/upload/route.ts`, `scripts/{sync-to-samesake,seed,r2-upload-smoke,rework-smoke}.ts`. Verify: playground typechecks; upload route runs enrich→index with no compose call.

9. **Cut over remaining example scripts.** `examples/fashion-search/{run-pipeline,eval-configs-lk,eval,live-lk-subset,spike-avirate,build-lk-subset,multiturn-search,serve}.ts`: declare `indexing`, remove manual `composeEmbedDocs`/`compose-embed` usage. Delete `examples/fashion-search/compose-embed.ts`. Verify: each script typechecks; `run-pipeline.ts` end-to-end.

10. **Delete the old path (the breaking commit).** Remove `CollectionEmbeddingDef.source`; delete `resolveEmbedTemplate` doc-path + the `data.title` fallback (`embed-index.ts:348-349`) + the apparel/category skip (`embed-index.ts:339-345`); remove `fashion.composeEmbedDoc`, `fashion.embedDocSource`, `FASHION_EMBED_DOC_SOURCE`; make `AuthoredCollection.indexing` required at the `collection()` factory boundary; generalize the DB-loaded-without-functions guard from `enrich` to `indexing`. Verify: typecheck fails for any config missing `indexing` (intended); full suite green except the tests in commit 11.

11. **Rewrite tests that asserted removed behavior.** `migrations.test.ts:328-351` (apparel-skip → gate-quarantine), and any `embed-index.test.ts`/`enrich-pipeline.test.ts`/`fashion-template.test.ts` cases referencing `.source`/`resolveEmbedTemplate`/title-fallback → rewrite to the `indexing` contract (assert quarantine + persisted surfaces). Do NOT delete — re-express the intent. Verify: full suite green.

12. **Manifest + offline validation.** Populate `CollectionDef.indexingManifest` on apply (surface keys + kinds + embedding cross-refs); validate `dense.embedding` references an existing `embeddings` key and `fts` channel references an `fts` surface, at apply time. Verify: applying a config with a dangling `embedding` ref throws.

13. **Docs + CHANGELOG.** Update `apps/docs/**` lifecycle doc to the `indexing` DSL; CHANGELOG breaking-change entry; point `rfcs/rfc-pipeline-integrity-seams.md` §7 blueprint/WBS at this plan. Verify: docs build.

## Decision Document

- **One required `indexing` block** on the authoring collection type; functions live in-process (mirrors `enrich.stages`), DB def holds declarations + a manifest. Chosen over: a single `project()` fn on the matcher (B), a pipeline-terminal materializer (C), a closed `surfaces` union (A) — see `docs/design/indexing-dsl.md` §"Why this shape".
- **Persist-at-enrich**: surface text + gate decision are computed and stored when enriching, not at index time — so re-index (embedder swap) never re-runs domain logic; "enrich output is the indexable doc" holds on disk.
- **Generic gate** returns `{index, reason}`; reason drives `pipeline_status`/quarantine telemetry. No fashion semantics in `@samesake/server`.
- **Embedding cross-ref by key** (`dense.embedding`), not a `$`-string; `CollectionEmbeddingDef.source` deleted.
- **`fts` tsvector** now generates from the persisted `fts_src` column (built by the `fts` surface), not from raw searchable field columns.
- **Filter-not-embed (REQ-11b):** the `embed_doc` builder carries graded/compositional signal only; hard low-cardinality attrs stay in filters/spaces.
- **Breaking, no compat:** no `source` alias, no optional-hook fallback, no dual-shape shipped; transient coexistence is confined to commits 1–9 and removed in 10.

## Testing Decisions

- Good tests assert **external behavior**, not internals: given a collection + rows, after enrich→index, assert what is searchable, quarantined, and what text was embedded — not which function was called.
- Modules tested: `enrich-pipeline` (surfaces persisted, gate→status, build error paths), `embed-index` (ready-only indexing, no title fallback, quarantine excluded), `fashion-template` (`indexing()` builds graded embed_doc, gate predicates), `migrations` (new columns idempotent; backfill), `search` (excludes non-ready).
- Prior art: existing `packages/server/test/{embed-index,enrich-pipeline,fashion-template,migrations}.test.ts`.
- New fail-to-pass tests tie to RFC IDs: `test:fashion-compose-gate`, `test:index-gate`, `test:embed-doc-no-hard-attrs`, `test:search-excludes-quarantined`, `test:gate-cross-signal`.

## Out of Scope

- The rest of the parent RFC not on the compose/gate/textualization seam: G1 image revalidation, G6 retry/backoff, G7 ranking, G8 eval harness (separate `rfcs/rfc-eval-harness.md`), the G4 rerank-blend.
- Routing `spaces` text/image `source` through builders too (its own follow-up; this refactor touches only the doc/rerank/fts surfaces).
- The `gender`/`kids`→`age_group` enum split (separate ADR).

## Further Notes

- **One-time data cost (not API):** after deploy, every collection must re-enrich (to populate `doc`/`rerank_doc`/`fts_src`/`pipeline_status`) and re-index. Communicate it; it is the intended consequence of the trimmed `embed_doc` + persisted surfaces, not a regression.
- Commits 1–9 may transiently carry both the old `source` path and the new `indexing` path; this is Fowler-style "keep it working" scaffolding, removed wholesale in commit 10. Nothing dual-shape is released.
