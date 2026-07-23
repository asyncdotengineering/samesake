// The domain-neutral commerce starter preset. The on-ramp: a consumer whose catalog is generic
// commerce adopts a working enrich + index pipeline in one line and graduates to a vertical
// (fashion) or a `definePreset` bundle when retrieval quality demands domain-specific attributes.
//
// Minimal by design — a universal schema (title, description, price, brand, category, image),
// one extract stage, a confidence gate. Ships no dedup and no nlq. Model/dim are never mandated:
// `indexing` surfaces reference an embedding KEY ("doc"), and the consumer's `embeddings` block
// (declared on the collection) supplies the actual provider/model/dim.
import { z } from "zod";
import type { IndexingDef, PipelineDef, StageDef } from "@samesake/core";
import type { AttrSpec, EnrichPreset, FieldSpec } from "./types.ts";

export interface ProductsFieldOptions {
  brandPath?: string;
  categoryPath?: string;
  imageKey?: string;
}
export interface ProductsEnrichOptions {
  titleKey?: string;
  descriptionKey?: string;
  imageKey?: string;
  extractModel?: string;
}
export interface ProductsIndexOptions {
  titleKey?: string;
}

const PRODUCTS_CONFIDENCE_FLOOR = 0.4;

function strOf(v: unknown): string {
  return v == null ? "" : Array.isArray(v) ? v.slice(0, 12).map(String).join(", ") : String(v);
}

export function productsSearchFields(opts: ProductsFieldOptions = {}): FieldSpec {
  return {
    title: { type: "text", searchable: true, path: "title" },
    description: { type: "text", path: "description" },
    brand: { type: "text", filterable: true, facet: true, path: opts.brandPath ?? "brand" },
    price: { type: "number", filterable: true, budget: true },
    category: { type: "text", filterable: true, facet: true, path: opts.categoryPath ?? "enriched.category" },
    image_url: { type: "text", path: opts.imageKey ?? "image_url" },
  };
}

function productsExtractSchema(): z.ZodType {
  return z.object({
    category: z
      .string()
      .describe("a short, generic category label a shopper filters by (e.g. 'electronics', 'apparel', 'home', 'beauty')"),
    search_document: z
      .string()
      .describe("rule[search_document]: 2-3 shopper-facing sentences — what it is and why someone would want it. No marketing fluff."),
    confidence: z
      .number()
      .describe("0.9+ = clear title/photo, attributes obvious; 0.5-0.7 = partial/ambiguous; <0.4 = mostly inferred"),
  });
}

const PRODUCTS_EXTRACT_INSTRUCTIONS = `<role>
You are cataloging ONE product for a commerce search engine.
Read the title, description, and image (when present) and extract a short category plus a shopper-facing search document.
</role>

<rules>
- rule[category_generic]: a concise, generic label shoppers filter by — not a brand, not a model number.
- rule[search_document]: 2-3 plain sentences — what it is and its key attributes. No marketing fluff.
- rule[unknown_over_guess]: if a fact is not visible or stated, leave it out rather than guess.
- confidence: 0.9+ = clear; 0.5-0.7 = partial; <0.4 = mostly inferred.
</rules>`;

export function productsEnrichPipeline(opts: ProductsEnrichOptions = {}): PipelineDef {
  const titleKey = opts.titleKey ?? "title";
  const descKey = opts.descriptionKey ?? "description";
  const imageKey = opts.imageKey ?? "image_url";
  const extractModel = opts.extractModel ?? "extract";

  const images = (ctx: { data: Record<string, unknown> }) => {
    const u = ctx.data[imageKey];
    return u ? [String(u)] : [];
  };

  const extract: StageDef = {
    name: "extract",
    model: extractModel,
    images,
    prompt: (ctx) =>
      `${PRODUCTS_EXTRACT_INSTRUCTIONS}

Title: ${strOf(ctx.data[titleKey])}
Description: ${strOf(ctx.data[descKey]).slice(0, 800) || "n/a"}${ctx.data[imageKey] ? "" : "\n(NO IMAGE AVAILABLE - extract from text only)"}`,
    schema: () => productsExtractSchema(),
  };

  return { stages: [extract] };
}

export function productsIndexing(opts: ProductsIndexOptions = {}): IndexingDef {
  const titleKey = opts.titleKey ?? "title";
  return {
    surfaces: {
      embed_doc: {
        kind: "dense",
        embedding: "doc",
        build: ({ data, enriched }) =>
          [data[titleKey], enriched.search_document, enriched.category].filter(Boolean).map(String).join(" "),
      },
      fts_doc: {
        kind: "fts",
        build: ({ data, enriched }) =>
          [data[titleKey], enriched.category, data.brand].filter(Boolean).map(String).join(" "),
      },
    },
    gate: ({ enriched }) => {
      if (Number(enriched.confidence ?? 1) < PRODUCTS_CONFIDENCE_FLOOR) {
        return { index: false, reason: "low-confidence" };
      }
      return { index: true };
    },
  };
}

export function productsEvalAttributes(): AttrSpec[] {
  return [{ name: "category", kind: "single" }];
}

/** The neutral commerce starter preset — `import { products } from "@samesake/presets"`. */
export const products: EnrichPreset = {
  name: "products",
  fields: productsSearchFields,
  enrich: productsEnrichPipeline,
  indexing: productsIndexing,
  evalAttributes: productsEvalAttributes,
};
