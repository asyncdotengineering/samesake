import type { RerankFn } from "@samesake/core";
import type { SearchHit } from "./types.ts";

export interface RerankBlendWeights {
  head: number;
  mid: number;
  tail: number;
  headCutoff: number;
  midCutoff: number;
}

export const DEFAULT_RERANK_BLEND_WEIGHTS: RerankBlendWeights = {
  head: 0.75,
  mid: 0.6,
  tail: 0.4,
  headCutoff: 3,
  midCutoff: 10,
};

export function clampRerankScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  if (score <= 0) return 0;
  if (score >= 1) return 1;
  return score;
}

function retrievalBlendWeight(
  rank: number,
  weights: RerankBlendWeights = DEFAULT_RERANK_BLEND_WEIGHTS
): number {
  if (rank <= weights.headCutoff) return weights.head;
  if (rank <= weights.midCutoff) return weights.mid;
  return weights.tail;
}

export function blendRerankScore(
  rrfRank: number,
  rerankScore: number,
  weights: RerankBlendWeights = DEFAULT_RERANK_BLEND_WEIGHTS
): number {
  const retrievalWeight = retrievalBlendWeight(rrfRank, weights);
  return retrievalWeight * (1 / rrfRank) + (1 - retrievalWeight) * clampRerankScore(rerankScore);
}

export function rerankCandidateText(hit: SearchHit): string {
  const direct = hit.rerank_doc;
  if (typeof direct === "string" && direct.trim()) return direct;

  const enriched =
    (hit.data.enriched as Record<string, unknown> | undefined) ??
    (hit.enriched as Record<string, unknown> | undefined);
  const enrichedText = enriched?.rerank_doc;
  if (typeof enrichedText === "string" && enrichedText.trim()) return enrichedText;

  return String(hit.title ?? hit.name ?? hit.data.title ?? hit.data.name ?? hit.data.description ?? "");
}

export function mergeBlendedRerank(
  hits: SearchHit[],
  ordered: Array<{ id: string; score: number }>,
  weights: RerankBlendWeights = DEFAULT_RERANK_BLEND_WEIGHTS
): SearchHit[] {
  const scoreById = new Map(ordered.map((entry) => [entry.id, clampRerankScore(entry.score)]));
  const scored = hits
    .map((hit, index) => {
      const rerankScore = scoreById.get(hit.id);
      if (rerankScore === undefined) return null;
      const blended = blendRerankScore(index + 1, rerankScore, weights);
      return { hit: { ...hit, score: blended }, blended, index };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .sort((left, right) => right.blended - left.blended || left.index - right.index);

  const result: SearchHit[] = [];
  let scoredIndex = 0;
  for (const hit of hits) {
    if (!scoreById.has(hit.id)) result.push(hit);
    else result.push(scored[scoredIndex++]!.hit);
  }
  return result;
}

export type { RerankFn };
