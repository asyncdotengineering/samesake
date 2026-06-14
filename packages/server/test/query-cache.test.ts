import "./load-env.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { collection, f, Channels } from "@samesake/core";
import { createMatcher } from "../src/createMatcher.ts";
import { createDbFromUrl } from "../src/db/client.ts";
import { stubEmbed } from "./fixtures.ts";
import { SearchResultCache, type SearchCacheKey } from "../src/core/search-cache.ts";

const databaseUrl = process.env.DATABASE_URL;
const describeIf = databaseUrl ? describe : describe.skip;

const cacheCollection = collection("things", {
  fields: {
    title: f.text({ searchable: true }),
    category: f.enum(["a", "b"], { filterable: true }),
  },
  embeddings: { doc: { source: "$title", model: "stub", dim: 8 } },
  search: {
    channels: [
      Channels.fts({ fields: ["title"], weight: 1 }),
      Channels.cosine({ embedding: "doc", weight: 1 }),
    ],
    nlq: { instructions: "cache test" },
  },
});

describe("search result cache key", () => {
  const base: SearchCacheKey = {
    project: "p",
    collection: "c",
    query: "",
    filters: {},
    weights: {},
    limit: 10,
    offset: 0,
    facets: [],
  };

  test("distinct image fingerprints do not collide on the same text query", () => {
    const cache = new SearchResultCache({ ttlMs: 1000, maxEntries: 10 });
    cache.set({ ...base, image: "url:a.jpg" }, { id: "A" });
    cache.set({ ...base, image: "url:b.jpg" }, { id: "B" });
    expect(cache.get<{ id: string }>({ ...base, image: "url:a.jpg" })).toEqual({ id: "A" });
    expect(cache.get<{ id: string }>({ ...base, image: "url:b.jpg" })).toEqual({ id: "B" });
  });

  test("an image-only query with no text builds a key without throwing", () => {
    const cache = new SearchResultCache({ ttlMs: 1000, maxEntries: 10 });
    const key: SearchCacheKey = { ...base, query: undefined, image: "url:only.jpg" };
    expect(() => cache.set(key, { id: "X" })).not.toThrow();
    expect(cache.get<{ id: string }>(key)).toEqual({ id: "X" });
  });
});

describeIf("query caches (Q2)", () => {
  const projectSlug = `t_${Math.random().toString(36).slice(2, 10)}`;
  const runToken = Math.random().toString(36).slice(2, 8);
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
        return { semantic_query: "widget thing", category: "a" };
      },
    });
    await matcher.migrate();
    const r = await matcher.apply(projectSlug, { entities: [], collections: [cacheCollection] });
    schemaName = r.schema;
    await matcher.indexDocuments(projectSlug, "things", [
      { id: "1", data: { title: "widget one" }, doc: "widget one", embedding: stubEmbed("widget", 8), fields: { title: "widget one", category: "a" } },
      { id: "2", data: { title: "widget two" }, doc: "widget two", embedding: stubEmbed("widget", 8), fields: { title: "widget two", category: "a" } },
      { id: "3", data: { title: "gadget" }, doc: "gadget", embedding: stubEmbed("gadget", 8), fields: { title: "gadget", category: "b" } },
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

  test("NLQ parse is cached in Postgres across calls (generate fires once)", async () => {
    const q = `some nice widget thing please ${runToken}`;
    const r1 = await matcher.search(projectSlug, "things", { q, cache: false });
    expect(generateCalls).toBe(1);
    // bypass result cache to force the NLQ path again
    const r2 = await matcher.search(projectSlug, "things", { q: q.toUpperCase(), cache: false });
    expect(generateCalls).toBe(1); // normalized-q cache hit
    expect(r2.hits.map((h) => h.id).sort()).toEqual(r1.hits.map((h) => h.id).sort());
  });

  test("in-process result cache is explicit opt-in", async () => {
    const q = "another lovely widget query";
    const fresh = await matcher.search(projectSlug, "things", { q });
    const cached = await matcher.search(projectSlug, "things", { q });
    expect(cached.hits).toEqual(fresh.hits);
    expect(cached.cached).toBeUndefined();

    const optInFresh = await matcher.search(projectSlug, "things", { q, cache: true });
    const optInCached = await matcher.search(projectSlug, "things", { q, cache: true });
    expect(optInCached.cached).toBe(true);
    expect(optInCached.hits).toEqual(optInFresh.hits);
  });

  test("opt-in result cache invalidates after document write and index", async () => {
    const q = "rare purple widget";
    const before = await matcher.search(projectSlug, "things", { q, cache: true });
    expect(before.hits.some((h) => h.id === "4")).toBe(false);

    await matcher.pushDocuments(projectSlug, "things", [
      { id: "4", data: { title: "rare purple widget", category: "a" } },
    ]);
    await matcher.index(projectSlug, "things");

    const after = await matcher.search(projectSlug, "things", { q, cache: true });
    expect(after.cached).toBeUndefined();
    expect(after.hits.some((h) => h.id === "4")).toBe(true);
  });
});
