import "./load-env.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { collection, f, Channels } from "../../sdk/src/index.ts";
import type { MatcherCtx } from "../src/types.ts";
import { createMatcher } from "../src/createMatcher.ts";
import { makeCollectionsSchemaGen } from "../src/core/collections-schema-gen.ts";
import { deriveNlqSchema, parseNlq } from "../src/core/nlq.ts";
import { parseSearchWeights, resolveAspectPlans } from "../src/core/search-query.ts";
import type { NlqParseResult } from "../src/core/nlq.ts";
import { createDbFromUrl } from "../src/db/client.ts";
import { stubEmbed } from "./fixtures.ts";

const databaseUrl = process.env.SAMESAKE_DATABASE_URL;
const describeIf = databaseUrl ? describe : describe.skip;

const aspectCollection = collection("products", {
  fields: {
    title: f.text({ searchable: true }),
    price: f.number({ filterable: true }),
  },
  embeddings: {
    doc: { model: "test-embed", dim: 8 },
    visual: { kind: "image", model: "test-embed", dim: 8 },
    facets: {
      model: "test-embed",
      dim: 8,
      evidence: true,
      extract: ({ enriched }: { enriched: Record<string, unknown> }) => [String(enriched.claim ?? "")].filter(Boolean),
    },
  } as const,
  search: {
    channels: [
      Channels.fts({ fields: ["title"], weight: 1 }),
      Channels.cosine({ embedding: "doc", weight: 1 }),
      Channels.cosine({ embedding: "visual", weight: 1 }),
      Channels.cosine({ embedding: "facets", weight: 1 }),
    ],
    combiner: "rrf",
    nlq: { enable: true },
  },
});

describe("test:aspect-config", () => {
  test("validates evidence and preserves embedding order", () => {
    expect(Object.keys(aspectCollection.embeddings ?? {})).toEqual(["doc", "visual", "facets"]);
    expect(aspectCollection.embeddings?.facets?.evidence).toBe(true);
    expect(() =>
      collection("bad", {
        fields: { title: f.text() },
        embeddings: {
          doc: { model: "m", dim: 8, evidence: true, extract: () => ["x"] },
        },
        search: { channels: [] },
      })
    ).toThrow(/first embedding cannot use evidence/);
    expect(() =>
      collection("bad", {
        fields: { title: f.text() },
        embeddings: {
          doc: { model: "m", dim: 8, extract: () => ["x"] },
        },
        search: { channels: [] },
      })
    ).toThrow(/extract without evidence/);
  });
});

describe("test:aspect-ddl", () => {
  const gen = makeCollectionsSchemaGen({ projectPrefix: "project_", systemSchema: "public", hasPhonetic: false });

  test("single embedding keeps the legacy DDL snapshot", () => {
    const one = collection("products", {
      fields: { title: f.text({ searchable: true }) },
      embeddings: { doc: { model: "m", dim: 8 } },
      search: { channels: [Channels.cosine({ embedding: "doc", weight: 1 })] },
    });
    const statements = gen.collectionTableDDL("project_demo", one);
    expect(createHash("sha256").update(JSON.stringify(statements)).digest("hex")).toBe(
      "e2a7970e47daf5baec98cbc1eebb8f1b2c1f4989e7d07b8ed05a7cc426fa529a"
    );
  });

  test("no-open-vocab collections keep the legacy system-column DDL snapshot", () => {
    expect(
      createHash("sha256")
        .update(JSON.stringify(gen.ensureCollectionSystemColumns("project_demo", "products", aspectCollection)))
        .digest("hex")
    ).toBe("b91e0a8053498afd693ced9e43bb8519a52cbf3ae723e372e07fab2d87abc53c");
  });

  test("multi-aspect DDL emits named columns and evidence storage", () => {
    const ddl = gen.collectionTableDDL("project_demo", aspectCollection).join("\n");
    expect(ddl).toContain("emb_visual halfvec(8)");
    expect(ddl).toContain("c_products_emb_visual_idx");
    expect(ddl).toContain("c_products_evidence");
    expect(ddl).toContain("aspect text NOT NULL");
    expect(ddl).toContain("vec halfvec(8) NOT NULL");
    expect(ddl).not.toContain("space_vec");
  });
});

describe("test:nlq-aspects", () => {
  test("derives aspect schema and normalizes unknown or malformed routes", async () => {
    const schema = deriveNlqSchema(aspectCollection) as { properties: Record<string, any> };
    expect(schema.properties.aspects.properties.visual.description).toContain("visual");
    const ctx = {
      generateConfigured: true,
      generate: async () => ({
        semantic_query: "floral dress",
        aspects: {
          visual: { subQuery: "floral silhouette", weight: 2 },
          missing: { weight: 1 },
          facets: { weight: "bad" },
        },
      }),
    } as unknown as MatcherCtx;
    const parsed = await parseNlq(ctx, aspectCollection, "floral wedding dress");
    expect(parsed.parsed.aspects).toEqual({
      visual: { subQuery: "floral silhouette", weight: 1 },
      facets: { weight: 0 },
    });
  });
});

describe("test:routing", () => {
  const nlq = (aspects?: NlqParseResult["parsed"]["aspects"], degraded = false): NlqParseResult => ({
    parsed: { semantic_query: "floral dress", ...(aspects ? { aspects } : {}) },
    degraded,
    filters: {},
    deterministicFilters: {},
    groundedValues: {},
    excludeTerms: [],
    budgetHints: {},
  });
  const embedCalls: Array<{ text?: string; image?: unknown }> = [];
  const embedService = {
    embedQuery: async (request: { text?: string; image?: unknown; dim: number }) => {
      embedCalls.push({ text: request.text, image: request.image });
      return stubEmbed(request.text, request.dim);
    },
  } as any;

  test("confident routing multiplies weights and uses focused subqueries", async () => {
    embedCalls.length = 0;
    // Intent-mode non-primary aspects are OFF by default (C9 gate verdict); the per-query
    // aspects override is the sanctioned way to enable them for routing experiments.
    const weights = parseSearchWeights(aspectCollection, { aspects: { visual: 1 } }, "intent", false);
    const plans = await resolveAspectPlans(
      aspectCollection,
      weights,
      nlq({ doc: { weight: 1 }, visual: { subQuery: "silhouette", weight: 0.5 } }),
      "floral wedding dress",
      "floral wedding dress",
      "intent",
      false,
      {},
      embedService
    );
    expect(plans.map((plan) => [plan.name, plan.weight])).toEqual([["doc", 1], ["visual", 0.5]]);
    expect(embedCalls.map((call) => call.text)).toEqual(["floral wedding dress", "silhouette"]);
  });

  test("successful short parses route normally while degraded parses use the first aspect", async () => {
    const weights = parseSearchWeights(aspectCollection, { aspects: { visual: 1 } }, "intent", false);
    embedCalls.length = 0;
    const plans = await resolveAspectPlans(
      aspectCollection,
      weights,
      nlq({ visual: { subQuery: "silhouette", weight: 0.5 } }),
      "nike",
      "nike",
      "intent",
      false,
      {},
      embedService
    );
    expect(plans.map((plan) => plan.name)).toEqual(["doc", "visual"]);
    expect(embedCalls).toHaveLength(2);

    const degraded = await resolveAspectPlans(
      aspectCollection,
      weights,
      nlq({ visual: { weight: 1 } }, true),
      "floral dress",
      "floral dress",
      "intent",
      false,
      {},
      embedService
    );
    expect(degraded.map((plan) => plan.name)).toEqual(["doc"]);
  });
});

describe("test:no-spaces-gate", () => {
  test("contains no removed spaces symbols in active SDK or server core", () => {
    const repoRoot = join(import.meta.dir, "../../..");
    const paths = [
      "packages/server/src/core",
      "packages/sdk/src",
    ];
    const symbols = /space_vec|SpacesChannel|spaceSegmentWeights|buildQuerySpace/;
    const offenders: string[] = [];
    for (const relative of paths) {
      const files = Bun.spawnSync(["rg", "--files", join(repoRoot, relative)])
        .stdout.toString()
        .trim()
        .split("\n")
        .filter(Boolean);
      for (const file of files) {
        if (symbols.test(readFileSync(file, "utf8"))) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describeIf("test:aspect-index and test:aspect-leg-sql and test:maxsim-leg and test:explain-aspects", () => {
  const projectSlug = `t_${Math.random().toString(36).slice(2, 10)}`;
  let matcher: ReturnType<typeof createMatcher>;
  let schemaName = "";

  beforeAll(async () => {
    matcher = createMatcher({
      databaseUrl: databaseUrl!,
      apiKey: "test-api-key-12345",
      migrate: "eager",
      embed: async ({ text, dim }) => stubEmbed(text, dim),
    });
    await matcher.migrate();
    schemaName = (await matcher.apply(projectSlug, { entities: [], collections: [aspectCollection] })).schema;
    const filtered = Array.from({ length: 20 }, (_, index) => ({
      id: `filtered-${index}`,
      data: { title: `filtered ${index}`, price: 999 },
      doc: `filtered ${index}`,
      embeddings: { doc: stubEmbed(`filtered ${index}`, 8), visual: stubEmbed(`filtered ${index}`, 8) },
      evidence: { facets: [{ src: "needle", vector: stubEmbed("needle", 8) }] },
      fields: { title: `filtered ${index}`, price: 999 },
    }));
    await matcher.indexDocuments(projectSlug, "products", [
      ...filtered,
      {
        id: "target",
        data: { title: "target", price: 5 },
        doc: "target",
        embeddings: { doc: stubEmbed("target", 8), visual: stubEmbed("target", 8) },
        evidence: {
          facets: [
            { src: "mediocre", vector: stubEmbed("other", 8) },
            { src: "needle", vector: stubEmbed("needle", 8) },
          ],
        },
        fields: { title: "target", price: 5 },
      },
    ]);
  }, 30_000);

  afterAll(async () => {
    if (schemaName) {
      const { db, close } = createDbFromUrl(databaseUrl!);
      await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`));
      await close();
    }
    if (matcher) await matcher.close();
  });

  test("test:aspect-index replaces evidence rows on reindex", async () => {
    const row = (src: string) => ({
      id: "reindex",
      data: { title: "reindex", price: 5 },
      doc: "reindex",
      embeddings: { doc: stubEmbed("reindex", 8), visual: stubEmbed("reindex", 8) },
      evidence: { facets: [{ src, vector: stubEmbed(src, 8) }] },
      fields: { title: "reindex", price: 5 },
    });
    await matcher.indexDocuments(projectSlug, "products", [row("old claim")]);
    await matcher.indexDocuments(projectSlug, "products", [row("new claim")]);
    const { db, close } = createDbFromUrl(databaseUrl!);
    const rows = await db.execute<{ src: string }>(sql.raw(
      `SELECT src FROM ${schemaName}.c_products_evidence WHERE doc_id = 'reindex' ORDER BY ord`
    ));
    await close();
    expect(Array.from(rows)).toEqual([{ src: "new claim" }]);
  });

  test("test:aspect-leg-sql emits only weighted aspect legs", async () => {
    const result = await matcher.searchExplain(projectSlug, "products", {
      q: "target",
      mode: "similar",
      limit: 3,
      weights: { fts: 0, aspects: { doc: 1, visual: 0, facets: 0 } },
    });
    expect(result.docs[0]?.aspect_ranks?.doc).toEqual(expect.any(Object));
    expect(result.docs[0]?.aspect_ranks?.visual?.rank).toBeNull();
    expect(result.docs[0]?.aspect_ranks?.facets?.rank).toBeNull();
  });

  test("MaxSim uses the best evidence row and survives a selective filter", async () => {
    const result = await matcher.search(projectSlug, "products", {
      q: "needle",
      mode: "similar",
      limit: 3,
      diversify: false,
      weights: { fts: 0, aspects: { doc: 0, visual: 0, facets: 1 } },
      filters: { price: { $lte: 10 } },
    });
    expect(result.hits[0]?.id).toBe("target");
  });

  test("explain includes every declared aspect", async () => {
    const result = await matcher.searchExplain(projectSlug, "products", {
      q: "target",
      mode: "similar",
      limit: 3,
      weights: { fts: 0, aspects: { doc: 1, visual: 1, facets: 1 } },
    });
    expect(result.docs[0]?.aspect_ranks).toEqual(expect.objectContaining({
      doc: expect.any(Object),
      visual: expect.any(Object),
      facets: expect.any(Object),
    }));
  });
});
