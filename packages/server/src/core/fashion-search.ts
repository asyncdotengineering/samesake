import type {
  CollectionDef,
  FashionPersonalizationContext,
  FashionRankingPolicy,
  FashionSearchImageInput,
  FashionSearchRequest,
  FashionSearchResponse,
  SearchWeightsInput,
} from "@samesake/core";
import type { MatcherCtx } from "../types.ts";
import type { ProjectsService } from "./projects.ts";
import type { SearchHit, SearchService, SearchOpts, SearchFilters } from "./search.ts";
import type { IngestService } from "./ingest.ts";
import { collectionTableName, getByPath, getPgClient } from "./db-utils.ts";
import { sanitiseIdent } from "./schema-gen.ts";
import { searchResultCache } from "./search-cache.ts";

type FactorValue = number | boolean | string | null;

export interface FashionCatalogSyncEvent {
  type:
    | "product.upsert"
    | "product.delete"
    | "variant.upsert"
    | "inventory.update"
    | "price.update"
    | "image.update";
  id: string;
  data?: Record<string, unknown>;
  changes?: Record<string, unknown>;
}

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

function defaultRankingPolicy(hasImage: boolean, hasPersonalization: boolean): Required<FashionRankingPolicy> {
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
  policy: FashionRankingPolicy | undefined,
  hasImage: boolean,
  hasPersonalization: boolean
): Required<FashionRankingPolicy> {
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
  image: FashionSearchImageInput | undefined,
  override: SearchWeightsInput | undefined
): SearchWeightsInput | undefined {
  const weights: SearchWeightsInput = { ...(override ?? {}) };
  if (!q) {
    weights.fts ??= 0;
    weights.cosine ??= 0;
  }
  if (image && def.spaces && weights.spaces === undefined) {
    const spaceWeights: Record<string, number> = {};
    for (const [name, sdef] of Object.entries(def.spaces)) {
      if (sdef.kind === "image") spaceWeights[name] = 4;
      if (sdef.kind === "text") spaceWeights[name] = q ? 1 : 0;
      if (sdef.kind === "number" || sdef.kind === "categorical") spaceWeights[name] = 0.4;
      if (sdef.kind === "recency") spaceWeights[name] = 0.2;
    }
    weights.spaces = spaceWeights;
  }
  return Object.keys(weights).length ? weights : undefined;
}

function personalize(hit: SearchHit, ctx?: FashionPersonalizationContext): number {
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
  policy: Required<FashionRankingPolicy>,
  personalization: FashionPersonalizationContext | undefined,
  visualById: Map<string, number>
): { hits: SearchHit[]; factors: Map<string, Record<string, FactorValue>> } {
  const factors = new Map<string, Record<string, FactorValue>>();
  const ranked = hits.map((hit) => {
    const availabilityRaw = hitValue(hit, "available");
    const available = availabilityRaw === undefined ? true : availabilityRaw === true;
    const visual = visualById.get(hit.id) ?? 0;
    const business =
      policy.businessField && policy.businessField.length
        ? Number(hitValue(hit, policy.businessField))
        : 0;
    const personalizationScore = personalize(hit, personalization);
    const f: Record<string, FactorValue> = {
      relevance: Number(hit.score),
      visual,
      available,
      business: Number.isFinite(business) ? business : 0,
      personalization: personalizationScore,
    };
    factors.set(hit.id, f);

    let score = Number(hit.score) * (policy.weights.relevance ?? 1);
    score += visual * (policy.weights.visual ?? 0);
    score += (available ? 1 : 0) * (policy.weights.availability ?? 0);
    score += (Number.isFinite(business) ? business : 0) * (policy.weights.business ?? 0);
    score += personalizationScore * (policy.weights.personalization ?? 0);
    if (!available && policy.buryUnavailable) score -= 2;
    return { ...hit, score };
  });
  ranked.sort((a, b) => b.score - a.score);
  return { hits: ranked, factors };
}

function relaxFilters(filters: SearchFilters): { filters: SearchFilters; relaxed: string[] } {
  const next = { ...filters };
  const relaxed: string[] = [];
  for (const key of ["colors", "material", "fit", "styles", "category", "price"]) {
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
    const values = Object.entries(doc.space_cosines ?? {})
      .filter(([name]) => name.toLowerCase().includes("visual") || name.toLowerCase().includes("image"))
      .map(([, value]) => Number(value));
    if (values.length) out.set(doc.id, Math.max(...values));
  }
  return out;
}

export function makeFashionSearchService(
  ctx: MatcherCtx,
  projectsService: ProjectsService,
  searchService: SearchService,
  ingestService: IngestService
) {
  async function resolveProductImage(
    projectSlug: string,
    collectionName: string,
    image: FashionSearchImageInput | undefined
  ): Promise<SearchOpts["image"] | undefined> {
    if (!image?.productId) return image;
    const project = await projectsService.getProject(projectSlug);
    if (!project) throw new Error(`project "${projectSlug}" not found`);
    const table = collectionTableName(project.schema_name, collectionName);
    const rows = await getPgClient(ctx.db, "fashion-search").unsafe(
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

  async function fashionSearch(
    projectSlug: string,
    collectionName: string,
    req: FashionSearchRequest
  ): Promise<FashionSearchResponse> {
    const started = Date.now();
    const def = await searchService.getCollectionDef(projectSlug, collectionName);
    if (!def) throw new Error(`collection "${collectionName}" not found in project "${projectSlug}"`);

    const q = req.q?.trim() ?? "";
    const image = await resolveProductImage(projectSlug, collectionName, req.image);
    if (!q && !image) throw new Error("fashionSearch requires q or image");

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
    };

    let base = await searchService.search(projectSlug, collectionName, opts);
    let fallback: FashionSearchResponse["fallback"];
    let appliedFilters = filters;

    if (base.hits.length === 0 && req.recoverNoResults) {
      const relaxed = relaxFilters(filters);
      if (relaxed.relaxed.length) {
        base = await searchService.search(projectSlug, collectionName, {
          ...opts,
          filters: relaxed.filters,
        });
        appliedFilters = relaxed.filters;
        fallback = { reason: "no_results", relaxedFilters: relaxed.relaxed };
      }
    }

    const explain = req.debug || req.explain
      ? await searchService.searchExplain(projectSlug, collectionName, {
          ...opts,
          filters: appliedFilters,
          limit: Math.min(limit, 20),
        })
      : null;
    const policy = mergeRankingPolicy(req.rankingPolicy, !!image, !!req.personalization);
    const ranked = rankHits(base.hits, policy, req.personalization, visualCosines(explain));

    const response: FashionSearchResponse = {
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

  async function syncFashionCatalogEvent(
    projectSlug: string,
    collectionName: string,
    event: FashionCatalogSyncEvent
  ): Promise<{ synced: boolean; action: "upserted" | "deleted"; needsReindex: boolean }> {
    const project = await projectsService.getProject(projectSlug);
    if (!project) throw new Error(`project "${projectSlug}" not found`);
    const def = await projectsService.getCollectionDef(projectSlug, collectionName);
    if (!def) throw new Error(`collection "${collectionName}" not found in project "${projectSlug}"`);
    const table = collectionTableName(project.schema_name, collectionName);

    if (event.type === "product.delete") {
      await getPgClient(ctx.db, "fashion-sync").unsafe(`DELETE FROM ${table} WHERE id = $1`, [event.id]);
      searchResultCache.invalidateProjectCollection(projectSlug, collectionName);
      return { synced: true, action: "deleted", needsReindex: false };
    }

    const rows = await getPgClient(ctx.db, "fashion-sync").unsafe(
      `SELECT data FROM ${table} WHERE id = $1 LIMIT 1`,
      [event.id]
    );
    const existing = (rows[0]?.data ?? {}) as Record<string, unknown>;
    const data = { ...existing, ...(event.data ?? {}), ...(event.changes ?? {}) };
    await ingestService.upsertDocuments(projectSlug, collectionName, [{ id: event.id, data }]);
    const setFragments: string[] = [];
    const params: unknown[] = [event.id];
    for (const [fieldName, fieldDef] of Object.entries(def.fields)) {
      const path = fieldDef.path ?? fieldName;
      if (path.startsWith("enriched.")) continue;
      const value = getByPath(data, path);
      if (value === undefined) continue;
      params.push(value);
      setFragments.push(`${sanitiseIdent(fieldName)} = $${params.length}`);
    }
    if (setFragments.length) {
      await getPgClient(ctx.db, "fashion-sync").unsafe(
        `UPDATE ${table} SET ${setFragments.join(", ")} WHERE id = $1`,
        params
      );
    }
    const needsReindex = ["product.upsert", "variant.upsert", "image.update"].includes(event.type);
    return { synced: true, action: "upserted", needsReindex };
  }

  return { fashionSearch, syncFashionCatalogEvent };
}

export type FashionSearchService = ReturnType<typeof makeFashionSearchService>;
