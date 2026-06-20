import type { SearchHit } from "./search.ts";

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

export function clamp01(score: number): number {
  if (!Number.isFinite(score)) return 0;
  if (score <= 0) return 0;
  if (score >= 1) return 1;
  return score;
}

export function retrievalBlendWeight(
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
  const w = retrievalBlendWeight(rrfRank, weights);
  const positionScore = 1 / rrfRank;
  return w * positionScore + (1 - w) * clamp01(rerankScore);
}

export function rerankCandidateText(h: SearchHit): string {
  const columnDoc = h.rerank_doc;
  if (typeof columnDoc === "string" && columnDoc.trim()) return columnDoc;

  const enriched =
    (h.data?.enriched as Record<string, unknown> | undefined) ??
    (h.enriched as Record<string, unknown> | undefined);
  const fromEnriched = enriched?.rerank_doc;
  if (typeof fromEnriched === "string" && fromEnriched.trim()) return fromEnriched;

  const data = h.data as Record<string, unknown>;
  return String(
    h.title ?? h.name ?? data?.title ?? data?.name ?? data?.description ?? ""
  );
}

export function mergeBlendedRerank(
  hits: SearchHit[],
  ordered: Array<{ id: string; score: number }>,
  weights: RerankBlendWeights = DEFAULT_RERANK_BLEND_WEIGHTS
): SearchHit[] {
  const scoreById = new Map(ordered.map((o) => [o.id, clamp01(o.score)]));

  const scoredSorted = hits
    .map((h, i) => {
      const rerank = scoreById.get(h.id);
      if (rerank === undefined) return null;
      const rank = i + 1;
      const blended = blendRerankScore(rank, rerank, weights);
      return { h: { ...h, score: blended }, blended, origIdx: i };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => b.blended - a.blended || a.origIdx - b.origIdx);

  const out: SearchHit[] = [];
  let scoredIdx = 0;
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i]!;
    if (!scoreById.has(h.id)) {
      out.push(h);
    } else {
      out.push(scoredSorted[scoredIdx++]!.h);
    }
  }
  return out;
}
