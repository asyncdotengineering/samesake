import { collection, f, Channels, pipeline, stage } from "@samesake/core";
import { fashion } from "@samesake/presets";
import { createMatcher } from "@samesake/server";
import {
  CATEGORIES,
  ENUMS,
  NLQ_INSTRUCTIONS,
  PARSE_INSTRUCTIONS,
  nlqSchema,
  stage1Schema,
  stage2Schema,
} from "./fashion.ts";
import { NLQ_MODEL, STAGE1_MODEL, STAGE2_MODEL, geminiEmbed, geminiGenerate } from "./gemini.ts";

export const PROJECT = "fashionparity";
export const COLLECTION = "products";

function fashionFacetEvidence({ enriched }: { enriched: Record<string, unknown> }): string[] {
  const claims: string[] = [];
  const values = (key: string): string[] => {
    const value = enriched[key];
    return Array.isArray(value) ? value.map(String).filter((item) => item && item !== "unknown") : [];
  };
  for (const color of values("colors")) claims.push(`color ${color}`);
  for (const occasion of values("occasions")) claims.push(`good for ${occasion}`);
  for (const style of values("styles")) claims.push(`${style} style`);
  const pattern = String(enriched.pattern ?? "");
  if (pattern && pattern !== "unknown") claims.push(`${pattern} pattern`);
  const material = String(enriched.material ?? "");
  if (material && material !== "unknown") claims.push(`made from ${material}`);
  const fit = String(enriched.fit ?? "");
  if (fit && fit !== "unknown") claims.push(`${fit} fit`);
  return claims;
}

export const productsCollection = collection("products", {
  fields: {
    title: f.text({ searchable: true, path: "title" }),
    brand: f.text({ filterable: true, path: "vendor" }),
    store_domain: f.text({ filterable: true }),
    price: f.number({ filterable: true, budget: true }),
    available: f.boolean({ filterable: true }),
    category: f.enum(CATEGORIES.map((c) => c.id), {
      filterable: true,
      path: "enriched.category",
    }),
    product_type: f.text({ filterable: true, path: "enriched.product_type" }),
    gender: f.enum(ENUMS.gender, {
      filterable: true,
      alsoMatch: ["unisex"],
      path: "enriched.gender",
    }),
    colors: f.array(f.enum(ENUMS.colors), {
      filterable: true,
      soft: true,
      path: "enriched.colors",
    }),
    occasions: f.array(f.enum(ENUMS.occasions), {
      filterable: true,
      soft: true,
      path: "enriched.occasions",
    }),
    styles: f.array(f.enum(ENUMS.styles), {
      filterable: true,
      path: "enriched.styles",
    }),
    pattern: f.enum(ENUMS.pattern, {
      filterable: true,
      path: "enriched.pattern",
    }),
    material: f.enum(ENUMS.materials, {
      filterable: true,
      path: "enriched.material",
    }),
    fit: f.enum(ENUMS.fit, {
      filterable: true,
      path: "enriched.fit",
    }),
  },
  enrich: pipeline(
    stage("classify", {
      model: STAGE1_MODEL,
      images: (ctx) => (ctx.data.image_url ? [String(ctx.data.image_url)] : []),
      prompt: (ctx) => {
        const tags = Array.isArray(ctx.data.raw_tags)
          ? (ctx.data.raw_tags as string[]).slice(0, 12).join(", ")
          : "n/a";
        return `Classify this fashion e-commerce product.\nTitle: ${ctx.data.title}\nStore type/categories: ${ctx.data.raw_type ?? "n/a"}\nTags: ${tags || "n/a"}`;
      },
      schema: () => stage1Schema(),
    }),
    stage("extract", {
      model: STAGE2_MODEL,
      condition: (ctx) =>
        ctx.enriched.is_apparel_product === true && ctx.enriched.category !== "other",
      images: (ctx) => (ctx.data.image_url ? [String(ctx.data.image_url)] : []),
      prompt: (ctx) => {
        const tags = Array.isArray(ctx.data.raw_tags)
          ? (ctx.data.raw_tags as string[]).slice(0, 12).join(", ")
          : "n/a";
        const hasImage = !!ctx.data.image_url;
        return `${PARSE_INSTRUCTIONS}\n\nProduct (category: ${ctx.enriched.category}, type: ${ctx.enriched.product_type}):\nTitle: ${ctx.data.title}\nStore type/categories: ${ctx.data.raw_type ?? "n/a"}\nTags: ${tags}\nDescription: ${String(ctx.data.description ?? "").slice(0, 800) || "n/a"}${hasImage ? "" : "\n(NO IMAGE AVAILABLE - extract from text only, mark uncertain fields)"}`;
      },
      schema: (ctx) => stage2Schema(String(ctx.enriched.category ?? "other")),
    })
  ),
  indexing: fashion.indexing(),
  embeddings: {
    doc: {
      model: "gemini-embedding-2",
      dim: 1536,
      taskType: "RETRIEVAL_DOCUMENT",
    },
    visual: {
      kind: "image",
      source: "$image_url",
      model: "gemini-embedding-2",
      dim: 768,
      taskType: "RETRIEVAL_DOCUMENT",
      describe: "visual appearance and silhouette",
    },
    facets: {
      evidence: true,
      extract: fashionFacetEvidence,
      model: "gemini-embedding-2",
      dim: 1536,
      taskType: "RETRIEVAL_DOCUMENT",
      describe: "short claims about colors, occasions, styles, pattern, material, and fit",
    },
  },
  search: {
    channels: [
      Channels.fts({ fields: ["title"], weight: 1 }),
      Channels.cosine({ embedding: "doc", weight: 1 }),
      // ASPECTS=0 zero-weights the aspect legs (gated out of the SQL entirely) for the
      // C9 same-code same-corpus baseline run; default ON is the gate candidate.
      // Aspects are secondary signals (same philosophy as the intent-mode keyword tiebreaker):
      // C9 cal-1 showed full-weight aspect legs dilute the doc+fts core via RRF fusion.
      Channels.cosine({ embedding: "visual", weight: process.env.ASPECTS === "0" ? 0 : 0.5 }),
      Channels.cosine({ embedding: "facets", weight: process.env.ASPECTS === "0" ? 0 : 0.3 }),
      Channels.recency({ field: "updated_at", halfLifeDays: 90, weight: 0 }),
    ],
    combiner: "rrf",
    // Contextual constraints relax before identity-bearing ones: "red dress for a wedding"
    // degrades to red dresses (occasion dropped), never to black wedding dresses.
    relaxOrder: ["occasions", "styles"],
    // Absolute cosine floor (FTS matches exempt) — calibrated ≈0.5 for gemini-embedding-2;
    // suppresses no-match padding (queries with no real match return few/no results).
    relevanceFloor: 0.5,
    nlq: {
      instructions: NLQ_INSTRUCTIONS,
      semanticRewrite: true,
      schema: nlqSchema(),
      model: NLQ_MODEL,
    },
  },
});

export function createFashionMatcher() {
  const databaseUrl = process.env.SAMESAKE_DATABASE_URL;
  const apiKey = process.env.SAMESAKE_API_KEY ?? process.env.GEMINI_API_KEY;
  if (!databaseUrl) throw new Error("SAMESAKE_DATABASE_URL missing");
  if (!apiKey) throw new Error("SAMESAKE_API_KEY or GEMINI_API_KEY missing");

  return createMatcher({
    databaseUrl,
    apiKey,
    migrate: "eager",
    embed: geminiEmbed,
    generate: geminiGenerate,
  });
}

export async function ensureProject(matcher: ReturnType<typeof createFashionMatcher>) {
  await matcher.migrate();
  return matcher.apply(PROJECT, {
    entities: [],
    collections: [productsCollection],
  });
}
