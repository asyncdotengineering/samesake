# S1c indexing migration — scratchpad

## Done
- Remove `CollectionEmbeddingDef.source` from `canonicalEmbeddings` (config-diff hashing)
- Remove broken `sdef.source === embDef.source` reuse branches in embed-index + search-query
- Migrate 8 test files to required `indexing` DSL; add `denseAndFtsIndexingByTitle` fixture helper
- `packages/server` tsc: 15 errors → 0
- `packages/server/test`: 222 pass / 0 fail

## Notes
- Entity embeddings still use `.source` (unchanged scope)
- Spaces `sdef.source` retained (legitimate SpaceDef field)
