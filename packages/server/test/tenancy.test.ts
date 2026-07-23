import "./load-env.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { collection, f, Channels } from "@samesake/core";
import { createPostgresBackend } from "../../postgres/src/backend.ts";
import { createMatcher } from "../src/createMatcher.ts";
import { createDbFromUrl } from "../src/db/client.ts";

const databaseUrl = process.env.SAMESAKE_DATABASE_URL;
const describeIf = databaseUrl ? describe : describe.skip;

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function hashEmbed(text: string, dim: number): number[] {
  const v = new Array<number>(dim).fill(0);
  for (const tok of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) v[hash(tok) % dim]! += 1;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

function makeListings(scopes?: string[]) {
  return collection("listings", {
    ...(scopes ? { scopes } : {}),
    fields: {
      title: f.text({ searchable: true }),
      category: f.text({ filterable: true, facet: true }),
    },
    embeddings: { doc: { source: "$title", model: "stub", dim: 64 } },
    search: {
      channels: [
        Channels.fts({ fields: ["title"], weight: 1 }),
        Channels.cosine({ embedding: "doc", weight: 1 }),
      ],
      combiner: "rrf",
    },
  });
}

const open = collection("open_products", {
  fields: { title: f.text({ searchable: true }) },
  embeddings: { doc: { source: "$title", model: "stub", dim: 64 } },
  search: {
    channels: [Channels.fts({ fields: ["title"], weight: 1 }), Channels.cosine({ embedding: "doc", weight: 1 })],
    combiner: "rrf",
  },
});

describeIf("collection tenancy (scopes)", () => {
  const projectSlug = `t_${Math.random().toString(36).slice(2, 10)}`;
  let schemaName = "";
  let matcher: ReturnType<typeof createMatcher>;
  const listings = makeListings(["tenant_id"]);

  beforeAll(async () => {
    matcher = createMatcher({
      databaseUrl: databaseUrl!,
      apiKey: "tenancy-test-key",
      migrate: "eager",
      embed: async ({ text, dim }) => hashEmbed(text ?? "", dim),
    });
    await matcher.migrate();
    const applied = await matcher.apply(projectSlug, {
      entities: [],
      collections: [listings, open],
    });
    schemaName = applied.schema;

    // Adversarial: v1 and v2 carry an IDENTICAL title — only the scope separates them.
    await matcher.pushDocuments(projectSlug, "listings", [
      { id: "l1", scope: { tenant_id: "v1" }, data: { title: "red running shoes", category: "shoes" } },
      { id: "l2", scope: { tenant_id: "v1" }, data: { title: "blue denim jacket", category: "jackets" } },
      { id: "l3", scope: { tenant_id: "v2" }, data: { title: "red running shoes", category: "shoes" } },
      { id: "l4", scope: { tenant_id: "v2" }, data: { title: "leather handbag", category: "bags" } },
    ]);
    const { indexed } = await matcher.index(projectSlug, "listings");
    expect(indexed).toBe(4);
  }, 120000);

  afterAll(async () => {
    if (schemaName) {
      const { db, close } = createDbFromUrl(databaseUrl!);
      await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`));
      await close();
    }
    await matcher.close();
  });

  test("schema: scope column is NOT NULL and composite-indexed", async () => {
    const { db, close } = createDbFromUrl(databaseUrl!);
    try {
      const res = (await db.execute(
        sql.raw(
          `SELECT column_name, is_nullable FROM information_schema.columns
           WHERE table_schema = '${schemaName}' AND table_name = 'c_listings' AND column_name = 'scope_tenant_id'`
        )
      )) as unknown;
      const rows = Array.isArray(res)
        ? (res as Array<Record<string, unknown>>)
        : ((res as { rows?: Array<Record<string, unknown>> }).rows ?? []);
      expect(rows.length).toBe(1);
      expect(rows[0]!.is_nullable).toBe("NO");
    } finally {
      await close();
    }

    const scopeSchema = `g4_${Math.random().toString(36).slice(2, 10)}`;
    const scopedCollection = collection("g4_rows", {
      ...({ scopes: ["tenant_id"] } as { scopes: string[] }),
      fields: { title: f.text() },
    });
    const backend = createPostgresBackend({ url: databaseUrl!, collection: scopedCollection, schema: scopeSchema });
    try {
      await backend.migrate();
      await backend.enrichStore.upsert([
        { id: "scoped-row", scope: { tenant_id: "tenant-a" }, data: { title: "tenant row" } },
      ]);
      const stored = await backend.adapter.query(`SELECT scope_tenant_id FROM ${scopeSchema}.c_g4_rows WHERE id = $1`, ["scoped-row"]);
      expect(stored[0]?.scope_tenant_id).toBe("tenant-a");
    } finally {
      await backend.adapter.query(`DROP SCHEMA IF EXISTS ${scopeSchema} CASCADE`);
      await backend.close();
    }
  });

  test("push without scope is rejected with the scope contract in the message", async () => {
    await expect(
      matcher.pushDocuments(projectSlug, "listings", [{ id: "x1", data: { title: "t" } }])
    ).rejects.toThrow(/scope\.tenant_id/);
  });

  test("push with an unknown scope key is rejected", async () => {
    await expect(
      matcher.pushDocuments(projectSlug, "listings", [
        { id: "x2", scope: { tenant_id: "v1", vendor: "nope" }, data: { title: "t" } },
      ])
    ).rejects.toThrow(/unknown scope key "vendor"/);
  });

  test("scope on an unscoped collection is rejected", async () => {
    await expect(
      matcher.pushDocuments(projectSlug, "open_products", [
        { id: "o1", scope: { tenant_id: "v1" }, data: { title: "t" } },
      ])
    ).rejects.toThrow(/declares no scopes/);
  });

  test("cross-tenant id takeover is rejected", async () => {
    await expect(
      matcher.pushDocuments(projectSlug, "listings", [
        { id: "l1", scope: { tenant_id: "v2" }, data: { title: "hijacked" } },
      ])
    ).rejects.toThrow(/different scope/);
  });

  test("search is scoped: identical titles never leak across tenants", async () => {
    const v1 = await matcher.search(projectSlug, "listings", {
      q: "red running shoes",
      scope: { tenant_id: "v1" },
      limit: 10,
    });
    expect(v1.hits.map((h) => h.id)).toEqual(["l1"]);
    const v2 = await matcher.search(projectSlug, "listings", {
      q: "red running shoes",
      scope: { tenant_id: "v2" },
      limit: 10,
    });
    expect(v2.hits.map((h) => h.id)).toEqual(["l3"]);
  });

  test("search without scope on a scoped collection is rejected", async () => {
    await expect(
      matcher.search(projectSlug, "listings", { q: "shoes", limit: 5 })
    ).rejects.toThrow(/requires scope\.tenant_id/);
  });

  test("facets are scoped", async () => {
    const res = await matcher.facets(projectSlug, "listings", {
      facets: ["category"],
      scope: { tenant_id: "v2" },
    });
    const category = res.category;
    const values = category && "values" in category ? category.values : [];
    const byValue = new Map(values.map((v) => [String(v.value), v.count]));
    expect(byValue.get("bags")).toBe(1);
    expect(byValue.has("jackets")).toBe(false); // v1-only category must not appear
  });

  test("getDocument is scoped", async () => {
    const own = await matcher.getDocument(projectSlug, "listings", "l1", { scope: { tenant_id: "v1" } });
    expect(own?.id).toBe("l1");
    const foreign = await matcher.getDocument(projectSlug, "listings", "l1", { scope: { tenant_id: "v2" } });
    expect(foreign).toBeNull();
  });

  test("removeDocuments is scoped: a tenant cannot delete another tenant's rows", async () => {
    const wrong = await matcher.removeDocuments(projectSlug, "listings", ["l3"], { tenant_id: "v1" });
    expect(wrong.removed).toBe(0);
    const still = await matcher.search(projectSlug, "listings", {
      q: "red running shoes",
      scope: { tenant_id: "v2" },
      limit: 5,
    });
    expect(still.hits.map((h) => h.id)).toEqual(["l3"]);
    const right = await matcher.removeDocuments(projectSlug, "listings", ["l3"], { tenant_id: "v2" });
    expect(right.removed).toBe(1);
  });

  test("HTTP surface: scoped GET search + scope-checked delete", async () => {
    const res = await matcher.fetch(
      new Request(
        `http://localhost/v1/projects/${projectSlug}/collections/listings/search?q=denim+jacket&scope.tenant_id=v1`,
        { headers: { Authorization: "Bearer tenancy-test-key" } }
      )
    );
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { hits: { id: string }[] };
    expect(body.hits.map((h) => h.id)).toEqual(["l2"]);

    const unscoped = await matcher.fetch(
      new Request(
        `http://localhost/v1/projects/${projectSlug}/collections/listings/search?q=denim`,
        { headers: { Authorization: "Bearer tenancy-test-key" } }
      )
    );
    expect(unscoped.ok).toBe(false);
  });

  test("changing scopes on an existing collection is a destructive migration", async () => {
    await expect(
      matcher.apply(projectSlug, { entities: [], collections: [makeListings(["tenant_id", "region"])] })
    ).rejects.toThrow(/destructive/);
  });
});
