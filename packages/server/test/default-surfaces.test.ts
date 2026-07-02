import "./load-env.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { collection, f, Channels } from "@samesake/core";
import { createMatcher } from "../src/createMatcher.ts";
import { createDbFromUrl } from "../src/db/client.ts";

const databaseUrl = process.env.SAMESAKE_DATABASE_URL;
const describeIf = databaseUrl ? describe : describe.skip;

// Deterministic stub embed: rare-brand docs point away from everything else so a
// hard filter is the only way they can surface.
const RARE = [0, 0, 0, 0, 0, 0, 0, 1];
const COMMON = [1, 0, 0, 0, 0, 0, 0, 0];
const embed = async ({ text }: { text?: string }) =>
  text?.includes("zzrare") ? RARE : COMMON;

const products = collection("products", {
  fields: {
    title: f.text({ searchable: true, ftsWeight: "A" }),
    tags: f.text({ searchable: true }),
    brand: f.text({ filterable: true }),
  },
  embeddings: {
    doc: { source: "$title $tags", model: "stub", dim: 8 },
  },
  search: {
    channels: [
      Channels.fts({ fields: ["title", "tags"], weight: 1 }),
      Channels.cosine({ embedding: "doc", weight: 1 }),
    ],
    combiner: "rrf",
  },
});

describeIf("default indexing surfaces (no enrich pipeline)", () => {
  const projectSlug = `t_${Math.random().toString(36).slice(2, 10)}`;
  let schemaName = "";
  let matcher: ReturnType<typeof createMatcher>;

  beforeAll(async () => {
    matcher = createMatcher({
      databaseUrl: databaseUrl!,
      apiKey: "test-api-key-12345",
      migrate: "eager",
      embed,
    });
    await matcher.migrate();
    const r = await matcher.apply(projectSlug, { entities: [], collections: [products] });
    schemaName = r.schema;
  });

  afterAll(async () => {
    if (schemaName) {
      const { db, close } = createDbFromUrl(databaseUrl!);
      await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`));
      await close();
    }
    if (matcher) await matcher.close();
  });

  test(
    "push → index works without an enrich pipeline",
    async () => {
      const docs = [
        { id: "title-hit", data: { title: "wombat parka", tags: "outdoor", brand: "acme" } },
        { id: "tag-hit", data: { title: "green parka", tags: "wombat outdoor", brand: "acme" } },
      ];
      for (let i = 0; i < 10; i++) {
        docs.push({
          id: `filler-${i}`,
          data: { title: `linen shirt ${i}`, tags: "everyday", brand: "acme" },
        });
      }
      for (let i = 0; i < 5; i++) {
        docs.push({
          id: `rare-${i}`,
          data: { title: `zzrare jacket ${i}`, tags: "zzrare", brand: "rarebrand" },
        });
      }
      await matcher.pushDocuments(projectSlug, "products", docs);
      const { indexed } = await matcher.index(projectSlug, "products");
      expect(indexed).toBe(docs.length);
    },
    60_000
  );

  test("embedding column is halfvec", async () => {
    const { db, close } = createDbFromUrl(databaseUrl!);
    const rows = await db.execute<{ udt_name: string }>(sql`
      SELECT udt_name FROM information_schema.columns
      WHERE table_schema = ${schemaName} AND table_name = 'c_products' AND column_name = 'embedding'
    `);
    await close();
    expect(rows[0]?.udt_name).toBe("halfvec");
  });

  test("push → index → search works without an enrich pipeline", async () => {
    const result = await matcher.search(projectSlug, "products", { q: "linen shirt", limit: 5 });
    expect(result.hits.length).toBeGreaterThan(0);
  });

  test("fts_src surfaces are composed from searchable fields", async () => {
    const { db, close } = createDbFromUrl(databaseUrl!);
    const rows = await db.execute<{ fts_src: string | null; fts_src_a: string | null }>(
      sql.raw(`SELECT fts_src, fts_src_a FROM ${schemaName}.c_products WHERE id = 'title-hit'`)
    );
    await close();
    expect(rows[0]?.fts_src_a).toBe("wombat parka");
    expect(rows[0]?.fts_src).toBe("outdoor");
  });

  test("setweight: title (A) match outranks tag (B) match on the lexical leg", async () => {
    const result = await matcher.search(projectSlug, "products", {
      q: "wombat",
      weights: { fts: 1, cosine: 0 },
      limit: 5,
    });
    const ids = result.hits.map((h: { id: string }) => h.id);
    expect(ids[0]).toBe("title-hit");
    expect(ids).toContain("tag-hit");
  });

  test("filtered recall: hard filter returns every matching doc despite adversarial vectors", async () => {
    const result = await matcher.search(projectSlug, "products", {
      q: "jacket",
      filters: { brand: "rarebrand" },
      limit: 10,
    });
    const ids = result.hits.map((h: { id: string }) => h.id).sort();
    expect(ids).toEqual(["rare-0", "rare-1", "rare-2", "rare-3", "rare-4"]);
  });

  test("efSearch knob is accepted and does not change filtered correctness", async () => {
    const result = await matcher.search(projectSlug, "products", {
      q: "jacket",
      filters: { brand: "rarebrand" },
      efSearch: 200,
      limit: 10,
    });
    expect(result.hits.length).toBe(5);
  });
});
