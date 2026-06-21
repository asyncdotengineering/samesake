import "./load-env.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { collection, f, Channels, gates } from "../../sdk/src/index.ts";
import { createMatcher } from "../src/createMatcher.ts";
import { createDbFromUrl } from "../src/db/client.ts";
import { makeCollectionsSchemaGen } from "../src/core/collections-schema-gen.ts";
import { makeEnrichPipelineService } from "../src/core/enrich-pipeline.ts";
import { makeProjectsService } from "../src/core/projects.ts";
import { makeSchemaGen } from "../src/core/schema-gen.ts";
import { createObservability } from "../src/core/observability.ts";
import { resolvePolicy } from "../src/core/policy.ts";
import { inProcessRunner } from "../src/jobs/in-process.ts";
import { makeSystemTables } from "../src/db/schema/system.ts";
import { runSystemMigrations } from "../src/db/migrations.ts";
import { collectionTableName } from "../src/core/db-utils.ts";
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

describeIf("test:record-failure-backoff (REQ-16)", () => {
  const projectSlug = `t_${Math.random().toString(36).slice(2, 10)}`;
  let schemaName = "";
  let matcher: ReturnType<typeof createMatcher>;
  let recordFailure: ReturnType<typeof makeEnrichPipelineService>["recordFailure"];
  let table = "";
  let sharedClose: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const built = createDbFromUrl(databaseUrl!);
    sharedClose = built.close;
    const collectionsSchemaGen = makeCollectionsSchemaGen({ projectPrefix: "project_" });
    const schemaGen = makeSchemaGen({ sys: "public", projectPrefix: "project_" });
    const ctx = {
      db: built.db,
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
  });

  afterAll(async () => {
    if (schemaName) {
      const { db, close } = createDbFromUrl(databaseUrl!);
      await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`));
      await close();
    }
    if (matcher) await matcher.close();
    if (sharedClose) await sharedClose();
  });

  test("increments attempt_count, sets failed status, last_error, and exponential next_attempt_at", async () => {
    await matcher.pushDocuments(projectSlug, "products", [
      { id: "fail1", data: { title: "Fail", content_hash: "fail1" } },
    ]);

    await recordFailure(table, "fail1", new Error("first failure"));

    const { db, close } = createDbFromUrl(databaseUrl!);
    const afterFirst = await db.execute<{
      pipeline_status: string;
      attempt_count: number;
      last_error: string | null;
      next_attempt_at: string | null;
    }>(sql.raw(`
      SELECT pipeline_status, attempt_count, last_error, next_attempt_at
      FROM ${table} WHERE id = 'fail1'
    `));
    await close();

    expect(afterFirst.length).toBe(1);
    expect(afterFirst[0]!.pipeline_status).toBe("failed");
    expect(Number(afterFirst[0]!.attempt_count)).toBe(1);
    expect(afterFirst[0]!.last_error).toBe("first failure");
    expect(afterFirst[0]!.next_attempt_at).not.toBeNull();

    await recordFailure(table, "fail1", new Error("second failure"));

    const { db: db2, close: close2 } = createDbFromUrl(databaseUrl!);
    const afterSecond = await db2.execute<{
      pipeline_status: string;
      attempt_count: number;
      last_error: string | null;
      next_attempt_at: string | null;
    }>(sql.raw(`
      SELECT pipeline_status, attempt_count, last_error, next_attempt_at
      FROM ${table} WHERE id = 'fail1'
    `));
    await close2();

    expect(afterSecond.length).toBe(1);
    expect(afterSecond[0]!.pipeline_status).toBe("failed");
    expect(Number(afterSecond[0]!.attempt_count)).toBe(2);
    expect(afterSecond[0]!.last_error).toBe("second failure");
    expect(new Date(afterSecond[0]!.next_attempt_at!).getTime()).toBeGreaterThan(
      new Date(afterFirst[0]!.next_attempt_at!).getTime()
    );
  });
});
