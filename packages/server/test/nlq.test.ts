import "./load-env.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createMatcher } from "../src/createMatcher.ts";
import { createDbFromUrl } from "../src/db/client.ts";
import { z } from "zod";
import { collection, f, Channels, type CollectionDef } from "@samesake/core";
import {
  deriveNlqSchema,
  deriveEnumTokenFilters,
  mergeDeterministicSoftFilters,
  nlqCacheKey,
  mergeFilters,
  nlqParsedToFilters,
  parseNlq,
  shouldSkipNlq,
} from "../src/core/nlq.ts";
import { buildFilterSql } from "../src/core/search.ts";
import type { MatcherCtx } from "../src/types.ts";
import { groundVocabValues, vocabCandidates } from "../src/core/field-vocab.ts";
import { ftsIndexingByTitle, nlqSchemaFixtureCollection, stubEmbed, testProductsCollection } from "./fixtures.ts";

const databaseUrl = process.env.SAMESAKE_DATABASE_URL;
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
  test("runs NLQ for every non-empty text query", () => {
    expect(shouldSkipNlq(testProductsCollection, "red shoes")).toBe(false);
    expect(shouldSkipNlq(testProductsCollection, "red")).toBe(false);
  });

  test("runs NLQ for longer or numeric queries", () => {
    expect(shouldSkipNlq(testProductsCollection, "red running shoes")).toBe(false);
    expect(shouldSkipNlq(testProductsCollection, "under 5000")).toBe(false);
  });

  test("skips image-only empty text", () => {
    expect(shouldSkipNlq(testProductsCollection, "")).toBe(true);
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
    expect(result.filters).toEqual({ colors: ["red"] });
    expect(result.deterministicFilters).toEqual({ colors: ["red"] });
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

  test("short queries invoke generate", async () => {
    let calls = 0;
    const ctx = {
      generateConfigured: true,
      generate: async () => {
        calls++;
        return { semantic_query: "x" };
      },
    } as unknown as MatcherCtx;

    await parseNlq(ctx, testProductsCollection, "red shoes");
    expect(calls).toBe(1);
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

  test("converts a zod nlq.schema to JSON Schema before generate", async () => {
    let received: Record<string, unknown> | undefined;
    const ctx = {
      generateConfigured: true,
      generate: async ({ schema }: { schema: Record<string, unknown> }) => {
        received = schema;
        return { semantic_query: "party wear" };
      },
    } as unknown as MatcherCtx;

    const coll = collection("products", {
      fields: {
        title: f.text({ searchable: true }),
        price: f.number({ filterable: true }),
      },
      indexing: ftsIndexingByTitle,
      search: {
        channels: [Channels.fts({ fields: ["title"], weight: 1 })],
        nlq: {
          enable: true,
          schema: z.object({ semantic_query: z.string(), max_price: z.number().optional() }),
        },
      },
    });

    await parseNlq(ctx, coll, "party wear under 3000");
    expect(received).toBeDefined();
    expect(received!.type).toBe("object");
    expect((received!.properties as Record<string, unknown>).semantic_query).toEqual({ type: "string" });
  });
});

describe("deterministic soft-enum guard", () => {
  test("test:enum-token-short-query derives red with zero generation calls", async () => {
    let calls = 0;
    const result = await parseNlq(
      {
        generateConfigured: false,
        generate: async () => {
          calls++;
          return {};
        },
      } as unknown as MatcherCtx,
      testProductsCollection,
      "red dress"
    );
    expect(result.filters).toEqual({ colors: ["red"] });
    expect(calls).toBe(0);
  });

  test("matches normalized enum tokens without generation", () => {
    const filters = deriveEnumTokenFilters("RED, dress", testProductsCollection);
    expect(filters).toEqual({ colors: ["red"] });
  });

  test("ignores negated and cross-field ambiguous values", () => {
    const ambiguous = collection("ambiguous", {
      fields: {
        title: f.text({ searchable: true }),
        color: f.enum(["red", "blue"], { filterable: true, soft: true }),
        shade: f.enum(["red", "green"], { filterable: true, soft: true }),
      },
      search: { channels: [Channels.fts({ fields: ["title"], weight: 1 })] },
    });
    expect(deriveEnumTokenFilters("not red shoes", testProductsCollection)).toEqual({});
    expect(deriveEnumTokenFilters("red", ambiguous)).toEqual({});
  });

  test("matches longest phrases and overrides only positive soft values", () => {
    const occasions = collection("occasions", {
      fields: {
        title: f.text({ searchable: true }),
        occasion: f.enum(["wedding", "wedding guest"], { filterable: true, soft: true }),
      },
      search: { channels: [Channels.fts({ fields: ["title"], weight: 1 })] },
    });
    const deterministic = deriveEnumTokenFilters("wedding guest", occasions);
    expect(deterministic).toEqual({ occasion: "wedding guest" });
    expect(mergeDeterministicSoftFilters({ occasion: "wedding" }, deterministic, occasions)).toEqual(deterministic);
  });
});

describe("catalog-grounded vocabulary", () => {
  const openVocab = collection("grounded", {
    fields: {
      title: f.text({ searchable: true }),
      brand: f.text({ filterable: true }),
    },
    search: { channels: [Channels.fts({ fields: ["title"], weight: 1 })], nlq: { enable: true } },
  });

  test("candidate lookup is scoped, thresholded, and bounded per field", async () => {
    let query = "";
    const ctx = {
      storage: {
        client: () => ({
          unsafe: async (sqlText: string) => {
            query = sqlText;
            return [
              { field: "brand", value: "Nike", count: 4 },
              { field: "brand", value: "Niko", count: 2 },
            ];
          },
        }),
      },
    } as unknown as MatcherCtx;
    const result = await vocabCandidates(ctx, "project_demo", "grounded", openVocab, "nike shoes", {
      scope_tenant: "tenant-a",
    });
    expect(result).toEqual({
      available: true,
      candidates: { brand: [{ value: "Nike", count: 4 }, { value: "Niko", count: 2 }] },
    });
    expect(query).toContain("> 0.25");
    expect(query).toContain("rn <= 8");
    expect(query).toContain("scope_tenant =");
  });

  test("grounding maps nearest values, keeps exact values, and fails closed on a missing table", async () => {
    const ctx = {
      storage: {
        client: () => ({
          unsafe: async () => [
            { field: "brand", parsed: "NIKE", matched_value: "Nike", similarity_score: 1 },
            { field: "brand", parsed: "Nkie", matched_value: "Nike", similarity_score: 0.7 },
            { field: "brand", parsed: "unknown", matched_value: null, similarity_score: 0 },
          ],
        }),
      },
    } as unknown as MatcherCtx;
    const grounded = await groundVocabValues(ctx, "project_demo", "grounded", {
      brand: ["NIKE", "Nkie", "unknown"],
    }, {});
    expect(grounded).toEqual({
      available: true,
      decisions: {
        brand: [
          { parsed: "NIKE", mapped: "Nike", action: "kept" },
          { parsed: "Nkie", mapped: "Nike", action: "mapped" },
          { parsed: "unknown", action: "dropped" },
        ],
      },
    });

    const missing = {
      storage: {
        client: () => ({ unsafe: async () => Promise.reject(Object.assign(new Error("relation c_grounded_vocab does not exist"), { code: "42P01" })) }),
      },
    } as unknown as MatcherCtx;
    await expect(vocabCandidates(missing, "project_demo", "grounded", openVocab, "nike", {})).resolves.toEqual({
      available: false,
      candidates: {},
    });
  });

  test("candidate and aspect changes invalidate the seven-day parse key", () => {
    const one = nlqCacheKey(openVocab, "nike shoes", { brand: [{ value: "Nike", count: 1 }] });
    const two = nlqCacheKey(openVocab, "nike shoes", { brand: [{ value: "Adidas", count: 1 }] });
    const aspectChanged = { ...openVocab, embeddings: { doc: { model: "x", dim: 8, describe: "visual" } } };
    expect(one).not.toBe(two);
    expect(one).not.toBe(nlqCacheKey(aspectChanged, "nike shoes", { brand: [{ value: "Nike", count: 1 }] }));
  });

  test("candidate values enter derived schema and custom schema without changing required fields", async () => {
    let received: Record<string, unknown> | undefined;
    const ctx = {
      generateConfigured: true,
      generate: async ({ schema, prompt }: { schema: Record<string, unknown>; prompt: string }) => {
        received = schema;
        expect(prompt).toContain("Catalog-grounded filter candidates");
        return { semantic_query: "shoes", brand: "Nike" };
      },
    } as unknown as MatcherCtx;
    await parseNlq(ctx, openVocab, "nike shoes", {
      candidates: { available: true, candidates: { brand: [{ value: "Nike", count: 4 }] } },
      grounding: { available: true, decisions: { brand: [{ parsed: "Nike", action: "kept" }] } },
    });
    const schema = received as { properties: Record<string, { enum?: string[] }> };
    expect(schema.properties.brand.enum).toEqual(["Nike"]);

    const custom = {
      ...openVocab,
      search: {
        channels: [Channels.fts({ fields: ["title"], weight: 1 })],
        nlq: {
          enable: true,
          schema: {
            type: "object",
            required: ["semantic_query"],
            properties: {
              semantic_query: { type: "string" },
              brand: { anyOf: [{ type: "string" }, { type: "null" }] },
            },
          },
        },
      },
    };
    received = undefined;
    await parseNlq(ctx, custom as unknown as CollectionDef, "nike shoes", {
      candidates: { available: true, candidates: { brand: [{ value: "Nike", count: 4 }] } },
      grounding: { available: true, decisions: { brand: [{ parsed: "Nike", action: "kept" }] } },
    });
    const customSchema = received as unknown as { required: string[]; properties: { brand: { anyOf: Array<{ enum?: string[] }> }; lexical_query: unknown } };
    expect(customSchema.required).toEqual(["semantic_query"]);
    expect(customSchema.properties.brand.anyOf[0]!.enum).toEqual(["Nike"]);
    expect(customSchema.properties.lexical_query).toBeDefined();
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
      limit: 1,
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

  test("short query invokes generate at search time", async () => {
    generateCalls = 0;
    await matcher.search(projectSlug, "products", { q: `red shoes ${runToken}`, limit: 1 });
    expect(generateCalls).toBe(1);
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
    indexing: ftsIndexingByTitle,
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

describeIf("nlq.schema persistence", () => {
  test("a zod nlq.schema is persisted as JSON Schema (survives the apply round-trip)", async () => {
    const slug = `t_${Math.random().toString(36).slice(2, 10)}`;
    const matcher = createMatcher({
      databaseUrl: databaseUrl!,
      apiKey: "test-api-key-12345",
      migrate: "eager",
      embed: async ({ text, dim }) => stubEmbed(text, dim),
      generate: async () => ({}),
    });
    await matcher.migrate();
    const coll = collection("products", {
      fields: { title: f.text({ searchable: true }) },
      indexing: ftsIndexingByTitle,
      search: {
        channels: [Channels.fts({ fields: ["title"], weight: 1 })],
        nlq: {
          enable: true,
          schema: z.object({ semantic_query: z.string(), max_price: z.number().optional() }),
        },
      },
    });
    const r = await matcher.apply(slug, { entities: [], collections: [coll] });

    // Read the persisted config straight from the DB — this is what a fresh search
    // process reloads (liveCollections is empty there), so it must be JSON Schema.
    const { db, close } = createDbFromUrl(databaseUrl!);
    const rows = await db.execute<{ config_json: { collections: { search: { nlq: { schema: Record<string, unknown> } } }[] } }>(
      sql.raw(`SELECT config_json FROM samesake_projects WHERE slug = '${slug}'`)
    );
    const persistedSchema = rows[0]!.config_json.collections[0]!.search.nlq.schema;
    expect(persistedSchema.type).toBe("object");
    expect((persistedSchema.properties as Record<string, unknown>).semantic_query).toEqual({ type: "string" });

    await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${r.schema} CASCADE`));
    await close();
    await matcher.close();
  });
});
