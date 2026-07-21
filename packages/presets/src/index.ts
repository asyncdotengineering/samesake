// @samesake/presets — predefined, overridable enrichment + search domain bundles.
// Depends ONLY on @samesake/core (the generic primitives: f, stage, pipeline, Channels,
// collection, and the PipelineDef/IndexingDef/CollectionDedupDef/CollectionFieldDef types).
// Ships no model, provider, dimension, or engine runtime — a preset is declarative content.
//
// fashion was relocated here (breaking) from @samesake/core; it is no longer exported from core.

// Authoring seam + types.
export type { EnrichPreset, FieldSpec, AttrSpec, NlqPreset } from "./types.ts";
export { definePreset } from "./define.ts";

// Shipped presets.
export { fashion } from "./fashion.ts";
export { products } from "./products.ts";

// Relocated fashion domain content (named exports; behavior unchanged).
export {
  fashionTaxonomy,
  fashionEnums,
  fashionEnrichPipeline,
  fashionSearchFields,
  fashionSearchDefaults,
  composeFashionEmbedDoc,
  composeFashionRerankDoc,
  fashionIndexing,
  FASHION_CONFIDENCE_FLOOR,
  fashionClassifySchema,
  fashionExtractSchema,
  fashionCategoryAttrBlock,
  fashionNlqSchema,
  FASHION_EXTRACT_INSTRUCTIONS,
  FASHION_NLQ_INSTRUCTIONS,
  fashionEvalAttributes,
  type FashionEnrichOptions,
} from "./fashion.ts";

// products named exports (for consumers who want the pieces without the bundle).
export {
  productsSearchFields,
  productsEnrichPipeline,
  productsIndexing,
  productsEvalAttributes,
  type ProductsFieldOptions,
  type ProductsEnrichOptions,
  type ProductsIndexOptions,
} from "./products.ts";
