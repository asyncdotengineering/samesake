import "./load-env.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createMatcher } from "../src/createMatcher.ts";
import { createDbFromUrl } from "../src/db/client.ts";
import { stubEmbed, testProductsCollection } from "./fixtures.ts";

const databaseUrl = process.env.SAMESAKE_DATABASE_URL;
const describeIf = databaseUrl ? describe : describe.skip;

describeIf("search filter validation", () => {
  const projectSlug = `t_${Math.random().toString(36).slice(2, 10)}`;
  let schemaName = "";
  let matcher: ReturnType<typeof createMatcher>;
  const masterKey = "test-api-key-12345";

  beforeAll(async () => {
    matcher = createMatcher({
      databaseUrl: databaseUrl!,
      apiKey: masterKey,
      migrate: "eager",
      embed: async ({ text, dim }) => stubEmbed(text, dim),
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

  async function postSearch(body: Record<string, unknown>) {
    return matcher.fetch(
      new Request(`http://localhost/v1/projects/${projectSlug}/collections/products/search`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${masterKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ q: "shoes", ...body }),
      })
    );
  }

  test("unknown filter field returns 400", async () => {
    const r = await postSearch({ filters: { not_a_field: "x" } });
    expect(r.status).toBe(400);
    const j = (await r.json()) as { error: string };
    expect(j.error).toBe("unknown_filter_field");
  });

  test("unknown filter operator returns 400", async () => {
    const r = await postSearch({ filters: { brand: { $where: "1=1" } } });
    expect(r.status).toBe(400);
    const j = (await r.json()) as { error: string };
    expect(j.error).toBe("unknown_filter_operator");
  });

  test("non-numeric value on number field returns 400", async () => {
    const r = await postSearch({ filters: { price: { $gt: "not-a-number" } } });
    expect(r.status).toBe(400);
    const j = (await r.json()) as { error: string };
    expect(j.error).toBe("invalid_filter_value");
  });

  test("hostile string filter value stays data (no 500)", async () => {
    const r = await postSearch({
      filters: { brand: { $contains: "1=1; DROP TABLE x;" } },
    });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { hits: unknown[] };
    expect(Array.isArray(j.hits)).toBe(true);
  });
});
