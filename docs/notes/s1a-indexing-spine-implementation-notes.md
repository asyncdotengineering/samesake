# S1a indexing spine — implementation notes

## Commits (ordered)

| SHA | Summary |
|-----|---------|
| `def147a` | Indexing DSL types + `gates.always` in `@samesake/core` |
| `f7c3984` | Surface columns (`rerank_doc`, `fts_src`, `gate_reason`); `fts` from `fts_src` with column fallback when `fts_src IS NULL` |
| `d7cc925` | `enrichOne` persists surfaces + gate → `pipeline_status` |
| `c9f6db9` | `indexCollection` uses persisted `doc` for `def.indexing` collections |
| `989d482` | Search filters to `pipeline_status = 'ready'`; index paths set `ready` on completion |

## Tradeoffs

- **FTS generated column:** Uses `CASE WHEN fts_src IS NOT NULL THEN fts_src ELSE <legacy field expr>` so rows indexed via the old path (no `fts_src`) remain searchable until enrich sets `fts_src`. End-state in later chunks is `coalesce(fts_src,'')` only.
- **Search filter:** Candidates require `pipeline_status = 'ready'` (or NULL). Legacy index paths now set `ready` on successful index so existing tests stay green without rewriting assertions.
- **Typecheck:** Root `bun run typecheck` requires `packages/sdk` dist rebuild (`bun run build` in sdk) because `@samesake/core` resolves to published `.d.ts` in `dist/`.

## Out of scope (S1b+)

Fashion template cut-over, playground, deleting `embeddings.source`, making `indexing` required.
