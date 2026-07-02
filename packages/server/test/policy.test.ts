import "./load-env.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { collection, f, Channels } from "@samesake/core";
import { createMatcher } from "../src/createMatcher.ts";
import { createDbFromUrl } from "../src/db/client.ts";
import { denseAndFtsIndexingByTitle, stubEmbed } from "./fixtures.ts";

const databaseUrl = process.env.SAMESAKE_DATABASE_URL;
const describeIf = databaseUrl ? describe : describe.skip;

const policyCollection = collection("policy", {
  fields: {
    title: f.text({ searchable: true }),
    category: f.enum(["a", "b"], { filterable: true }),
  },
  indexing: denseAndFtsIndexingByTitle,
  embeddings: { doc: { model: "stub", dim: 8 } },
  search: {
    channels: [
      Channels.fts({ fields: ["title"], weight: 1 }),
      Channels.cosine({ embedding: "doc", weight: 0 }),
    ],
    nlq: { instructions: "policy timeout test" },
  },
});

describeIf("policy config", () => {
  const projectSlug = `t_${Math.random().toString(36).slice(2, 10)}`;
  let schemaName = "";
  let matcher: ReturnType<typeof createMatcher>;

  beforeAll(async () => {
    matcher = createMatcher({
      databaseUrl: databaseUrl!,
      apiKey: "test-api-key-12345",
      migrate: "eager",
      embed: async ({ text, dim }) => stubEmbed(text, dim),
      generate: async () => {
        await new Promise((r) => setTimeout(r, 200));
        return { semantic_query: "slow", category: "a" };
      },
      policy: { llm: { timeoutMs: 50 } },
    });
    await matcher.migrate();
    const r = await matcher.apply(projectSlug, { entities: [], collections: [policyCollection] });
    schemaName = r.schema;
    await matcher.indexDocuments(projectSlug, "policy", [
      {
        id: "1",
        data: { title: "slow widget" },
        doc: "slow widget",
        embedding: stubEmbed("slow widget", 8),
        fields: { title: "slow widget", category: "a" },
      },
    ]);
  });

  afterAll(async () => {
    if (schemaName) {
      const { db, close } = createDbFromUrl(databaseUrl!);
      await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`));
      await close();
    }
    if (matcher) await matcher.close();
  });

  test("short llm timeout degrades NLQ instead of hanging", async () => {
    const before = matcher.metrics().nlq_degraded_total;
    const result = await matcher.search(projectSlug, "policy", {
      q: "slow widget luxury under 100",
      cache: false,
    });
    expect(result.nlq_degraded).toBe(true);
    expect(matcher.metrics().nlq_degraded_total).toBeGreaterThan(before);
    expect(result.parsed?.semantic_query).toBe("slow widget luxury under 100");
  });
});
