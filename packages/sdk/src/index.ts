// The developer-facing SDK. Imported by consumer config files.
//
// The factories below preserve the literal shape of the user's input
// (via `const` type parameters introduced in TS 5.0 and `NoInfer<T>` from
// TS 5.4). That lets the entity() factory validate that every
// `Scorers.cosine({ embedding: "..." })` reference matches a declared
// embedding key — typos fail at compile time.
//
// v0.2: no more `providers.*` registry. Embedding declarations carry just
// the model string + dim; the actual call lives on createMatcher's `embed`
// function. See @samesake/server's MatcherConfig.
import type {
  EntityDef,
  ParseDef,
  FieldDef,
  EmbeddingDef,
  PhoneticDef,
  TypedScorer,
  CosineScorer,
  TrigramScorer,
  PhoneticEqScorer,
  PhoneExactScorer,
  AliasHitScorer,
  InternalCodeExactScorer,
  SizeUnitGateScorer,
  BrandGateScorer,
  CollectionDef,
  CollectionFieldDef,
  CollectionEmbeddingDef,
  StageContext,
  StageDef,
  SchemaInput,
  PipelineDef,
  ConnectorDef,
  CollectionTextFieldDef,
  CollectionNumberFieldDef,
  CollectionBooleanFieldDef,
  CollectionEnumFieldDef,
  CollectionArrayFieldDef,
  TypedSearchChannel,
  FtsChannel,
  CosineChannel,
  RecencyChannel,
  SpacesChannel,
  TextSpaceDef,
  ImageSpaceDef,
  NumberSpaceDef,
  RecencySpaceDef,
  CategoricalSpaceDef,
  SpaceDef,
} from "./types.ts";
import { assertIdent, assertNoIdentCollisions } from "./ident.ts";

export * from "./types.ts";
// Best-default enrichment templates (fashion commerce).
export {
  fashion,
  fashionTaxonomy,
  fashionEnums,
  fashionEnrichPipeline,
  fashionSearchFields,
  fashionSpaces,
  composeFashionEmbedDoc,
  fashionClassifySchema,
  fashionExtractSchema,
  fashionCategoryAttrBlock,
  fashionNlqSchema,
  FASHION_EXTRACT_INSTRUCTIONS,
  FASHION_NLQ_INSTRUCTIONS,
  FASHION_EMBED_DOC_SOURCE,
  type FashionEnrichOptions,
} from "./templates/fashion.ts";
export { IdentError, assertIdent, assertNoIdentCollisions } from "./ident.ts";

const DEF_KIND = Symbol.for("@samesake/core.defKind");
type DefKind = "entity" | "collection";

function brandDef<T extends object>(def: T, kind: DefKind): T {
  Object.defineProperty(def, DEF_KIND, {
    value: kind,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return def;
}

export function isEntityDef(value: unknown): value is EntityDef {
  return !!value && typeof value === "object" && (value as Record<PropertyKey, unknown>)[DEF_KIND] === "entity";
}

export function isCollectionDef(value: unknown): value is CollectionDef {
  return !!value && typeof value === "object" && (value as Record<PropertyKey, unknown>)[DEF_KIND] === "collection";
}

// ── Field factories ─────────────────────────────────────────────────────
export const fields = {
  text(opts: { required?: boolean; optional?: boolean; maxLength?: number } = {}): FieldDef {
    return { type: "text", ...opts };
  },
  number(opts: { required?: boolean; optional?: boolean } = {}): FieldDef {
    return { type: "number", ...opts };
  },
} as const;

// ── Scorer factories — generic so each call captures the literal name(s) ─
// it references. The captured literal flows through TypedScorer<F,E,P> at
// the entity() call site, where it's checked against keyof the entity's
// own fields/embeddings/phonetic.
export const Scorers = {
  cosine<const E extends string>(opts: { embedding: E; weight: number }): CosineScorer<E> {
    return { kind: "cosine", ...opts };
  },
  trigram<const F extends string>(
    opts: { field: F; weight: number; latinOnlyPartial?: boolean }
  ): TrigramScorer<F> {
    return { kind: "trigram", ...opts };
  },
  phoneticEq<const P extends string>(opts: { phonetic: P; weight: number }): PhoneticEqScorer<P> {
    return { kind: "phoneticEq", ...opts };
  },
  phoneExact<const F extends string>(opts: { field: F; weight: number }): PhoneExactScorer<F> {
    return { kind: "phoneExact", ...opts };
  },
  aliasHit(opts: { weight: number }): AliasHitScorer {
    return { kind: "aliasHit", ...opts };
  },
  internalCodeExact(opts: { field: string; shortCircuit?: boolean }): InternalCodeExactScorer {
    return { kind: "internalCodeExact", ...opts };
  },
  sizeUnitGate(opts: { value: string; unit: string }): SizeUnitGateScorer {
    return { kind: "sizeUnitGate", ...opts };
  },
  brandGate(opts: {
    field: string;
    matchBoost?: number;
    mismatchFactor?: number;
  }): BrandGateScorer {
    return { kind: "brandGate", ...opts };
  },
} as const;

// ── entity() factory — the type-safety hub ──────────────────────────────
// `const TFields` etc. preserve the literal shape (TS 5.0+).
// `NoInfer<keyof T>` (TS 5.4+) makes the scoring.channels constraint
// purely consume the field/embedding/phonetic keys — the channels'
// references cannot accidentally widen the inferred field/embedding/
// phonetic sets.
type EntityInput<
  TFields extends Record<string, FieldDef>,
  TScopes extends readonly string[],
  TEmbeddings extends Record<string, EmbeddingDef>,
  TPhonetic extends Record<string, PhoneticDef>,
> = {
  fields: TFields;
  scopes: TScopes;
  embeddings?: TEmbeddings;
  phonetic?: TPhonetic;
  parse?: ParseDef;
  scoring?: {
    channels: ReadonlyArray<
      TypedScorer<
        NoInfer<keyof TFields & string>,
        NoInfer<keyof TEmbeddings & string>,
        NoInfer<keyof TPhonetic & string>
      >
    >;
    combiner?: "probabilistic-or" | "rrf" | "fellegi-sunter";
    thresholds?: { autoLink?: number; suggest?: number };
  };
};

export function entity<
  const TFields extends Record<string, FieldDef>,
  const TScopes extends readonly string[],
  const TEmbeddings extends Record<string, EmbeddingDef> = Record<string, never>,
  const TPhonetic extends Record<string, PhoneticDef> = Record<string, never>,
>(
  name: string,
  def: EntityInput<TFields, TScopes, TEmbeddings, TPhonetic>
): EntityDef & { name: string } {
  assertIdent(name, "entity");
  for (const s of def.scopes ?? []) assertIdent(s, "scope");
  assertNoIdentCollisions(Object.keys(def.fields ?? {}), "field");
  return brandDef({ ...(def as unknown as EntityDef), name }, "entity");
}

// ── Collection field factories ──────────────────────────────────────────
export const f = {
  text(opts: Omit<CollectionTextFieldDef, "type"> = {}): CollectionTextFieldDef {
    return { type: "text", ...opts };
  },
  number(opts: Omit<CollectionNumberFieldDef, "type"> = {}): CollectionNumberFieldDef {
    return { type: "number", ...opts };
  },
  boolean(opts: Omit<CollectionBooleanFieldDef, "type"> = {}): CollectionBooleanFieldDef {
    return { type: "boolean", ...opts };
  },
  enum<const T extends readonly string[]>(
    values: T,
    opts: Omit<CollectionEnumFieldDef, "type" | "values"> = {}
  ): CollectionEnumFieldDef {
    return { type: "enum", values, ...opts };
  },
  array(
    item: CollectionEnumFieldDef | { type: "text" },
    opts: Omit<CollectionArrayFieldDef, "type" | "itemType" | "values"> = {}
  ): CollectionArrayFieldDef {
    if (item.type === "enum") {
      return { type: "array", itemType: "enum", values: item.values, ...opts };
    }
    return { type: "array", itemType: "text", ...opts };
  },
} as const;

// ── Search channel factories ────────────────────────────────────────────
export const Channels = {
  fts<const F extends string>(opts: { fields: readonly F[]; weight: number }): FtsChannel<F> {
    return { kind: "fts", ...opts };
  },
  cosine<const E extends string>(opts: { embedding: E; weight: number }): CosineChannel<E> {
    return { kind: "cosine", ...opts };
  },
  recency<const F extends string>(opts: {
    field: F;
    halfLifeDays: number;
    weight: number;
  }): RecencyChannel<F> {
    return { kind: "recency", ...opts };
  },
  spaces(opts: { weight: number }): SpacesChannel {
    return { kind: "spaces", ...opts };
  },
} as const;

const PGVECTOR_HNSW_MAX_DIMS = 2000;

function spaceDim(def: SpaceDef): number {
  return def.kind === "text" || def.kind === "image" ? def.dim : def.dims;
}

function validateSpaceDims(spaces: Record<string, SpaceDef>): void {
  let total = 0;
  for (const def of Object.values(spaces)) {
    total += spaceDim(def);
  }
  if (total > PGVECTOR_HNSW_MAX_DIMS) {
    throw new Error(
      `spaces total dimension ${total} exceeds pgvector HNSW limit of ${PGVECTOR_HNSW_MAX_DIMS} for vector columns. ` +
        `Reduce space dims or split spaces across collections. Future escape hatch: halfvec (up to 4000 dims).`
    );
  }
}

export const s = {
  text(opts: Omit<TextSpaceDef, "kind">): TextSpaceDef {
    return { kind: "text", ...opts };
  },
  image(opts: Omit<ImageSpaceDef, "kind">): ImageSpaceDef {
    return { kind: "image", ...opts };
  },
  number(opts: Omit<NumberSpaceDef, "kind">): NumberSpaceDef {
    return { kind: "number", ...opts };
  },
  recency(opts: Omit<RecencySpaceDef, "kind">): RecencySpaceDef {
    return { kind: "recency", ...opts };
  },
  categorical(opts: Omit<CategoricalSpaceDef, "kind">): CategoricalSpaceDef {
    return { kind: "categorical", ...opts };
  },
} as const;

type CollectionInput<
  TFields extends Record<string, CollectionFieldDef>,
  TEmbeddings extends Record<string, CollectionEmbeddingDef>,
  TSpaces extends Record<string, SpaceDef> = Record<string, never>,
> = {
  fields: TFields;
  enrich?: PipelineDef;
  sources?: ConnectorDef[];
  embeddings?: TEmbeddings;
  spaces?: TSpaces;
  search?: {
    channels: ReadonlyArray<
      TypedSearchChannel<
        NoInfer<keyof TFields & string>,
        NoInfer<keyof TEmbeddings & string>
      >
    >;
    combiner?: "rrf";
    defaultSpaceWeights?: Partial<Record<NoInfer<keyof TSpaces & string>, number>>;
    /** Declared field whose value groups product variants; results collapse to one per group. */
    variantGroup?: NoInfer<keyof TFields & string>;
    nlq?: {
      instructions?: string;
      semanticRewrite?: boolean;
      enable?: boolean;
      schema?: SchemaInput;
      model?: string;
    };
  };
};

export function collection<
  const TFields extends Record<string, CollectionFieldDef>,
  const TEmbeddings extends Record<string, CollectionEmbeddingDef> = Record<string, never>,
  const TSpaces extends Record<string, SpaceDef> = Record<string, never>,
>(
  name: string,
  def: CollectionInput<TFields, TEmbeddings, TSpaces>
): CollectionDef & { name: string } {
  assertIdent(name, "collection");
  assertNoIdentCollisions(Object.keys(def.fields ?? {}), "field");
  if (def.spaces) assertNoIdentCollisions(Object.keys(def.spaces), "space");
  if (def.embeddings) assertNoIdentCollisions(Object.keys(def.embeddings), "embedding");
  if (def.spaces && Object.keys(def.spaces).length > 0) {
    validateSpaceDims(def.spaces);
  }
  const vg = (def as unknown as CollectionDef).search?.variantGroup;
  if (vg && !(def.fields && vg in def.fields)) {
    throw new Error(`collection "${name}": search.variantGroup "${vg}" must be a declared field`);
  }
  return brandDef({ ...(def as unknown as CollectionDef), name }, "collection");
}

export function stage(
  name: string,
  def: Omit<StageDef, "name">
): StageDef {
  return { name, ...def };
}

export function pipeline(...stages: StageDef[]): PipelineDef {
  return { stages };
}

export const fashionAttributes = {
  categories: [
    "dresses",
    "tops",
    "bottoms",
    "outerwear",
    "ethnic",
    "activewear",
    "footwear",
    "bags",
    "jewelry",
    "accessories",
    "kids",
    "other",
  ],
  colors: [
    "black",
    "white",
    "ivory",
    "beige",
    "brown",
    "tan",
    "grey",
    "red",
    "pink",
    "purple",
    "blue",
    "navy",
    "green",
    "yellow",
    "orange",
    "multicolor",
  ],
  materials: [
    "cotton",
    "linen",
    "denim",
    "silk",
    "satin",
    "chiffon",
    "knit",
    "polyester",
    "leather",
    "wool",
    "blend",
    "unknown",
  ],
  patterns: ["solid", "floral", "striped", "checked", "embroidered", "graphic", "other"],
  fit: ["slim", "regular", "relaxed", "oversized", "tailored", "unknown"],
  occasions: ["everyday", "office", "party", "wedding guest", "festive", "beach", "gym", "evening"],
  seasons: ["spring", "summer", "fall", "winter", "all-season"],
  formality: ["casual", "smart-casual", "formal", "occasion"],
  modesty: ["modest", "moderate", "revealing"],
  genders: ["women", "men", "unisex", "kids"],
  styles: ["casual", "formal", "bohemian", "minimalist", "streetwear", "romantic", "classic", "sporty"],
} as const;

export function fashionAttributeSchema(): Record<string, unknown> {
  return {
    type: "OBJECT",
    properties: {
      category: { type: "STRING", enum: fashionAttributes.categories },
      silhouette: { type: "STRING" },
      colors: { type: "ARRAY", items: { type: "STRING", enum: fashionAttributes.colors } },
      material: { type: "STRING", enum: fashionAttributes.materials },
      pattern: { type: "STRING", enum: fashionAttributes.patterns },
      fit: { type: "STRING", enum: fashionAttributes.fit },
      sleeve_length: { type: "STRING" },
      neckline: { type: "STRING" },
      length: { type: "STRING" },
      occasions: { type: "ARRAY", items: { type: "STRING", enum: fashionAttributes.occasions } },
      season: { type: "STRING", enum: fashionAttributes.seasons },
      formality: { type: "STRING", enum: fashionAttributes.formality },
      modesty: { type: "STRING", enum: fashionAttributes.modesty },
      gender: { type: "STRING", enum: fashionAttributes.genders },
      style_archetypes: { type: "ARRAY", items: { type: "STRING", enum: fashionAttributes.styles } },
      search_document: { type: "STRING" },
      confidence: { type: "NUMBER" },
      uncertain_fields: { type: "ARRAY", items: { type: "STRING" } },
    },
    required: ["category", "colors", "search_document", "confidence"],
  };
}

export function fashionEnrichmentPreset(opts: {
  model?: string;
  imageField?: string;
  titleField?: string;
  descriptionField?: string;
} = {}): PipelineDef {
  const imageField = opts.imageField ?? "image_url";
  const titleField = opts.titleField ?? "title";
  const descriptionField = opts.descriptionField ?? "description";
  return pipeline(
    stage("fashion_attributes", {
      model: opts.model,
      images: (ctx) => {
        const url = ctx.data[imageField];
        return typeof url === "string" && url ? [url] : [];
      },
      prompt: (ctx) =>
        [
          "Extract structured fashion catalog attributes for visual search.",
          `Title: ${String(ctx.data[titleField] ?? "")}`,
          `Description: ${String(ctx.data[descriptionField] ?? "").slice(0, 1200)}`,
          "Prefer observable image evidence, use allowed enum values, and write a concise shopper-facing search_document.",
        ].join("\n"),
      schema: () => fashionAttributeSchema(),
    })
  );
}

export function fashionSearchPreset(opts: {
  name?: string;
  textModel: string;
  textDim: number;
  imageModel?: string;
  imageDim?: number;
  enableVisual?: boolean;
  enrichmentModel?: string;
  fields?: {
    title?: string;
    brand?: string;
    price?: string;
    variants?: string;
    availability?: string;
    imageUrl?: string;
    category?: string;
    rawTags?: string;
  };
}): CollectionDef & { name: string } {
  const fieldsMap = {
    title: opts.fields?.title ?? "title",
    brand: opts.fields?.brand ?? "brand",
    price: opts.fields?.price ?? "price",
    availability: opts.fields?.availability ?? "available",
    imageUrl: opts.fields?.imageUrl ?? "image_url",
    category: opts.fields?.category ?? "category",
  };
  const spaces: Record<string, SpaceDef> = {
    intent: s.text({
      source: "$enriched.search_document $title",
      model: opts.textModel,
      dim: opts.textDim,
      taskType: "RETRIEVAL_DOCUMENT",
    }),
    price: s.number({ field: "price", mode: "closer", dims: 8, min: 0, max: 100000, scale: "log" }),
  };
  if (opts.enableVisual !== false && opts.imageModel && opts.imageDim) {
    spaces.visual = s.image({
      source: `$${fieldsMap.imageUrl}`,
      model: opts.imageModel,
      dim: opts.imageDim,
      taskType: "RETRIEVAL_DOCUMENT",
    });
  }
  return collection(opts.name ?? "products", {
    fields: {
      title: f.text({ searchable: true, path: fieldsMap.title }),
      brand: f.text({ filterable: true, facet: true, path: fieldsMap.brand }),
      price: f.number({ filterable: true, facet: "range", budget: true, path: fieldsMap.price }),
      available: f.boolean({ filterable: true, facet: true, path: fieldsMap.availability }),
      category: f.text({ filterable: true, facet: true, path: fieldsMap.category }),
      colors: f.array(f.enum(fashionAttributes.colors), { filterable: true, soft: true, path: "enriched.colors" }),
      material: f.enum(fashionAttributes.materials, { filterable: true, soft: true, path: "enriched.material" }),
      fit: f.enum(fashionAttributes.fit, { filterable: true, soft: true, path: "enriched.fit" }),
      styles: f.array(f.enum(fashionAttributes.styles), { filterable: true, soft: true, path: "enriched.style_archetypes" }),
    },
    enrich: fashionEnrichmentPreset({ model: opts.enrichmentModel, imageField: fieldsMap.imageUrl, titleField: fieldsMap.title }),
    embeddings: {
      intent: {
        source: "$enriched.search_document $title",
        model: opts.textModel,
        dim: opts.textDim,
        taskType: "RETRIEVAL_DOCUMENT",
      },
    },
    spaces,
    search: {
      channels: [
        Channels.fts({ fields: ["title"], weight: 1 }),
        Channels.cosine({ embedding: "intent", weight: 1 }),
        Channels.spaces({ weight: 1 }),
      ],
      combiner: "rrf",
      defaultSpaceWeights: {
        intent: 1,
        price: 0.4,
        ...(spaces.visual ? { visual: 1.2 } : {}),
      },
      nlq: {
        semanticRewrite: true,
        schema: fashionAttributeSchema(),
      },
    },
  });
}

export const sources = {
  shopifyFeed(opts: {
    domain: string;
    currency?: string;
    maxPages?: number;
    name?: string;
  }): ConnectorDef {
    return {
      name: opts.name ?? `shopify:${opts.domain}`,
      kind: "shopify",
      options: {
        domain: opts.domain,
        currency: opts.currency ?? "LKR",
        maxPages: opts.maxPages ?? 8,
      },
    };
  },
  wooStoreFeed(opts: {
    domain: string;
    currency?: string;
    maxPages?: number;
    name?: string;
  }): ConnectorDef {
    return {
      name: opts.name ?? `woo:${opts.domain}`,
      kind: "woocommerce",
      options: {
        domain: opts.domain,
        currency: opts.currency ?? "LKR",
        maxPages: opts.maxPages ?? 8,
      },
    };
  },
  jsonl(opts: { path: string; name?: string }): ConnectorDef {
    return {
      name: opts.name ?? `jsonl:${opts.path}`,
      kind: "jsonl",
      options: { path: opts.path },
    };
  },
} as const;
