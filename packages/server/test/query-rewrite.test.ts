import "./load-env.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { collection, f, Channels, gates } from "../../sdk/src/index.ts";
import { createMatcher } from "../src/createMatcher.ts";
import { createDbFromUrl } from "../src/db/client.ts";
import { proposeRewrites } from "../src/core/query-rewrite.ts";
import type { MatcherCtx } from "../src/types.ts";

const databaseUrl = process.env.SAMESAKE_DATABASE_URL;
const describeIf = databaseUrl ? describe : describe.skip;

describe("typed query rewrites", () => {
  test("rejects malformed, duplicate, and original proposals", async () => {
    let calls = 0;
    const ctx = {
      generateConfigured: true,
      generate: async () => {
        calls++;
        return {
          rewrites: [
            { type: "unknown", query: "sneakers" },
            { type: "spellfix", query: "" },
            { type: "spellfix", query: "Sneakers" },
            { type: "synonym", query: "sneakers" },
            { type: "broader", query: "shoes" },
          ],
        };
      },
      policy: { llm: { timeoutMs: 1000 } },
      systemTables: undefined,
    } as unknown as MatcherCtx;
    const rewrites = await proposeRewrites(
      ctx,
      { name: "products", fields: {}, search: { channels: [], nlq: { enable: true } } },
      "sneakers",
      "empty"
    );
    expect(calls).toBe(1);
    expect(rewrites).toEqual([{ type: "broader", query: "shoes" }]);
  });
});

describeIf("test:rewrite-ladder", () => {
  const projectSlug = `t_${Math.random().toString(36).slice(2, 10)}`;
  let schemaName = "";
  let matcher: ReturnType<typeof createMatcher>;
  let generateCalls = 0;

  const products = collection("rewrite_products", {
    fields: { title: f.text({ searchable: true }) },
    indexing: {
      surfaces: {
        embed_doc: { kind: "dense", embedding: "doc", build: ({ data }) => String(data.title ?? "") },
        fts_doc: { kind: "fts", build: ({ data }) => String(data.title ?? "") },
      },
      gate: gates.always,
    },
    embeddings: { doc: { model: "rewrite-test", dim: 2 } },
    search: {
      channels: [
        Channels.fts({ fields: ["title"], weight: 1 }),
        Channels.cosine({ embedding: "doc", weight: 1 }),
      ],
      nlq: { enable: true },
    },
  });

  function embed(text: string | undefined): number[] {
    return text?.toLowerCase().includes("sneakers") ? [0.8, 0.6] : [1, 0];
  }

  beforeAll(async () => {
    matcher = createMatcher({
      databaseUrl: databaseUrl!,
      apiKey: "rewrite-test-key",
      migrate: "eager",
      embed: async ({ text }) => embed(text),
      generate: async ({ prompt }) => {
        generateCalls++;
        if (prompt.includes("typed JSON rewrites")) {
          return { rewrites: [{ type: "spellfix", query: "sneakers" }] };
        }
        return { semantic_query: "snekers", lexical_query: "snekers" };
      },
    });
    await matcher.migrate();
    schemaName = (await matcher.apply(projectSlug, { entities: [], collections: [products] })).schema;
    await matcher.pushDocuments(projectSlug, "rewrite_products", [{ id: "s1", data: { title: "adidas sneakers" } }]);
    await matcher.index(projectSlug, "rewrite_products");
  }, 30_000);

  afterAll(async () => {
    if (schemaName) {
      const { db, close } = createDbFromUrl(databaseUrl!);
      await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`));
      await close();
    }
    if (matcher) await matcher.close();
  });

  test("shares one accepted rewrite between search and explain without reparsing", async () => {
    const before = generateCalls;
    const q = `snekers ${projectSlug}`;
    const result = await matcher.search(projectSlug, "rewrite_products", {
      q,
      limit: 5,
      weights: { fts: 1, cosine: 0 },
    });
    expect(generateCalls - before).toBe(2);
    expect(result.hits.map((hit) => hit.id)).toEqual(["s1"]);
    expect(result.rewritten).toEqual({ type: "spellfix", from: q, to: "sneakers" });

    const explain = await matcher.searchExplain(projectSlug, "rewrite_products", {
      q,
      limit: 5,
      weights: { fts: 1, cosine: 0 },
    });
    expect(explain.rewritten).toEqual(result.rewritten);
    expect(explain.constraintTrace.rewritten).toEqual(result.constraintTrace.rewritten);
    expect(explain.constraintTrace.appliedFilters).toEqual(result.constraintTrace.appliedFilters);

    const cachedBefore = generateCalls;
    const cached = await matcher.search(projectSlug, "rewrite_products", {
      q,
      limit: 5,
      weights: { fts: 1, cosine: 0 },
    });
    expect(generateCalls).toBe(cachedBefore);
    expect(cached.rewritten).toEqual(result.rewritten);
  }, 30_000);
});
