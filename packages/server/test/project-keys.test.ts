import "./load-env.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createMatcher } from "../src/createMatcher.ts";
import { createDbFromUrl } from "../src/db/client.ts";
import { stubEmbed, testProductsCollection } from "./fixtures.ts";

const databaseUrl = process.env.DATABASE_URL;
const describeIf = databaseUrl ? describe : describe.skip;

const MASTER = "test-api-key-12345";

async function authFetch(
  matcher: ReturnType<typeof createMatcher>,
  path: string,
  key: string,
  init?: RequestInit
): Promise<Response> {
  return matcher.fetch(
    new Request(`http://local${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    })
  );
}

describeIf("project API keys", () => {
  const projectA = `t_${Math.random().toString(36).slice(2, 10)}`;
  const projectB = `t_${Math.random().toString(36).slice(2, 10)}`;
  let schemaA = "";
  let schemaB = "";
  let matcher: ReturnType<typeof createMatcher>;
  let projectKeyA = "";

  beforeAll(async () => {
    matcher = createMatcher({
      databaseUrl: databaseUrl!,
      apiKey: MASTER,
      migrate: "eager",
      embed: async ({ text, dim }) => stubEmbed(text, dim),
    });
    await matcher.migrate();
    const ra = await matcher.apply(projectA, { entities: [], collections: [testProductsCollection] });
    schemaA = ra.schema;
    const rb = await matcher.apply(projectB, { entities: [], collections: [testProductsCollection] });
    schemaB = rb.schema;
    await matcher.indexDocuments(projectA, "products", [
      {
        id: "1",
        data: { title: "red shoes" },
        doc: "red shoes",
        embedding: stubEmbed("red shoes", 8),
        fields: { title: "red shoes", brand: "nike", price: 50, category: "shoes", colors: ["red"] },
      },
    ]);
    const rotated = await matcher.rotateProjectKey(projectA);
    projectKeyA = rotated.apiKey;
  });

  afterAll(async () => {
    const { db, close } = createDbFromUrl(databaseUrl!);
    if (schemaA) await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schemaA} CASCADE`));
    if (schemaB) await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schemaB} CASCADE`));
    await close();
    if (matcher) await matcher.close();
  });

  test("rotated project key authorizes own project search", async () => {
    const res = await authFetch(matcher, `/v1/projects/${projectA}/collections/products/search`, projectKeyA, {
      method: "POST",
      body: JSON.stringify({ q: "red shoes" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hits: unknown[] };
    expect(body.hits.length).toBeGreaterThan(0);
  });

  test("foreign project key is rejected", async () => {
    const res = await authFetch(matcher, `/v1/projects/${projectB}/collections/products/search`, projectKeyA, {
      method: "POST",
      body: JSON.stringify({ q: "red shoes" }),
    });
    expect(res.status).toBe(401);
  });

  test("master key always works on project routes", async () => {
    const res = await authFetch(matcher, `/v1/projects/${projectB}/collections/products/search`, MASTER, {
      method: "POST",
      body: JSON.stringify({ q: "shoes" }),
    });
    expect(res.status).toBe(200);
  });

  test("/v1/metrics requires master key", async () => {
    const denied = await authFetch(matcher, "/v1/metrics", projectKeyA);
    expect(denied.status).toBe(401);
    const ok = await authFetch(matcher, "/v1/metrics", MASTER);
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { searches_total: number };
    expect(typeof body.searches_total).toBe("number");
  });
});
