import "./load-env.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { collection, f, Channels, pipeline, stage, gates } from "../../sdk/src/index.ts";
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
  let lastClassifySchema: Record<string, unknown> | undefined;

  const enrichCollection = collection("products", {
    fields: {
      title: f.text({ searchable: true }),
      category: f.text({ filterable: true, path: "enriched.category" }),
    },
    enrich: pipeline(
      stage("classify", {
        prompt: (ctx) => `classify ${ctx.data.title}`,
        // zod schema — the matcher must convert it to JSON Schema before calling generate.
        schema: () => z.object({ is_apparel: z.boolean(), category: z.string(), confidence: z.number() }),
        model: "cheap",
      }),
      stage("extract", {
        condition: (ctx) => ctx.enriched.is_apparel === true,
        prompt: (ctx) => `extract ${ctx.data.title}`,
        schema: () => ({ type: "object" }),
        model: "default",
      })
    ),
    indexing: {
      surfaces: {
        embed_doc: { kind: "dense", embedding: "doc", build: ({ data }) => String(data.title ?? "").trim() },
        fts_doc: { kind: "fts", build: ({ data }) => String(data.title ?? "").trim() },
      },
      gate: gates.always,
    },
    embeddings: {
      doc: { model: "test-embed", dim: 8 },
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
      generate: async ({ prompt, schema }) => {
        generateCalls++;
        if (prompt.startsWith("classify")) lastClassifySchema = schema;
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

    // the classify stage declares its schema as a zod schema — the matcher must
    // hand generate the converted JSON Schema, not the zod instance.
    expect(lastClassifySchema).toBeDefined();
    expect(lastClassifySchema!.type).toBe("object");
    const classifyProps = lastClassifySchema!.properties as Record<string, unknown>;
    expect(classifyProps.is_apparel).toEqual({ type: "boolean" });
    expect(classifyProps.category).toEqual({ type: "string" });
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

describeIf("test:index-gate enrich pipeline surfaces", () => {
  const projectSlug = `t_${Math.random().toString(36).slice(2, 10)}`;
  let schemaName = "";
  let matcher: ReturnType<typeof createMatcher>;

  const indexingCollection = collection("products", {
    fields: {
      title: f.text({ searchable: true }),
    },
    enrich: pipeline(
      stage("classify", {
        prompt: (ctx) => `classify ${ctx.data.title}`,
        schema: () => ({ type: "object", properties: { category: { type: "string" } } }),
      })
    ),
    indexing: {
      surfaces: {
        embed_doc: {
          kind: "dense",
          embedding: "doc",
          build: ({ data, enriched }) => `${data.title} ${enriched.category ?? ""}`.trim(),
        },
        rerank_doc: {
          kind: "rerank",
          build: ({ data }) => String(data.title ?? ""),
        },
        fts_doc: {
          kind: "fts",
          build: ({ data, enriched }) => `${data.title} ${enriched.category ?? ""}`.trim(),
        },
      },
      gate: gates.always,
    },
    embeddings: {
      doc: { model: "test-embed", dim: 8 },
    },
    search: {
      channels: [Channels.fts({ fields: ["title"], weight: 1 })],
    },
  });

  beforeAll(async () => {
    matcher = createMatcher({
      databaseUrl: databaseUrl!,
      apiKey: "test-api-key-12345",
      migrate: "eager",
      embed: async ({ dim }) => new Array(dim).fill(0),
      generate: async () => ({ category: "dress" }),
    });
    await matcher.migrate();
    schemaName = (
      await matcher.apply(projectSlug, { entities: [], collections: [indexingCollection] })
    ).schema;
    await matcher.pushDocuments(projectSlug, "products", [
      { id: "idx1", data: { title: "Silk Midi", content_hash: "idx1" } },
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

  test("test:index-gate persists surfaces and pipeline_status ready", async () => {
    const r = await matcher.enrich(projectSlug, "products");
    expect(r.enriched).toBe(1);

    const { db, close } = createDbFromUrl(databaseUrl!);
    const rows = await db.execute<{
      doc: string | null;
      rerank_doc: string | null;
      fts_src: string | null;
      pipeline_status: string;
      gate_reason: string | null;
      enriched_at: string | null;
    }>(sql.raw(`
      SELECT doc, rerank_doc, fts_src, pipeline_status, gate_reason, enriched_at
      FROM ${schemaName}.c_products WHERE id = 'idx1'
    `));
    await close();

    const row = rows[0]!;
    expect(row.doc).toBe("Silk Midi dress");
    expect(row.rerank_doc).toBe("Silk Midi");
    expect(row.fts_src).toBe("Silk Midi dress");
    expect(row.pipeline_status).toBe("ready");
    expect(row.gate_reason).toBeNull();
    expect(row.enriched_at).toBeTruthy();
  });
});
