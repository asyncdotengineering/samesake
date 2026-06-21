import "./load-env.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createMatcher } from "../src/createMatcher.ts";
import { createDbFromUrl } from "../src/db/client.ts";
import { stubEmbed, testProductsCollection } from "./fixtures.ts";

const databaseUrl = process.env.DATABASE_URL;
const describeIf = databaseUrl ? describe : describe.skip;

describeIf("removeDocuments", () => {
  const projectSlug = `t_${Math.random().toString(36).slice(2, 10)}`;
  let schemaName = "";
  let matcher: ReturnType<typeof createMatcher>;

  beforeAll(async () => {
    matcher = createMatcher({
      databaseUrl: databaseUrl!,
      apiKey: "test-api-key-12345",
      migrate: "eager",
      embed: async ({ text, dim }) => stubEmbed(text, dim),
    });
    await matcher.migrate();
    schemaName = (
      await matcher.apply(projectSlug, { entities: [], collections: [testProductsCollection] })
    ).schema;
    await matcher.pushDocuments(projectSlug, "products", [
      { id: "r1", data: { title: "red shoes" } },
      { id: "r2", data: { title: "blue shoes" } },
      { id: "r3", data: { title: "green shoes" } },
    ]);
  }, 20_000);

  afterAll(async () => {
    if (schemaName) {
      const { db, close } = createDbFromUrl(databaseUrl!);
      await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`));
      await close();
    }
    if (matcher) await matcher.close();
  });

  test("removeDocuments deletes rows by id and reports the count", async () => {
    const { removed } = await matcher.removeDocuments(projectSlug, "products", ["r1", "r3"]);
    expect(removed).toBe(2);

    const { db, close } = createDbFromUrl(databaseUrl!);
    const rows = (await db.execute(
      sql.raw(`SELECT id FROM ${schemaName}.c_products ORDER BY id`)
    )) as unknown as { id: string }[];
    await close();
    expect(rows.map((r) => r.id)).toEqual(["r2"]);
  });

  test("removeDocuments with no ids is a no-op", async () => {
    const { removed } = await matcher.removeDocuments(projectSlug, "products", []);
    expect(removed).toBe(0);
  });

  test("removeDocuments ignores ids that do not exist", async () => {
    const { removed } = await matcher.removeDocuments(projectSlug, "products", ["does-not-exist"]);
    expect(removed).toBe(0);
  });
});
