import "./load-env.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { collection, f, Channels } from "@samesake/core";
import { createMatcher } from "../src/createMatcher.ts";
import { createDbFromUrl } from "../src/db/client.ts";
import { stubEmbed } from "./fixtures.ts";

const databaseUrl = process.env.DATABASE_URL;
const describeIf = databaseUrl ? describe : describe.skip;

const budgetCollection = collection("items", {
  fields: {
    title: f.text({ searchable: true }),
    price: f.number({ filterable: true, budget: true }),
  },
  embeddings: { doc: { source: "$title", model: "stub", dim: 8 } },
  search: {
    channels: [
      Channels.fts({ fields: ["title"], weight: 1 }),
      Channels.cosine({ embedding: "doc", weight: 1 }),
    ],
    combiner: "rrf",
    nlq: { instructions: "test" },
  },
});

describeIf("implied budget end-to-end (Q1)", () => {
  const projectSlug = `t_${Math.random().toString(36).slice(2, 10)}`;
  let schemaName = "";
  let matcher: ReturnType<typeof createMatcher>;

  beforeAll(async () => {
    matcher = createMatcher({
      databaseUrl: databaseUrl!,
      apiKey: "test-api-key-12345",
      migrate: "eager",
      embed: async ({ text, dim }) => stubEmbed(text, dim),
      generate: async () => ({ semantic_query: "tshirt", price_budget_hint: "cheap" }),
    });
    await matcher.migrate();
    const r = await matcher.apply(projectSlug, { entities: [], collections: [budgetCollection] });
    schemaName = r.schema;
    // prices 10..100; p30 over 10 values = ~37
    const docs = Array.from({ length: 10 }, (_, i) => ({
      id: String(i + 1),
      data: { title: `tshirt variant ${i + 1}` },
      doc: `tshirt variant ${i + 1}`,
      embedding: stubEmbed("tshirt", 8),
      fields: { title: `tshirt variant ${i + 1}`, price: (i + 1) * 10 },
    }));
    await matcher.indexDocuments(projectSlug, "items", docs);
  });

  afterAll(async () => {
    if (schemaName) {
      const { db, close } = createDbFromUrl(databaseUrl!);
      await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`));
      await close();
    }
    if (matcher) await matcher.close();
  });

  test("'cheap' hint filters to bottom price percentile", async () => {
    const r = await matcher.search(projectSlug, "items", { q: "some cheap tshirts please", limit: 10 });
    expect(r.hits.length).toBeGreaterThan(0);
    for (const h of r.hits) {
      expect(Number((h as Record<string, unknown>).price)).toBeLessThanOrEqual(37.1);
    }
  });

  test("explicit max_price beats the hint (no double constraint)", async () => {
    const m2 = createMatcher({
      databaseUrl: databaseUrl!,
      apiKey: "test-api-key-12345",
      embed: async ({ text, dim }) => stubEmbed(text, dim),
      generate: async () => ({ semantic_query: "tshirt", price_budget_hint: "cheap", max_price: 95 }),
    });
    // reuse the applied project: re-apply registers collection defs in this instance
    await m2.apply(projectSlug, { entities: [], collections: [budgetCollection] });
    const r = await m2.search(projectSlug, "items", { q: "cheap tshirts under 95", limit: 10 });
    const prices = r.hits.map((h) => Number((h as Record<string, unknown>).price));
    expect(Math.max(...prices)).toBeGreaterThan(37.1); // hint did NOT apply
    expect(Math.max(...prices)).toBeLessThanOrEqual(95);
    await m2.close();
  });
});
