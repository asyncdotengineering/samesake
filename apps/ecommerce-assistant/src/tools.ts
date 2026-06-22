import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import postgres from "postgres";
import { getMatcher, PROJECT, PRODUCTS, BRANDS, PRODUCTS_TABLE } from "./samesake.ts";

let _sql: ReturnType<typeof postgres> | null = null;
function sql() {
  if (!_sql) _sql = postgres(process.env.DATABASE_URL!, { ssl: "require" });
  return _sql;
}

// The Query Agent decides on its own whether to run a semantic search, a filtered search,
// or an aggregation, and against which collection. We give a Mastra agent the same reach by
// exposing those capabilities as three tools over the samesake matcher.

const PRODUCT_CATEGORIES = ["Tops", "Bottoms", "Outerwear", "Footwear", "Accessories", "Dresses & Jumpsuits"] as const;

type ProductHit = {
  id: string;
  name: unknown;
  brand: unknown;
  category: unknown;
  subcategory: unknown;
  price: unknown;
  description: unknown;
};

function toProduct(h: { id: string; data: Record<string, unknown> }): ProductHit {
  return {
    id: h.id,
    name: h.data.name,
    brand: h.data.brand,
    category: h.data.category,
    subcategory: h.data.subcategory,
    price: h.data.price,
    description: h.data.description,
  };
}

export const searchProducts = createTool({
  id: "search_products",
  description:
    "Semantic + keyword search over the e-commerce clothing catalog. Use for finding items by " +
    "style, vibe, occasion, brand, or category. Prices are in USD; pass max_price to cap the budget " +
    "(it becomes a hard filter). Returns matching products with name, brand, category and price.",
  inputSchema: z.object({
    query: z.string().describe("natural-language description of what the shopper wants, e.g. 'vintage clothes'"),
    max_price: z.number().optional().describe("maximum price in USD (hard filter)"),
    category: z.enum(PRODUCT_CATEGORIES).optional().describe("restrict to one top-level category"),
    limit: z.number().int().min(1).max(50).default(8),
  }),
  execute: async ({ query, max_price, category, limit }) => {
    const filters: Record<string, { $lte: number } | string> = {};
    if (typeof max_price === "number") filters.price = { $lte: max_price };
    if (category) filters.category = category;
    const result = await getMatcher().search(PROJECT, PRODUCTS, { q: query, filters, limit });
    return { count: result.hits.length, products: result.hits.map(toProduct) };
  },
});

export const searchBrands = createTool({
  id: "search_brands",
  description:
    "Look up clothing brands and their details: parent brand, child brands, country of operation, " +
    "average customer rating, and founding year. Use to answer questions about a brand's hierarchy or origin.",
  inputSchema: z.object({
    query: z.string().describe("brand name or a description to search for, e.g. 'Loom & Aura'"),
    limit: z.number().int().min(1).max(20).default(5),
  }),
  execute: async ({ query, limit }) => {
    const result = await getMatcher().search(PROJECT, BRANDS, { q: query, limit });
    return {
      count: result.hits.length,
      brands: result.hits.map((h) => ({
        name: h.data.name,
        parent_brand: h.data.parent_brand,
        child_brands: h.data.child_brands,
        country: h.data.country,
        avg_customer_rating: h.data.avg_customer_rating,
        foundation_year: h.data.foundation_year,
        description: h.data.description,
      })),
    };
  },
});

export const countProductsByBrand = createTool({
  id: "count_products_by_brand",
  description:
    "Count how many catalog items each brand lists, ranked highest first — a GROUP BY brand + COUNT. " +
    "Use for 'which brand lists the most X'. Pass `category` to restrict to one category (e.g. shoes -> Footwear); " +
    "omit it to count across the whole catalog.",
  inputSchema: z.object({
    category: z.enum(PRODUCT_CATEGORIES).optional().describe("e.g. 'shoes' -> Footwear; omit for all categories"),
  }),
  execute: async ({ category }) => {
    const db = sql();
    const rows = await db<{ brand: string; count: number }[]>`
      SELECT brand, count(*)::int AS count
      FROM ${db.unsafe(PRODUCTS_TABLE)}
      WHERE ${category ? db`category = ${category}` : db`true`}
      GROUP BY brand
      ORDER BY count DESC, brand ASC`;
    const by_brand = rows.map((r) => ({ value: r.brand, count: r.count }));
    return { category: category ?? null, by_brand, top: by_brand[0] ?? null };
  },
});

export const averagePrice = createTool({
  id: "average_price",
  description:
    "Return the average price (USD) and item count for a brand's items across the whole catalog. " +
    "Use for 'what is the average price of an item from brand X'.",
  inputSchema: z.object({
    brand: z.string().describe("the brand to average over, e.g. 'Loom & Aura'"),
  }),
  execute: async ({ brand }) => {
    const db = sql();
    const [agg] = await db<{ n: number; avg: number | null }[]>`
      SELECT count(*)::int AS n, avg(price)::float AS avg
      FROM ${db.unsafe(PRODUCTS_TABLE)}
      WHERE brand = ${brand}`;
    return {
      brand,
      item_count: agg?.n ?? 0,
      average_price_usd: agg?.avg == null ? null : Math.round(agg.avg * 100) / 100,
    };
  },
});

export const tools = { searchProducts, searchBrands, countProductsByBrand, averagePrice };
