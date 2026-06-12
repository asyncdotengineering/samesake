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
 * `model` is an opaque identifier (e.g. "gemini-embedding-001", "text-embedding-3-small",
 * "nomic-embed-text"). @samesake/server passes it through to the consumer's `embed`
 * function untouched; the consumer's embedder decides what to do with it. The matcher
 * uses it to namespace the embedding cache.
 *
 * `dim` is the vector dimension. It IS load-bearing for samesake: the per-project
 * entity_<kind>_match table is created with `vector(<dim>)` columns.
 *
 * `taskType` is opaque metadata that @samesake/server forwards to the consumer's
 * embedder. Useful for provider-specific hints like Gemini's "SEMANTIC_SIMILARITY"
 * vs "RETRIEVAL_QUERY"/"RETRIEVAL_DOCUMENT".
 */
export interface EmbeddingDef {
  source: string;
  model: string;
  dim: number;
  taskType?: string;
}

export interface PhoneticDef {
  source: string;
  algorithm: "indic-soundex" | "soundex" | "metaphone";
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
   * Opaque model identifier passed to the consumer's parse function (e.g.
   * "gemini-2.5-flash-lite", "gpt-4o-mini"). Defaults are decided by the
   * consumer's parse function.
   */
  model?: string;
  /**
   * Override the default product-parse system prompt. Use this when your domain
   * has specific extraction rules — e.g. "Sinhala medication strengths must
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
  weight?: number;
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
  source: string;
  model: string;
  dim: number;
  taskType?: string;
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

export type SpacesChannel = {
  kind: "spaces";
  weight: number;
};

export type TypedSearchChannel<F extends string, E extends string> =
  | FtsChannel<F>
  | CosineChannel<E>
  | RecencyChannel<F | "updated_at">
  | SpacesChannel;

export interface SearchChannelDef {
  kind: "fts" | "cosine" | "recency" | "spaces";
  weight: number;
  fields?: string[];
  embedding?: string;
  field?: string;
  halfLifeDays?: number;
}

export interface TextSpaceDef {
  kind: "text";
  source: string;
  model: string;
  dim: number;
  taskType?: string;
}

export interface ImageSpaceDef {
  kind: "image";
  source: string;
  model: string;
  dim: number;
  taskType?: string;
}

export interface NumberSpaceDef {
  kind: "number";
  field: string;
  mode: "closer" | "max" | "min";
  dims: number;
  min: number;
  max: number;
  scale?: "linear" | "log";
}

export interface RecencySpaceDef {
  kind: "recency";
  field: string;
  halfLifeDays: number;
  dims: number;
  staleAfterDays?: number;
}

export interface CategoricalSpaceDef {
  kind: "categorical";
  field: string;
  values?: readonly string[];
  dims: number;
}

export type SpaceDef =
  | TextSpaceDef
  | ImageSpaceDef
  | NumberSpaceDef
  | RecencySpaceDef
  | CategoricalSpaceDef;

export interface CollectionSearchDef {
  channels: SearchChannelDef[];
  combiner?: "rrf";
  defaultSpaceWeights?: Record<string, number>;
  nlq?: {
    instructions?: string;
    semanticRewrite?: boolean;
    enable?: boolean;
    schema?: Record<string, unknown>;
    model?: string;
  };
}

export interface StageContext {
  data: Record<string, unknown>;
  enriched: Record<string, unknown>;
}

export interface StageDef {
  name: string;
  model?: string;
  condition?: (ctx: StageContext) => boolean;
  prompt: (ctx: StageContext) => string;
  images?: (ctx: StageContext) => string[];
  schema: (ctx: StageContext) => Record<string, unknown>;
}

export interface PipelineDef {
  stages: StageDef[];
}

export interface ConnectorDef {
  name: string;
  kind: "shopify" | "woocommerce" | "jsonl";
  options: Record<string, unknown>;
}

export interface CollectionDef {
  name?: string;
  fields: Record<string, CollectionFieldDef>;
  enrich?: PipelineDef;
  sources?: ConnectorDef[];
  embeddings?: Record<string, CollectionEmbeddingDef>;
  spaces?: Record<string, SpaceDef>;
  search?: CollectionSearchDef;
}

export type SearchWeightsInput<S extends string = string> = {
  fts?: number;
  cosine?: number;
  recency?: number;
  spaces?: number | Partial<Record<S, number>>;
};

export interface ProjectConfig {
  entities?: EntityDef[];
  collections?: CollectionDef[];
}

// Match result types live in schemas.ts as Zod schemas — re-exported here
// so existing imports continue to resolve.
export type { MatchCandidate, MatchComponents, MatchResult, ResolvedMatch } from "./schemas.ts";
