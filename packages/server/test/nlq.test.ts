import "./load-env.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createMatcher } from "../src/createMatcher.ts";
import { createDbFromUrl } from "../src/db/client.ts";
import { collection, f, Channels } from "@samesake/core";
import {
  deriveNlqSchema,
  mergeFilters,
  nlqParsedToFilters,
  parseNlq,
  shouldSkipNlq,
  tokenCount,
} from "../src/core/nlq.ts";
import { buildFilterSql } from "../src/core/search.ts";
import type { MatcherCtx } from "../src/types.ts";
import { nlqSchemaFixtureCollection, stubEmbed, testProductsCollection } from "./fixtures.ts";

const databaseUrl = process.env.DATABASE_URL;
const describeIf = databaseUrl ? describe : describe.skip;

describe("deriveNlqSchema", () => {
  test("auto-derives enum, number, array, boolean filterables", () => {
    const schema = deriveNlqSchema(nlqSchemaFixtureCollection) as {
      properties: Record<string, Record<string, unknown>>;
      required: string[];
    };

    expect(schema.required).toEqual(["semantic_query"]);
    expect(schema.properties.semantic_query).toMatchObject({ type: "STRING" });
    expect(schema.properties.exclude_terms).toMatchObject({ type: "ARRAY" });

    expect(schema.properties.status).toMatchObject({
      type: "STRING",
      enum: ["active", "draft", "any"],
    });
    expect(schema.properties.exclude_status).toMatchObject({
      type: "ARRAY",
      items: { type: "STRING", enum: ["active", "draft"] },
    });

    expect(schema.properties.max_price).toMatchObject({ type: "NUMBER" });
    expect(schema.properties.min_price).toMatchObject({ type: "NUMBER" });

    expect(schema.properties.colors).toMatchObject({
      type: "ARRAY",
      items: { type: "STRING", enum: ["red", "blue"] },
    });
    expect(schema.properties.exclude_colors).toBeDefined();

    expect(schema.properties.in_stock).toMatchObject({ type: "BOOLEAN" });

    expect(schema.properties.title).toBeUndefined();
    expect(schema.properties.brand).toMatchObject({ type: "STRING" });
    expect(schema.properties.exclude_brand).toBeDefined();
  });
});

describe("nlqParsedToFilters", () => {
  test("maps NLQ output to filter compiler input", () => {
    const { filters, excludeTerms } = nlqParsedToFilters(
      {
        semantic_query: "running shoes",
        max_price: 100,
        min_price: 20,
        status: "active",
        colors: ["red"],
        exclude_colors: ["blue"],
        exclude_terms: ["bodycon"],
        in_stock: true,
      },
      nlqSchemaFixtureCollection
    );

    expect(excludeTerms).toEqual(["bodycon"]);
    expect(filters.price).toEqual({ $lte: 100, $gte: 20 });
    expect(filters.status).toBe("active");
    expect(filters.colors).toEqual({ $contains: ["red"], $exclude: ["blue"] });
    expect(filters.in_stock).toBe(true);

    const compiled = buildFilterSql(
      filters,
      nlqSchemaFixtureCollection,
      { soft: true, excludeTerms },
      1
    );
    expect(compiled.where).toContain("price <=");
    expect(compiled.where).toContain("status =");
    expect(compiled.where).toContain("colors &&");
    expect(compiled.where).toContain("NOT (colors &&");
    expect(compiled.where).toContain("!~*");
    expect(compiled.params).toContain("bodycon");
  });

  test("mergeFilters lets explicit filters override NLQ", () => {
    const merged = mergeFilters(
      { brand: "nike", price: { $lte: 100 } },
      { brand: "adidas" }
    );
    expect(merged.brand).toBe("adidas");
    expect(merged.price).toEqual({ $lte: 100 });
  });
});

describe("shouldSkipNlq", () => {
  test("skips short keyword queries without digits", () => {
    expect(shouldSkipNlq(testProductsCollection, "red shoes")).toBe(true);
    expect(tokenCount("red shoes")).toBe(2);
  });

  test("runs NLQ for longer or numeric queries", () => {
    expect(shouldSkipNlq(testProductsCollection, "red running shoes")).toBe(false);
    expect(shouldSkipNlq(testProductsCollection, "under 5000")).toBe(false);
  });

  test("skips when nlq config missing", () => {
    const noNlq = { ...testProductsCollection, search: { channels: [] } };
    expect(shouldSkipNlq(noNlq, "red running shoes under 5000")).toBe(true);
  });
});

describe("parseNlq", () => {
  const baseCtx = {
    generateConfigured: true,
    generate: async () => ({}),
  } as unknown as MatcherCtx;

  test("degrades when generate throws", async () => {
    const ctx = {
      ...baseCtx,
      generate: async () => {
        throw new Error("boom");
      },
    } as unknown as MatcherCtx;

    const result = await parseNlq(ctx, testProductsCollection, "red nike shoes under 100");
    expect(result.degraded).toBe(true);
    expect(result.parsed.semantic_query).toBe("red nike shoes under 100");
    expect(result.filters).toEqual({});
  });

  test(
    "degrades on slow generate (>5s)",
    async () => {
      const ctx = {
        ...baseCtx,
        generate: async () => {
          await new Promise((r) => setTimeout(r, 6000));
          return { semantic_query: "slow" };
        },
      } as unknown as MatcherCtx;

      const t0 = Date.now();
      const result = await parseNlq(ctx, testProductsCollection, "red nike shoes under 100");
      expect(Date.now() - t0).toBeLessThan(5500);
      expect(result.degraded).toBe(true);
    },
    7000
  );

  test("keyword fast-path skips generate", async () => {
    let calls = 0;
    const ctx = {
      generateConfigured: true,
      generate: async () => {
        calls++;
        return { semantic_query: "x" };
      },
    } as unknown as MatcherCtx;

    await parseNlq(ctx, testProductsCollection, "red shoes");
    expect(calls).toBe(0);
  });

  test("applies stub generate filters", async () => {
    const ctx = {
      generateConfigured: true,
      generate: async () => ({
        semantic_query: "running shoes",
        max_price: 120,
        brand: "nike",
      }),
    } as unknown as MatcherCtx;

    const result = await parseNlq(
      ctx,
      testProductsCollection,
      "nike running shoes under 120"
    );
    expect(result.degraded).toBe(false);
    expect(result.filters.price).toEqual({ $lte: 120 });
    expect(result.filters.brand).toBe("nike");
  });
});

describeIf("NLQ search integration", () => {
  const projectSlug = `t_${Math.random().toString(36).slice(2, 10)}`;
  const runToken = Math.random().toString(36).slice(2, 10);
  let schemaName = "";
  let matcher: ReturnType<typeof createMatcher>;
  let generateCalls = 0;

  beforeAll(async () => {
    matcher = createMatcher({
      databaseUrl: databaseUrl!,
      apiKey: "test-api-key-12345",
      migrate: "eager",
      embed: async ({ text, dim }) => stubEmbed(text, dim),
      generate: async () => {
        generateCalls++;
        return {
          semantic_query: "running shoes",
          max_price: 100,
          brand: "nike",
        };
      },
    });
    await matcher.migrate();
    const r = await matcher.apply(projectSlug, {
      entities: [],
      collections: [testProductsCollection],
    });
    schemaName = r.schema;

    await matcher.indexDocuments(projectSlug, "products", [
      {
        id: "1",
        data: { title: "nike running shoes" },
        doc: "nike running shoes",
        embedding: stubEmbed("running", 8),
        fields: {
          title: "nike running shoes",
          brand: "nike",
          price: 90,
          category: "shoes",
          colors: ["red"],
          available: true,
        },
      },
      {
        id: "2",
        data: { title: "adidas running shoes" },
        doc: "adidas running shoes",
        embedding: stubEmbed("running", 8),
        fields: {
          title: "adidas running shoes",
          brand: "adidas",
          price: 80,
          category: "shoes",
          colors: ["blue"],
          available: true,
        },
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

  test("NLQ hard filters applied to results", async () => {
    generateCalls = 0;
    const result = await matcher.search(projectSlug, "products", {
      q: `nike running shoes under 100 dollars ${runToken}`,
      limit: 10,
    });
    expect(generateCalls).toBe(1);
    expect(result.parsed?.semantic_query).toBe("running shoes");
    expect(result.hits.every((h) => h.brand === "nike")).toBe(true);
    expect(result.hits.every((h) => Number(h.price) <= 100)).toBe(true);
  });

  test("explicit filters override NLQ-derived filters", async () => {
    const result = await matcher.search(projectSlug, "products", {
      q: "nike running shoes under 100 dollars",
      filters: { brand: "adidas" },
      limit: 10,
    });
    expect(result.hits.every((h) => h.brand === "adidas")).toBe(true);
  });

  test("generate failure still returns results with nlq_degraded", async () => {
    const degradedMatcher = createMatcher({
      databaseUrl: databaseUrl!,
      apiKey: "test-api-key-12345",
      migrate: "eager",
      embed: async ({ text, dim }) => stubEmbed(text, dim),
      generate: async () => {
        throw new Error("fail");
      },
    });
    await degradedMatcher.migrate();
    const result = await degradedMatcher.search(projectSlug, "products", {
      q: "nike running shoes under 100",
      limit: 5,
    });
    await degradedMatcher.close();
    expect(result.nlq_degraded).toBe(true);
    expect(result.hits.length).toBeGreaterThan(0);
  });

  test("keyword fast-path skips generate at search time", async () => {
    generateCalls = 0;
    await matcher.search(projectSlug, "products", { q: "red shoes", limit: 5 });
    expect(generateCalls).toBe(0);
  });
});

describe("implied budget hints (Q1)", () => {
  const budgetDef = collection("b", {
    fields: {
      title: f.text({ searchable: true }),
      price: f.number({ filterable: true, budget: true }),
      weight: f.number({ filterable: true }),
      category: f.enum(["dresses", "tops"], { filterable: true }),
    },
    search: { channels: [Channels.fts({ fields: ["title"], weight: 1 })] },
  });

  test("schema derives budget_hint only for budget-flagged number fields", () => {
    const schema = deriveNlqSchema(budgetDef) as { properties: Record<string, unknown> };
    expect(schema.properties.price_budget_hint).toBeDefined();
    expect(schema.properties.weight_budget_hint).toBeUndefined();
  });

  test("hint surfaces when no explicit bound parsed", () => {
    const r = nlqParsedToFilters({ semantic_query: "x", price_budget_hint: "cheap" }, budgetDef);
    expect(r.budgetHints).toEqual({ price: "cheap" });
    expect(r.filters.price).toBeUndefined();
  });

  test("explicit max suppresses the hint", () => {
    const r = nlqParsedToFilters(
      { semantic_query: "x", price_budget_hint: "cheap", max_price: 5000 },
      budgetDef
    );
    expect(r.budgetHints).toEqual({});
    expect(r.filters.price).toEqual({ $lte: 5000 });
  });

  test("'none' hint is ignored", () => {
    const r = nlqParsedToFilters({ semantic_query: "x", price_budget_hint: "none" }, budgetDef);
    expect(r.budgetHints).toEqual({});
  });
});
