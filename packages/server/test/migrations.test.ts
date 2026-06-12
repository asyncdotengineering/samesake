import "./load-env.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { collection, f, Channels, s } from "../../sdk/src/index.ts";
import { createMatcher } from "../src/createMatcher.ts";
import { createDbFromUrl } from "../src/db/client.ts";
import { stubEmbed } from "./fixtures.ts";

const databaseUrl = process.env.DATABASE_URL;
const describeIf = databaseUrl ? describe : describe.skip;

const baseCollection = collection("products", {
  fields: {
    title: f.text({ searchable: true }),
    brand: f.text({ filterable: true }),
    price: f.number({ filterable: true }),
  },
  embeddings: { doc: { source: "$title", model: "test-embed", dim: 8 } },
  search: {
    channels: [
      Channels.fts({ fields: ["title"], weight: 1 }),
      Channels.cosine({ embedding: "doc", weight: 1 }),
    ],
  },
});

describeIf("collection migrations", () => {
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
    schemaName = (
      await matcher.apply(projectSlug, { entities: [], collections: [baseCollection] })
    ).schema;
  });

  afterAll(async () => {
    if (schemaName) {
      const { db, close } = createDbFromUrl(databaseUrl!);
      await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`));
      await close();
    }
    if (matcher) await matcher.close();
  });

  test("REQ-V03B-REPRO1: add field → ALTER + backfill from path", async () => {
    await matcher.pushDocuments(projectSlug, "products", [
      { id: "m1", data: { title: "Coat", brand: "zara", price: 100, content_hash: "m1" } },
    ]);
    const { db, close } = createDbFromUrl(databaseUrl!);
    await db.execute(sql.raw(`
      UPDATE ${schemaName}.c_products
      SET enriched = '{"category":"outerwear"}'::jsonb, enriched_at = now()
      WHERE id = 'm1'
    `));
    await close();

    const withCategory = collection("products", {
      fields: {
        title: f.text({ searchable: true }),
        brand: f.text({ filterable: true }),
        price: f.number({ filterable: true }),
        category: f.text({ filterable: true, path: "enriched.category" }),
      },
      embeddings: { doc: { source: "$title", model: "test-embed", dim: 8 } },
      search: {
        channels: [
          Channels.fts({ fields: ["title"], weight: 1 }),
          Channels.cosine({ embedding: "doc", weight: 1 }),
        ],
      },
    });

    const r = await matcher.apply(projectSlug, { entities: [], collections: [withCategory] });
    expect(r.plan.additions.some((a) => a.includes("category"))).toBe(true);

    const { db: db2, close: close2 } = createDbFromUrl(databaseUrl!);
    const cols = await db2.execute<{ column_name: string }>(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = ${schemaName} AND table_name = 'c_products' AND column_name = 'category'
    `);
    const rows = await db2.execute<{ category: string }>(
      sql.raw(`SELECT category FROM ${schemaName}.c_products WHERE id = 'm1'`)
    );
    await close2();
    expect(cols.length).toBe(1);
    expect(rows[0]!.category).toBe("outerwear");
  });

  test("REQ-V03B-REPRO1: add spaces → space_vec + HNSW index", async () => {
    const withSpaces = collection("products", {
      fields: {
        title: f.text({ searchable: true }),
        brand: f.text({ filterable: true }),
        price: f.number({ filterable: true }),
        category: f.text({ filterable: true, path: "enriched.category" }),
      },
      embeddings: { doc: { source: "$title", model: "test-embed", dim: 8 } },
      spaces: { style: s.text({ source: "$title", model: "test-embed", dim: 8 }) },
      search: { channels: [Channels.fts({ fields: ["title"], weight: 1 }), Channels.spaces({ weight: 1 })] },
    });

    const r = await matcher.apply(projectSlug, { entities: [], collections: [withSpaces] });
    expect(r.plan.additions.some((a) => a.includes("space_vec"))).toBe(true);

    const { db, close } = createDbFromUrl(databaseUrl!);
    const col = await db.execute<{ column_name: string }>(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = ${schemaName} AND table_name = 'c_products' AND column_name = 'space_vec'
    `);
    const idx = await db.execute<{ indexname: string }>(sql`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = ${schemaName} AND tablename = 'c_products' AND indexname = 'c_products_space_vec_idx'
    `);
    await close();
    expect(col.length).toBe(1);
    expect(idx.length).toBe(1);
  });

  test("REQ-V03B-REPRO2: divergence plan + destructive refusal", async () => {
    const withoutSpaces = collection("products", {
      fields: {
        title: f.text({ searchable: true }),
        brand: f.text({ filterable: true }),
        price: f.number({ filterable: true }),
        category: f.text({ filterable: true, path: "enriched.category" }),
      },
      embeddings: { doc: { source: "$title", model: "test-embed", dim: 8 } },
      search: {
        channels: [
          Channels.fts({ fields: ["title"], weight: 1 }),
          Channels.cosine({ embedding: "doc", weight: 1 }),
        ],
      },
    });

    const plan = await matcher.apply(projectSlug, { entities: [], collections: [withoutSpaces] }, { dryRun: true });
    expect(plan.plan.destructive.some((d) => d.includes("spaces"))).toBe(true);

    await expect(matcher.apply(projectSlug, { entities: [], collections: [withoutSpaces] })).rejects.toThrow(
      /allowDestructive/
    );

    await matcher.apply(projectSlug, { entities: [], collections: [withoutSpaces] }, { allowDestructive: true });

    const { db, close } = createDbFromUrl(databaseUrl!);
    const col = await db.execute<{ column_name: string }>(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = ${schemaName} AND table_name = 'c_products' AND column_name = 'space_vec'
    `);
    await close();
    expect(col.length).toBe(0);
  });

  test("REQ-V03B-REPRO3: embedding def change clears indexed_at", async () => {
    await matcher.pushDocuments(projectSlug, "products", [
      { id: "m3", data: { title: "Scarf", brand: "hm", price: 20, content_hash: "m3" } },
    ]);
    await matcher.index(projectSlug, "products");

    const changedSource = collection("products", {
      fields: {
        title: f.text({ searchable: true }),
        brand: f.text({ filterable: true }),
        price: f.number({ filterable: true }),
        category: f.text({ filterable: true, path: "enriched.category" }),
      },
      embeddings: { doc: { source: "$title $brand", model: "test-embed", dim: 8 } },
      search: {
        channels: [
          Channels.fts({ fields: ["title"], weight: 1 }),
          Channels.cosine({ embedding: "doc", weight: 1 }),
        ],
      },
    });

    const r = await matcher.apply(projectSlug, { entities: [], collections: [changedSource] });
    expect(r.plan.reindexRequired.some((x) => x.includes("embedding"))).toBe(true);

    const { db, close } = createDbFromUrl(databaseUrl!);
    const after = await db.execute<{ indexed_at: Date | null }>(
      sql.raw(`SELECT indexed_at FROM ${schemaName}.c_products WHERE id = 'm3'`)
    );
    await close();
    expect(after[0]!.indexed_at).toBeNull();
  });

  test("REQ-V03B-REPRO3: dim change recreates embedding column", async () => {
    const dim16 = collection("products", {
      fields: {
        title: f.text({ searchable: true }),
        brand: f.text({ filterable: true }),
        price: f.number({ filterable: true }),
        category: f.text({ filterable: true, path: "enriched.category" }),
      },
      embeddings: { doc: { source: "$title $brand", model: "test-embed", dim: 16 } },
      search: {
        channels: [
          Channels.fts({ fields: ["title"], weight: 1 }),
          Channels.cosine({ embedding: "doc", weight: 1 }),
        ],
      },
    });

    const r = await matcher.apply(projectSlug, { entities: [], collections: [dim16] }, { allowDestructive: true });
    expect(r.plan.destructive.some((d) => d.includes("dimension"))).toBe(true);

    const { db, close } = createDbFromUrl(databaseUrl!);
    const col = await db.execute<{ coltype: string }>(sql.raw(`
      SELECT format_type(a.atttypid, a.atttypmod) AS coltype
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = '${schemaName}' AND c.relname = 'c_products'
        AND a.attname = 'embedding' AND NOT a.attisdropped
    `));
    await close();
    expect(col[0]!.coltype).toBe("vector(16)");
  });
});

describeIf("field addition without reindex", () => {
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
    schemaName = (
      await matcher.apply(projectSlug, { entities: [], collections: [baseCollection] })
    ).schema;
  });

  afterAll(async () => {
    if (schemaName) {
      const { db, close } = createDbFromUrl(databaseUrl!);
      await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`));
      await close();
    }
    if (matcher) await matcher.close();
  });

  test("field addition does not trigger reindex", async () => {
    const withTag = collection("products", {
      fields: {
        title: f.text({ searchable: true }),
        brand: f.text({ filterable: true }),
        price: f.number({ filterable: true }),
        tag: f.text({ filterable: true }),
      },
      embeddings: { doc: { source: "$title", model: "test-embed", dim: 8 } },
      search: {
        channels: [
          Channels.fts({ fields: ["title"], weight: 1 }),
          Channels.cosine({ embedding: "doc", weight: 1 }),
        ],
      },
    });

    const r = await matcher.apply(projectSlug, { entities: [], collections: [withTag] });
    expect(r.plan.reindexRequired, JSON.stringify(r.plan)).toHaveLength(0);
    expect(r.plan.additions.some((a) => a.includes("tag"))).toBe(true);
  });
});

describeIf("embed-index terminal skip", () => {
  const projectSlug = `t_${Math.random().toString(36).slice(2, 10)}`;
  let schemaName = "";
  let matcher: ReturnType<typeof createMatcher>;

  const enrichGuardCollection = collection("products", {
    fields: { title: f.text({ searchable: true }) },
    enrich: {
      stages: [
        {
          name: "classify",
          prompt: (ctx: { data: Record<string, unknown> }) => `classify ${ctx.data.title}`,
          schema: () => ({ type: "object" }),
        },
      ],
    },
    embeddings: { doc: { source: "$title", model: "test-embed", dim: 8 } },
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
      generate: async () => ({}),
    });
    await matcher.migrate();
    schemaName = (
      await matcher.apply(projectSlug, { entities: [], collections: [enrichGuardCollection] })
    ).schema;
  });

  afterAll(async () => {
    if (schemaName) {
      const { db, close } = createDbFromUrl(databaseUrl!);
      await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`));
      await close();
    }
    if (matcher) await matcher.close();
  });

  test("REQ-V03B-REPRO4: skipped rows terminal — second index processes 0", async () => {
    await matcher.pushDocuments(projectSlug, "products", [
      { id: "skip1", data: { title: "Widget", content_hash: "s1" } },
    ]);
    const { db, close } = createDbFromUrl(databaseUrl!);
    await db.execute(sql.raw(`
      UPDATE ${schemaName}.c_products
      SET enriched = '{"is_apparel":false,"category":"other"}'::jsonb, enriched_at = now()
      WHERE id = 'skip1'
    `));
    await close();

    expect((await matcher.index(projectSlug, "products")).indexed).toBe(0);

    const { db: db2, close: close2 } = createDbFromUrl(databaseUrl!);
    const row = await db2.execute<{ indexed_at: Date | null; doc: string | null }>(
      sql.raw(`SELECT indexed_at, doc FROM ${schemaName}.c_products WHERE id = 'skip1'`)
    );
    await close2();
    expect(row[0]!.indexed_at).not.toBeNull();
    expect(row[0]!.doc).toBeNull();

    expect((await matcher.index(projectSlug, "products")).indexed).toBe(0);
  });
});
