import "./load-env.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createMatcher } from "../src/createMatcher.ts";
import { createDbFromUrl } from "../src/db/client.ts";
import { testProductsCollection } from "./fixtures.ts";

const databaseUrl = process.env.DATABASE_URL;
const describeIf = databaseUrl ? describe : describe.skip;

describeIf("collections DDL", () => {
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

  test("creates collection table", async () => {
    const { db, close } = createDbFromUrl(databaseUrl!);
    const rows = await db.execute<{ tablename: string }>(sql`
      SELECT tablename FROM pg_tables
      WHERE schemaname = ${schemaName} AND tablename = 'c_products'
    `);
    await close();
    expect(rows.length).toBe(1);
  });

  test("creates fts gin index", async () => {
    const { db, close } = createDbFromUrl(databaseUrl!);
    const rows = await db.execute<{ indexname: string }>(sql`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = ${schemaName} AND tablename = 'c_products'
        AND indexname = 'c_products_fts_idx'
    `);
    await close();
    expect(rows.length).toBe(1);
  });

  test("creates hnsw embedding index", async () => {
    const { db, close } = createDbFromUrl(databaseUrl!);
    const rows = await db.execute<{ indexname: string }>(sql`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = ${schemaName} AND tablename = 'c_products'
        AND indexname = 'c_products_emb_idx'
    `);
    await close();
    expect(rows.length).toBe(1);
  });

  test("creates btree on filterable brand column", async () => {
    const { db, close } = createDbFromUrl(databaseUrl!);
    const rows = await db.execute<{ indexname: string }>(sql`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = ${schemaName} AND tablename = 'c_products'
        AND indexname = 'c_products_brand_idx'
    `);
    await close();
    expect(rows.length).toBe(1);
  });
});
