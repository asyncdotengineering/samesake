import "./load-env.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { collection, f, Channels } from "../../sdk/src/index.ts";
import { createMatcher } from "../src/createMatcher.ts";
import { createDbFromUrl } from "../src/db/client.ts";
import { inProcessRunner } from "../src/jobs/in-process.ts";
import { stubEmbed } from "./fixtures.ts";

const databaseUrl = process.env.DATABASE_URL;
const pgBossUrl = process.env.PGBOSS_TEST_URL ?? databaseUrl;
const describeIf = databaseUrl ? describe : describe.skip;
const describePgBoss = pgBossUrl ? describe : describe.skip;

describe("JobRunner in-process", () => {
  test("passthrough runs fn and returns result", async () => {
    const out = await inProcessRunner.run("test:job", { x: 1 }, async () => ({ ok: true, n: 42 }));
    expect(out).toEqual({ ok: true, n: 42 });
  });
});

describePgBoss("JobRunner pg-boss smoke", () => {
  const projectSlug = `t_${Math.random().toString(36).slice(2, 10)}`;
  let schemaName = "";
  let matcher: ReturnType<typeof createMatcher>;
  let pgBossStop: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    const mod = await import("@samesake/jobs-pgboss");
    const runner = await mod.createPgBossRunner({ connectionString: pgBossUrl! });
    pgBossStop = () => runner.stop();

    matcher = createMatcher({
      databaseUrl: pgBossUrl!,
      apiKey: "test-api-key-12345",
      migrate: "eager",
      embed: async ({ text, dim }) => stubEmbed(text, dim),
      jobs: runner,
    });
    await matcher.migrate();
    schemaName = (
      await matcher.apply(projectSlug, {
        entities: [],
        collections: [
          collection("products", {
            fields: { title: f.text({ searchable: true }) },
            embeddings: { doc: { source: "$title", model: "test-embed", dim: 8 } },
            search: { channels: [Channels.fts({ fields: ["title"], weight: 1 })] },
          }),
        ],
      })
    ).schema;
    await matcher.pushDocuments(projectSlug, "products", [
      { id: "j1", data: { title: "Jacket", content_hash: "j1" } },
    ]);
  });

  afterAll(async () => {
    if (schemaName) {
      const { db, close } = createDbFromUrl(pgBossUrl!);
      await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`));
      await close();
    }
    if (matcher) await matcher.close();
    if (pgBossStop) await pgBossStop();
  });

  test("index via pgBossRunner completes with same result shape", async () => {
    expect(await matcher.index(projectSlug, "products")).toEqual({ indexed: 1 });
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
            embeddings: { doc: { source: "$title", model: "test-embed", dim: 8 } },
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
