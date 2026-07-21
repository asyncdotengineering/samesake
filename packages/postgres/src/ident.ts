const IDENT = /^[a-z_][a-z0-9_]{0,62}$/i;

export function ident(value: string, label = "identifier"): string {
  if (!IDENT.test(value)) throw new Error(`@samesake/postgres: invalid ${label} "${value}"`);
  return value;
}

export function collectionTable(schema: string, collection: string): string {
  return `${ident(schema, "schema")}.c_${ident(collection, "collection")}`;
}

export function embeddingColumn(name: string, index: number): string {
  return index === 0 ? "embedding" : `emb_${ident(name)}`;
}

export function vectorLiteral(vector: number[]): string {
  if (!vector.length || vector.some((value) => !Number.isFinite(value))) {
    throw new Error("@samesake/postgres: embedding vector must contain finite values");
  }
  return `[${vector.join(",")}]`;
}
