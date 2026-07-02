# S1b fashion cutover — implementation notes

## Commits (6–9)

| SHA | Summary |
|-----|---------|
| `0da921c` | Add `fashion.indexing()` with graded embed/rerank/fts builders + composite gate |
| `efa4f12` | Cut `examples/fashion-search/samesake.config.ts` to `fashion.indexing()`; `source` optional on `CollectionEmbeddingDef` |
| `37e6eea` | Playground declares `indexing`; delete `embed-doc.ts`; remove compose from upload/sync/smokes |
| `24b5062` | Cut example scripts; delete `compose-embed.ts`; fix `embed-index` for optional `source` |

## Decisions

- **`CollectionEmbeddingDef.source` optional (not deleted):** C7 requires dropping `source` from configs while S1c removes the field entirely. Made optional to typecheck indexing-only configs without a shim string.
- **`crossSignalAgrees`:** Infers category from title + `raw_tags`/`tags` + `raw_type` via taxonomy keyword match; quarantines when text-inferred category ≠ enriched category. No signal → pass (can't contradict).
- **`composeFashionEmbedDoc` trim:** Removed category/gender/colors/material/fit clauses; kept product_type as `Type:` line, pattern/occasions/styles/details/modesty.
- **`template-smoke.ts`:** Updated though not listed in RFC C9 file list — required by DoD grep (no manual compose callers left).

## G3 proof

Unit tests `test:embed-doc-no-hard-attrs` and `test:fashion-compose-gate` assert `fashion.indexing().surfaces.embed_doc.build(ctx)` is non-empty graded text without hard-attr clauses. Live end-to-end smoke not run — `GEMINI_API_KEY` / `API_KEY` absent in env.

## Unverified / environmental

- Full `bun test packages/server/test`: verified **184 pass / 0 fail** during implementation; later runs hit Neon `CONNECTION_DESTROYED` flakes (remote DB). Re-run locally when DB is stable.
- `examples/fashion-search` typecheck: pre-existing errors in `eval.ts`, `ingest.ts`, `multiturn-search.ts` (unrelated to this chunk).
- `apps/playground` typecheck: pre-existing errors in `lib/embed.test.ts` (unrelated).

## Deferred to S1c

- Delete `CollectionEmbeddingDef.source`, `resolveEmbedTemplate` doc-path, apparel hardcode, `fashion.composeEmbedDoc` exports, required `indexing`.
