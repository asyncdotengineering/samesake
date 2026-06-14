import "./load-env.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { collection, f, Channels, s } from "../../sdk/src/index.ts";
import type { EmbedRequest } from "../src/types.ts";
import { createMatcher } from "../src/createMatcher.ts";
import { createDbFromUrl } from "../src/db/client.ts";

const databaseUrl = process.env.DATABASE_URL;
const describeIf = databaseUrl ? describe : describe.skip;

function peakVector(dim: number, peak: number): number[] {
  const out = new Array(dim).fill(0);
  out[peak % dim] = 1;
  return out;
}

function embed(req: EmbedRequest): number[] {
  if (req.image?.url) return peakVector(req.dim, req.image.url.includes("red") ? 0 : 1);
  if (req.text) return peakVector(req.dim, req.text.includes("red") ? 0 : 1);
  throw new Error("expected text or image");
}

function mockFetch(responseFor: (url: string) => Response) {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return Promise.resolve(responseFor(url));
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

const agentCollection = collection("products", {
  fields: {
    title: f.text({ searchable: true }),
    brand: f.text({ filterable: true }),
    price: f.number({ filterable: true }),
    currency: f.text({ filterable: true }),
    available: f.boolean({ filterable: true }),
    sizes: f.array({ type: "text" }, { filterable: true }),
  },
  spaces: {
    intent: s.text({ source: "$title", model: "test-text", dim: 8 }),
    visual: s.image({ source: "$image_url", model: "test-img", dim: 8 }),
  },
  search: {
    channels: [Channels.fts({ fields: ["title"], weight: 1 }), Channels.spaces({ weight: 1 })],
    defaultSpaceWeights: { intent: 1, visual: 1 },
  },
});

describeIf("agent retrieval tools", () => {
  const projectSlug = `t_${Math.random().toString(36).slice(2, 10)}`;
  const redUrl = "https://example.com/red.jpg";
  const blueUrl = "https://example.com/blue.jpg";
  let matcher: ReturnType<typeof createMatcher>;
  let schemaName = "";
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
      embed: async (req) => embed(req),
    });
    await matcher.migrate();
    const applied = await matcher.apply(projectSlug, { entities: [], collections: [agentCollection] });
    schemaName = applied.schema;
    await matcher.pushDocuments(projectSlug, "products", [
      {
        id: "red",
        data: {
          title: "red cotton wedding guest dress",
          brand: "Luna",
          price: 128,
          currency: "USD",
          available: true,
          sizes: ["M"],
          image_url: redUrl,
          url: "https://shop.example/red",
          inventory_checked_at: new Date().toISOString(),
        },
      },
      {
        id: "blue",
        data: {
          title: "blue linen office dress",
          brand: "Aster",
          price: 98,
          currency: "USD",
          available: true,
          image_url: blueUrl,
          url: "https://shop.example/blue",
        },
      },
      {
        id: "sold",
        data: {
          title: "red sold out dress",
          brand: "Aster",
          price: 88,
          currency: "USD",
          available: false,
          sizes: ["M"],
          image_url: redUrl,
        },
      },
    ]);
    await matcher.index(projectSlug, "products");
  }, 60_000);

  afterAll(async () => {
    restoreFetch?.();
    if (schemaName) {
      const { db, close } = createDbFromUrl(databaseUrl!);
      await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`));
      await close();
    }
    await matcher?.close();
  });

  test("findProducts returns grounded candidates with freshness and verification", async () => {
    const result = await matcher.findProducts(projectSlug, "products", {
      intent: "red wedding guest dress",
      constraints: { inStock: true, maxPrice: 150, size: "M" },
      explain: true,
      limit: 3,
    });

    expect(result.products[0]!.id).toBe("red");
    expect(result.products[0]!.grounding).toMatchObject({
      project: projectSlug,
      collection: "products",
      productId: "red",
    });
    expect(result.products[0]!.availability?.freshness).toBe("fresh");
    expect(result.products[0]!.verification.status).toBe("satisfied");
    expect(result.products.map((p) => p.id)).not.toContain("sold");
    expect(result.products[0]!.why).toBeTruthy();
    expect(result.constraintTrace?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "available", source: "explicit", kind: "boolean" }),
        expect.objectContaining({ field: "price", source: "explicit", kind: "max" }),
        expect.objectContaining({ field: "sizes", source: "explicit", kind: "contains" }),
      ])
    );
  });

  test("strict mode excludes unknown verification fields", async () => {
    const result = await matcher.findProducts(projectSlug, "products", {
      intent: "blue dress",
      constraints: { inStock: true, size: "M" },
      constraintMode: "strict",
      limit: 3,
    });

    expect(result.products.map((p) => p.id)).not.toContain("blue");
  });

  test("findSimilarProducts can use a catalog product image", async () => {
    const result = await matcher.findSimilarProducts(projectSlug, "products", {
      productId: "red",
      constraints: { inStock: true },
      limit: 2,
    });

    expect(result.products[0]!.id).toBe("red");
  });

  test("HTTP route and descriptors expose structured agent tools", async () => {
    const toolsRes = await matcher.fetch(new Request("http://localhost/v1/agent-tools/tools.json"));
    expect(toolsRes.status).toBe(200);
    const tools = (await toolsRes.json()) as { tools: Array<{ name: string }> };
    expect(tools.tools.map((t) => t.name)).toContain("find_products");

    const res = await matcher.fetch(
      new Request(`http://localhost/v1/projects/${projectSlug}/collections/products/agent/find-products`, {
        method: "POST",
        headers: { authorization: "Bearer test-api-key-12345", "content-type": "application/json" },
        body: JSON.stringify({ intent: "red dress", constraints: { inStock: true }, limit: 1 }),
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { products: unknown[] };
    expect(body.products.length).toBe(1);

    const openapiRes = await matcher.fetch(new Request("http://localhost/v1/agent-tools/openapi.json"));
    const openapi = (await openapiRes.json()) as { paths: Record<string, unknown> };
    expect(Object.keys(openapi.paths)).toContain("/v1/projects/{project}/collections/{collection}/agent/find-products");
  });
});
