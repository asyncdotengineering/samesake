import "./load-env.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { collection, f, Channels, gates } from "../../sdk/src/index.ts";
import { createMatcher } from "../src/createMatcher.ts";
import { createDbFromUrl } from "../src/db/client.ts";
import { inProcessRunner } from "../src/jobs/in-process.ts";
import { stubEmbed } from "./fixtures.ts";

const databaseUrl = process.env.DATABASE_URL;
const describeIf = databaseUrl ? describe : describe.skip;

describe("JobRunner in-process", () => {
  test("passthrough runs fn and returns result", async () => {
    const out = await inProcessRunner.run("test:job", { x: 1 }, async () => ({ ok: true, n: 42 }));
    expect(out).toEqual({ ok: true, n: 42 });
  });
});

describeIf("enrich routes through JobRunner", () => {
  const projectSlug = `t_${Math.random().toString(36).slice(2, 10)}`;
  let schemaName = "";
  let matcher: ReturnType<typeof createMatcher>;
  let ranViaRunner = false;

  beforeAll(async () => {
    matcher = createMatcher({
      databaseUrl: databaseUrl!,
      apiKey: "test-api-key-12345",
      migrate: "eager",
      embed: async ({ text, dim }) => stubEmbed(text, dim),
      jobs: {
        run: async <T>(_n: string, _p: unknown, fn: () => Promise<T>) => {
          ranViaRunner = true;
          return fn();
        },
      },
      generate: async () => ({ category: "top" }),
    });
    await matcher.migrate();
    schemaName = (
      await matcher.apply(projectSlug, {
        entities: [],
        collections: [
          collection("products", {
            fields: { title: f.text({ searchable: true }) },
            enrich: {
              stages: [
                {
                  name: "classify",
                  prompt: (ctx: { data: Record<string, unknown> }) => `go ${ctx.data.title}`,
                  schema: () => ({ type: "object" }),
                },
              ],
            },
            indexing: {
              surfaces: {
                embed_doc: { kind: "dense", embedding: "doc", build: ({ data }) => String(data.title ?? "").trim() },
                fts_doc: { kind: "fts", build: ({ data }) => String(data.title ?? "").trim() },
              },
              gate: gates.always,
            },
            embeddings: { doc: { model: "test-embed", dim: 8 } },
            search: { channels: [Channels.fts({ fields: ["title"], weight: 1 })] },
          }),
        ],
      })
    ).schema;
    await matcher.pushDocuments(projectSlug, "products", [
      { id: "e1", data: { title: "Shirt", content_hash: "e1" } },
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

  test("enrichCollection invokes ctx.jobs.run", async () => {
    const r = await matcher.enrich(projectSlug, "products");
    expect(ranViaRunner).toBe(true);
    expect(r.enriched).toBe(1);
  });
});
