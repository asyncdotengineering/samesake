import { collection, f, Channels } from "../../packages/sdk/src/index.ts";
import { createDbFromUrl, createMatcher } from "../../packages/server/src/index.ts";
import type { EmbedRequest } from "../../packages/server/src/types.ts";
import { sql } from "../../packages/server/node_modules/drizzle-orm/index.js";

const PROJECT = `agentdemo_${Math.random().toString(36).slice(2, 8)}`;
const COLLECTION = "products";
const API_KEY = "agent-demo-key-12345";

function peakVector(dim: number, peak: number): number[] {
  const out = new Array(dim).fill(0);
  out[peak % dim] = 1;
  return out;
}

function embed(req: EmbedRequest): Promise<number[]> {
  if (req.image?.url) return Promise.resolve(peakVector(req.dim, req.image.url.includes("red") ? 0 : 1));
  if (req.text) return Promise.resolve(peakVector(req.dim, req.text.includes("red") ? 0 : 1));
  throw new Error("embed requires text or image");
}

function mockImageFetch() {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://example.com/")) {
      return Promise.resolve(new Response(Buffer.from([0xff, 0xd8, 0xff]), {
        headers: { "content-type": "image/jpeg" },
      }));
    }
    return original(input);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

const products = collection(COLLECTION, {
  fields: {
    title: f.text({ searchable: true }),
    price: f.number({ filterable: true }),
    currency: f.text({ filterable: true }),
    available: f.boolean({ filterable: true }),
    sizes: f.array({ type: "text" }, { filterable: true }),
  },
  embeddings: {
    doc: { source: "$title", model: "demo-text", dim: 8 },
    visual: { kind: "image", source: "$image_url", model: "demo-image", dim: 8 },
  },
  search: {
    channels: [
      Channels.fts({ fields: ["title"], weight: 1 }),
      Channels.cosine({ embedding: "doc", weight: 1 }),
      Channels.cosine({ embedding: "visual", weight: 1 }),
    ],
  },
});

async function main() {
  if (!process.env.SAMESAKE_DATABASE_URL) {
    throw new Error("SAMESAKE_DATABASE_URL is required for the agentic commerce demo");
  }
  const restoreFetch = mockImageFetch();
  const matcher = createMatcher({
    databaseUrl: process.env.SAMESAKE_DATABASE_URL,
    apiKey: API_KEY,
    migrate: "eager",
    embed,
  });
  let schemaName = "";

  try {
    await matcher.migrate();
    const applied = await matcher.apply(PROJECT, { entities: [], collections: [products] });
    schemaName = applied.schema;
    await matcher.pushDocuments(PROJECT, COLLECTION, [
      {
        id: "red-dress",
        data: {
          title: "red cotton wedding guest dress",
          price: 128,
          currency: "USD",
          available: true,
          sizes: ["M"],
          image_url: "https://example.com/red-dress.jpg",
          url: "https://shop.example/red-dress",
          inventory_checked_at: new Date().toISOString(),
        },
      },
      {
        id: "blue-dress",
        data: {
          title: "blue linen office dress",
          price: 98,
          currency: "USD",
          available: true,
          image_url: "https://example.com/blue-dress.jpg",
          url: "https://shop.example/blue-dress",
        },
      },
    ]);
    await matcher.index(PROJECT, COLLECTION);

    const textOnly = await matcher.findProducts(PROJECT, COLLECTION, {
      intent: "red wedding guest dress under 150",
      constraints: { inStock: true, maxPrice: 150, size: "M" },
      explain: true,
      limit: 2,
    });
    const visual = await matcher.findProducts(PROJECT, COLLECTION, {
      intent: "red similar look but purchasable",
      image: { kind: "product_image", productId: "red-dress" },
      constraints: { inStock: true, maxPrice: 150 },
      explain: true,
      limit: 2,
    });

    console.log(JSON.stringify({
      boundary: "Samesake stops at grounded retrieval. Cart, checkout, and payment are downstream systems.",
      textOnly: textOnly.products.map((p) => ({
        id: p.id,
        price: p.price,
        availability: p.availability,
        verification: p.verification,
        why: p.why,
      })),
      imageAndText: visual.products.map((p) => ({
        id: p.id,
        grounding: p.grounding,
        verification: p.verification,
      })),
      downstreamHandoff: {
        kind: "candidate_products",
        productIds: visual.products.map((p) => p.id),
        nextSystem: "cart/payment guardrail provider such as Allowance or Zinc",
      },
    }, null, 2));
  } finally {
    restoreFetch();
    await matcher.close();
    if (schemaName) {
      const { db, close } = createDbFromUrl(process.env.SAMESAKE_DATABASE_URL!);
      await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`));
      await close();
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
