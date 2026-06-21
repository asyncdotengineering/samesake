import "./load-env.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { collection, f, Channels, pipeline, stage } from "../../sdk/src/index.ts";
import { createMatcher } from "../src/createMatcher.ts";
import { createDbFromUrl } from "../src/db/client.ts";
import { denseAndFtsIndexingByTitle } from "./fixtures.ts";

const databaseUrl = process.env.DATABASE_URL;
const describeIf = databaseUrl ? describe : describe.skip;

// Structured-intent bypass: when the query derives hard filters (price/etc.), the
// semantic floor must be skipped so a filter-dominated query is not emptied — even
// when the residual semantic intent has near-zero cosine to every document.
describeIf("relevanceFloor structured-intent bypass", () => {
  const projectSlug = `t_${Math.random().toString(36).slice(2, 10)}`;
  let schemaName = "";
  let matcher: ReturnType<typeof createMatcher>;

  // orthogonal basis vectors → exact cosines; "widget" intent is orthogonal to every doc.
  const axis = (i: number) => { const v = new Array(8).fill(0); v[i] = 1; return v; };
  const VEC: Record<string, number[]> = { alpha: axis(0), beta: axis(1), widget: axis(7) };

  const coll = collection("products", {
    fields: { title: f.text({ searchable: true }), price: f.number({ filterable: true }) },
    enrich: pipeline(stage("noop", { prompt: () => "noop", schema: () => ({ type: "object" }) })),
    indexing: denseAndFtsIndexingByTitle,
    embeddings: { doc: { model: `floorbypass-${projectSlug}`, dim: 8 } },
    search: {
      channels: [
        Channels.fts({ fields: ["title"], weight: 1 }),
        Channels.cosine({ embedding: "doc", weight: 1 }),
      ],
      relevanceFloor: 0.6,
      nlq: {
        instructions: "extract price",
        schema: {
          type: "object",
          properties: { max_price: { type: ["number", "null"] }, semantic_query: { type: "string" } },
          required: ["semantic_query"],
        },
      },
    },
  });

  beforeAll(async () => {
    matcher = createMatcher({
      databaseUrl: databaseUrl!,
      apiKey: "test-api-key-12345",
      migrate: "eager",
      embed: async ({ text }) => VEC[(text ?? "").trim()] ?? axis(6),
      // NLQ stub: a "under N" query derives a max_price filter; otherwise none.
      generate: async ({ prompt }) =>
        (prompt ?? "").includes("under")
          ? { max_price: 100, semantic_query: "widget" }
          : { semantic_query: "widget" },
    });
    await matcher.migrate();
    schemaName = (await matcher.apply(projectSlug, { entities: [], collections: [coll] })).schema;
    await matcher.pushDocuments(projectSlug, "products", [
      { id: "alpha", data: { title: "alpha", price: 50, content_hash: "a" } },
      { id: "beta", data: { title: "beta", price: 200, content_hash: "b" } },
    ]);
    await matcher.enrich(projectSlug, "products");
    await matcher.index(projectSlug, "products");
  }, 20_000);

  afterAll(async () => {
    if (schemaName) {
      const { db, close } = createDbFromUrl(databaseUrl!);
      await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`));
      await close();
    }
    if (matcher) await matcher.close();
  });

  test("a filter-derived query is NOT emptied by the floor (bypass)", async () => {
    // residual intent "widget" is orthogonal to every doc (cosine 0 < 0.6); only the
    // derived price filter (<=100) should narrow — the floor must not zero it out.
    const res = await matcher.search(projectSlug, "products", { q: "anything under 100" });
    const ids = (res.hits as { id: string }[]).map((h) => h.id);
    expect(ids).toContain("alpha"); // price 50 — kept by the filter, not floored
    expect(ids).not.toContain("beta"); // price 200 — excluded by the filter
  });

  test("the same query WITHOUT a derived filter is floored to empty (no bypass)", async () => {
    const res = await matcher.search(projectSlug, "products", { q: "widget nomatch" });
    expect(res.hits.length).toBe(0);
  });
});
