import "./load-env.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createMatcher } from "../src/createMatcher.ts";
import { createDbFromUrl } from "../src/db/client.ts";
import { testProductsCollection } from "./fixtures.ts";

const databaseUrl = process.env.DATABASE_URL;
const describeIf = databaseUrl ? describe : describe.skip;

const FRAMEWORK_COLUMNS = [
  { name: "pipeline_status", dataType: "text", nullable: "NO", default: "'pending'::text" },
  { name: "attempt_count", dataType: "integer", nullable: "NO", default: "0" },
  { name: "last_error", dataType: "text", nullable: "YES", default: null },
  { name: "next_attempt_at", dataType: "timestamp with time zone", nullable: "YES", default: null },
  { name: "image_etag", dataType: "text", nullable: "YES", default: null },
  { name: "image_checked_at", dataType: "timestamp with time zone", nullable: "YES", default: null },
] as const;

describeIf("test:framework-columns-idempotent (REQ-15)", () => {
  const projectSlug = `t_${Math.random().toString(36).slice(2, 10)}`;
  let schemaName = "";
  let matcher: ReturnType<typeof createMatcher>;

  beforeAll(async () => {
    matcher = createMatcher({
      databaseUrl: databaseUrl!,
      apiKey: "test-api-key-12345",
      migrate: "eager",
      embed: async () => [0, 0, 0, 0, 0, 0, 0, 0],
    });
    await matcher.migrate();
    const r = await matcher.apply(projectSlug, {
      entities: [],
      collections: [testProductsCollection],
    });
    schemaName = r.schema;
  });

  afterAll(async () => {
    if (schemaName) {
      const { db, close } = createDbFromUrl(databaseUrl!);
      await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`));
      await close();
    }
    if (matcher) await matcher.close();
  });

  async function readFrameworkColumns() {
    const { db, close } = createDbFromUrl(databaseUrl!);
    const rows = await db.execute<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(sql`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = ${schemaName}
        AND table_name = 'c_products'
        AND column_name IN (
          'pipeline_status', 'attempt_count', 'last_error', 'next_attempt_at',
          'image_etag', 'image_checked_at'
        )
      ORDER BY column_name
    `);
    await close();
    return rows;
  }

  test("fresh apply creates all six framework columns with correct types and defaults", async () => {
    const rows = await readFrameworkColumns();
    expect(rows.length).toBe(6);
    for (const expected of FRAMEWORK_COLUMNS) {
      const col = rows.find((r) => r.column_name === expected.name);
      expect(col).toBeDefined();
      expect(col!.data_type).toBe(expected.dataType);
      expect(col!.is_nullable).toBe(expected.nullable);
      if (expected.default === null) {
        expect(col!.column_default).toBeNull();
      } else {
        expect(col!.column_default).toBe(expected.default);
      }
    }
  });

  test("re-apply is idempotent", async () => {
    await expect(
      matcher.apply(projectSlug, { entities: [], collections: [testProductsCollection] })
    ).resolves.toBeDefined();
  });

  test("backfill sets pipeline_status ready for indexed or enriched rows only", async () => {
    await matcher.pushDocuments(projectSlug, "products", [
      { id: "indexed", data: { title: "Indexed", brand: "a", price: 1, content_hash: "i1" } },
      { id: "enriched", data: { title: "Enriched", brand: "b", price: 2, content_hash: "e1" } },
      { id: "fresh", data: { title: "Fresh", brand: "c", price: 3, content_hash: "f1" } },
    ]);

    const { db, close } = createDbFromUrl(databaseUrl!);
    await db.execute(sql.raw(`
      UPDATE ${schemaName}.c_products SET indexed_at = now() WHERE id = 'indexed';
      UPDATE ${schemaName}.c_products SET enriched_at = now() WHERE id = 'enriched';
      UPDATE ${schemaName}.c_products SET pipeline_status = 'pending'
      WHERE id IN ('indexed', 'enriched', 'fresh');
    `));
    await close();

    await matcher.apply(projectSlug, { entities: [], collections: [testProductsCollection] });

    const { db: db2, close: close2 } = createDbFromUrl(databaseUrl!);
    const statuses = await db2.execute<{ id: string; pipeline_status: string }>(sql.raw(`
      SELECT id, pipeline_status FROM ${schemaName}.c_products
      WHERE id IN ('indexed', 'enriched', 'fresh')
      ORDER BY id
    `));
    await close2();

    const byId = Object.fromEntries(statuses.map((r) => [r.id, r.pipeline_status]));
    expect(byId.indexed).toBe("ready");
    expect(byId.enriched).toBe("ready");
    expect(byId.fresh).toBe("pending");
  });
});
