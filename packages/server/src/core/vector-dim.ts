export const PGVECTOR_HNSW_MAX_DIMENSIONS = 2000;

export function assertIndexableVectorDimension(input: {
  owner: string;
  field: string;
  dimensions: number;
  max?: number;
}): void {
  const max = input.max ?? PGVECTOR_HNSW_MAX_DIMENSIONS;
  if (!Number.isInteger(input.dimensions) || input.dimensions <= 0) {
    throw new Error(
      `${input.owner}.${input.field}: vector dimension must be a positive integer, got ${input.dimensions}.`
    );
  }
  if (input.dimensions > max) {
    throw new Error(
      `${input.owner}.${input.field}: vector dimension ${input.dimensions} exceeds pgvector HNSW vector limit of ${max}. ` +
        "Reduce the embedding dimension to 2000 or less for the default index path. " +
        "Future options such as halfvec, quantization, or dimensionality reduction require an explicit migration design and are not enabled automatically."
    );
  }
}
