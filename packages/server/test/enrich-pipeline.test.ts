import "./load-env.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { collection, f, Channels, pipeline, stage } from "../../sdk/src/index.ts";
import { createMatcher } from "../src/createMatcher.ts";
import { createDbFromUrl } from "../src/db/client.ts";
import { stubEmbed } from "./fixtures.ts";

const databaseUrl = process.env.DATABASE_URL;
const describeIf = databaseUrl ? describe : describe.skip;

describeIf("enrich pipeline", () => {
  const projectSlug = `t_${Math.random().toString(36).slice(2, 10)}`;
  let schemaName = "";
  let matcher: ReturnType<typeof createMatcher>;
  let generateCalls = 0;

  const enrichCollection = collection("products", {
    fields: {
      title: f.text({ searchable: true }),
      category: f.text({ filterable: true, path: "enriched.category" }),
    },
    enrich: pipeline(
      stage("classify", {
        prompt: (ctx) => `classify ${ctx.data.title}`,
        schema: () => ({ type: "object" }),
        model: "cheap",
      }),
      stage("extract", {
        condition: (ctx) => ctx.enriched.is_apparel === true,
        prompt: (ctx) => `extract ${ctx.data.title}`,
        schema: () => ({ type: "object" }),
        model: "default",
      })
    ),
    embeddings: {
      doc: { source: "$title", model: "test-embed", dim: 8 },
    },
    search: {
      channels: [Channels.fts({ fields: ["title"], weight: 1 })],
    },
  });

  beforeAll(async () => {
    generateCalls = 0;
    const { db: cacheDb, close: cacheClose } = createDbFromUrl(databaseUrl!);
    await cacheDb.execute(sql.raw(`DELETE FROM samesake_stage_cache`));
    await cacheClose();

    matcher = createMatcher({
      databaseUrl: databaseUrl!,
      apiKey: "test-api-key-12345",
      migrate: "eager",
      embed: async ({ text, dim }) => stubEmbed(text, dim),
      generate: async ({ prompt }) => {
        generateCalls++;
        if (prompt.includes("wallet")) {
          return { is_apparel: false, category: "accessories", confidence: 0.8 };
        }
        if (prompt.startsWith("classify")) {
          return { is_apparel: true, category: "dress", confidence: 0.85 };
        }
        return { colors: ["red"], confidence: 0.95 };
      },
    });
    await matcher.migrate();
    const r = await matcher.apply(projectSlug, {
      entities: [],
      collections: [enrichCollection],
    });
    schemaName = r.schema;

    await matcher.pushDocuments(projectSlug, "products", [
      {
        id: "1",
        data: {
          title: "apparel dress",
          description: null,
          price: 100,
          image_url: null,
          available: true,
          raw_type: null,
          raw_tags: [],
          content_hash: "h1",
        },
      },
      {
        id: "2",
        data: {
          title: "wallet item",
          description: null,
          price: 50,
          image_url: null,
          available: true,
          raw_type: null,
          raw_tags: [],
          content_hash: "h2",
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

  test("runs two stages with condition gate and stores _stages", async () => {
    generateCalls = 0;
    const r = await matcher.enrich(projectSlug, "products", { concurrency: 2 });
    expect(r.enriched).toBe(2);
    expect(generateCalls).toBe(3);

    const { db, close } = createDbFromUrl(databaseUrl!);
    const rows = await db.execute<{ id: string; enriched: unknown }>(
      sql.raw(`SELECT id, enriched FROM ${schemaName}.c_products ORDER BY id`)
    );
    await close();

    const doc1 = rows.find((x) => x.id === "1")!.enriched as Record<string, unknown>;
    const doc2 = rows.find((x) => x.id === "2")!.enriched as Record<string, unknown>;
    expect(doc1.category).toBe("dress");
    expect(doc1.colors).toEqual(["red"]);
    expect((doc1._stages as Record<string, unknown>).extract).toBeTruthy();
    expect(doc2.category).toBe("accessories");
    expect((doc2._stages as Record<string, unknown>).extract).toBeUndefined();
    expect(doc1.confidence).toBe(0.95);
  });

  test("second enrich run hits stage cache", async () => {
    await matcher.pushDocuments(projectSlug, "products", [
      {
        id: "4",
        data: {
          title: "cache test item",
          description: null,
          price: 80,
          image_url: null,
          available: true,
          raw_type: null,
          raw_tags: [],
          content_hash: "h4",
        },
      },
    ]);
    generateCalls = 0;
    await matcher.enrich(projectSlug, "products", { concurrency: 2 });
    expect(generateCalls).toBe(2);

    const { db, close } = createDbFromUrl(databaseUrl!);
    await db.execute(sql.raw(`UPDATE ${schemaName}.c_products SET enriched_at = NULL WHERE id = '4'`));
    await close();

    generateCalls = 0;
    const second = await matcher.enrich(projectSlug, "products", { concurrency: 2 });
    expect(second.enriched).toBe(1);
    expect(generateCalls).toBe(0);
  });

  test("resumability: unchanged re-ingest skips enrich; title change re-enriches one", async () => {
    generateCalls = 0;
    await matcher.pushDocuments(projectSlug, "products", [
      {
        id: "1",
        data: {
          title: "apparel dress",
          description: null,
          price: 100,
          image_url: null,
          available: true,
          raw_type: null,
          raw_tags: [],
          content_hash: "h1",
        },
      },
      {
        id: "2",
        data: {
          title: "wallet item",
          description: null,
          price: 50,
          image_url: null,
          available: true,
          raw_type: null,
          raw_tags: [],
          content_hash: "h2",
        },
      },
    ]);
    let r = await matcher.enrich(projectSlug, "products");
    expect(r.enriched).toBe(0);
    expect(generateCalls).toBe(0);

    generateCalls = 0;
    await matcher.pushDocuments(projectSlug, "products", [
      {
        id: "1",
        data: {
          title: "apparel dress updated",
          description: null,
          price: 100,
          image_url: null,
          available: true,
          raw_type: null,
          raw_tags: [],
          content_hash: "h1-changed",
        },
      },
    ]);
    r = await matcher.enrich(projectSlug, "products");
    expect(r.enriched).toBe(1);
    expect(generateCalls).toBe(2);
  }, 20000);

  test("lazy-errors when generate slot missing", async () => {
    const noGen = createMatcher({
      databaseUrl: databaseUrl!,
      apiKey: "test-api-key-12345",
      migrate: "eager",
      embed: async ({ dim }) => new Array(dim).fill(0),
    });
    await noGen.migrate();
    const slug = `t_${Math.random().toString(36).slice(2, 8)}`;
    await noGen.apply(slug, { entities: [], collections: [enrichCollection] });
    await expect(noGen.enrich(slug, "products")).rejects.toThrow(/generate.*not configured/i);
    await noGen.close();
  });
});
