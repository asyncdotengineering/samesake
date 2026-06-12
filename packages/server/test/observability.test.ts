import "./load-env.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { collection, f, Channels } from "@samesake/core";
import { createMatcher } from "../src/createMatcher.ts";
import { createDbFromUrl } from "../src/db/client.ts";
import { stubEmbed } from "./fixtures.ts";

const databaseUrl = process.env.DATABASE_URL;
const describeIf = databaseUrl ? describe : describe.skip;

const obsCollection = collection("obs", {
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
    nlq: { instructions: "obs test" },
  },
});

describeIf("observability counters", () => {
  const projectSlug = `t_${Math.random().toString(36).slice(2, 10)}`;
  let schemaName = "";
  let matcher: ReturnType<typeof createMatcher>;
  let generateCalls = 0;
  const events: Array<{ level: string; scope: string; msg: string }> = [];

  beforeAll(async () => {
    matcher = createMatcher({
      databaseUrl: databaseUrl!,
      apiKey: "test-api-key-12345",
      migrate: "eager",
      embed: async ({ text, dim }) => stubEmbed(text, dim),
      generate: async () => {
        generateCalls++;
        return { semantic_query: "widget", category: "a" };
      },
      logger: (e) => events.push({ level: e.level, scope: e.scope, msg: e.msg }),
    });
    await matcher.migrate();
    const r = await matcher.apply(projectSlug, { entities: [], collections: [obsCollection] });
    schemaName = r.schema;
    await matcher.indexDocuments(projectSlug, "obs", [
      {
        id: "1",
        data: { title: "widget alpha" },
        doc: "widget alpha",
        embedding: stubEmbed("widget alpha", 8),
        fields: { title: "widget alpha", category: "a" },
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

  test("search and cache counters increment", async () => {
    const before = matcher.metrics();
    const q = "widget alpha";
    await matcher.search(projectSlug, "obs", { q });
    await matcher.search(projectSlug, "obs", { q });
    const after = matcher.metrics();
    expect(after.searches_total).toBeGreaterThan(before.searches_total + 1);
    expect(after.search_cache_hits).toBeGreaterThan(before.search_cache_hits);
  });

  test("nlq cache hit counter increments on repeat parse", async () => {
    const before = matcher.metrics().nlq_cache_hits;
    const q = "another obs nlq phrase here";
    generateCalls = 0;
    await matcher.search(projectSlug, "obs", { q, cache: false });
    expect(generateCalls).toBe(1);
    await matcher.search(projectSlug, "obs", { q: q.toUpperCase(), cache: false });
    expect(generateCalls).toBe(1);
    expect(matcher.metrics().nlq_cache_hits).toBe(before + 1);
  });
});
