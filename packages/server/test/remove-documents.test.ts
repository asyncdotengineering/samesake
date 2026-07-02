import "./load-env.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createMatcher } from "../src/createMatcher.ts";
import { createDbFromUrl } from "../src/db/client.ts";
import { stubEmbed, testProductsCollection } from "./fixtures.ts";

const databaseUrl = process.env.SAMESAKE_DATABASE_URL;
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
    await matcher.index(projectSlug, "products");
  }, 30_000);

  afterAll(async () => {
    if (schemaName) {
      const { db, close } = createDbFromUrl(databaseUrl!);
      await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`));
      await close();
    }
    if (matcher) await matcher.close();
  });

  test("push → delete → search returns nothing (HTTP + in-process)", async () => {
    const before = await matcher.search(projectSlug, "products", { q: "shoes" });
    expect(before.hits.map((h) => h.id).sort()).toEqual(["r1", "r2", "r3"]);

    // HTTP surface
    const res = await matcher.fetch(
      new Request(`http://x/v1/projects/${projectSlug}/collections/products/documents`, {
        method: "DELETE",
        headers: {
          Authorization: "Bearer test-api-key-12345",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ids: ["r1", "r3"] }),
      })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: 2 });

    const after = await matcher.search(projectSlug, "products", { q: "shoes" });
    expect(after.hits.map((h) => h.id)).toEqual(["r2"]);

    // In-process surface
    const { removed } = await matcher.removeDocuments(projectSlug, "products", ["r2"]);
    expect(removed).toBe(1);

    const empty = await matcher.search(projectSlug, "products", { q: "shoes" });
    expect(empty.hits).toEqual([]);
  }, 30_000);

  test("removeDocuments with no ids is a no-op", async () => {
    const { removed } = await matcher.removeDocuments(projectSlug, "products", []);
    expect(removed).toBe(0);
  });

  test("removeDocuments ignores ids that do not exist", async () => {
    const { removed } = await matcher.removeDocuments(projectSlug, "products", ["does-not-exist"]);
    expect(removed).toBe(0);
  });
});
