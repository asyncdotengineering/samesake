import "./load-env.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { collection, f, Channels, gates, type CollectionDef } from "../../sdk/src/index.ts";
import { createMatcher } from "../src/createMatcher.ts";
import { createDbFromUrl } from "../src/db/client.ts";
import { stubEmbed } from "./fixtures.ts";

const databaseUrl = process.env.SAMESAKE_DATABASE_URL;
const describeIf = databaseUrl ? describe : describe.skip;

const prims = collection("products", {
  fields: {
    title: f.text({ searchable: true }),
    style_id: f.text({ filterable: true }),
    rank: f.number({ filterable: true }),
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
    variantGroup: "style_id",
  },
}) as CollectionDef & { name: string };

const DOCS = [
  { id: "1", title: "red cocktail dress", style_id: "S1", rank: 3 },
  { id: "2", title: "red cocktail dress short", style_id: "S1", rank: 1 },
  { id: "3", title: "red cocktail dress long", style_id: "S1", rank: 2 },
  { id: "4", title: "green linen wallet", style_id: "S2", rank: 4 },
  { id: "5", title: "blue denim jacket", style_id: "S3", rank: 5 },
];

async function indexInto(
  matcher: ReturnType<typeof createMatcher>,
  slug: string,
  schemaName: string
) {
  await matcher.indexDocuments(
    slug,
    "products",
    DOCS.map((d) => ({
      id: d.id,
      data: { title: d.title, rank: d.rank },
      doc: d.title,
      embedding: stubEmbed(d.title, 8),
      fields: { title: d.title, style_id: d.style_id, rank: d.rank },
    }))
  );
  const { db, close } = createDbFromUrl(databaseUrl!);
  await db.execute(sql.raw(`UPDATE ${schemaName}.c_products SET fts_src = doc WHERE doc IS NOT NULL`));
  await close();
}

describeIf("search primitives", () => {
  const slug = `t_${Math.random().toString(36).slice(2, 10)}`;
  const slugR = `t_${Math.random().toString(36).slice(2, 10)}`;
  let schemaName = "";
  let schemaNameR = "";
  let matcher: ReturnType<typeof createMatcher>;
  let matcherR: ReturnType<typeof createMatcher>;

  beforeAll(async () => {
    matcher = createMatcher({
      databaseUrl: databaseUrl!,
      apiKey: "test-api-key-12345",
      migrate: "eager",
      embed: async ({ text, dim }) => stubEmbed(text, dim),
    });
    await matcher.migrate();
    schemaName = (await matcher.apply(slug, { entities: [], collections: [prims] })).schema;
    await indexInto(matcher, slug, schemaName);

    // A second matcher wired with a deterministic reranker: lower `rank` field = better.
    matcherR = createMatcher({
      databaseUrl: databaseUrl!,
      apiKey: "test-api-key-12345",
      migrate: "eager",
      embed: async ({ text, dim }) => stubEmbed(text, dim),
      rerank: async ({ candidates }) =>
        candidates.map((c) => ({
          id: c.id,
          score: 1 / Number((c.data as { rank?: number }).rank ?? 99),
        })),
    });
    await matcherR.migrate();
    schemaNameR = (await matcherR.apply(slugR, { entities: [], collections: [prims] })).schema;
    await indexInto(matcherR, slugR, schemaNameR);
  }, 60_000);

  afterAll(async () => {
    const { db, close } = createDbFromUrl(databaseUrl!);
    if (schemaName) await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`));
    if (schemaNameR) await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schemaNameR} CASCADE`));
    await close();
    await matcher.close();
    await matcherR.close();
  });

  test("FTS soft-OR: a multi-term query matches docs sharing any term (not all)", async () => {
    // No doc contains all of red+linen+jacket; old plainto_tsquery (AND) returned nothing.
    const res = await matcher.search(slug, "products", {
      q: "red linen jacket",
      weights: { fts: 1, cosine: 0 },
      mode: "intent",
      diversify: false,
      limit: 10,
    });
    expect(res.hits.length).toBeGreaterThan(0);
  });

  test("diversify: collapses variants of the same style by default; off returns all", async () => {
    const collapsed = await matcher.search(slug, "products", { q: "red cocktail dress", limit: 10 });
    const s1 = collapsed.hits.filter((h) => h.style_id === "S1");
    expect(s1.length).toBe(1);

    const all = await matcher.search(slug, "products", { q: "red cocktail dress", limit: 10, diversify: false });
    expect(all.hits.filter((h) => h.style_id === "S1").length).toBeGreaterThan(1);
  });

  test("rerank: blend preserves RRF head; rerank:false is pure RRF", async () => {
    const pure = await matcher.search(slug, "products", {
      q: "red cocktail dress",
      diversify: false,
      limit: 5,
    });
    const rrfOnly = await matcherR.search(slugR, "products", {
      q: "red cocktail dress",
      diversify: false,
      limit: 5,
      rerank: false,
    });
    const blended = await matcherR.search(slugR, "products", {
      q: "red cocktail dress",
      diversify: false,
      limit: 5,
    });
    expect(rrfOnly.hits.map((h) => h.id)).toEqual(pure.hits.map((h) => h.id));
    expect(blended.hits[0]!.id).toBe(pure.hits[0]!.id);
  });

  test("calibrateSearch: sweeps the grid and returns a recommendation (labels, no LLM)", async () => {
    const queries: Array<{ q: string; relevant: Record<string, number> }> = [
      { q: "red cocktail dress", relevant: { "1": 3, "2": 2, "3": 2 } },
      { q: "denim jacket", relevant: { "5": 3 } },
    ];
    const out = await matcher.calibrateSearch(slug, "products", {
      queries,
      grid: [
        { name: "intent", mode: "intent" as const },
        { name: "fts0", weights: { fts: 0 } },
      ],
    });
    expect(out.results.length).toBe(2);
    expect(out.recommended.name).toBeDefined();
    expect(out.results.every((r) => r.ndcg >= 0 && r.ndcg <= 1)).toBe(true);
  });
});
