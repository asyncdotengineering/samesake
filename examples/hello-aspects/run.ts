#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createMatcher, createDbFromUrl } from "@samesake/server";
import { products } from "./samesake.config.ts";
import { stubEmbed } from "./stub-embed.ts";

function loadEnv(): void {
  if (process.env.SAMESAKE_DATABASE_URL) return;
  const envPath = join(import.meta.dir, "../../.env");
  if (!existsSync(envPath)) return;
  const env = readFileSync(envPath, "utf8");
  for (const line of env.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq);
    if (key === "SAMESAKE_DATABASE_URL") process.env.SAMESAKE_DATABASE_URL = trimmed.slice(eq + 1);
  }
}

const docs = [
  ["1", "red floral wedding dress", "luna", "dresses", ["red color", "good for weddings", "floral pattern"]],
  ["2", "blue linen office shirt", "aster", "tops", ["blue color", "office style", "made from linen"]],
  ["3", "green trail running shoes", "nike", "footwear", ["green color", "sporty style", "running"]],
  ["4", "black leather crossbody bag", "orbit", "bags", ["black color", "made from leather", "everyday"]],
  ["5", "ivory beach wedding sandals", "shore", "footwear", ["ivory color", "good for beach weddings", "flat fit"]],
  ["6", "pink romantic midi skirt", "flora", "bottoms", ["pink color", "romantic style", "midi length"]],
  ["7", "navy relaxed cotton trousers", "north", "bottoms", ["navy color", "relaxed fit", "made from cotton"]],
  ["8", "yellow casual tote bag", "sun", "bags", ["yellow color", "casual style", "everyday"]],
] as const;

async function main(): Promise<void> {
  loadEnv();
  const databaseUrl = process.env.SAMESAKE_DATABASE_URL;
  if (!databaseUrl) throw new Error("SAMESAKE_DATABASE_URL is required (set in .env or environment)");

  const project = `hello_aspects_${Math.random().toString(36).slice(2, 8)}`;
  const matcher = createMatcher({
    databaseUrl,
    apiKey: "hello-aspects-key",
    migrate: "eager",
    embed: async ({ text, dim }) => stubEmbed(text ?? "", dim),
  });
  let schemaName = "";
  try {
    await matcher.migrate();
    const applied = await matcher.apply(project, { entities: [], collections: [products] });
    schemaName = applied.schema;
    const rows = docs.map(([id, title, brand, category, claims]) => ({
      id,
      data: { title, brand, category, image_url: `https://example.invalid/${id}.jpg` },
      doc: title,
      embeddings: {
        doc: stubEmbed(title, 8),
        visual: stubEmbed(`visual:${category}`, 8),
      },
      evidence: { facets: claims.map((src) => ({ src, vector: stubEmbed(src, 8) })) },
      fields: { title, brand, category },
    }));
    await matcher.indexDocuments(project, "products", rows);
    const { db, close } = createDbFromUrl(databaseUrl);
    const client = (db as unknown as { $client: { unsafe(query: string): Promise<unknown> } }).$client;
    await client.unsafe(`UPDATE ${schemaName}.c_products SET fts_src = doc WHERE doc IS NOT NULL`);
    await close();

    const routed = await matcher.searchExplain(project, "products", {
      q: "floral beach wedding",
      mode: "similar",
      limit: 3,
      weights: { fts: 0, aspects: { doc: 0.5, facets: 1, visual: 0.8 } },
    });
    console.log("hello-aspects — routed retrieval");
    console.log(JSON.stringify(routed.docs.map((doc) => ({ id: doc.id, aspects: doc.aspect_ranks })), null, 2));

    const keyword = await matcher.searchExplain(project, "products", {
      q: "nike",
      mode: "intent",
      limit: 3,
      weights: { fts: 1, aspects: { doc: 1, facets: 0, visual: 0 } },
    });
    console.log("hello-aspects — keyword retrieval");
    console.log(JSON.stringify(keyword.docs.map((doc) => ({ id: doc.id, aspects: doc.aspect_ranks })), null, 2));
    console.log("\n✓ hello-aspects is green.");
  } finally {
    if (schemaName) {
      const { db, close } = createDbFromUrl(databaseUrl);
      const client = (db as unknown as { $client: { unsafe(query: string): Promise<unknown> } }).$client;
      await client.unsafe(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await close();
    }
    await matcher.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
