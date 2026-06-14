import type {
  CollectionDef,
  AgentToolDescriptor,
  FindProductsRequest,
  FindProductsResponse,
  GroundedProductCandidate,
  ProductVariantAvailability,
  ConstraintVerification,
} from "@samesake/core";
import type { MatcherCtx } from "../types.ts";
import type { ProjectsService } from "./projects.ts";
import type { SearchHit, SearchOpts, SearchService, SearchFilters } from "./search.ts";
import { collectionTableName, getByPath, getPgClient } from "./db-utils.ts";

type ConstraintMode = "best_effort" | "strict";

function hitValue(hit: SearchHit, key: string): unknown {
  if (key in hit) return hit[key];
  return getByPath(hit.data, key);
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Lowercased string values of declared text/enum/array fields only — never keys, never numeric/url-only data. */
function declaredTextValues(hit: SearchHit, def: CollectionDef): string[] {
  const out: string[] = [];
  for (const [name, fieldDef] of Object.entries(def.fields)) {
    if (fieldDef.type !== "text" && fieldDef.type !== "enum" && fieldDef.type !== "array") continue;
    for (const item of asArray(hitValue(hit, name))) {
      if (item != null) out.push(String(item).toLowerCase());
    }
  }
  return out;
}

function toSearchImage(image: FindProductsRequest["image"]): SearchOpts["image"] | undefined {
  if (!image) return undefined;
  if (image.kind === "url") return { url: image.url };
  if (image.kind === "bytes") return { bytesBase64: image.bytesBase64, mimeType: image.mimeType };
  return undefined;
}

function constraintsToFilters(constraints: Record<string, unknown> = {}): SearchFilters {
  const filters: SearchFilters = {};
  for (const [key, value] of Object.entries(constraints)) {
    if (key === "inStock") filters.available = value === true;
    else if (key === "maxPrice") filters.price = { ...(filters.price as object), $lte: Number(value) };
    else if (key === "minPrice") filters.price = { ...(filters.price as object), $gte: Number(value) };
    else if (key === "size") filters.sizes = [String(value)];
    else if (key === "currency" || key === "market" || key === "blockedAttributes") continue;
    else filters[key] = value as SearchFilters[string];
  }
  return filters;
}

function imageOnlyWeights(def: CollectionDef, intent: string, image: SearchOpts["image"]): SearchOpts["weights"] {
  if (intent || !image || !def.spaces) return undefined;
  const spaces: Record<string, number> = {};
  for (const [name, space] of Object.entries(def.spaces)) {
    spaces[name] = space.kind === "image" ? 4 : 0;
  }
  return { fts: 0, cosine: 0, spaces };
}

function freshness(lastCheckedAt?: string): "fresh" | "stale" | "unknown" {
  if (!lastCheckedAt) return "unknown";
  const ts = new Date(lastCheckedAt).getTime();
  if (!Number.isFinite(ts)) return "unknown";
  return Date.now() - ts <= 24 * 60 * 60 * 1000 ? "fresh" : "stale";
}

function extractTitle(hit: SearchHit): string | undefined {
  const value = hitValue(hit, "title") ?? hitValue(hit, "name");
  return value == null ? undefined : String(value);
}

function extractUrl(hit: SearchHit): string | undefined {
  const value = hitValue(hit, "url") ?? hitValue(hit, "product_url") ?? hitValue(hit, "handle");
  return value == null ? undefined : String(value);
}

function extractImageUrl(hit: SearchHit): string | undefined {
  const value = hitValue(hit, "image_url") ?? hitValue(hit, "imageUrl") ?? hitValue(hit, "image");
  return value == null ? undefined : String(value);
}

function extractVariants(hit: SearchHit): ProductVariantAvailability[] | undefined {
  const variants = hitValue(hit, "variants");
  if (!Array.isArray(variants)) return undefined;
  return variants
    .filter((v): v is Record<string, unknown> => !!v && typeof v === "object")
    .map((v) => ({
      id: v.id == null ? undefined : String(v.id),
      title: v.title == null ? undefined : String(v.title),
      size: v.size == null ? undefined : String(v.size),
      price: typeof v.price === "number" ? v.price : undefined,
      available: typeof v.available === "boolean" ? v.available : undefined,
      inventoryQuantity: typeof v.inventoryQuantity === "number" ? v.inventoryQuantity : undefined,
      updatedAt: v.updatedAt == null ? undefined : String(v.updatedAt),
    }));
}

function verifyCandidate(
  hit: SearchHit,
  constraints: Record<string, unknown>,
  mode: ConstraintMode,
  def: CollectionDef
): ConstraintVerification {
  const satisfied: string[] = [];
  const violated: string[] = [];
  const unknown: string[] = [];

  function checkField(name: string, value: unknown, predicate: (v: unknown) => boolean): void {
    if (value === undefined || value === null) unknown.push(name);
    else if (predicate(value)) satisfied.push(name);
    else violated.push(name);
  }

  for (const [key, expected] of Object.entries(constraints)) {
    if (key === "maxPrice") {
      checkField(key, hitValue(hit, "price"), (v) => Number(v) <= Number(expected));
    } else if (key === "minPrice") {
      checkField(key, hitValue(hit, "price"), (v) => Number(v) >= Number(expected));
    } else if (key === "inStock") {
      checkField(key, hitValue(hit, "available"), (v) => Boolean(v) === Boolean(expected));
    } else if (key === "size") {
      const sizes = asArray(hitValue(hit, "sizes")).map(String);
      const variants = extractVariants(hit) ?? [];
      const variantHasSize = variants.some((v) => v.size === String(expected) && v.available !== false);
      if (!sizes.length && !variants.length) unknown.push(key);
      else if (sizes.includes(String(expected)) || variantHasSize) satisfied.push(key);
      else violated.push(key);
    } else if (key === "currency") {
      checkField(key, hitValue(hit, "currency"), (v) => String(v) === String(expected));
    } else if (key === "blockedAttributes") {
      const blocked = asArray(expected)
        .map((v) => String(v).toLowerCase().trim())
        .filter(Boolean);
      const values = declaredTextValues(hit, def);
      const found = blocked.filter((term) => {
        const re = new RegExp(`\\b${escapeRegex(term)}\\b`, "i");
        return values.some((val) => re.test(val));
      });
      if (found.length) violated.push(key);
      else satisfied.push(key);
    }
  }

  const strictExcluded = mode === "strict" && unknown.length > 0;
  const status =
    violated.length > 0 ? "violated" : unknown.length > 0 ? "unknown" : "satisfied";
  return { status, satisfied, violated, unknown, ...(strictExcluded ? { strictExcluded } : {}) };
}

function isExcluded(verification: ConstraintVerification, mode: ConstraintMode): boolean {
  return verification.violated.length > 0 || (mode === "strict" && verification.unknown.length > 0);
}

function toGroundedCandidate(
  hit: SearchHit,
  project: string,
  collection: string,
  metadata: Record<string, { indexedAt?: string; sourceUpdatedAt?: string }>,
  constraints: Record<string, unknown>,
  mode: ConstraintMode,
  def: CollectionDef,
  why?: Record<string, unknown>
): GroundedProductCandidate {
  const price = Number(hitValue(hit, "price"));
  const currencyRaw = hitValue(hit, "currency");
  const availableRaw = hitValue(hit, "available");
  const lastCheckedAt =
    hitValue(hit, "inventory_checked_at") ??
    hitValue(hit, "availability_checked_at") ??
    hitValue(hit, "updated_at");
  const verification = verifyCandidate(hit, constraints, mode, def);
  const meta = metadata[hit.id] ?? {};

  return {
    id: hit.id,
    title: extractTitle(hit),
    url: extractUrl(hit),
    imageUrl: extractImageUrl(hit),
    price: Number.isFinite(price)
      ? {
          amount: price,
          currency: currencyRaw == null ? undefined : String(currencyRaw),
          lastUpdatedAt: hitValue(hit, "price_updated_at") == null ? undefined : String(hitValue(hit, "price_updated_at")),
        }
      : undefined,
    availability: {
      inStock: typeof availableRaw === "boolean" ? availableRaw : undefined,
      variants: extractVariants(hit),
      lastCheckedAt: lastCheckedAt == null ? undefined : String(lastCheckedAt),
      freshness: freshness(lastCheckedAt == null ? undefined : String(lastCheckedAt)),
    },
    score: hit.score,
    data: hit.data,
    grounding: {
      project,
      collection,
      productId: hit.id,
      indexedAt: meta.indexedAt,
      sourceUpdatedAt: meta.sourceUpdatedAt,
    },
    verification,
    why,
  };
}

export const agentFindProductsRequestSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    intent: { type: "string" },
    image: {
      oneOf: [
        { type: "object", properties: { kind: { const: "url" }, url: { type: "string" } }, required: ["kind", "url"] },
        { type: "object", properties: { kind: { const: "bytes" }, bytesBase64: { type: "string" }, mimeType: { type: "string" } }, required: ["kind", "bytesBase64"] },
        { type: "object", properties: { kind: { const: "product_image" }, productId: { type: "string" }, imageField: { type: "string" } }, required: ["kind", "productId"] },
      ],
    },
    constraints: { type: "object", additionalProperties: true },
    shopperContext: { type: "object", additionalProperties: true },
    constraintMode: { type: "string", enum: ["best_effort", "strict"] },
    explain: { type: "boolean" },
    limit: { type: "number" },
  },
};

export const agentFindProductsResponseSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    products: { type: "array", items: { type: "object" } },
    parsed: { type: "object" },
    constraintTrace: { type: "object" },
    relaxed: { type: "boolean" },
    took_ms: { type: "number" },
  },
  required: ["products", "took_ms"],
};

export function agentToolDescriptors(): AgentToolDescriptor[] {
  return [
    {
      name: "find_products",
      description: "Return grounded, purchasable product candidates for a shopper intent. Stops before cart, checkout, or payment.",
      inputSchema: agentFindProductsRequestSchema,
      outputSchema: agentFindProductsResponseSchema,
    },
    {
      name: "find_similar_products",
      description: "Find products similar to a reference product image or product id using the same retrieval engine.",
      inputSchema: agentFindProductsRequestSchema,
      outputSchema: agentFindProductsResponseSchema,
    },
  ];
}

export function agentToolsOpenApi(): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: { title: "Samesake Agent Retrieval Tools", version: "1.0.0" },
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
      schemas: {
        FindProductsRequest: agentFindProductsRequestSchema,
        FindProductsResponse: agentFindProductsResponseSchema,
      },
    },
    paths: {
      "/v1/projects/{project}/collections/{collection}/agent/find-products": {
        post: {
          operationId: "find_products",
          summary: "Find grounded product candidates for an agent",
          description: "Requires a project key or master key. Returns structured candidates with freshness and verification metadata.",
          parameters: [
            { name: "project", in: "path", required: true, schema: { type: "string" } },
            { name: "collection", in: "path", required: true, schema: { type: "string" } },
          ],
          requestBody: { required: true, content: { "application/json": { schema: agentFindProductsRequestSchema } } },
          responses: {
            "200": { description: "Grounded product candidates", content: { "application/json": { schema: agentFindProductsResponseSchema } } },
            "400": { description: "Invalid request or unverifiable image input" },
            "401": { description: "Missing or invalid bearer token" },
          },
        },
      },
      "/v1/projects/{project}/collections/{collection}/agent/find-similar-products": {
        post: {
          operationId: "find_similar_products",
          summary: "Find products similar to a reference image or product id",
          description: "Requires a project key or master key. Returns structured candidates with freshness and verification metadata.",
          parameters: [
            { name: "project", in: "path", required: true, schema: { type: "string" } },
            { name: "collection", in: "path", required: true, schema: { type: "string" } },
          ],
          requestBody: { required: true, content: { "application/json": { schema: agentFindProductsRequestSchema } } },
          responses: {
            "200": { description: "Grounded product candidates", content: { "application/json": { schema: agentFindProductsResponseSchema } } },
            "400": { description: "Invalid request or unverifiable image input" },
            "401": { description: "Missing or invalid bearer token" },
          },
        },
      },
    },
  };
}

export function makeAgentToolsService(
  ctx: MatcherCtx,
  projectsService: ProjectsService,
  searchService: SearchService
) {
  async function resolveProductImage(
    projectSlug: string,
    collectionName: string,
    req: FindProductsRequest
  ): Promise<SearchOpts["image"] | undefined> {
    if (req.image?.kind !== "product_image") return toSearchImage(req.image);
    const project = await projectsService.getProject(projectSlug);
    if (!project) throw new Error(`project "${projectSlug}" not found`);
    const table = collectionTableName(project.schema_name, collectionName);
    const rows = await getPgClient(ctx.db, "agent-tools").unsafe(
      `SELECT data FROM ${table} WHERE id = $1 LIMIT 1`,
      [req.image.productId]
    );
    const data = rows[0]?.data as Record<string, unknown> | undefined;
    const field = req.image.imageField ?? "image_url";
    const url = data ? String(getByPath(data, field) ?? data.imageUrl ?? data.image ?? "") : "";
    if (!url) throw new Error(`product "${req.image.productId}" has no ${field}`);
    return { url };
  }

  async function loadMetadata(
    projectSlug: string,
    collectionName: string,
    ids: string[]
  ): Promise<Record<string, { indexedAt?: string; sourceUpdatedAt?: string }>> {
    if (!ids.length) return {};
    const project = await projectsService.getProject(projectSlug);
    if (!project) throw new Error(`project "${projectSlug}" not found`);
    const table = collectionTableName(project.schema_name, collectionName);
    const rows = await getPgClient(ctx.db, "agent-tools").unsafe(
      `SELECT id, indexed_at, updated_at FROM ${table} WHERE id = ANY($1::text[])`,
      [ids]
    );
    const out: Record<string, { indexedAt?: string; sourceUpdatedAt?: string }> = {};
    for (const row of rows) {
      out[String(row.id)] = {
        indexedAt: row.indexed_at ? new Date(row.indexed_at as Date).toISOString() : undefined,
        sourceUpdatedAt: row.updated_at ? new Date(row.updated_at as Date).toISOString() : undefined,
      };
    }
    return out;
  }

  async function findProducts(
    projectSlug: string,
    collectionName: string,
    req: FindProductsRequest
  ): Promise<FindProductsResponse> {
    const intent = req.intent?.trim() ?? "";
    const image = await resolveProductImage(projectSlug, collectionName, req);
    if (!intent && !image) throw new Error("find_products requires intent or image");
    const def = await searchService.getCollectionDef(projectSlug, collectionName);
    if (!def) throw new Error(`collection "${collectionName}" not found in project "${projectSlug}"`);
    const constraints = req.constraints ?? {};
    const mode = req.constraintMode ?? "best_effort";
    const filters = constraintsToFilters(constraints);
    const weights = imageOnlyWeights(def, intent, image);

    // search and explain use identical filters here (no fallback dependency between them),
    // so run the two independent retrieval passes concurrently instead of serially.
    const [search, explain] = await Promise.all([
      searchService.search(projectSlug, collectionName, {
        q: intent,
        image,
        filters,
        limit: Math.min(Math.max(req.limit ?? 10, 1), 50),
        weights,
      }),
      req.explain
        ? searchService.searchExplain(projectSlug, collectionName, {
            q: intent,
            image,
            filters,
            limit: Math.min(Math.max(req.limit ?? 10, 1), 20),
            weights,
          })
        : Promise.resolve(null),
    ]);
    const explainById = new Map(explain?.docs.map((doc) => [doc.id, doc]) ?? []);
    const metadata = await loadMetadata(projectSlug, collectionName, search.hits.map((h) => h.id));
    const products = search.hits
      .map((hit) =>
        toGroundedCandidate(
          hit,
          projectSlug,
          collectionName,
          metadata,
          constraints,
          mode,
          def,
          explainById.has(hit.id) ? { retrieval: explainById.get(hit.id) } : undefined
        )
      )
      .filter((candidate) => !isExcluded(candidate.verification, mode));

    return {
      products,
      parsed: search.parsed,
      constraintTrace: explain?.constraintTrace ?? search.constraintTrace,
      relaxed: search.relaxed,
      took_ms: search.took_ms,
    };
  }

  async function findSimilarProducts(
    projectSlug: string,
    collectionName: string,
    req: FindProductsRequest & { productId?: string }
  ): Promise<FindProductsResponse> {
    const image = req.image ?? (req.productId ? { kind: "product_image" as const, productId: req.productId } : undefined);
    return findProducts(projectSlug, collectionName, { ...req, image });
  }

  return { findProducts, findSimilarProducts, toolDescriptors: agentToolDescriptors, openApi: agentToolsOpenApi };
}

export type AgentToolsService = ReturnType<typeof makeAgentToolsService>;
