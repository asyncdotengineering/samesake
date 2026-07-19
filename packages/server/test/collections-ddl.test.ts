import "./load-env.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { collection, f, Channels } from "../../sdk/src/index.ts";
import { createMatcher } from "../src/createMatcher.ts";
import { createDbFromUrl } from "../src/db/client.ts";
import { testProductsCollection } from "./fixtures.ts";

const databaseUrl = process.env.SAMESAKE_DATABASE_URL;
const describeIf = databaseUrl ? describe : describe.skip;

const scopedVocabCollection = collection("scoped", {
  ...{ scopes: ["tenant"] },
  fields: {
    title: f.text({ searchable: true }),
    brand: f.text({ filterable: true }),
  },
  embeddings: { doc: { model: "test-embed", dim: 8 } },
  search: { channels: [Channels.cosine({ embedding: "doc", weight: 1 })] },
});

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
      collections: [testProductsCollection, scopedVocabCollection],
    });
    schemaName = r.schema;
  }, 30_000);

  afterAll(async () => {
    if (schemaName) {
      const { db, close } = createDbFromUrl(databaseUrl!);
      await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`));
      await close();
    }
    if (matcher) await matcher.close();
  }, 30_000);

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

  test("creates scoped vocabulary table, trigram index, and row trigger", async () => {
    const { db, close } = createDbFromUrl(databaseUrl!);
    const table = await db.execute<{ table_name: string }>(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = ${schemaName} AND table_name = 'c_scoped_vocab'
    `);
    const columns = await db.execute<{ column_name: string }>(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = ${schemaName} AND table_name = 'c_scoped_vocab'
      ORDER BY ordinal_position
    `);
    const indexes = await db.execute<{ indexname: string }>(sql`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = ${schemaName} AND tablename = 'c_scoped_vocab'
    `);
    const triggers = await db.execute<{ tgname: string }>(sql`
      SELECT tgname FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${schemaName} AND c.relname = 'c_scoped'
        AND NOT t.tgisinternal
    `);
    await close();
    expect(table).toHaveLength(1);
    expect(columns.map((row) => row.column_name)).toEqual(["scope_tenant", "field", "value", "count"]);
    expect(indexes.map((row) => row.indexname)).toContain("c_scoped_vocab_value_trgm_idx");
    expect(triggers.map((row) => row.tgname)).toContain("c_scoped_vocab_maintain_trg");
  });

  test("maintains scoped counts across replacement, visibility, deletion, and re-apply", async () => {
    const vector = [1, 0, 0, 0, 0, 0, 0, 0];
    await matcher.indexDocuments(projectSlug, "scoped", [
      { id: "a1", data: { title: "one" }, embedding: vector, scope: { tenant: "a" }, fields: { brand: "Acme" } },
      { id: "a2", data: { title: "two" }, embedding: vector, scope: { tenant: "a" }, fields: { brand: "Acme" } },
      { id: "b1", data: { title: "three" }, embedding: vector, scope: { tenant: "b" }, fields: { brand: "Acme" } },
    ]);

    async function readVocab() {
      const { db, close } = createDbFromUrl(databaseUrl!);
      const rows = await db.execute<{ tenant: string; value: string; count: number }>(sql.raw(`
        SELECT scope_tenant AS tenant, value, count
        FROM ${schemaName}.c_scoped_vocab
        ORDER BY scope_tenant, value
      `));
      await close();
      return Array.from(rows, (row) => ({ tenant: row.tenant, value: row.value, count: Number(row.count) }));
    }

    expect(await readVocab()).toEqual([
      { tenant: "a", value: "Acme", count: 2 },
      { tenant: "b", value: "Acme", count: 1 },
    ]);

    await matcher.indexDocuments(projectSlug, "scoped", [
      { id: "a2", data: { title: "two" }, embedding: vector, scope: { tenant: "a" }, fields: { brand: "Bravo" } },
    ]);
    expect(await readVocab()).toEqual([
      { tenant: "a", value: "Acme", count: 1 },
      { tenant: "a", value: "Bravo", count: 1 },
      { tenant: "b", value: "Acme", count: 1 },
    ]);

    const { db, close } = createDbFromUrl(databaseUrl!);
    await db.execute(sql.raw(`UPDATE ${schemaName}.c_scoped SET pipeline_status = 'quarantined' WHERE id = 'a1'`));
    expect(await readVocab()).toEqual([
      { tenant: "a", value: "Bravo", count: 1 },
      { tenant: "b", value: "Acme", count: 1 },
    ]);
    await db.execute(sql.raw(`UPDATE ${schemaName}.c_scoped SET pipeline_status = 'ready' WHERE id = 'a1'`));
    await close();
    expect(await readVocab()).toEqual([
      { tenant: "a", value: "Acme", count: 1 },
      { tenant: "a", value: "Bravo", count: 1 },
      { tenant: "b", value: "Acme", count: 1 },
    ]);

    await matcher.removeDocuments(projectSlug, "scoped", ["a2"], { tenant: "a" });
    expect(await readVocab()).toEqual([
      { tenant: "a", value: "Acme", count: 1 },
      { tenant: "b", value: "Acme", count: 1 },
    ]);

    await matcher.apply(projectSlug, { entities: [], collections: [testProductsCollection, scopedVocabCollection] });
    expect(await readVocab()).toEqual([
      { tenant: "a", value: "Acme", count: 1 },
      { tenant: "b", value: "Acme", count: 1 },
    ]);
  }, 30_000);
});
