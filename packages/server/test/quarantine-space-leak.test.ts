import "./load-env.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { collection, f, Channels, pipeline, stage, s } from "../../sdk/src/index.ts";
import { createMatcher } from "../src/createMatcher.ts";
import { createDbFromUrl } from "../src/db/client.ts";
import { stubEmbed } from "./fixtures.ts";

const databaseUrl = process.env.DATABASE_URL;
const describeIf = databaseUrl ? describe : describe.skip;

// Regression: a collection that has BOTH an enrich gate AND spaces must still keep
// quarantined rows out of the index. The `space_vec IS NULL` backfill clause used to
// sit outside the `pipeline_status = 'ready'` guard, so a freshly-enriched quarantined
// row (space_vec NULL) was indexed and promoted to `ready` — defeating the gate.
describeIf("quarantine holds when the collection has spaces", () => {
  const projectSlug = `t_${Math.random().toString(36).slice(2, 10)}`;
  let schemaName = "";
  let matcher: ReturnType<typeof createMatcher>;

  const coll = collection("products", {
    fields: {
      title: f.text({ searchable: true }),
      price: f.number({ filterable: true }),
    },
    enrich: pipeline(
      stage("classify", { prompt: (ctx) => `classify ${ctx.data.title}`, schema: () => ({ type: "object" }) })
    ),
    indexing: {
      surfaces: {
        embed_doc: { kind: "dense", embedding: "doc", build: ({ data }) => `${data.title}`.trim() },
      },
      gate: ({ data }) =>
        String(data.title ?? "").includes("Skip") ? { index: false, reason: "skipped" } : { index: true },
    },
    embeddings: { doc: { model: "test-embed", dim: 8 } },
    spaces: { pricey: s.number({ field: "price", mode: "closer", dims: 8, min: 0, max: 100 }) },
    search: {
      channels: [Channels.cosine({ embedding: "doc", weight: 1 }), Channels.spaces({ weight: 1 })],
    },
  });

  beforeAll(async () => {
    matcher = createMatcher({
      databaseUrl: databaseUrl!,
      apiKey: "test-api-key-12345",
      migrate: "eager",
      embed: async ({ text, dim }) => stubEmbed(text, dim),
      generate: async () => ({}),
    });
    await matcher.migrate();
    schemaName = (await matcher.apply(projectSlug, { entities: [], collections: [coll] })).schema;
    await matcher.pushDocuments(projectSlug, "products", [
      { id: "ready", data: { title: "Ready Item", price: 10, content_hash: "r1" } },
      { id: "skip", data: { title: "Skip Item", price: 20, content_hash: "s1" } },
    ]);
    await matcher.enrich(projectSlug, "products");
  }, 20_000);

  afterAll(async () => {
    if (schemaName) {
      const { db, close } = createDbFromUrl(databaseUrl!);
      await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`));
      await close();
    }
    if (matcher) await matcher.close();
  });

  test("quarantined row is not indexed or promoted by space backfill, and is not searchable", async () => {
    const { db: dbPre, close: closePre } = createDbFromUrl(databaseUrl!);
    const pre = (await dbPre.execute(
      sql.raw(`SELECT id, pipeline_status FROM ${schemaName}.c_products ORDER BY id`)
    )) as unknown as { id: string; pipeline_status: string }[];
    await closePre();
    expect(pre.find((r) => r.id === "skip")!.pipeline_status).toBe("quarantined");

    await matcher.index(projectSlug, "products");

    const { db, close } = createDbFromUrl(databaseUrl!);
    const rows = (await db.execute(
      sql.raw(
        `SELECT id, pipeline_status, indexed_at, space_vec::text AS space_vec
         FROM ${schemaName}.c_products WHERE id IN ('ready','skip') ORDER BY id`
      )
    )) as unknown as { id: string; pipeline_status: string; indexed_at: string | null; space_vec: string | null }[];
    await close();

    const ready = rows.find((x) => x.id === "ready")!;
    const skip = rows.find((x) => x.id === "skip")!;

    expect(ready.pipeline_status).toBe("ready");
    expect(ready.indexed_at).toBeTruthy();

    expect(skip.pipeline_status).toBe("quarantined");
    expect(skip.indexed_at).toBeNull();
    expect(skip.space_vec).toBeNull();

    const res = await matcher.search(projectSlug, "products", { q: "Skip Item", limit: 10 });
    const hits = (res.hits ?? []) as { id: string }[];
    expect(hits.some((h) => h.id === "skip")).toBe(false);
  });
});
