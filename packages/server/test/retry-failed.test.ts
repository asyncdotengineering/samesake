import "./load-env.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { collection, f, Channels, gates } from "../../sdk/src/index.ts";
import { createMatcher } from "../src/createMatcher.ts";
import { createDbFromUrl } from "../src/db/client.ts";
import { PostgresAdapter } from "../src/db/storage-adapter.ts";
import { makeEnrichPipelineService } from "../src/core/enrich-pipeline.ts";
import { makeProjectsService } from "../src/core/projects.ts";
import { makeSchemaGen } from "../src/core/schema-gen.ts";
import { makeCollectionsSchemaGen } from "../src/core/collections-schema-gen.ts";
import { createObservability } from "../src/core/observability.ts";
import { resolvePolicy } from "../src/core/policy.ts";
import { inProcessRunner } from "../src/jobs/in-process.ts";
import { makeSystemTables } from "../src/db/schema/system.ts";
import { runSystemMigrations } from "../src/db/migrations.ts";
import { collectionTableName } from "../src/core/db-utils.ts";
import { DEFAULT_MAX_ATTEMPTS } from "../src/core/pipeline-failure.ts";
import { stubEmbed } from "./fixtures.ts";

const databaseUrl = process.env.DATABASE_URL;
const describeIf = databaseUrl ? describe : describe.skip;

const baseCollection = collection("products", {
  fields: { title: f.text({ searchable: true }) },
  indexing: {
    surfaces: {
      embed_doc: { kind: "dense", embedding: "doc", build: ({ data }) => String(data.title ?? "").trim() },
      fts_doc: { kind: "fts", build: ({ data }) => String(data.title ?? "").trim() },
    },
    gate: gates.always,
  },
  embeddings: { doc: { model: "test-embed", dim: 8 } },
  search: { channels: [Channels.fts({ fields: ["title"], weight: 1 })] },
});

describeIf("test:retry-failed (REQ-17)", () => {
  const projectSlug = `t_${Math.random().toString(36).slice(2, 10)}`;
  let schemaName = "";
  let matcher: ReturnType<typeof createMatcher>;
  let recordFailure: ReturnType<typeof makeEnrichPipelineService>["recordFailure"];
  let table = "";

  beforeAll(async () => {
    const built = createDbFromUrl(databaseUrl!);
    const collectionsSchemaGen = makeCollectionsSchemaGen({ projectPrefix: "project_" });
    const schemaGen = makeSchemaGen({ sys: "public", projectPrefix: "project_" });
    const ctx = {
      db: built.db,
      storage: new PostgresAdapter(built),
      schema: "public",
      projectPrefix: "project_",
      apiKey: "test-api-key-12345",
      embed: async ({ text, dim }: { text?: string; dim: number }) => stubEmbed(text, dim),
      parse: async () => ({}),
      generate: async () => ({}),
      generateConfigured: false,
      jobs: inProcessRunner,
      observability: createObservability(),
      policy: resolvePolicy({}),
      systemTables: makeSystemTables("public"),
      ensureMigrations: async () => {
        await runSystemMigrations(ctx);
      },
    };
    const projectsService = makeProjectsService(ctx, schemaGen, collectionsSchemaGen);
    recordFailure = makeEnrichPipelineService(ctx, projectsService).recordFailure;
    await runSystemMigrations(ctx);

    matcher = createMatcher({
      db: built.db,
      apiKey: "test-api-key-12345",
      migrate: "eager",
      embed: async ({ text, dim }) => stubEmbed(text, dim),
    });
    await matcher.migrate();
    const r = await matcher.apply(projectSlug, { entities: [], collections: [baseCollection] });
    schemaName = r.schema;
    table = collectionTableName(schemaName, "products");
  }, 30_000);

  afterAll(async () => {
    if (schemaName) {
      const { db, close } = createDbFromUrl(databaseUrl!);
      await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`));
      await close();
    }
    if (matcher) await matcher.close();
  });

  test("retries a failed row past next_attempt_at and marks max-attempt rows dead", async () => {
    await matcher.pushDocuments(projectSlug, "products", [
      { id: "retry-me", data: { title: "Retry", content_hash: "r1" } },
      { id: "dead-me", data: { title: "Dead", content_hash: "d1" } },
    ]);

    await recordFailure(table, "retry-me", new Error("transient"));
    await recordFailure(table, "dead-me", new Error("exhausted"));

    const { db: db1, close: close1 } = createDbFromUrl(databaseUrl!);
    await db1.execute(sql.raw(`
      UPDATE ${table}
      SET next_attempt_at = now() - interval '1 minute',
          attempt_count = ${DEFAULT_MAX_ATTEMPTS - 1}
      WHERE id = 'retry-me'
    `));
    await db1.execute(sql.raw(`
      UPDATE ${table}
      SET next_attempt_at = now() - interval '1 minute',
          attempt_count = ${DEFAULT_MAX_ATTEMPTS}
      WHERE id = 'dead-me'
    `));
    await close1();

    const { db: dbBefore, close: closeBefore } = createDbFromUrl(databaseUrl!);
    await dbBefore.execute(sql.raw(`
      UPDATE ${table}
      SET enriched_at = now(),
          doc = 'Retry',
          pipeline_status = 'failed',
          last_error = 'index transient'
      WHERE id = 'retry-me'
    `));
    await closeBefore();

    const { retried, dead } = await matcher.retryFailed(projectSlug, "products");
    expect(dead).toBe(1);
    expect(retried).toBe(1);

    const { db, close } = createDbFromUrl(databaseUrl!);
    const rows = await db.execute<{
      id: string;
      pipeline_status: string;
      indexed_at: string | null;
    }>(sql.raw(`
      SELECT id, pipeline_status, indexed_at
      FROM ${table}
      WHERE id IN ('retry-me', 'dead-me')
      ORDER BY id
    `));
    await close();

    const retryRow = rows.find((r) => r.id === "retry-me");
    const deadRow = rows.find((r) => r.id === "dead-me");
    expect(retryRow!.pipeline_status).toBe("ready");
    expect(retryRow!.indexed_at).not.toBeNull();
    expect(deadRow!.pipeline_status).toBe("dead");
  });
});
