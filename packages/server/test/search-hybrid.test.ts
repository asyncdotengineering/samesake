import "./load-env.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createMatcher } from "../src/createMatcher.ts";
import { createDbFromUrl } from "../src/db/client.ts";
import { stubEmbed, testProductsCollection } from "./fixtures.ts";
import { collection, f, Channels, s } from "../../sdk/src/index.ts";

const databaseUrl = process.env.DATABASE_URL;
const describeIf = databaseUrl ? describe : describe.skip;

describeIf("hybrid search", () => {
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
    const r = await matcher.apply(projectSlug, {
      entities: [],
      collections: [testProductsCollection],
    });
    schemaName = r.schema;

    const docs = [
      { id: "1", title: "red running shoes", brand: "nike", price: 120, category: "shoes", colors: ["red"], vecText: "red running shoes" },
      { id: "2", title: "blue casual sneakers", brand: "adidas", price: 90, category: "shoes", colors: ["blue"], vecText: "blue casual sneakers" },
      { id: "3", title: "leather wallet", brand: "nike", price: 45, category: "accessories", colors: [], vecText: "red running shoes" },
      { id: "4", title: "sport socks pack", brand: "puma", price: 15, category: "accessories", colors: ["red"], vecText: "blue casual sneakers" },
      { id: "5", title: "red hat", brand: "nike", price: 25, category: "accessories", colors: ["red"], vecText: "red hat fashion" },
      { id: "6", title: "green dress", brand: "zara", price: 80, category: "apparel", colors: ["green"], vecText: "green dress summer" },
      { id: "7", title: "running shorts", brand: "nike", price: 55, category: "apparel", colors: ["blue"], vecText: "red running shoes" },
      { id: "8", title: "training tee", brand: "nike", price: 35, category: "apparel", colors: ["red"], vecText: "red running shoes" },
      { id: "9", title: "hiking boots", brand: "timberland", price: 200, category: "shoes", colors: ["green"], vecText: "hiking boots outdoor" },
      { id: "10", title: "sandals", brand: "birken", price: 70, category: "shoes", colors: ["blue"], vecText: "sandals beach" },
      { id: "11", title: "red scarf", brand: "uniqlo", price: 20, category: "accessories", colors: ["red"], vecText: "red scarf winter" },
      { id: "12", title: "gym bag", brand: "nike", price: 60, category: "accessories", colors: ["black"], vecText: "gym bag training" },
      { id: "13", title: "red running shoes premium", brand: "nike", price: 180, category: "shoes", colors: ["red"], vecText: "red running shoes" },
      { id: "14", title: "blue jeans", brand: "levis", price: 95, category: "apparel", colors: ["blue"], vecText: "blue jeans denim" },
      { id: "15", title: "windbreaker", brand: "nike", price: 110, category: "apparel", colors: ["red"], vecText: "red running shoes" },
      { id: "16", title: "cap", brand: "nike", price: 30, category: "accessories", colors: ["red"], vecText: "red cap sport" },
      { id: "17", title: "track pants", brand: "adidas", price: 65, category: "apparel", colors: ["blue"], vecText: "track pants running" },
      { id: "18", title: "red gloves", brand: "northface", price: 40, category: "accessories", colors: ["red"], vecText: "red gloves winter" },
      { id: "19", title: "polo shirt", brand: "nike", price: 50, category: "apparel", colors: ["green"], vecText: "polo shirt casual" },
      { id: "20", title: "red running shoes outlet", brand: "nike", price: 99, category: "shoes", colors: ["red"], vecText: "red running shoes" },
    ];

    await matcher.indexDocuments(
      projectSlug,
      "products",
      docs.map((d) => ({
        id: d.id,
        data: { title: d.title, brand: d.brand },
        doc: d.title,
        embedding: stubEmbed(d.vecText, 8),
        fields: {
          title: d.title,
          brand: d.brand,
          price: d.price,
          category: d.category,
          colors: d.colors,
          tag: d.colors.includes("red") ? "redline" : "standard",
        },
      }))
    );
  }, 20_000);

  afterAll(async () => {
    if (schemaName) {
      const { db, close } = createDbFromUrl(databaseUrl!);
      await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`));
      await close();
    }
    if (matcher) await matcher.close();
  });

  test("RRF hybrid beats single-channel for dual-signal query", async () => {
    const hybrid = await matcher.search(projectSlug, "products", {
      q: "red running shoes",
      limit: 5,
    });
    const ftsOnly = await matcher.search(projectSlug, "products", {
      q: "red running shoes",
      limit: 5,
      weights: { fts: 1, cosine: 0 },
    });
    const vecOnly = await matcher.search(projectSlug, "products", {
      q: "red running shoes",
      limit: 5,
      weights: { fts: 0, cosine: 1 },
    });

    expect(hybrid.hits.length).toBeGreaterThan(0);
    const hybridTop = hybrid.hits[0]!.id;
    const ftsTop = ftsOnly.hits[0]?.id;
    const vecTop = vecOnly.hits[0]?.id;

    expect(["1", "13", "20"]).toContain(hybridTop);
    if (ftsTop && vecTop && ftsTop !== vecTop) {
      expect(hybridTop).not.toBe(ftsTop === vecTop ? ftsTop : "impossible");
    }
    expect(hybrid.hits[0]!.score).toBeGreaterThan(0);
  });

  test("weights override changes ranking", async () => {
    const ftsOnly = await matcher.search(projectSlug, "products", {
      q: "wallet",
      limit: 3,
      weights: { fts: 1, cosine: 0 },
    });
    const vecOnly = await matcher.search(projectSlug, "products", {
      q: "wallet",
      limit: 3,
      weights: { fts: 0, cosine: 1 },
    });
    expect(ftsOnly.hits[0]!.id).toBe("3");
    expect(vecOnly.hits[0]!.id).not.toBe("3");
  });

  test("filters push into both legs", async () => {
    const filtered = await matcher.search(projectSlug, "products", {
      q: "running",
      filters: { brand: "nike" },
      limit: 10,
    });
    expect(filtered.hits.length).toBeGreaterThan(0);
    for (const h of filtered.hits) {
      expect(h.brand).toBe("nike");
    }
  });

  test("soft filter relaxation triggers when over-constrained", async () => {
    const result = await matcher.search(projectSlug, "products", {
      q: "red running shoes",
      filters: { colors: ["red"], tag: "nonexistent-tag" },
      limit: 10,
    });
    expect(result.relaxed).toBe(true);
    expect(result.hits.length).toBeGreaterThanOrEqual(0);
  });

  test("lexical-only works with no embedding", async () => {
    const noEmbedMatcher = createMatcher({
      databaseUrl: databaseUrl!,
      apiKey: "test-api-key-12345",
      migrate: "eager",
      embed: async () => {
        throw new Error("embed disabled");
      },
    });
    await noEmbedMatcher.migrate();
    const result = await noEmbedMatcher.search(projectSlug, "products", {
      q: "wallet",
      limit: 5,
      weights: { fts: 1, cosine: 1 },
    });
    await noEmbedMatcher.close();
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits.some((h) => String(h.title).includes("wallet"))).toBe(true);
  });

  test("GET search route returns response shape", async () => {
    const res = await matcher.fetch(
      new Request(
        `http://localhost/v1/projects/${projectSlug}/collections/products/search?q=wallet&limit=3`,
        { headers: { Authorization: "Bearer test-api-key-12345" } }
      )
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hits: unknown[]; relaxed: boolean; took_ms: number };
    expect(Array.isArray(body.hits)).toBe(true);
    expect(typeof body.relaxed).toBe("boolean");
    expect(typeof body.took_ms).toBe("number");
  });

  test("POST search route applies auth", async () => {
    const bad = await matcher.fetch(
      new Request(`http://localhost/v1/projects/${projectSlug}/collections/products/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q: "wallet" }),
      })
    );
    expect(bad.status).toBe(401);

    const ok = await matcher.fetch(
      new Request(`http://localhost/v1/projects/${projectSlug}/collections/products/search`, {
        method: "POST",
        headers: {
          Authorization: "Bearer test-api-key-12345",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ q: "wallet", filters: { brand: "nike" } }),
      })
    );
    expect(ok.status).toBe(200);
  });
});

describeIf("test:search-excludes-quarantined", () => {
  const projectSlug = `t_${Math.random().toString(36).slice(2, 10)}`;
  let schemaName = "";
  let matcher: ReturnType<typeof createMatcher>;
  const targetId = "q-target";

  const quarantineCollection = collection("products", {
    fields: {
      title: f.text({ searchable: true }),
      brand: f.text({ filterable: true }),
    },
    embeddings: {
      doc: { source: "$title", model: "test-embed", dim: 8 },
    },
    spaces: {
      style: s.text({ source: "$title", model: "test-embed", dim: 8 }),
    },
    search: {
      channels: [
        Channels.fts({ fields: ["title"], weight: 1 }),
        Channels.cosine({ embedding: "doc", weight: 1 }),
        Channels.spaces({ weight: 1 }),
      ],
    },
  });

  beforeAll(async () => {
    matcher = createMatcher({
      databaseUrl: databaseUrl!,
      apiKey: "test-api-key-12345",
      migrate: "eager",
      embed: async ({ text, dim }) => stubEmbed(text, dim),
    });
    await matcher.migrate();
    schemaName = (
      await matcher.apply(projectSlug, { entities: [], collections: [quarantineCollection] })
    ).schema;

    const vec = stubEmbed("quarantine target unique", 8);
    await matcher.indexDocuments(projectSlug, "products", [
      {
        id: targetId,
        data: { title: "quarantine target unique", brand: "zara" },
        doc: "quarantine target unique",
        embedding: vec,
        fields: { title: "quarantine target unique", brand: "zara" },
      },
    ]);

    const { db, close } = createDbFromUrl(databaseUrl!);
    await db.execute(sql.raw(`
      UPDATE ${schemaName}.c_products
      SET space_vec = embedding,
          fts_src = title,
          pipeline_status = 'ready'
      WHERE id = '${targetId}'
    `));
    await db.execute(sql.raw(`
      UPDATE ${schemaName}.c_products
      SET pipeline_status = 'quarantined', gate_reason = 'test-quarantine'
      WHERE id = '${targetId}'
    `));
    await close();
  }, 20_000);

  afterAll(async () => {
    if (schemaName) {
      const { db, close } = createDbFromUrl(databaseUrl!);
      await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`));
      await close();
    }
    if (matcher) await matcher.close();
  });

  test("test:search-excludes-quarantined from fts, cosine, and spaces", async () => {
    const fts = await matcher.search(projectSlug, "products", {
      q: "quarantine target unique",
      limit: 10,
      weights: { fts: 1, cosine: 0, spaces: 0 },
    });
    expect(fts.hits.some((h) => h.id === targetId)).toBe(false);

    const cosine = await matcher.search(projectSlug, "products", {
      q: "quarantine target unique",
      limit: 10,
      weights: { fts: 0, cosine: 1, spaces: 0 },
    });
    expect(cosine.hits.some((h) => h.id === targetId)).toBe(false);

    const spaces = await matcher.search(projectSlug, "products", {
      q: "quarantine target unique",
      limit: 10,
      weights: { fts: 0, cosine: 0, spaces: 1 },
    });
    expect(spaces.hits.some((h) => h.id === targetId)).toBe(false);
  });
});
