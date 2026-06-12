import "./load-env.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createMatcher } from "../src/createMatcher.ts";
import { createDbFromUrl } from "../src/db/client.ts";
import { stubEmbed, testProductsCollection } from "./fixtures.ts";

const databaseUrl = process.env.DATABASE_URL;
const describeIf = databaseUrl ? describe : describe.skip;

describeIf("search explain", () => {
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
    const r = await matcher.apply(projectSlug, { entities: [], collections: [testProductsCollection] });
    schemaName = r.schema;

    await matcher.indexDocuments(projectSlug, "products", [
      {
        id: "1",
        data: { title: "red running shoes" },
        doc: "red running shoes",
        embedding: stubEmbed("red running shoes", 8),
        fields: {
          title: "red running shoes",
          brand: "nike",
          price: 120,
          category: "shoes",
          colors: ["red"],
          tag: "redline",
        },
      },
      {
        id: "2",
        data: { title: "blue casual sneakers" },
        doc: "blue casual sneakers",
        embedding: stubEmbed("blue casual sneakers", 8),
        fields: {
          title: "blue casual sneakers",
          brand: "adidas",
          price: 90,
          category: "shoes",
          colors: ["blue"],
          tag: "standard",
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

  test("explain returns per-leg ranks for a known doc", async () => {
    const explain = await matcher.searchExplain(projectSlug, "products", {
      q: "red running shoes",
      limit: 5,
    });

    expect(explain.docs.length).toBeGreaterThan(0);
    expect(explain.filters.sql).toBeTruthy();

    const top = explain.docs.find((d) => d.id === "1") ?? explain.docs[0]!;
    expect(top.fts_rank).not.toBeNull();
    expect(top.cosine_rank).not.toBeNull();
    expect(top.rrf_score).toBeGreaterThan(0);
    expect(typeof explain.weights.fts).toBe("number");
  });
});
