import "./load-env.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { collection, f, Channels, gates, type CollectionDef } from "../../sdk/src/index.ts";
import { createMatcher } from "../src/createMatcher.ts";
import { createDbFromUrl } from "../src/db/client.ts";
import { fashionRerank } from "../src/core/rerank.ts";
import type { GenerateFn } from "../src/types.ts";
import { stubEmbed } from "./fixtures.ts";

const databaseUrl = process.env.DATABASE_URL;
const describeIf = databaseUrl ? describe : describe.skip;

const coll = collection("products", {
  fields: {
    title: f.text({ searchable: true }),
  },
  indexing: {
    surfaces: {
      embed_doc: { kind: "dense", embedding: "doc", build: ({ data }) => String(data.title ?? "").trim() },
      fts_doc: { kind: "fts", build: ({ data }) => String(data.title ?? "").trim() },
    },
    gate: gates.always,
  },
  embeddings: { doc: { model: "test-embed", dim: 8 } },
  search: {
    channels: [
      Channels.fts({ fields: ["title"], weight: 1 }),
      Channels.cosine({ embedding: "doc", weight: 1 }),
    ],
    combiner: "rrf",
  },
}) as CollectionDef & { name: string };

describeIf("fashionRerank", () => {
  const slug = `t_${Math.random().toString(36).slice(2, 10)}`;
  let schemaName = "";
  let matcher: ReturnType<typeof createMatcher>;
  let matcherNoRerank: ReturnType<typeof createMatcher>;

  const stubGenerate: GenerateFn = async () => ({
    grades: [
      { id: "good", grade: 2, facets: {}, reason: "match" },
      { id: "bad", grade: 0, facets: {}, reason: "miss" },
    ],
  });

  beforeAll(async () => {
    matcherNoRerank = createMatcher({
      databaseUrl: databaseUrl!,
      apiKey: "test-api-key-12345",
      migrate: "eager",
      embed: async ({ text, dim }) => stubEmbed(text, dim),
    });
    await matcherNoRerank.migrate();
    schemaName = (await matcherNoRerank.apply(slug, { entities: [], collections: [coll] })).schema;

    matcher = createMatcher({
      databaseUrl: databaseUrl!,
      apiKey: "test-api-key-12345",
      migrate: "eager",
      embed: async ({ text, dim }) => stubEmbed(text, dim),
      generate: stubGenerate,
      rerank: fashionRerank(stubGenerate),
    });
    await matcher.migrate();
    await matcher.apply(slug, { entities: [], collections: [coll] });

    await matcher.indexDocuments(slug, "products", [
      {
        id: "good",
        data: { title: "red silk dress" },
        doc: "red silk dress",
        embedding: stubEmbed("red silk dress", 8),
        fields: { title: "red silk dress" },
      },
      {
        id: "bad",
        data: { title: "blue denim jacket" },
        doc: "blue denim jacket",
        embedding: stubEmbed("blue denim jacket", 8),
        fields: { title: "blue denim jacket" },
      },
    ]);
    const { db, close } = createDbFromUrl(databaseUrl!);
    await db.execute(sql.raw(`UPDATE ${schemaName}.c_products SET fts_src = doc WHERE doc IS NOT NULL`));
    await close();
  }, 60_000);

  afterAll(async () => {
    if (schemaName) {
      const { db, close } = createDbFromUrl(databaseUrl!);
      await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`));
      await close();
    }
    await matcher?.close();
    await matcherNoRerank?.close();
  });

  test("fashionRerank(stubGenerate) promotes judged-relevant hit", async () => {
    const res = await matcher.search(slug, "products", { q: "red dress", limit: 2 });
    expect(res.hits[0]!.id).toBe("good");
  });

  test("rerank:false keeps pure RRF order", async () => {
    const rrf = await matcher.search(slug, "products", { q: "red dress", limit: 2, rerank: false });
    const pure = await matcherNoRerank.search(slug, "products", { q: "red dress", limit: 2 });
    expect(rrf.hits.map((h) => h.id)).toEqual(pure.hits.map((h) => h.id));
  });

  test("absent rerank config yields RRF (no regression)", async () => {
    const pure = await matcherNoRerank.search(slug, "products", { q: "red dress", limit: 2 });
    expect(pure.hits.length).toBeGreaterThan(0);
  });
});

describe("fashionRerank unit", () => {
  test("maps judge grades to [0,1] scores", async () => {
    const generate: GenerateFn = async () => ({
      grades: [{ id: "a", grade: 2, facets: {}, reason: "ok" }],
    });
    const rerank = fashionRerank(generate);
    const out = await rerank({
      query: "q",
      candidates: [{ id: "a", text: "t", data: {}, score: 0.1 }],
      topK: 5,
    });
    expect(out).toEqual([{ id: "a", score: 1 }]);
  });
});
