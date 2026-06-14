import "./load-env.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { collection, f, Channels, pipeline, stage } from "@samesake/core";
import { createMatcher } from "../src/createMatcher.ts";
import { createDbFromUrl } from "../src/db/client.ts";
import { stubEmbed } from "./fixtures.ts";

const databaseUrl = process.env.DATABASE_URL;
const describeIf = databaseUrl ? describe : describe.skip;

const seenPrompts: string[] = [];
const reviewCollection = collection("rev", {
  fields: {
    title: f.text({ searchable: true }),
    category: f.enum(["dresses", "bottoms"], { filterable: true, path: "enriched.category" }),
  },
  enrich: pipeline(
    stage("classify", {
      prompt: (ctx) => `classify: ${ctx.data.title}`,
      schema: () => ({ type: "OBJECT", properties: { category: { type: "STRING" } } }),
    })
  ),
  embeddings: { doc: { source: "$title", model: "stub", dim: 8 } },
  search: { channels: [Channels.fts({ fields: ["title"], weight: 1 })] },
});

describeIf("review loop (Q6)", () => {
  const projectSlug = `t_${Math.random().toString(36).slice(2, 10)}`;
  const runToken = Math.random().toString(36).slice(2, 8);
  let schemaName = "";
  let matcher: ReturnType<typeof createMatcher>;

  beforeAll(async () => {
    matcher = createMatcher({
      databaseUrl: databaseUrl!,
      apiKey: "test-api-key-12345",
      migrate: "eager",
      embed: async ({ text, dim }) => stubEmbed(text, dim),
      generate: async ({ prompt }) => {
        seenPrompts.push(prompt);
        return { category: "dresses", confidence: 0.5, uncertain_fields: ["category"] };
      },
    });
    await matcher.migrate();
    const r = await matcher.apply(projectSlug, { entities: [], collections: [reviewCollection] });
    schemaName = r.schema;
    await matcher.pushDocuments(projectSlug, "rev", [
      { id: "skirt-1", data: { title: "Pleated Midi Skirt" } },
      { id: "dress-1", data: { title: "Wrap Midi Dress" } },
    ]);
    await matcher.enrich(projectSlug, "rev");
    await matcher.index(projectSlug, "rev");
  });

  afterAll(async () => {
    if (schemaName) {
      const { db, close } = createDbFromUrl(databaseUrl!);
      await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`));
      await close();
    }
    if (matcher) await matcher.close();
  });

  test("low-confidence rows surface for review", async () => {
    const rows = await matcher.reviewList(projectSlug, "rev", { maxConfidence: 0.7 });
    expect(rows.length).toBe(2);
    expect(rows[0]!.uncertain_fields).toContain("category");
  });

  test("correct merges enrichment, records correction, clears indexed_at", async () => {
    const r = await matcher.reviewCorrect(projectSlug, "rev", "skirt-1", { category: "bottoms" });
    expect(r.corrected).toEqual(["category"]);
    const { db, close } = createDbFromUrl(databaseUrl!);
    const [row] = (await db.execute(
      sql.raw(`SELECT enriched->>'category' AS cat, enriched ? '_corrected' AS corrected, indexed_at FROM ${schemaName}.c_rev WHERE id = 'skirt-1'`)
    )) as unknown as { cat: string; corrected: boolean; indexed_at: unknown }[];
    expect(row.cat).toBe("bottoms");
    expect(row.corrected).toBe(true);
    expect(row.indexed_at).toBeNull();
    await close();
    // re-index refreshes the filter column from the corrected enrichment
    await matcher.index(projectSlug, "rev");
    const hits = await matcher.search(projectSlug, "rev", { q: "pleated midi skirt", filters: { category: "bottoms" }, cache: false });
    expect(hits.hits.map((h) => h.id)).toContain("skirt-1");
  });

  test("future enrichment runs include correction few-shot", async () => {
    await matcher.pushDocuments(projectSlug, "rev", [
      { id: "skirt-2", data: { title: `A-line Pleated Skirt ${runToken}` } },
    ]);
    seenPrompts.length = 0;
    await matcher.enrich(projectSlug, "rev");
    expect(seenPrompts.length).toBeGreaterThan(0);
    expect(seenPrompts[0]).toContain("Corrections from human review");
    expect(seenPrompts[0]).toContain("bottoms");
  });
});
