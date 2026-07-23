// Public type vocabulary the consumer's config file uses.
//
// Two layers:
//   - **Runtime types** (FieldDef, EntityDef, ScorerDef, etc.) — what flows
//     over HTTP as JSON and back. Loose by design, fully serializable
//     (no functions, no zod schemas — those live on createMatcher).
//   - **Authoring generics** (TypedScorer<...>, EntityFor<...>) — exposed via
//     the entity() / Scorers.* factories in index.ts. These preserve the
//     literal shape of the user's config so cross-references between
//     scoring channels and declared fields/embeddings/phonetic are validated
//     at compile time.
//
// As of v0.2 there is NO `providers.*` registry and NO `EmbeddingProviderDef`
// in the DSL. Entity declarations carry only what's needed to author the data
// model: the model name (an opaque identifier), the vector dim, and optional
// task-type hint. The actual embedding/parse FUNCTIONS live on createMatcher
// — see @samesake/server's MatcherConfig. That separation keeps the SDK and
// matcher entirely free of opinions about which LLM provider you use.

import type { ZodType } from "zod";

export interface FieldDef {
  type: "text" | "number";
  required?: boolean;
  optional?: boolean;
  maxLength?: number;
}

/**
 * `source` is either:
 *   - a field name on the entity data (e.g. "name")
 *   - a template expression with $-prefixed field refs (e.g. "$brand $item_canonical")
 *
 * Functions aren't supported — they can't survive HTTP transport.
 *
 * `model` is an opaque identifier chosen by the consumer. @samesake/server passes it through to the consumer's `embed`
 * function untouched; the consumer's embedder decides what to do with it. The matcher
 * uses it to namespace the embedding cache.
 *
 * `dim` is the vector dimension. It IS load-bearing for samesake: the per-project
 * entity_<kind>_match table is created with `vector(<dim>)` columns.
 *
 * `taskType` is opaque metadata that @samesake/server forwards to the consumer's
 * embedder. It is available for provider-specific hints without making any
 * provider part of the SDK contract.
 */
export interface EmbeddingDef {
  source: string;
  model: string;
  dim: number;
  taskType?: string;
}

export interface PhoneticDef {
  /** Field name or source expression whose value is phonetically hashed. The algorithm
   *  is chosen by the PhoneticProvider on createMatcher (e.g. indicPhonetic), not here. */
  source: string;
}

/**
 * Marks an entity as "parse-shape" — the matcher will call the consumer-provided
 * `parse` function on createMatcher to extract structured product/asset fields
 * (brand, item_canonical, size_value, size_unit, variant, internal_code, ...)
 * from the entity's source text. Those parsed fields then drive gated matching:
 * a brand mismatch downweights a candidate by 5x; a size mismatch drops it.
 *
 * The parse OUTPUT shape (ParsedProductSchema) is owned by @samesake/server
 * because the SQL match function generation depends on its columns. Consumers
 * can override `instructions` to tune the prompt for their domain (medication
 * vs grocery vs hardware), and `model` to pick a model — both forwarded to the
 * consumer's parse function untouched.
 */
export interface ParseDef {
  /** Field on entity.data to extract from. Defaults to the "name" field. */
  source?: string;
  /**
   * Opaque model identifier passed to the consumer's parse function. Defaults
   * are decided by the consumer's parse function.
   */
  model?: string;
  /**
   * Override the default product-parse system prompt. Use this when your domain
   * has specific extraction rules — e.g. "medication strengths must
   * preserve units (mg/g/ml) verbatim."
   */
  instructions?: string;
  /** Cache TTL hint, e.g. "30d". Currently advisory; the cache always uses 90d. */
  cacheTtl?: string;
}

// ── Runtime scorer types (loose, what crosses the HTTP boundary) ──────
export interface ScorerDef {
  kind:
    | "cosine"
    | "trigram"
    | "phoneticEq"
    | "phoneExact"
    | "aliasHit"
    | "internalCodeExact"
    | "sizeUnitGate"
    | "brandGate";
  weight?: number;
  field?: string;
  embedding?: string;
  phonetic?: string;
  value?: string;
  unit?: string;
  shortCircuit?: boolean;
  matchBoost?: number;
  mismatchFactor?: number;
  latinOnlyPartial?: boolean;
}

// ── Authoring-side scorer shapes (preserve literal references) ─────────
// Each shape carries the literal name(s) it references so the `channels`
// union below can be parameterized by keyof TFields / TEmbeddings / TPhonetic.
export type CosineScorer<E extends string> = {
  kind: "cosine"; embedding: E; weight: number;
};
export type TrigramScorer<F extends string> = {
  kind: "trigram"; field: F; weight: number; latinOnlyPartial?: boolean;
};
export type PhoneticEqScorer<P extends string> = {
  kind: "phoneticEq"; phonetic: P; weight: number;
};
export type PhoneExactScorer<F extends string> = {
  kind: "phoneExact"; field: F; weight: number;
};
export type AliasHitScorer = {
  kind: "aliasHit"; weight: number;
};
// internalCode / sizeUnit / brand reference *parsed* fields (e.g.
// "parsed.internal_code"), not raw entity fields — they intentionally
// stay as plain string.
export type InternalCodeExactScorer = {
  kind: "internalCodeExact"; field: string; shortCircuit?: boolean;
};
export type SizeUnitGateScorer = {
  kind: "sizeUnitGate"; value: string; unit: string;
};
export type BrandGateScorer = {
  kind: "brandGate"; field: string; matchBoost?: number; mismatchFactor?: number;
};

/**
 * The discriminated union the `scoring.channels` array accepts at the
 * entity() call site. Generic over the entity's own field/embedding/
 * phonetic key sets so e.g. `Scorers.cosine({ embedding: "name_emb" })`
 * only compiles when "name_emb" is a key of the entity's embeddings.
 */
export type TypedScorer<F extends string, E extends string, P extends string> =
  | CosineScorer<E>
  | TrigramScorer<F>
  | PhoneticEqScorer<P>
  | PhoneExactScorer<F>
  | AliasHitScorer
  | InternalCodeExactScorer
  | SizeUnitGateScorer
  | BrandGateScorer;

export interface ScoringDef {
  channels: ScorerDef[];
  combiner?: "probabilistic-or" | "rrf" | "fellegi-sunter";
  thresholds?: { autoLink?: number; suggest?: number };
}

export interface EntityDef {
  name?: string;
  fields: Record<string, FieldDef>;
  scopes: string[];
  embeddings?: Record<string, EmbeddingDef>;
  phonetic?: Record<string, PhoneticDef>;
  scoring?: ScoringDef;
  parse?: ParseDef;
}

// ── Collection / search types ───────────────────────────────────────────
export interface CollectionTextFieldDef {
  type: "text";
  searchable?: boolean;
  filterable?: boolean;
  facet?: boolean | "range";
  soft?: boolean;
  path?: string;
  /**
   * tsvector weight class for the lexical leg: "A" (title-class, ranks above
   * everything else) or "B" (default). Only meaningful with `searchable: true`.
   */
  ftsWeight?: "A" | "B";
}

export interface CollectionNumberFieldDef {
  type: "number";
  filterable?: boolean;
  facet?: boolean | "range";
  soft?: boolean;
  path?: string;
  /** NLQ maps implied budget words ("cheap", "premium") to percentile filters on this field. */
  budget?: boolean;
}

export interface CollectionBooleanFieldDef {
  type: "boolean";
  filterable?: boolean;
  facet?: boolean;
  soft?: boolean;
  path?: string;
}

export interface CollectionEnumFieldDef {
  type: "enum";
  values: readonly string[];
  filterable?: boolean;
  facet?: boolean;
  soft?: boolean;
  path?: string;
  alsoMatch?: readonly string[];
}

export interface CollectionArrayFieldDef {
  type: "array";
  itemType: "text" | "enum";
  values?: readonly string[];
  filterable?: boolean;
  facet?: boolean;
  soft?: boolean;
  path?: string;
}

export type CollectionFieldDef =
  | CollectionTextFieldDef
  | CollectionNumberFieldDef
  | CollectionBooleanFieldDef
  | CollectionEnumFieldDef
  | CollectionArrayFieldDef;

export interface CollectionEmbeddingDef {
  model: string;
  dim: number;
  taskType?: string;
  kind?: "text" | "image";
  evidence?: boolean;
  extract?: (ctx: DerivedDocContext) => string[];
  describe?: string;
  /**
   * Template for the embedded document when the collection has no `indexing`
   * surfaces (`"$title $brand"` interpolates data/enriched values). Collections
   * with an enrich pipeline + `indexing` build their surfaces there instead.
   */
  source?: string;
}

export type FtsChannel<F extends string> = {
  kind: "fts";
  fields: readonly F[];
  weight: number;
};

export type CosineChannel<E extends string> = {
  kind: "cosine";
  embedding: E;
  weight: number;
};

export type RecencyChannel<F extends string> = {
  kind: "recency";
  field: F;
  halfLifeDays: number;
  weight: number;
};

export type TypedSearchChannel<F extends string, E extends string> =
  | FtsChannel<F>
  | CosineChannel<E>
  | RecencyChannel<F | "updated_at">;

export interface SearchChannelDef {
  kind: "fts" | "cosine" | "recency";
  weight: number;
  fields?: string[];
  embedding?: string;
  field?: string;
  halfLifeDays?: number;
}

export type RankingHardAxis = "availability" | "business";
export type RankingSoftAxis = "newness" | "personalization" | "visual" | "business";

export interface RankingPolicy {
  weights?: {
    relevance?: number;
    visual?: number;
    availability?: number;
    newness?: number;
    business?: number;
    personalization?: number;
  };
  /** Numeric field used as a merchant/business signal, for example margin or sell-through. */
  businessField?: string;
  boostAvailable?: boolean;
  buryUnavailable?: boolean;
  /** Multiplicative penalty on unavailable items (0–1). Default 0.2. */
  buryFactor?: number;
  /** Drop hits below this normalized relevance before boosting. Default 0. */
  minRelevanceFloor?: number;
  /** Exponent on normalized relevance in the multiplicative core. Default 1. */
  relevanceExponent?: number;
  /** Hard conjunctive axes — composed multiplicatively with relevance. */
  hardAxes?: RankingHardAxis[];
  /** Soft boosts — composed additively after the multiplicative core. */
  softAxes?: RankingSoftAxis[];
}

export interface CollectionSearchDef {
  channels: SearchChannelDef[];
  combiner?: "rrf";
  /**
   * Declared field whose value groups variants of the same product (e.g. a
   * parent/style id). When set, search collapses results to the best-scoring item
   * per group by default (override per-query with `diversify: false`). Items with a
   * null/empty value are never collapsed.
   */
  variantGroup?: string;
  /** Post-fusion ranking boosts applied after rerank (when present). */
  rankingPolicy?: RankingPolicy;
  /**
   * Filter keys shopSearch's `recoverNoResults` may drop (in this order) when a filtered
   * query returns zero hits. Core relaxes nothing unless the collection declares this —
   * load-bearing constraints (e.g. gender, brand) stay hard by omission.
   */
  relaxableFilters?: string[];
  /**
   * Priority order for progressive soft-filter relaxation: listed fields are dropped
   * FIRST, in this order, before any unlisted soft field. Declare contextual constraints
   * (occasions, styles) here so identity-bearing ones (colors, material) survive longest —
   * selectivity counts alone invert on real corpora ("red dress for a wedding" must relax
   * to red dresses, never to black ones). Unlisted fields fall back to
   * least-selective-first (highest standalone match count).
   */
  relaxOrder?: string[];
  /**
   * Minimum query–document cosine similarity (0–1) a semantic-only hit must clear
   * to survive; hits that also match via FTS keywords are exempt. Suppresses
   * no-match padding — a query with no real match returns few/no results instead
   * of the nearest neighbours. Calibrate per embedding model; see
   * guides/eval-gate.
   */
  relevanceFloor?: number;
  /**
   * Result-cutoff strategy: decides where the result list honestly ends instead
   * of padding with nearest neighbours (bad results are worse than an honest
   * zero-results page). Defaults to `{ strategy: "score-drop" }` — declare
   * `{ strategy: "none" }` to opt out. Hits with an FTS keyword match are never
   * cut (lexical evidence anchors the list); the strategies only judge
   * semantic-only tails. Bypassed when NLQ derived hard filters (structured
   * intent defines relevance there), mirroring `relevanceFloor`.
   */
  cutoff?: CollectionCutoffDef;
  /**
   * Extend the lexical leg with cross-script phonetic token matching: index
   * time stores per-token `samesake_phonetic` codes of the fts sources
   * (`fts_phon` column), query time ORs the query's phonetic codes into the
   * lexical candidate set — so "අම්මා" finds "amma". Requires
   * `createMatcher({ phonetic })` (e.g. `indicPhonetic`).
   */
  phonetic?: boolean;
  nlq?: {
    instructions?: string;
    semanticRewrite?: boolean;
    enable?: boolean;
    schema?: SchemaInput;
    model?: string;
  };
}

export interface CollectionCutoffDef {
  /**
   * - "score-drop" (default): with no FTS-anchored hit, the whole list is cut when
   *   even the best cosine is below `minAnchor`; within a list, a relative cosine
   *   cliff of more than `maxDrop` ends the semantic tail.
   * - "category-coherence": with no FTS-anchored hit, the list is cut when the top
   *   hits scatter across `field` values (majority share below `coherenceMin`) —
   *   scattered categories mean the query matched nothing real.
   * - "none": opt out.
   */
  strategy: "score-drop" | "category-coherence" | "none";
  /** score-drop: relative drop between consecutive cosines that ends the tail (0–1). Default 0.5. */
  maxDrop?: number;
  /**
   * Best-cosine floor an unanchored (no FTS match) result list must clear to
   * survive at all. Calibrate per embedding model, like `relevanceFloor`.
   * Default 0.3 (deliberately conservative).
   */
  minAnchor?: number;
  /** category-coherence: the declared field whose values define coherence. Required for that strategy. */
  field?: string;
  /** category-coherence: minimum majority share among the top hits (0–1). Default 0.5. */
  coherenceMin?: number;
}

// ── Cross-vendor offer dedup ────────────────────────────────────────────
/**
 * A single scoring channel for offer-dedup. The weighted channels contribute a
 * normalized [0,1] score (Σ weightᵢ·channelᵢ / Σ weightᵢ); an `exactKey` channel
 * is decisive — equal non-empty values short-circuit to an auto-link regardless
 * of the other channels (REQ-4). Empty/null key values never match.
 */
export type DedupChannelDef =
  | { kind: "exactKey"; field: string }
  | { kind: "trigram"; field: string; weight: number }
  | { kind: "cosine"; weight: number };

/**
 * Declares that a collection clusters listings of the same physical product so
 * search returns one hit per product with an `offers` array. Collections WITHOUT
 * this block are bit-for-bit unaffected on every surface (REQ-1). Clustering is an
 * explicit `matcher.dedup(project, collection)` stage — never automatic on index.
 */
export interface CollectionDedupDef {
  /** Scoring channels; weighted sum normalized by total weight → [0,1]. */
  channels: DedupChannelDef[];
  /** Best-candidate score at/above which a row auto-joins the candidate's cluster. (0,1]. */
  autoLink: number;
  /**
   * Scores in [suggest, autoLink) persist a suggestion for human review instead of
   * auto-linking. Unset = no suggestions (precision-first: uncertain pairs found their
   * own cluster). Must satisfy 0 < suggest <= autoLink.
   */
  suggest?: number;
  /** Declared collection fields copied onto each offer entry (e.g. ["vendor","price","available"]). */
  offerFields: string[];
  /** Cluster-id column name. Default "product_group". Must not collide with a declared field. */
  groupField?: string;
}

export interface StageContext {
  data: Record<string, unknown>;
  enriched: Record<string, unknown>;
}

// A structured-output schema declared on an enrich stage or NLQ config. Either a
// zod schema (converted to JSON Schema by the matcher) or a plain JSON Schema object,
// which is forwarded as-is to your `generate` function.
export type SchemaInput = ZodType | Record<string, unknown>;

export interface StageDef {
  name: string;
  model?: string;
  condition?: (ctx: StageContext) => boolean;
  prompt: (ctx: StageContext) => string;
  images?: (ctx: StageContext) => string[];
  schema: (ctx: StageContext) => SchemaInput;
}

export interface PipelineDef {
  stages: StageDef[];
}

export interface ConnectorDef {
  name: string;
  kind: "shopify" | "woocommerce" | "jsonl";
  options: Record<string, unknown>;
  /**
   * Scope values stamped onto every document this connector pulls (one feed =
   * one tenant). Required when the collection declares `scopes`.
   */
  scope?: Record<string, string>;
}

export interface DerivedDocContext {
  readonly data: Record<string, unknown>;
  readonly enriched: Record<string, unknown>;
}

export type DerivedDocDef =
  | { kind: "dense"; build: (ctx: DerivedDocContext) => string; embedding: string }
  | { kind: "rerank"; build: (ctx: DerivedDocContext) => string }
  | { kind: "fts"; build: (ctx: DerivedDocContext) => string; weight?: "A" | "B" };

export type IndexGate = (ctx: DerivedDocContext) => { index: boolean; reason?: string };

export interface IndexingDef {
  surfaces: Record<string, DerivedDocDef>;
  gate: IndexGate;
}

export interface CollectionDef {
  name?: string;
  /**
   * Full-text-search configuration for the lexical leg (stemming +
   * stopwords): "english" (default), "german", "spanish", "simple" (no
   * stemming — right for mixed-language or non-European-language catalogs), or
   * any installed regconfig. Applied to both the indexed `fts` column and
   * query parsing. Changing it on an existing collection rebuilds the fts
   * column — a destructive migration.
   */
  language?: string;
  /**
   * Tenancy: scope key names (e.g. `["tenant_id"]`). Each key compiles to a
   * `scope_<key>` column, and every read/write on the collection then REQUIRES
   * all scope values — documents carry `scope` on push, queries pass
   * `scope` in SearchOpts; there is no cross-scope search. Scopes answer
   * "whose catalog is this row" (hard isolation between stores/tenants) — a
   * vendor facet inside one shared marketplace catalog is a normal field, not
   * a scope. Ids stay unique per collection (not per scope); an upsert that
   * would overwrite an id owned by a different scope is rejected. Adding or
   * changing scopes on an existing collection is a destructive migration.
   */
  scopes?: string[];
  fields: Record<string, CollectionFieldDef>;
  enrich?: PipelineDef;
  sources?: ConnectorDef[];
  embeddings?: Record<string, CollectionEmbeddingDef>;
  search?: CollectionSearchDef;
  /**
   * Cross-vendor offer dedup: cluster listings of the same physical product so search
   * returns one hit per product with an `offers` array. Declaring it adds cluster-state
   * columns + a suggestions table and makes search collapse on the cluster id by default.
   * Omit it and the collection is completely unaffected. See {@link CollectionDedupDef}.
   */
  dedup?: CollectionDedupDef;
  indexing?: IndexingDef;
  indexingManifest?: {
    surfaces: Record<string, { kind: "dense" | "rerank" | "fts"; embedding?: string }>;
  };
}

export interface AuthoredCollection extends CollectionDef {
  indexing: IndexingDef;
}

export const gates = {
  always: ((_ctx: DerivedDocContext) => ({ index: true })) satisfies IndexGate,
};

export type SearchWeightsInput<S extends string = string> = {
  fts?: number;
  cosine?: number;
  recency?: number;
  aspects?: number | Partial<Record<S, number>>;
};

/**
 * Retrieval objective. The two are different problems and need different channel weighting:
 * - "intent": find items matching a need/constraints. Keyword is a tiebreaker (capped below
 *   semantic), visual is off for text queries. NLQ hard filters apply.
 * - "similar": find items that look/feel like the query. Keyword is off (it pulls in
 *   word-decoys); semantic + visual lead.
 * Resolved automatically when omitted: "similar" if a query image is present, else "intent".
 */
export type SearchMode = "intent" | "similar";

export type ConstraintTraceSource = "nlq" | "deterministic" | "explicit" | "budget_hint" | "agent";

export interface RelaxationStep {
  field: string;
  standaloneMatchCount: number;
  resultCount: number;
}

export interface GroundedValueDecision {
  parsed: string;
  mapped?: string;
  action: "kept" | "mapped" | "dropped";
}

export type RewriteType = "spellfix" | "synonym" | "broader" | "substitute";

export interface RewriteRecord {
  type: RewriteType;
  from: string;
  to: string;
}

export type ConstraintFieldType = "text" | "number" | "boolean" | "enum" | "array";

export type ConstraintOperator =
  | "eq"
  | "ne"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "in"
  | "nin"
  | "contains"
  | "exclude"
  | "not";

export type ConstraintTraceKind =
  | "eq"
  | "not_eq"
  | "min"
  | "max"
  | "range"
  | "in"
  | "not_in"
  | "contains"
  | "exclude"
  | "boolean";

export interface ConstraintTraceItem {
  field: string;
  source: ConstraintTraceSource;
  kind: ConstraintTraceKind;
  operator?: string;
  value?: unknown;
  soft?: boolean;
}

export interface ConstraintPredicate {
  field: string;
  fieldType: ConstraintFieldType;
  operator: ConstraintOperator;
  value: unknown;
  source?: ConstraintTraceSource;
  soft?: boolean;
}

export interface ConstraintPlan {
  predicates: ConstraintPredicate[];
  excludedTerms: string[];
  relaxedFields: string[];
}

export interface ConstraintTrace {
  semanticQuery?: string;
  items: ConstraintTraceItem[];
  plan: ConstraintPlan;
  derivedFilters: Record<string, unknown>;
  explicitFilters: Record<string, unknown>;
  appliedFilters: Record<string, unknown>;
  relaxedFields: string[];
  excludedTerms: string[];
  budgetHints: Record<string, "cheap" | "premium">;
  deterministicFilters: Record<string, unknown>;
  groundedValues: Record<string, GroundedValueDecision[]>;
  relaxationSteps: RelaxationStep[];
  rewritten?: RewriteRecord;
}

export interface ShopSearchImageInput {
  /** Remote image URL. The server fetches it through the same hardened image guard used for indexing. */
  url?: string;
  /** Base64 image bytes for callers that do not want Samesake to fetch a URL. */
  bytesBase64?: string;
  /** In-process callers may pass bytes directly. Not valid over JSON HTTP. */
  bytes?: Uint8Array;
  mimeType?: string;
  /** Product id whose catalog image should be used as the query image. */
  productId?: string;
}

/** Request-scoped shopper preferences applied as a re-ranking axis — never persisted. */
export interface ShopperContext {
  size?: string;
  priceBand?: { min?: number; max?: number };
  preferredBrands?: string[];
  blockedBrands?: string[];
  viewedProductIds?: string[];
  avoidedStyles?: string[];
  colorAffinity?: Record<string, number>;
}

export interface ShopSearchRequest<S extends string = string> {
  q?: string;
  image?: ShopSearchImageInput;
  /** Tenancy scope — required (all declared keys) when the collection declares `scopes`. */
  scope?: Record<string, string>;
  filters?: Record<string, unknown>;
  weights?: SearchWeightsInput<S>;
  rankingPolicy?: RankingPolicy;
  personalization?: ShopperContext;
  limit?: number;
  offset?: number;
  debug?: boolean;
  explain?: boolean;
  recoverNoResults?: boolean;
}

export interface ShopSearchExplanation {
  hitId: string;
  factors: Record<string, number | boolean | string | null>;
  appliedFilters: string[];
}

export interface ShopSearchResponse {
  hits: Array<Record<string, unknown> & { id: string; score: number }>;
  parsed?: Record<string, unknown>;
  appliedFilters: Record<string, unknown>;
  constraintTrace?: ConstraintTrace;
  explanations?: ShopSearchExplanation[];
  fallback?: {
    reason: "no_results" | "low_confidence";
    relaxedFilters: string[];
  };
  debug?: Record<string, unknown>;
  took_ms: number;
}

export type AgentImageInput =
  | { kind: "url"; url: string }
  | { kind: "bytes"; bytesBase64: string; mimeType?: string }
  | { kind: "product_image"; productId: string; imageField?: string };

export interface FindProductsRequest {
  intent?: string;
  image?: AgentImageInput;
  constraints?: Record<string, unknown>;
  shopperContext?: Record<string, unknown>;
  constraintMode?: "best_effort" | "strict";
  explain?: boolean;
  limit?: number;
}

export interface ProductVariantAvailability {
  id?: string;
  title?: string;
  size?: string;
  price?: number;
  available?: boolean;
  inventoryQuantity?: number;
  updatedAt?: string;
}

export interface ConstraintVerification {
  status: "satisfied" | "violated" | "unknown";
  satisfied: string[];
  violated: string[];
  unknown: string[];
  strictExcluded?: boolean;
}

export interface GroundedProductCandidate {
  id: string;
  title?: string;
  url?: string;
  imageUrl?: string;
  price?: { amount: number; currency?: string; lastUpdatedAt?: string };
  availability?: {
    inStock?: boolean;
    variants?: ProductVariantAvailability[];
    lastCheckedAt?: string;
    freshness: "fresh" | "stale" | "unknown";
  };
  score: number;
  data: Record<string, unknown>;
  grounding: {
    project: string;
    collection: string;
    productId: string;
    indexedAt?: string;
    sourceUpdatedAt?: string;
  };
  verification: ConstraintVerification;
  why?: Record<string, unknown>;
}

export interface FindProductsResponse {
  products: GroundedProductCandidate[];
  parsed?: Record<string, unknown>;
  constraintTrace?: ConstraintTrace;
  relaxed?: boolean;
  took_ms: number;
}

export interface AgentToolDescriptor {
  name:
    | "find_products"
    | "find_similar_products"
    | "compare_products"
    | "explain_result"
    | "get_product_availability"
    | "recover_no_results";
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

export interface ProjectConfig {
  entities?: EntityDef[];
  collections?: CollectionDef[];
}

// Match result types live in schemas.ts as Zod schemas — re-exported here
// so existing imports continue to resolve.
export type { MatchCandidate, MatchComponents, MatchResult, ResolvedMatch } from "./schemas.ts";
