import "./load-env.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { collection, f, Channels, fashionSearchDefaults } from "../../sdk/src/index.ts";
import { denseAndFtsIndexingByTitle } from "./fixtures.ts";
import type { EmbedRequest } from "../src/types.ts";
import { createMatcher } from "../src/createMatcher.ts";
import { createDbFromUrl } from "../src/db/client.ts";
import { __setImageTransport } from "../src/core/fetch-image.ts";

const databaseUrl = process.env.SAMESAKE_DATABASE_URL;
const describeIf = databaseUrl ? describe : describe.skip;

function peakVector(dim: number, peak: number): number[] {
  const out = new Array(dim).fill(0);
  out[peak % dim] = 1;
  return out;
}

function multimodalStub(req: EmbedRequest): number[] {
  if (req.image?.url) {
    return peakVector(req.dim, req.image.url.includes("red") ? 0 : 1);
  }
  if (req.text) {
    return peakVector(req.dim, req.text.includes("red") ? 0 : 1);
  }
  throw new Error("stub needs text or image");
}

function mockFetch(responseFor: (url: string) => Response) {
  __setImageTransport(async ({ url }) => {
    const res = responseFor(url.href);
    const headers: Record<string, string | undefined> = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    const buf = new Uint8Array(await res.arrayBuffer());
    async function* body() {
      if (buf.byteLength) yield buf;
    }
    return { status: res.status, headers, body: body() };
  });
  return () => __setImageTransport(null);
}

const shopCollection = collection("products", {
  fields: {
    title: f.text({ searchable: true }),
    brand: f.text({ filterable: true, facet: true }),
    price: f.number({ filterable: true, budget: true }),
    available: f.boolean({ filterable: true }),
    category: f.text({ filterable: true }),
    colors: f.array(f.enum(["red", "blue", "green", "black", "purple"] as const), {
      filterable: true,
      soft: true,
    }),
    material: f.enum(["cotton", "linen", "denim", "unknown"] as const, {
      filterable: true,
      soft: true,
    }),
    sizes: f.array({ type: "text" }, { filterable: true }),
    styles: f.array({ type: "text" }, { filterable: true, soft: true }),
  },
  embeddings: {
    doc: { source: "$title", model: "test-text", dim: 8 },
    visual: { kind: "image", source: "$image_url", model: "test-img", dim: 8 },
  },
  indexing: denseAndFtsIndexingByTitle,
  search: {
    channels: [
      Channels.fts({ fields: ["title"], weight: 1 }),
      Channels.cosine({ embedding: "doc", weight: 1 }),
      Channels.cosine({ embedding: "visual", weight: 1 }),
    ],
    ...fashionSearchDefaults(),
  },
});

describeIf("shopSearch product surface", () => {
  const projectSlug = `t_${Math.random().toString(36).slice(2, 10)}`;
  const redUrl = "https://example.com/red-dress.jpg";
  const blueUrl = "https://example.com/blue-dress.jpg";
  let schemaName = "";
  let matcher: ReturnType<typeof createMatcher>;
  let restoreFetch: (() => void) | null = null;

  beforeAll(async () => {
    restoreFetch = mockFetch(() =>
      new Response(Buffer.from([0xff, 0xd8, 0xff]), {
        headers: { "content-type": "image/jpeg" },
      })
    );
    matcher = createMatcher({
      databaseUrl: databaseUrl!,
      apiKey: "test-api-key-12345",
      migrate: "eager",
      embed: async (req) => multimodalStub(req),
    });
    await matcher.migrate();
    const r = await matcher.apply(projectSlug, {
      entities: [],
      collections: [shopCollection],
    });
    schemaName = r.schema;
    await matcher.pushDocuments(projectSlug, "products", [
      {
        id: "red",
        data: {
          title: "red cotton summer dress",
          brand: "Luna",
          price: 120,
          available: true,
          category: "dresses",
          colors: ["red"],
          material: "cotton",
          sizes: ["M"],
          styles: ["romantic"],
          image_url: redUrl,
        },
      },
      {
        id: "blue",
        data: {
          title: "blue linen office dress",
          brand: "Aster",
          price: 80,
          available: true,
          category: "dresses",
          colors: ["blue"],
          material: "linen",
          sizes: ["S"],
          styles: ["classic"],
          image_url: blueUrl,
        },
      },
      {
        id: "sold-red",
        data: {
          title: "red denim party dress",
          brand: "Aster",
          price: 95,
          available: false,
          category: "dresses",
          colors: ["red"],
          material: "denim",
          sizes: ["M"],
          styles: ["party"],
          image_url: redUrl,
        },
      },
    ]);
    const { db, close } = createDbFromUrl(databaseUrl!);
    await db.execute(sql.raw(`
      UPDATE ${schemaName}.c_products
      SET fts_src = data->>'title', pipeline_status = 'ready'
    `));
    await close();
    await matcher.index(projectSlug, "products");
  }, 60_000);

  afterAll(async () => {
    restoreFetch?.();
    if (schemaName) {
      const { db, close } = createDbFromUrl(databaseUrl!);
      await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`));
      await close();
    }
    if (matcher) await matcher.close();
  });

  test("accepts image plus intent while preserving hard filters and explanations", async () => {
    const result = await matcher.shopSearch(projectSlug, "products", {
      q: "summer dress",
      image: { url: redUrl },
      filters: { available: true },
      rankingPolicy: { weights: { visual: 3, availability: 1 } },
      limit: 3,
      debug: true,
    });

    expect(result.hits.map((h) => h.id)).not.toContain("sold-red");
    expect(result.hits[0]!.id).toBe("red");
    expect(result.explanations?.[0]?.factors).toHaveProperty("visual");
    expect(result.appliedFilters).toEqual({ available: true });
    expect(result.constraintTrace?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "available", source: "explicit", kind: "boolean" }),
      ])
    );
    expect(result.constraintTrace?.plan.predicates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "available", fieldType: "boolean", operator: "eq", source: "explicit" }),
      ])
    );
  });

  test("personalization reorders without violating hard filters", async () => {
    const result = await matcher.shopSearch(projectSlug, "products", {
      q: "dress",
      filters: { available: true },
      personalization: {
        preferredBrands: ["Aster"],
        blockedBrands: ["Luna"],
        priceBand: { max: 100 },
        viewedProductIds: ["red"],
      },
      rankingPolicy: { weights: { personalization: 3, relevance: 0.2 } },
      limit: 2,
      explain: true,
    });

    expect(result.hits[0]!.id).toBe("blue");
    expect(result.hits.every((h) => h.available === true)).toBe(true);
    expect(result.explanations?.[0]?.factors).toHaveProperty("personalization");
  });

  test("recovers no-results by relaxing declared relaxable filters transparently", async () => {
    const result = await matcher.shopSearch(projectSlug, "products", {
      q: "dress",
      filters: { available: true, category: "skirts", colors: ["purple"], material: "denim" },
      recoverNoResults: true,
      limit: 3,
    });

    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.fallback?.reason).toBe("no_results");
    expect(result.fallback?.relaxedFilters).toEqual(expect.arrayContaining(["category", "colors", "material"]));
    expect(result.constraintTrace?.explicitFilters).toMatchObject({ category: "skirts" });
    expect(result.constraintTrace?.appliedFilters).toEqual({ available: true });
    expect(result.constraintTrace?.relaxedFields).toEqual(expect.arrayContaining(["category", "colors", "material"]));
    expect(result.constraintTrace?.plan.predicates).toEqual([
      expect.objectContaining({ field: "available", fieldType: "boolean", operator: "eq", source: "explicit" }),
    ]);
    expect(result.hits.every((h) => h.available === true)).toBe(true);
  });

  test("catalog sync updates filter columns for inventory and price changes", async () => {
    const synced = await matcher.syncCatalogEvent(projectSlug, "products", {
      type: "price.update",
      id: "red",
      changes: { price: 60, available: false },
    });
    expect(synced).toEqual({ synced: true, action: "upserted", needsReindex: false });

    const result = await matcher.shopSearch(projectSlug, "products", {
      q: "red dress",
      filters: { available: true, price: { $lte: 70 } },
      limit: 5,
    });
    expect(result.hits.map((h) => h.id)).not.toContain("red");
  });
});
