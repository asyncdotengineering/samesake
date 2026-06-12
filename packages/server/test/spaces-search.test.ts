import "./load-env.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { collection, f, Channels, s } from "../../sdk/src/index.ts";
import { createMatcher } from "../src/createMatcher.ts";
import { createDbFromUrl } from "../src/db/client.ts";
import { stubEmbed } from "./fixtures.ts";

const databaseUrl = process.env.DATABASE_URL;
const describeIf = databaseUrl ? describe : describe.skip;

const spacesProductsCollection = collection("products", {
  fields: {
    title: f.text({ searchable: true }),
    brand: f.text({ filterable: true }),
    price: f.number({ filterable: true }),
    category: f.text({ filterable: true }),
  },
  embeddings: {
    doc: { source: "$title", model: "test-embed", dim: 8, taskType: "RETRIEVAL_QUERY" },
  },
  spaces: {
    style: s.text({ source: "$title", model: "test-embed", dim: 8 }),
    price: s.number({ field: "price", mode: "closer", dims: 8, min: 0, max: 200, scale: "linear" }),
    freshness: s.recency({ field: "ingested_at", halfLifeDays: 30, dims: 8 }),
    category: s.categorical({
      field: "category",
      values: ["shoes", "accessories", "apparel"],
      dims: 8,
    }),
  },
  search: {
    channels: [
      Channels.fts({ fields: ["title"], weight: 0 }),
      Channels.cosine({ embedding: "doc", weight: 0 }),
      Channels.spaces({ weight: 1 }),
    ],
    combiner: "rrf",
    defaultSpaceWeights: { style: 1, price: 1, freshness: 1, category: 1 },
  },
});

describeIf("spaces search integration", () => {
  const projectSlug = `t_${Math.random().toString(36).slice(2, 10)}`;
  let schemaName = "";
  let matcher: ReturnType<typeof createMatcher>;

  beforeAll(async () => {
    matcher = createMatcher({
      databaseUrl: databaseUrl!,
      apiKey: "test-api-key-12345",
      migrate: "eager",
      embed: async ({ text, dim }) => stubEmbed(text, dim),
    });
    await matcher.migrate();
    const r = await matcher.apply(projectSlug, {
      entities: [],
      collections: [spacesProductsCollection],
    });
    schemaName = r.schema;

    const now = Date.now();
    const docs = [
      { id: "1", title: "red running shoes", brand: "nike", price: 120, category: "shoes", ageDays: 1, vecText: "red running shoes" },
      { id: "2", title: "blue casual sneakers", brand: "adidas", price: 90, category: "shoes", ageDays: 5, vecText: "blue casual sneakers" },
      { id: "3", title: "leather wallet", brand: "nike", price: 45, category: "accessories", ageDays: 2, vecText: "red running shoes" },
      { id: "4", title: "sport socks", brand: "puma", price: 15, category: "accessories", ageDays: 60, vecText: "blue casual sneakers" },
      { id: "5", title: "red hat", brand: "nike", price: 25, category: "accessories", ageDays: 3, vecText: "red hat" },
      { id: "6", title: "green dress", brand: "zara", price: 80, category: "apparel", ageDays: 1, vecText: "green dress" },
      { id: "7", title: "running shorts", brand: "nike", price: 55, category: "apparel", ageDays: 10, vecText: "red running shoes" },
      { id: "8", title: "training tee", brand: "nike", price: 35, category: "apparel", ageDays: 4, vecText: "red running shoes" },
      { id: "9", title: "hiking boots", brand: "timberland", price: 200, category: "shoes", ageDays: 90, vecText: "hiking boots" },
      { id: "10", title: "sandals", brand: "birken", price: 70, category: "shoes", ageDays: 7, vecText: "sandals" },
      { id: "11", title: "red scarf", brand: "uniqlo", price: 20, category: "accessories", ageDays: 2, vecText: "red scarf" },
      { id: "12", title: "gym bag", brand: "nike", price: 60, category: "accessories", ageDays: 45, vecText: "gym bag" },
    ];

    await matcher.pushDocuments(
      projectSlug,
      "products",
      docs.map((d) => ({
        id: d.id,
        data: {
          title: d.title,
          brand: d.brand,
          price: d.price,
          category: d.category,
        },
      }))
    );

    const { db, close } = createDbFromUrl(databaseUrl!);
    for (const d of docs) {
      const ingestedAt = new Date(now - d.ageDays * 86_400_000).toISOString();
      await db.execute(sql.raw(`
        UPDATE ${schemaName}.c_products
        SET ingested_at = '${ingestedAt}'::timestamptz
        WHERE id = '${d.id}'
      `));
    }
    await close();

    await matcher.index(projectSlug, "products");
  }, 60_000);

  afterAll(async () => {
    if (schemaName) {
      const { db, close } = createDbFromUrl(databaseUrl!);
      await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`));
      await close();
    }
    if (matcher) await matcher.close();
  });

  test("spaces leg returns ranked hits", async () => {
    const result = await matcher.search(projectSlug, "products", {
      q: "red running shoes",
      limit: 5,
      weights: { fts: 0, cosine: 0, spaces: 1 },
    });
    expect(result.hits.length).toBeGreaterThan(0);
    expect(["1", "3", "7", "8"]).toContain(result.hits[0]!.id);
  });

  test("freshness weight flip reorders results", async () => {
    const lowFresh = await matcher.search(projectSlug, "products", {
      q: "shoes",
      filters: { category: "shoes" },
      limit: 12,
      weights: { fts: 0, cosine: 0, spaces: { freshness: 0, style: 1, price: 1, category: 1 } },
    });
    const highFresh = await matcher.search(projectSlug, "products", {
      q: "shoes",
      filters: { category: "shoes" },
      limit: 12,
      weights: { fts: 0, cosine: 0, spaces: { freshness: 5, style: 0.1, price: 0.1, category: 0.1 } },
    });
    const lowIds = lowFresh.hits.map((h) => h.id);
    const highIds = highFresh.hits.map((h) => h.id);
    expect(lowIds).not.toEqual(highIds);
    const staleBootsLow = lowIds.indexOf("9");
    const staleBootsHigh = highIds.indexOf("9");
    const freshShoesLow = lowIds.indexOf("1");
    const freshShoesHigh = highIds.indexOf("1");
    expect(staleBootsLow).toBeGreaterThanOrEqual(0);
    expect(staleBootsHigh).toBeGreaterThanOrEqual(0);
    expect(freshShoesLow).toBeGreaterThanOrEqual(0);
    expect(freshShoesHigh).toBeGreaterThanOrEqual(0);
    expect(staleBootsHigh).toBeGreaterThan(staleBootsLow);
    expect(freshShoesHigh).toBeLessThan(freshShoesLow);
  });

  test("filters push into spaces leg", async () => {
    const filtered = await matcher.search(projectSlug, "products", {
      q: "running",
      filters: { category: "apparel" },
      limit: 10,
      weights: { fts: 0, cosine: 0, spaces: 1 },
    });
    expect(filtered.hits.length).toBeGreaterThan(0);
    for (const h of filtered.hits) {
      expect(h.category).toBe("apparel");
    }
  });
});

describeIf("legacy collection without spaces", () => {
  const projectSlug = `t_${Math.random().toString(36).slice(2, 10)}`;
  let schemaName = "";
  let matcher: ReturnType<typeof createMatcher>;

  const legacyCollection = collection("legacy", {
    fields: { title: f.text({ searchable: true }) },
    embeddings: {
      doc: { source: "$title", model: "test-embed", dim: 8 },
    },
    search: {
      channels: [
        Channels.fts({ fields: ["title"], weight: 1 }),
        Channels.cosine({ embedding: "doc", weight: 1 }),
      ],
    },
  });

  beforeAll(async () => {
    matcher = createMatcher({
      databaseUrl: databaseUrl!,
      apiKey: "test-api-key-12345",
      migrate: "eager",
      embed: async ({ text, dim }) => stubEmbed(text, dim),
    });
    await matcher.migrate();
    const r = await matcher.apply(projectSlug, {
      entities: [],
      collections: [legacyCollection],
    });
    schemaName = r.schema;

    await matcher.indexDocuments(projectSlug, "legacy", [
      {
        id: "a",
        data: { title: "hello" },
        doc: "hello",
        embedding: stubEmbed("hello", 8),
        fields: { title: "hello" },
      },
    ]);
  });

  afterAll(async () => {
    if (schemaName) {
      const { db, close } = createDbFromUrl(databaseUrl!);
      await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`));
      await close();
    }
    if (matcher) await matcher.close();
  });

  test("no space_vec column on legacy tables", async () => {
    const { db, close } = createDbFromUrl(databaseUrl!);
    const rows = await db.execute<{ column_name: string }>(sql.raw(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = '${schemaName}' AND table_name = 'c_legacy'
    `));
    await close();
    const cols = rows.map((r) => r.column_name);
    expect(cols).not.toContain("space_vec");
    expect(cols).toContain("embedding");
  });
});
