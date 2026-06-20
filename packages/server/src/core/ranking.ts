import type {
  RankingHardAxis,
  RankingPolicy,
  RankingSoftAxis,
} from "@samesake/core";
import type { SearchHit } from "./search.ts";
import { getByPath } from "./db-utils.ts";

export type RankingFactorValue = number | boolean | string | null;

export interface RankingApplyContext {
  resolveAxis?: (hit: SearchHit, axis: string) => number | boolean | undefined;
}

interface MergedRankingPolicy {
  weights: Required<NonNullable<RankingPolicy["weights"]>>;
  businessField: string;
  boostAvailable: boolean;
  buryUnavailable: boolean;
  buryFactor: number;
  minRelevanceFloor: number;
  relevanceExponent: number;
  hardAxes: RankingHardAxis[];
  softAxes: RankingSoftAxis[];
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function hitValue(hit: SearchHit, key: string): unknown {
  if (key in hit) return hit[key];
  return getByPath(hit.data, key);
}

function normalizeScores(hits: SearchHit[]): Map<string, number> {
  const out = new Map<string, number>();
  if (!hits.length) return out;
  const scores = hits.map((h) => Number(h.score));
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const range = max - min;
  for (const hit of hits) {
    const raw = Number(hit.score);
    const norm = range === 0 ? 1 : (raw - min) / range;
    out.set(hit.id, clamp01(norm));
  }
  return out;
}

function mergeRankingPolicy(policy: RankingPolicy): MergedRankingPolicy {
  return {
    weights: {
      relevance: policy.weights?.relevance ?? 1,
      visual: policy.weights?.visual ?? 0,
      availability: policy.weights?.availability ?? 0.2,
      newness: policy.weights?.newness ?? 0,
      business: policy.weights?.business ?? 0,
      personalization: policy.weights?.personalization ?? 0,
    },
    businessField: policy.businessField ?? "",
    boostAvailable: policy.boostAvailable ?? true,
    buryUnavailable: policy.buryUnavailable ?? true,
    buryFactor: policy.buryFactor ?? 0.2,
    minRelevanceFloor: policy.minRelevanceFloor ?? 0,
    // PLACEHOLDER default (1) — tune relevanceExponent via runEval sweep; see guides/eval-gate.mdx.
    relevanceExponent: policy.relevanceExponent ?? 1,
    hardAxes: policy.hardAxes ?? ["availability"],
    softAxes: policy.softAxes ?? ["newness", "personalization", "visual", "business"],
  };
}

function resolveAvailability(hit: SearchHit, ctx?: RankingApplyContext): boolean {
  const fromCtx = ctx?.resolveAxis?.(hit, "availability");
  if (typeof fromCtx === "boolean") return fromCtx;
  const raw = hitValue(hit, "available");
  return raw === undefined ? true : raw === true;
}

function resolveBusiness(hit: SearchHit, field: string, ctx?: RankingApplyContext): number {
  const fromCtx = ctx?.resolveAxis?.(hit, "business");
  if (typeof fromCtx === "number" && Number.isFinite(fromCtx)) return fromCtx;
  if (!field) return 0;
  const value = Number(hitValue(hit, field));
  return Number.isFinite(value) ? value : 0;
}

function resolveSoftAxis(
  hit: SearchHit,
  axis: RankingSoftAxis,
  ctx: RankingApplyContext | undefined,
  businessField: string
): number {
  const fromCtx = ctx?.resolveAxis?.(hit, axis);
  if (typeof fromCtx === "number" && Number.isFinite(fromCtx)) return fromCtx;
  if (axis === "business") return resolveBusiness(hit, businessField, ctx);
  if (axis === "newness") {
    const raw = hitValue(hit, "newness");
    const value = Number(raw);
    return Number.isFinite(value) ? value : 0;
  }
  return 0;
}

function availabilityFactor(available: boolean, policy: MergedRankingPolicy): number {
  if (available) return 1;
  if (policy.buryUnavailable) return policy.buryFactor;
  return 0;
}

export function applyRankingPolicy(
  hits: SearchHit[],
  policy: RankingPolicy,
  ctx?: RankingApplyContext
): { hits: SearchHit[]; factors: Map<string, Record<string, RankingFactorValue>> } {
  const merged = mergeRankingPolicy(policy);
  const normalized = normalizeScores(hits);
  const factors = new Map<string, Record<string, RankingFactorValue>>();

  const eligible = hits.filter((hit) => {
    const norm = normalized.get(hit.id) ?? 0;
    return norm >= merged.minRelevanceFloor;
  });

  const ranked = eligible.map((hit) => {
    const normRelevance = normalized.get(hit.id) ?? 0;
    const available = resolveAvailability(hit, ctx);
    const visual = resolveSoftAxis(hit, "visual", ctx, merged.businessField);
    const personalization = resolveSoftAxis(hit, "personalization", ctx, merged.businessField);
    const newness = resolveSoftAxis(hit, "newness", ctx, merged.businessField);
    const business = resolveBusiness(hit, merged.businessField, ctx);

    const f: Record<string, RankingFactorValue> = {
      relevance: normRelevance,
      visual: clamp01(visual),
      available,
      business: clamp01(business),
      personalization,
      newness: clamp01(newness),
    };
    factors.set(hit.id, f);

    const relExp = merged.relevanceExponent * merged.weights.relevance;
    let multiplicative = Math.pow(normRelevance, relExp);

    if (merged.hardAxes.includes("availability") && merged.boostAvailable) {
      const avail = availabilityFactor(available, merged);
      multiplicative *= Math.pow(clamp01(avail), merged.weights.availability);
    } else if (!available && merged.buryUnavailable) {
      multiplicative *= merged.buryFactor;
    }

    if (merged.hardAxes.includes("business") && merged.weights.business > 0) {
      multiplicative *= Math.pow(clamp01(business), merged.weights.business);
    }

    let additive = 0;
    for (const axis of merged.softAxes) {
      if (merged.hardAxes.includes(axis as RankingHardAxis)) continue;
      const weight = merged.weights[axis];
      if (!weight) continue;
      if (axis === "visual") additive += clamp01(visual) * weight;
      else if (axis === "personalization") additive += personalization * weight;
      else if (axis === "newness") additive += clamp01(newness) * weight;
      else if (axis === "business") additive += clamp01(business) * weight;
    }

    return { ...hit, score: multiplicative + additive };
  });

  ranked.sort((a, b) => b.score - a.score);
  return { hits: ranked, factors };
}
