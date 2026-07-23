// Pure aspect-over-def helper shared by the NLQ and aspect-planning brains. @samesake/query
// owns this trivial leaf because both nlq.ts and search-query.ts depend on it and query
// cannot import @samesake/server's copy (which also holds SQL-gen helpers). The two are
// structurally identical over CollectionDef.
import type { CollectionDef, CollectionEmbeddingDef } from "@samesake/core";

export function embeddingEntries(
  def: CollectionDef
): Array<[string, CollectionEmbeddingDef]> {
  return Object.entries(def.embeddings ?? {});
}
