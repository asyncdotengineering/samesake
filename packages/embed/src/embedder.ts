import type { EmbedRequest } from "@samesake/core";
import type { Embedder, EmbedderCaps } from "./types.ts";

export interface EmbedderConfig {
  single: (request: EmbedRequest) => Promise<number[]>;
  many: (requests: EmbedRequest[]) => Promise<number[][]>;
  caps: EmbedderCaps;
}

function validateVector(request: EmbedRequest, vector: number[]): number[] {
  if (vector.length !== request.dim) {
    throw new Error(
      `[@samesake/embed] provider returned a ${vector.length}-dimensional vector, expected ${request.dim} — dimension mismatch`,
    );
  }
  return vector;
}

function validateBatch(requests: EmbedRequest[], vectors: number[][]): number[][] {
  if (vectors.length !== requests.length) {
    throw new Error(
      `[@samesake/embed] provider returned ${vectors.length} vectors for ${requests.length} requests`,
    );
  }
  return vectors.map((vector, index) => validateVector(requests[index]!, vector));
}

export function createEmbedder(config: EmbedderConfig): Embedder {
  const single = async (request: EmbedRequest): Promise<number[]> =>
    validateVector(request, await config.single(request));
  const many = async (requests: EmbedRequest[]): Promise<number[][]> => {
    const vectors: number[][] = [];
    for (let start = 0; start < requests.length; start += config.caps.maxBatch) {
      const batch = requests.slice(start, start + config.caps.maxBatch);
      vectors.push(...validateBatch(batch, await config.many(batch)));
    }
    return vectors;
  };
  const embedder = single as Embedder;
  embedder.many = many;
  Object.defineProperty(embedder, "caps", {
    value: Object.freeze({ ...config.caps }),
    enumerable: true,
    writable: false,
    configurable: false,
  });
  return embedder;
}
