/** HNSW limit for `vector` columns (entity embeddings). */
export const PGVECTOR_HNSW_MAX_DIMENSIONS = 2000;
/** HNSW limit for `halfvec` columns (collection embedding / space_vec). */
export const PGVECTOR_HNSW_MAX_DIMENSIONS_HALFVEC = 4000;

export function assertIndexableVectorDimension(input: {
  owner: string;
  field: string;
  dimensions: number;
  /** Column type the dimension is checked against. Default "vector". */
  columnType?: "vector" | "halfvec";
}): void {
  const columnType = input.columnType ?? "vector";
  const max =
    columnType === "halfvec" ? PGVECTOR_HNSW_MAX_DIMENSIONS_HALFVEC : PGVECTOR_HNSW_MAX_DIMENSIONS;
  if (!Number.isInteger(input.dimensions) || input.dimensions <= 0) {
    throw new Error(
      `${input.owner}.${input.field}: vector dimension must be a positive integer, got ${input.dimensions}.`
    );
  }
  if (input.dimensions > max) {
    throw new Error(
      `${input.owner}.${input.field}: vector dimension ${input.dimensions} exceeds pgvector HNSW ${columnType} limit of ${max}. ` +
        `Reduce the embedding dimension to ${max} or less for the default index path.`
    );
  }
}
