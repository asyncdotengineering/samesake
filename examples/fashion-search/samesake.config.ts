import { collection, f, Channels, pipeline, stage, s } from "@samesake/core";
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

// Visual commerce is the point: spaces + the image space are ON by default. This is now
// intent-safe because search mode="intent" (the default for text queries) does not weight the
// spaces/visual leg — so the intent parity gate is unaffected — while mode="similar" and image
// queries get genuine visual + semantic similarity. Opt out with SPACES=0 / SPACES_VISUAL=0.
const spacesEnabled = process.env.SPACES !== "0";
const visualSpaceEnabled = process.env.SPACES_VISUAL !== "0";

const fashionSpaces = {
  // No `style` text-space here: it would duplicate Channels.cosine({embedding:"doc"}) (same
  // $enriched.embed_doc source/model/dim) and push the segmented vector past pgvector's 2000-d
  // HNSW limit. The cosine channel carries text semantics; the spaces leg carries the
  // *complementary* signals — visual look, price, category, freshness.
  price: s.number({
    field: "price",
    mode: "closer" as const,
    dims: 8,
    min: 0,
    max: 50000,
    scale: "log" as const,
  }),
  freshness: s.recency({ field: "ingested_at", halfLifeDays: 60, dims: 8 }),
  category: s.categorical({
    field: "category",
    values: CATEGORIES.map((c) => c.id),
    dims: 32,
  }),
  ...(visualSpaceEnabled
    ? {
        visual: s.image({
          source: "$image_url",
          model: "gemini-embedding-2",
          dim: 768,
          taskType: "RETRIEVAL_DOCUMENT",
        }),
      }
    : {}),
};

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
  embeddings: {
    doc: {
      source: "$enriched.embed_doc",
      model: "gemini-embedding-2",
      dim: 1536,
      taskType: "RETRIEVAL_DOCUMENT",
    },
  },
  ...(spacesEnabled ? { spaces: fashionSpaces } : {}),
  search: {
    channels: [
      Channels.fts({ fields: ["title"], weight: 1 }),
      Channels.cosine({ embedding: "doc", weight: 1 }),
      Channels.recency({ field: "updated_at", halfLifeDays: 90, weight: 0 }),
      ...(spacesEnabled ? [Channels.spaces({ weight: 1 })] : []),
    ],
    combiner: "rrf",
    ...(spacesEnabled
      ? {
          defaultSpaceWeights: {
            freshness: 0.3,
            price: 0.5,
            category: 0.8,
            // Visual leads the spaces leg so an image / similar-look query ranks by genuine
            // look. (For text "intent" queries the spaces leg is off; for text "similar" the
            // image segment is zeroed since there is no query image.)
            ...(visualSpaceEnabled ? { visual: 2 } : {}),
          },
        }
      : {}),
    nlq: {
      instructions: NLQ_INSTRUCTIONS,
      semanticRewrite: true,
      schema: nlqSchema(),
      model: NLQ_MODEL,
    },
  },
});

export function createFashionMatcher() {
  const databaseUrl = process.env.DATABASE_URL;
  const apiKey = process.env.API_KEY ?? process.env.GEMINI_API_KEY;
  if (!databaseUrl) throw new Error("DATABASE_URL missing");
  if (!apiKey) throw new Error("API_KEY or GEMINI_API_KEY missing");

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
