import "./load-env.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { collection, f, Channels, gates } from "../../sdk/src/index.ts";
import { createMatcher } from "../src/createMatcher.ts";
import { createDbFromUrl } from "../src/db/client.ts";
import { stubEmbed } from "./fixtures.ts";

const databaseUrl = process.env.SAMESAKE_DATABASE_URL;
const describeIf = databaseUrl ? describe : describe.skip;

const rankingCollection = collection("ranked", {
  fields: {
    title: f.text({ searchable: true }),
    available: f.boolean({ filterable: true }),
    margin: f.number({ filterable: true }),
  },
  indexing: {
    surfaces: {
      embed_doc: { kind: "dense", embedding: "doc", build: ({ data }) => String(data.title ?? "").trim() },
      fts_doc: { kind: "fts", build: ({ data }) => String(data.title ?? "").trim() },
    },
    gate: gates.always,
  },
  embeddings: {
    doc: { model: "test-embed", dim: 8 },
  },
  search: {
    channels: [
      Channels.fts({ fields: ["title"], weight: 1 }),
      Channels.cosine({ embedding: "doc", weight: 1 }),
    ],
    rankingPolicy: {
      businessField: "margin",
      weights: { relevance: 1, business: 5 },
      hardAxes: [],
      softAxes: ["business"],
    },
  },
});

describeIf("core search rankingPolicy hook", () => {
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
      collections: [rankingCollection],
    });
    schemaName = r.schema;
    await matcher.indexDocuments(projectSlug, "ranked", [
      {
        id: "weak-margin",
        data: { title: "red running shoes premium edition" },
        doc: "red running shoes premium edition",
        embedding: stubEmbed("red running shoes premium edition", 8),
        fields: { title: "red running shoes premium edition", available: true, margin: 0.1 },
      },
      {
        id: "strong-margin",
        data: { title: "red running shoes" },
        doc: "red running shoes",
        embedding: stubEmbed("red running shoes", 8),
        fields: { title: "red running shoes", available: true, margin: 1 },
      },
    ]);
    const { db, close } = createDbFromUrl(databaseUrl!);
    await db.execute(sql.raw(`UPDATE ${schemaName}.c_ranked SET fts_src = title`));
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

  test("test:core-ranking-policy collection hook reorders post-fusion hits", async () => {
    const withPolicy = await matcher.search(projectSlug, "ranked", {
      q: "red running shoes",
      limit: 2,
      rerank: false,
    });
    expect(withPolicy.hits[0]!.id).toBe("strong-margin");
  });
});

describeIf("core search without rankingPolicy", () => {
  const projectSlug = `t_${Math.random().toString(36).slice(2, 10)}`;
  let schemaName = "";
  let matcher: ReturnType<typeof createMatcher>;

  const plainCollection = collection("plain", {
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
    embeddings: {
      doc: { model: "test-embed", dim: 8 },
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
      collections: [plainCollection],
    });
    schemaName = r.schema;
    await matcher.indexDocuments(projectSlug, "plain", [
      {
        id: "a",
        data: { title: "alpha item" },
        doc: "alpha item",
        embedding: stubEmbed("alpha item", 8),
        fields: { title: "alpha item" },
      },
      {
        id: "b",
        data: { title: "beta item" },
        doc: "beta item",
        embedding: stubEmbed("beta item", 8),
        fields: { title: "beta item" },
      },
    ]);
    const { db, close } = createDbFromUrl(databaseUrl!);
    await db.execute(sql.raw(`UPDATE ${schemaName}.c_plain SET fts_src = title`));
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

  test("test:core-ranking-policy absent leaves pure RRF order", async () => {
    const result = await matcher.search(projectSlug, "plain", {
      q: "alpha",
      limit: 2,
      rerank: false,
    });
    expect(result.hits[0]!.id).toBe("a");
  });
});
