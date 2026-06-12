import "./load-env.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createMatcher } from "../src/createMatcher.ts";
import { createDbFromUrl } from "../src/db/client.ts";
import { stubEmbed, testProductsCollection } from "./fixtures.ts";

const databaseUrl = process.env.DATABASE_URL;
const describeIf = databaseUrl ? describe : describe.skip;

describeIf("facets and pagination", () => {
  const projectSlug = `t_${Math.random().toString(36).slice(2, 10)}`;
  let schemaName = "";
  let matcher: ReturnType<typeof createMatcher>;

  beforeAll(async () => {
    matcher = createMatcher({
      databaseUrl: databaseUrl!,
      apiKey: "test-api-key-12345",
      migrate: "eager",
      embed: async ({ text, dim }) => stubEmbed(text, dim),
      generate: async () => ({ semantic_query: "test" }),
    });
    await matcher.migrate();
    const r = await matcher.apply(projectSlug, {
      entities: [],
      collections: [testProductsCollection],
    });
    schemaName = r.schema;

    const docs = [
      { id: "1", title: "red nike shoes", brand: "nike", price: 120, category: "shoes", colors: ["red"], available: true },
      { id: "2", title: "blue adidas shoes", brand: "adidas", price: 90, category: "shoes", colors: ["blue"], available: true },
      { id: "3", title: "red nike hat", brand: "nike", price: 25, category: "accessories", colors: ["red"], available: false },
      { id: "4", title: "green dress", brand: "zara", price: 80, category: "apparel", colors: ["green"], available: true },
      { id: "5", title: "red scarf", brand: "uniqlo", price: 20, category: "accessories", colors: ["red"], available: true },
    ];

    await matcher.indexDocuments(
      projectSlug,
      "products",
      docs.map((d) => ({
        id: d.id,
        data: { title: d.title },
        doc: d.title,
        embedding: stubEmbed(d.title, 8),
        fields: {
          title: d.title,
          brand: d.brand,
          price: d.price,
          category: d.category,
          colors: d.colors,
          available: d.available,
        },
      }))
    );
  });

  afterAll(async () => {
    if (schemaName) {
      const { db, close } = createDbFromUrl(databaseUrl!);
      await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`));
      await close();
    }
    if (matcher) await matcher.close();
  });

  test("scalar facet counts reflect active filters", async () => {
    const result = await matcher.search(projectSlug, "products", {
      q: "red",
      filters: { brand: "nike" },
      facets: ["category", "available"],
      limit: 10,
    });

    expect(result.facets?.category).toMatchObject({
      values: expect.arrayContaining([
        { value: "shoes", count: 1 },
        { value: "accessories", count: 1 },
      ]),
    });
    expect(result.facets?.available).toMatchObject({
      values: expect.arrayContaining([
        { value: "true", count: 1 },
        { value: "false", count: 1 },
      ]),
    });
  });

  test("array facet unnest counts reflect filters", async () => {
    const all = await matcher.search(projectSlug, "products", {
      q: "shoes",
      facets: ["colors"],
      limit: 10,
    });
    const redOnly = await matcher.search(projectSlug, "products", {
      q: "shoes",
      filters: { colors: ["red"] },
      facets: ["colors"],
      limit: 10,
    });

    const allColors = (all.facets?.colors as { values: { value: string }[] }).values.map(
      (v) => v.value
    );
    const filteredColors = (
      redOnly.facets?.colors as { values: { value: string }[] }
    ).values.map((v) => v.value);

    expect(allColors).toContain("blue");
    expect(filteredColors).toEqual(["red"]);
  });

  test("range facet returns min max buckets", async () => {
    const result = await matcher.search(projectSlug, "products", {
      q: "shoes",
      filters: { brand: "nike" },
      facets: ["price"],
      limit: 10,
    });

    const priceFacet = result.facets?.price as {
      min: number;
      max: number;
      buckets: Array<{ lo: number; hi: number; count: number }>;
    };
    expect(priceFacet.min).toBe(25);
    expect(priceFacet.max).toBe(120);
    expect(priceFacet.buckets.length).toBe(6);
    expect(priceFacet.buckets.reduce((s, b) => s + b.count, 0)).toBe(2);
  });

  test("offset pagination and total_candidates", async () => {
    const page0 = await matcher.search(projectSlug, "products", {
      q: "red",
      limit: 2,
      offset: 0,
    });
    const page1 = await matcher.search(projectSlug, "products", {
      q: "red",
      limit: 2,
      offset: 2,
    });

    expect(page0.total_candidates).toBeGreaterThanOrEqual(3);
    expect(page0.hits.length).toBe(2);
    expect(page1.hits.length).toBeGreaterThan(0);
    expect(page0.hits[0]!.id).not.toBe(page1.hits[0]!.id);
  });
});
