// This example now consumes the fashion enrichment TEMPLATE from @samesake/core
// (taxonomy, enums, classify/extract schemas, prompts, embed-doc composer, NLQ defaults).
// It keeps the old export names so the rest of the example is unchanged, and appends
// Sri-Lanka-specific NLQ vocabulary on top of the region-neutral core defaults.
import {
  fashionTaxonomy,
  fashionEnums,
  fashionClassifySchema,
  fashionExtractSchema,
  fashionNlqSchema,
  composeFashionEmbedDoc,
  fashionCategoryAttrBlock,
  FASHION_EXTRACT_INSTRUCTIONS,
  FASHION_NLQ_INSTRUCTIONS,
} from "@samesake/core";

export const CATEGORIES = fashionTaxonomy;
export const ENUMS = fashionEnums;
export const stage1Schema = fashionClassifySchema;
export const stage2Schema = fashionExtractSchema;
export const categoryAttrBlock = fashionCategoryAttrBlock;
export const composeEmbedDoc = composeFashionEmbedDoc;
export const nlqSchema = fashionNlqSchema;
export const PARSE_INSTRUCTIONS = FASHION_EXTRACT_INSTRUCTIONS;

// Region-neutral core NLQ defaults + Sri-Lankan cultural vocabulary for this LK catalog.
export const NLQ_INSTRUCTIONS = `${FASHION_NLQ_INSTRUCTIONS}
Prices are in LKR ("rupees"/"rs" = LKR).
Sri Lankan cultural vocabulary (map to filters AND enrich semantic_query with the translation):
- "poya"/"poya day"/"temple wear" -> colors=[white], occasions include festive, modest; semantic_query: "white modest outfit for temple or poya day".
- "kandyan" -> ethnic category; semantic_query mentions "kandyan osariya saree".
- "avurudu"/"new year" -> occasions festive; semantic_query mentions "avurudu festive traditional wear".
- "osariya"=kandyan saree drape; "sarama"/"sarong" -> ethnic, gender men; "salwar"/"shalwar"/"churidar"/"kurti" -> ethnic; "frock" (LK English) = dress; "office wear abaya" -> modest dress.
- Transliterations: "saree"="sari"; "gauma"=dress/frock; "kalisama"=trousers; "kamisaya"=shirt.`;
