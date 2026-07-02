import "./load-env.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { collection, f, Channels } from "@samesake/core";
import { createMatcher } from "../src/createMatcher.ts";
import { createDbFromUrl } from "../src/db/client.ts";
import { applyCutoff, type CutoffEvidence } from "../src/core/cutoff.ts";

// ── Pure strategy unit tests (no DB) ────────────────────────────────────
describe("applyCutoff strategies", () => {
  const hitIds = ["a", "b", "c", "d"];
  const ev = (
    ftsPresent: boolean,
    cos: number | null,
    value?: unknown
  ): CutoffEvidence => ({ ftsPresent, cos, value });

  test("score-drop: relative cliff cuts the semantic tail, fts hits survive", () => {
    const evidence = [ev(false, 0.9), ev(false, 0.85), ev(true, 0.2), ev(false, 0.2)];
    const { hits, dropped } = applyCutoff(hitIds, evidence, { strategy: "score-drop" });
    // d (cos 0.2 after 0.85, no fts) is cut; c survives the cliff via fts anchor.
    expect(hits).toEqual(["a", "b", "c"]);
    expect(dropped).toBe(1);
  });

  test("score-drop: smooth score decay is untouched", () => {
    const evidence = [ev(false, 0.9), ev(false, 0.8), ev(false, 0.7), ev(false, 0.6)];
    const { hits, dropped } = applyCutoff(hitIds, evidence, { strategy: "score-drop" });
    expect(hits).toEqual(hitIds);
    expect(dropped).toBe(0);
  });

  test("category-coherence: unanchored + scattered (above anchor floor) cuts to zero", () => {
    const evidence = [
      ev(false, 0.6, "bags"),
      ev(false, 0.6, "dresses"),
      ev(false, 0.6, "shirts"),
      ev(false, 0.6, "accessories"),
    ];
    const { hits, dropped } = applyCutoff(hitIds, evidence, {
      strategy: "category-coherence",
      field: "category",
    });
    expect(hits).toEqual([]);
    expect(dropped).toBe(4);
  });

  test("category-coherence: coherent majority survives", () => {
    const evidence = [
      ev(false, 0.6, "dresses"),
      ev(false, 0.6, "dresses"),
      ev(false, 0.6, "dresses"),
      ev(false, 0.6, "bags"),
    ];
    const { hits, dropped } = applyCutoff(hitIds, evidence, {
      strategy: "category-coherence",
      field: "category",
    });
    expect(hits).toEqual(hitIds);
    expect(dropped).toBe(0);
  });

  test("category-coherence without field is a config error", () => {
    expect(() =>
      applyCutoff(hitIds, [ev(false, 0.6, "x")], { strategy: "category-coherence" })
    ).toThrow("requires `field`");
  });
});

const databaseUrl = process.env.SAMESAKE_DATABASE_URL;
const describeIf = databaseUrl ? describe : describe.skip;

// Deterministic token+trigram hash embed: queries sharing vocabulary with a doc
// land close; disjoint vocabulary ("laptop" vs a clothing catalog) lands near
// orthogonal. This makes honest-zero behavior provable without a live model.
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function hashEmbed(text: string, dim: number): number[] {
  const v = new Array<number>(dim).fill(0);
  for (const tok of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    v[hash(tok) % dim]! += 1;
    for (let i = 0; i + 3 <= tok.length; i++) v[hash(tok.slice(i, i + 3)) % dim]! += 0.25;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

const CLOTHING = [
  { id: "d1", title: "red evening dress", category: "dresses" },
  { id: "d2", title: "green summer dress", category: "dresses" },
  { id: "d3", title: "navy linen blazer", category: "jackets" },
  { id: "d4", title: "black leather handbag", category: "bags" },
  { id: "d5", title: "canvas shoulder bag", category: "bags" },
  { id: "d6", title: "white cotton shirt", category: "shirts" },
  { id: "d7", title: "wool winter scarf", category: "accessories" },
  { id: "d8", title: "silver chain necklace", category: "accessories" },
];

function clothingCollection(name: string, cutoff?: Record<string, unknown>) {
  return collection(name, {
    fields: {
      title: f.text({ searchable: true }),
      category: f.text({ filterable: true }),
    },
    embeddings: {
      doc: { source: "$title $category", model: "stub", dim: 256 },
    },
    search: {
      channels: [
        Channels.fts({ fields: ["title"], weight: 1 }),
        Channels.cosine({ embedding: "doc", weight: 1 }),
      ],
      combiner: "rrf",
      ...(cutoff ? { cutoff } : {}),
    },
  });
}

// The adversarial case from the plan (Digitec via MICES): "laptop" against a
// clothing catalog must return an honest zero, not the three least-irrelevant
// handbags.
describeIf("result cutoff — honest zero-results", () => {
  const projectSlug = `t_${Math.random().toString(36).slice(2, 10)}`;
  let schemaName = "";
  let matcher: ReturnType<typeof createMatcher>;

  const products = clothingCollection("products"); // default cutoff (score-drop)
  const productsOpen = clothingCollection("products_open", { strategy: "none" });
  const productsCoh = clothingCollection("products_coh", {
    strategy: "category-coherence",
    field: "category",
  });

  beforeAll(async () => {
    matcher = createMatcher({
      databaseUrl: databaseUrl!,
      apiKey: "cutoff-test-key",
      migrate: "eager",
      embed: async ({ text, dim }) => hashEmbed(text ?? "", dim),
    });
    await matcher.migrate();
    const applied = await matcher.apply(projectSlug, {
      entities: [],
      collections: [products, productsOpen, productsCoh],
    });
    schemaName = applied.schema;
    for (const coll of ["products", "products_open", "products_coh"]) {
      await matcher.pushDocuments(
        projectSlug,
        coll,
        CLOTHING.map(({ id, ...data }) => ({ id, data }))
      );
      const { indexed } = await matcher.index(projectSlug, coll);
      expect(indexed).toBe(CLOTHING.length);
    }
  }, 120000);

  afterAll(async () => {
    if (schemaName) {
      const { db, close } = createDbFromUrl(databaseUrl!);
      await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`));
      await close();
    }
    await matcher.close();
  });

  test("default (score-drop): off-catalog query returns zero, not nearest neighbours", async () => {
    const res = await matcher.search(projectSlug, "products", { q: "laptop", limit: 5 });
    expect(res.hits.length).toBe(0);
    expect(res.cutoff_dropped ?? 0).toBeGreaterThan(0);
  });

  test("default (score-drop): anchored query still returns results", async () => {
    const res = await matcher.search(projectSlug, "products", { q: "red dress", limit: 5 });
    expect(res.hits.length).toBeGreaterThan(0);
    expect(res.hits[0]!.id).toBe("d1");
  });

  test('strategy "none" opts out — padding comes back', async () => {
    const res = await matcher.search(projectSlug, "products_open", { q: "laptop", limit: 5 });
    expect(res.hits.length).toBeGreaterThan(0);
    expect(res.cutoff_dropped).toBeUndefined();
  });

  test("hard filters bypass the cutoff — filtered recall stays total", async () => {
    const res = await matcher.search(projectSlug, "products", {
      q: "laptop",
      filters: { category: "bags" },
      limit: 5,
    });
    expect(res.hits.map((h) => h.id).sort()).toEqual(["d4", "d5"]);
  });

  test("category-coherence: scattered unanchored results cut to zero", async () => {
    const res = await matcher.search(projectSlug, "products_coh", { q: "laptop", limit: 5 });
    expect(res.hits.length).toBe(0);
    expect(res.cutoff_dropped ?? 0).toBeGreaterThan(0);
  });

  test("category-coherence: anchored query unaffected", async () => {
    const res = await matcher.search(projectSlug, "products_coh", { q: "summer dress", limit: 5 });
    expect(res.hits.length).toBeGreaterThan(0);
    expect(res.hits[0]!.category).toBe("dresses");
  });
});
