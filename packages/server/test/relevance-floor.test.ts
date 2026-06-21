import "./load-env.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { collection, f, Channels, pipeline, stage } from "../../sdk/src/index.ts";
import { createMatcher } from "../src/createMatcher.ts";
import { createDbFromUrl } from "../src/db/client.ts";
import { denseAndFtsIndexingByTitle } from "./fixtures.ts";

const databaseUrl = process.env.DATABASE_URL;
const describeIf = databaseUrl ? describe : describe.skip;

// Deterministic 8-d basis vectors so cosines are exact: each doc gets its own
// axis (orthogonal → cosine 0 between unrelated items, 1 for an exact query).
function axis(i: number): number[] {
  const v = new Array(8).fill(0);
  v[i] = 1;
  return v;
}
const VEC: Record<string, number[]> = {
  "alpha bravo charlie": axis(0),
  "delta echo foxtrot": axis(1),
  "golf hotel india": axis(2),
  delta: axis(5), // orthogonal to every doc → only FTS can surface d2
  "0192 3847 5601": axis(6), // orthogonal to every doc → must be floored
};

// An absolute cosine floor suppresses no-match padding: a query with no real
// match returns nothing instead of the nearest neighbours, while keyword (FTS)
// matches stay exempt from the floor.
describeIf("search relevanceFloor", () => {
  const projectSlug = `t_${Math.random().toString(36).slice(2, 10)}`;
  let schemaName = "";
  let matcher: ReturnType<typeof createMatcher>;

  const coll = collection("products", {
    fields: { title: f.text({ searchable: true }) },
    enrich: pipeline(stage("noop", { prompt: () => "noop", schema: () => ({ type: "object" }) })),
    indexing: denseAndFtsIndexingByTitle,
    embeddings: { doc: { model: `floortest-${projectSlug}`, dim: 8 } },
    search: {
      channels: [
        Channels.fts({ fields: ["title"], weight: 1 }),
        Channels.cosine({ embedding: "doc", weight: 1 }),
      ],
      relevanceFloor: 0.6,
    },
  });

  const docs = ["alpha bravo charlie", "delta echo foxtrot", "golf hotel india"];

  beforeAll(async () => {
    matcher = createMatcher({
      databaseUrl: databaseUrl!,
      apiKey: "test-api-key-12345",
      migrate: "eager",
      embed: async ({ text }) => VEC[(text ?? "").trim()] ?? axis(7),
      generate: async () => ({}),
    });
    await matcher.migrate();
    schemaName = (await matcher.apply(projectSlug, { entities: [], collections: [coll] })).schema;
    await matcher.pushDocuments(
      projectSlug,
      "products",
      docs.map((title, i) => ({ id: `d${i + 1}`, data: { title, content_hash: `h${i}` } }))
    );
    await matcher.enrich(projectSlug, "products"); // composes doc + fts_src surfaces
    await matcher.index(projectSlug, "products"); // embeds doc text via the controlled embed fn
  }, 20_000);

  afterAll(async () => {
    if (schemaName) {
      const { db, close } = createDbFromUrl(databaseUrl!);
      await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`));
      await close();
    }
    if (matcher) await matcher.close();
  });

  test("a strong match clears the floor", async () => {
    const res = await matcher.search(projectSlug, "products", { q: "alpha bravo charlie", limit: 5 });
    expect((res.hits as { id: string }[]).some((h) => h.id === "d1")).toBe(true);
  });

  test("a no-match query returns nothing instead of nearest-neighbour padding", async () => {
    const res = await matcher.search(projectSlug, "products", { q: "0192 3847 5601", limit: 5 });
    expect(res.hits.length).toBe(0);
  });

  test("an FTS keyword match is exempt from the floor (cosine 0, FTS surfaces it)", async () => {
    const res = await matcher.search(projectSlug, "products", { q: "delta", limit: 5 });
    expect((res.hits as { id: string }[]).some((h) => h.id === "d2")).toBe(true);
  });

  // Regression: relevanceFloor must not add a dangling SQL param in explain mode.
  test("searchExplain does not error when relevanceFloor is set", async () => {
    const ex = await matcher.searchExplain(projectSlug, "products", { q: "alpha bravo charlie", limit: 5 });
    expect(Array.isArray((ex as { docs?: unknown[] }).docs)).toBe(true);
  });
});
