// Storefront search facade: one call that layers ranking policy, request-scoped shopper
// personalization, and declared no-results recovery on top of the core search engine.
// Vertical-neutral — everything catalog-specific (relaxable filters, ranking policy) comes
// from the collection's `search` def, which vertical templates pre-fill.
import type {
  CollectionDef,
  RankingPolicy,
  ShopperContext,
  ShopSearchImageInput,
  ShopSearchRequest,
  ShopSearchResponse,
  SearchWeightsInput,
} from "@samesake/core";
import type { MatcherCtx } from "../types.ts";
import type { ProjectsService } from "./projects.ts";
import type { SearchHit, SearchService, SearchOpts, SearchFilters } from "./search.ts";
import { collectionTableName, getByPath } from "./db-utils.ts";
import { applyRankingPolicy } from "@samesake/query";

type FactorValue = number | boolean | string | null;

function hitValue(hit: SearchHit, key: string): unknown {
  if (key in hit) return hit[key];
  return getByPath(hit.data, key);
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string" && value) return [value];
  return [];
}

function intersects(a: string[], b: string[]): boolean {
  const set = new Set(a.map((v) => v.toLowerCase()));
  return b.some((v) => set.has(v.toLowerCase()));
}

function normalizeFilters(filters?: Record<string, unknown>): SearchFilters {
  return { ...(filters ?? {}) } as SearchFilters;
}

type ResolvedRankingPolicy = RankingPolicy & {
  weights: Required<NonNullable<RankingPolicy["weights"]>>;
  businessField: string;
  boostAvailable: boolean;
  buryUnavailable: boolean;
};

function defaultRankingPolicy(hasImage: boolean, hasPersonalization: boolean): ResolvedRankingPolicy {
  return {
    weights: {
      relevance: 1,
      visual: hasImage ? 1 : 0,
      availability: 0.2,
      newness: 0,
      business: 0,
      personalization: hasPersonalization ? 0.6 : 0,
    },
    businessField: "",
    boostAvailable: true,
    buryUnavailable: true,
  };
}

function mergeRankingPolicy(
  policy: RankingPolicy | undefined,
  hasImage: boolean,
  hasPersonalization: boolean
): ResolvedRankingPolicy {
  const base = defaultRankingPolicy(hasImage, hasPersonalization);
  return {
    weights: { ...base.weights, ...(policy?.weights ?? {}) },
    businessField: policy?.businessField ?? base.businessField,
    boostAvailable: policy?.boostAvailable ?? base.boostAvailable,
    buryUnavailable: policy?.buryUnavailable ?? base.buryUnavailable,
  };
}

function buildWeights(
  def: CollectionDef,
  q: string,
  image: ShopSearchImageInput | undefined,
  override: SearchWeightsInput | undefined
): SearchWeightsInput | undefined {
  const weights: SearchWeightsInput = { ...(override ?? {}) };
  if (!q) {
    weights.fts ??= 0;
    weights.cosine ??= 0;
  }
  if (image && def.embeddings && weights.aspects === undefined) {
    const aspects: Record<string, number> = {};
    for (const [name, embedding] of Object.entries(def.embeddings)) {
      aspects[name] = embedding.kind === "image" ? 4 : q ? 1 : 0;
    }
    weights.aspects = aspects;
  }
  return Object.keys(weights).length ? weights : undefined;
}

// Reads commerce-generic hit fields (brand/price/size/styles/colors); a hit simply
// contributes nothing on fields its schema does not declare.
function personalize(hit: SearchHit, ctx?: ShopperContext): number {
  if (!ctx) return 0;
  let score = 0;
  const brand = String(hitValue(hit, "brand") ?? "").toLowerCase();
  if (ctx.blockedBrands?.some((b) => b.toLowerCase() === brand)) score -= 2;
  if (ctx.preferredBrands?.some((b) => b.toLowerCase() === brand)) score += 1;
  if (ctx.viewedProductIds?.includes(hit.id)) score -= 0.35;

  const price = Number(hitValue(hit, "price"));
  if (Number.isFinite(price) && ctx.priceBand) {
    if (ctx.priceBand.min !== undefined && price < ctx.priceBand.min) score -= 0.25;
    else if (ctx.priceBand.max !== undefined && price > ctx.priceBand.max) score -= 0.25;
    else score += 0.35;
  }

  const sizes = [...asStringArray(hitValue(hit, "sizes")), ...asStringArray(hitValue(hit, "size"))];
  if (ctx.size && sizes.length && sizes.map((s) => s.toLowerCase()).includes(ctx.size.toLowerCase())) {
    score += 0.5;
  }

  const styles = asStringArray(hitValue(hit, "styles"));
  if (ctx.avoidedStyles?.length && intersects(styles, ctx.avoidedStyles)) score -= 1;

  const colors = asStringArray(hitValue(hit, "colors"));
  if (ctx.colorAffinity && colors.length) {
    score += Math.max(...colors.map((c) => Number(ctx.colorAffinity?.[c] ?? 0)), 0);
  }

  return score;
}

function rankHits(
  hits: SearchHit[],
  policy: ResolvedRankingPolicy,
  personalization: ShopperContext | undefined,
  visualById: Map<string, number>
): { hits: SearchHit[]; factors: Map<string, Record<string, FactorValue>> } {
  return applyRankingPolicy(hits, policy, {
    resolveAxis: (hit, axis) => {
      if (axis === "visual") return visualById.get(hit.id) ?? 0;
      if (axis === "personalization") return personalize(hit, personalization);
      return undefined;
    },
  });
}

function relaxFilters(
  filters: SearchFilters,
  relaxable: string[]
): { filters: SearchFilters; relaxed: string[] } {
  const next = { ...filters };
  const relaxed: string[] = [];
  for (const key of relaxable) {
    if (key in next) {
      delete next[key];
      relaxed.push(key);
    }
  }
  return { filters: next, relaxed };
}

function visualCosines(explain: Awaited<ReturnType<SearchService["searchExplain"]>> | null): Map<string, number> {
  const out = new Map<string, number>();
  for (const doc of explain?.docs ?? []) {
    const values = Object.entries(doc.aspect_ranks ?? {})
      .filter(([name]) => name.toLowerCase().includes("visual") || name.toLowerCase().includes("image"))
      .map(([, value]) => Number(value.cosine));
    if (values.length) out.set(doc.id, Math.max(...values));
  }
  return out;
}

export function makeShopSearchService(
  ctx: MatcherCtx,
  projectsService: ProjectsService,
  searchService: SearchService
) {
  async function resolveProductImage(
    projectSlug: string,
    collectionName: string,
    image: ShopSearchImageInput | undefined
  ): Promise<SearchOpts["image"] | undefined> {
    if (!image?.productId) return image;
    const project = await projectsService.getProject(projectSlug);
    if (!project) throw new Error(`project "${projectSlug}" not found`);
    const table = collectionTableName(project.schema_name, collectionName);
    const rows = await ctx.storage.client("shop-search").unsafe(
      `SELECT data FROM ${table} WHERE id = $1 LIMIT 1`,
      [image.productId]
    );
    const data = rows[0]?.data as Record<string, unknown> | undefined;
    const url = data
      ? String(data.image_url ?? data.imageUrl ?? data.image ?? "")
      : "";
    if (!url) throw new Error(`product "${image.productId}" has no image_url`);
    return {
      url,
      bytes: image.bytes,
      bytesBase64: image.bytesBase64,
      mimeType: image.mimeType,
    };
  }

  async function shopSearch(
    projectSlug: string,
    collectionName: string,
    req: ShopSearchRequest
  ): Promise<ShopSearchResponse> {
    const started = Date.now();
    const def = await searchService.getCollectionDef(projectSlug, collectionName);
    if (!def) throw new Error(`collection "${collectionName}" not found in project "${projectSlug}"`);

    const q = req.q?.trim() ?? "";
    const image = await resolveProductImage(projectSlug, collectionName, req.image);
    if (!q && !image) throw new Error("shopSearch requires q or image");

    const filters = normalizeFilters(req.filters);
    const weights = buildWeights(def, q, image, req.weights);
    const limit = req.limit ?? 20;
    const opts: SearchOpts = {
      q,
      image,
      filters,
      weights,
      limit: Math.min(Math.max(limit, 1), 100),
      offset: req.offset,
      scope: req.scope,
    };

    // One retrieval yields both hits and (when requested) the explain breakdown.
    // The breakdown must reflect the filters actually applied, so it is recomputed
    // alongside the hits whenever the no-results fallback relaxes them.
    const wantExplain = req.debug || req.explain;
    let base: Awaited<ReturnType<SearchService["search"]>>;
    let explain: Awaited<ReturnType<SearchService["searchExplain"]>> | null = null;
    if (wantExplain) {
      const both = await searchService.searchWithExplain(projectSlug, collectionName, opts);
      base = both.result;
      explain = both.explain;
    } else {
      base = await searchService.search(projectSlug, collectionName, opts);
    }
    let fallback: ShopSearchResponse["fallback"];
    let appliedFilters = filters;

    if (base.hits.length === 0 && req.recoverNoResults) {
      const relaxed = relaxFilters(filters, def.search?.relaxableFilters ?? []);
      if (relaxed.relaxed.length) {
        const relaxedOpts = { ...opts, filters: relaxed.filters };
        if (wantExplain) {
          const both = await searchService.searchWithExplain(projectSlug, collectionName, relaxedOpts);
          base = both.result;
          explain = both.explain;
        } else {
          base = await searchService.search(projectSlug, collectionName, relaxedOpts);
        }
        appliedFilters = relaxed.filters;
        fallback = { reason: "no_results", relaxedFilters: relaxed.relaxed };
      }
    }

    const policy = mergeRankingPolicy(req.rankingPolicy, !!image, !!req.personalization);
    const ranked = rankHits(base.hits, policy, req.personalization, visualCosines(explain));

    const response: ShopSearchResponse = {
      hits: ranked.hits,
      parsed: base.parsed,
      appliedFilters,
      constraintTrace: fallback
        ? {
            ...base.constraintTrace,
            explicitFilters: filters,
            appliedFilters,
            relaxedFields: [
              ...new Set([
                ...base.constraintTrace.relaxedFields,
                ...fallback.relaxedFilters,
              ]),
            ].sort(),
          }
        : base.constraintTrace,
      fallback,
      took_ms: Date.now() - started,
    };

    if (req.debug || req.explain) {
      response.explanations = ranked.hits.map((hit) => ({
        hitId: hit.id,
        factors: ranked.factors.get(hit.id) ?? {},
        appliedFilters: Object.keys(appliedFilters),
      }));
      response.debug = {
        weights,
        rankingPolicy: policy,
        searchExplain: explain,
        privacy: "personalization context is request-scoped; Samesake does not persist shopper identity or preferences here.",
      };
    }

    return response;
  }

  return { shopSearch };
}

export type ShopSearchService = ReturnType<typeof makeShopSearchService>;
