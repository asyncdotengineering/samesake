import "./load-env.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { collection, f, Channels } from "../../sdk/src/index.ts";
import { createMatcher } from "../src/createMatcher.ts";
import { createDbFromUrl } from "../src/db/client.ts";
import {
  l2Renormalize,
  resolveEmbedTemplate,
  resolveFieldValue,
} from "../src/core/embed-index.ts";
import { stubEmbed } from "./fixtures.ts";

const databaseUrl = process.env.DATABASE_URL;
const describeIf = databaseUrl ? describe : describe.skip;

describe("embed-index helpers", () => {
  test("resolveEmbedTemplate handles $enriched tokens and array join", () => {
    const doc = resolveEmbedTemplate(
      "$title. $enriched.search_document Category: $enriched.category. Colors: $enriched.colors.",
      { title: "Red Dress", price: 120 },
      { search_document: "flowy midi", category: "dress", colors: ["red", "blue"] }
    );
    expect(doc).toContain("Red Dress");
    expect(doc).toContain("flowy midi");
    expect(doc).toContain("dress");
    expect(doc).toContain("red, blue");
  });

  test("l2Renormalize produces unit length vector", () => {
    const v = l2Renormalize([3, 4]);
    const norm = Math.sqrt(v[0]! ** 2 + v[1]! ** 2);
    expect(norm).toBeCloseTo(1, 5);
  });

  test("resolveFieldValue reads enriched path", () => {
    const val = resolveFieldValue(
      "category",
      { type: "text", filterable: true, path: "enriched.category" },
      { title: "x" },
      { category: "shoes" }
    );
    expect(val).toBe("shoes");
  });
});

describeIf("embed-index integration", () => {
  const projectSlug = `t_${Math.random().toString(36).slice(2, 10)}`;
  let schemaName = "";
  let matcher: ReturnType<typeof createMatcher>;

  const indexCollection = collection("products", {
    fields: {
      title: f.text({ searchable: true }),
      brand: f.text({ filterable: true, path: "enriched.brand" }),
      price: f.number({ filterable: true }),
      colors: f.array(f.enum(["red", "blue", "green"] as const), {
        filterable: true,
        path: "enriched.colors",
      }),
    },
    embeddings: {
      doc: {
        source:
          "$title. $enriched.summary Category: $enriched.category. Colors: $enriched.colors.",
        model: "test-embed",
        dim: 8,
        taskType: "RETRIEVAL_DOCUMENT",
      },
    },
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
    });
    await matcher.migrate();
    const r = await matcher.apply(projectSlug, {
      entities: [],
      collections: [indexCollection],
    });
    schemaName = r.schema;

    await matcher.pushDocuments(projectSlug, "products", [
      {
        id: "a",
        data: {
          title: "Silk Top",
          price: 4500,
          content_hash: "a1",
        },
      },
    ]);

    const { db, close } = createDbFromUrl(databaseUrl!);
    await db.execute(sql.raw(`
      UPDATE ${schemaName}.c_products
      SET enriched = '{"summary":"soft silk","category":"top","colors":["red"],"brand":"zara"}'::jsonb,
          enriched_at = now()
      WHERE id = 'a'
    `));
    await close();
  });

  afterAll(async () => {
    if (schemaName) {
      const { db, close } = createDbFromUrl(databaseUrl!);
      await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`));
      await close();
    }
    if (matcher) await matcher.close();
  });

  test("indexes with resolved template, renormalized vectors, and filter columns", async () => {
    const r = await matcher.index(projectSlug, "products");
    expect(r.indexed).toBe(1);

    const { db, close } = createDbFromUrl(databaseUrl!);
    const rows = await db.execute<{
      doc: string;
      brand: string;
      price: string;
      colors: string[];
      embedding: string;
    }>(sql.raw(`
      SELECT doc, brand, price, colors, embedding::text AS embedding
      FROM ${schemaName}.c_products WHERE id = 'a'
    `));
    await close();

    const row = rows[0]!;
    expect(row.doc).toContain("Silk Top");
    expect(row.doc).toContain("soft silk");
    expect(row.doc).toContain("red");
    expect(row.brand).toBe("zara");
    expect(Number(row.price)).toBe(4500);
    expect(row.colors).toEqual(["red"]);

    const vec = row.embedding
      .slice(1, -1)
      .split(",")
      .map(Number);
    const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 4);
  });

  test("re-index only stale docs after enrich update", async () => {
    let r = await matcher.index(projectSlug, "products");
    expect(r.indexed).toBe(0);

    const { db, close } = createDbFromUrl(databaseUrl!);
    await db.execute(sql.raw(`
      UPDATE ${schemaName}.c_products
      SET enriched = '{"summary":"updated","category":"top","colors":["blue"],"brand":"hm"}'::jsonb,
          enriched_at = now() + interval '1 second'
      WHERE id = 'a'
    `));
    await close();

    r = await matcher.index(projectSlug, "products");
    expect(r.indexed).toBe(1);

    const { db: db2, close: close2 } = createDbFromUrl(databaseUrl!);
    const rows = await db2.execute<{ brand: string; colors: string[] }>(
      sql.raw(`SELECT brand, colors FROM ${schemaName}.c_products WHERE id = 'a'`)
    );
    await close2();
    expect(rows[0]!.brand).toBe("hm");
    expect(rows[0]!.colors).toEqual(["blue"]);
  });
});
