import type { CollectionDef, CollectionEmbeddingDef } from "@samesake/core";
import { sanitiseIdent } from "./schema-gen.ts";
import { embeddingEntries } from "@samesake/query";

export const EVIDENCE_MAX_ROWS = 64;
export const EVIDENCE_OVERFETCH_FACTOR = 4;

// embeddingEntries moved to @samesake/query (pure def introspection); re-exported
// here so existing server importers (collections-*, embed-index, search) resolve.
export { embeddingEntries };

export function embeddingColumn(name: string, index: number): string {
  return index === 0 ? "embedding" : `emb_${sanitiseIdent(name)}`;
}

export function embeddingIndexName(collection: string, name: string, index: number): string {
  return index === 0
    ? `c_${sanitiseIdent(collection)}_emb_idx`
    : `c_${sanitiseIdent(collection)}_emb_${sanitiseIdent(name)}_idx`;
}

export function evidenceTable(schema: string, collection: string): string {
  return `${schema}.c_${sanitiseIdent(collection)}_evidence`;
}

export function evidenceEntries(def: CollectionDef): Array<[string, CollectionEmbeddingDef]> {
  return embeddingEntries(def).filter(([, embedding]) => embedding.evidence === true);
}
