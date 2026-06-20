# S1c indexing migration — implementation notes

## Root cause
S1c removed `CollectionEmbeddingDef.source` and made `indexing` required on collections, but three core files still referenced `embDef.source` and eight test files still used the old embedding shape without `indexing`.

## Changes

### Core (behavior-preserving)
- **`collections-migrate.ts`**: `canonicalEmbeddings` now hashes `{ model, dim, taskType }` only. Dropping the removed field is correct; real embedding config changes still produce distinct hashes.
- **`embed-index.ts` / `search-query.ts`**: Removed the dense-doc reuse optimization (`sdef.source === embDef.source`). No live consumer in the fashion template (no text spaces). Text spaces now always embed from their own `sdef.source`.

### Tests
- Added `denseAndFtsIndexingByTitle` to `fixtures.ts` alongside existing `ftsIndexingByTitle` / `spaceOnlyIndexing`.
- Migrated: `budget`, `filter-compiler`, `ident-validation`, `nlq`, `observability`, `policy`, `search-mode`.

## Verification
- `cd packages/server && bunx tsc --noEmit` → exit 0 (was 15 errors)
- `cd packages/sdk && bunx tsc --noEmit` → exit 0
- `bun test packages/server/test` → 222 pass, 0 fail
