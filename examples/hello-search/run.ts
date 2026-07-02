#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createMatcher, createDbFromUrl } from "@samesake/server";
import { products } from "./samesake.config.ts";
import { stubEmbed } from "./stub-embed.ts";

function loadEnv(): void {
  if (process.env.SAMESAKE_DATABASE_URL) return;
  try {
    const env = readFileSync(join(import.meta.dir, "../../.env"), "utf8");
    for (const line of env.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq);
      const val = trimmed.slice(eq + 1);
      if (key === "SAMESAKE_DATABASE_URL") process.env.SAMESAKE_DATABASE_URL = val;
    }
  } catch {
    /* no .env */
  }
}

const DOCS = [
  { id: "1", title: "red running shoes", brand: "nike", price: 120, category: "shoes" },
  { id: "2", title: "blue casual sneakers", brand: "adidas", price: 90, category: "shoes" },
  { id: "3", title: "leather wallet", brand: "nike", price: 45, category: "accessories" },
  { id: "4", title: "green dress", brand: "zara", price: 80, category: "apparel" },
  { id: "5", title: "red hat", brand: "nike", price: 25, category: "accessories" },
] as const;

async function main(): Promise<void> {
  loadEnv();
  const databaseUrl = process.env.SAMESAKE_DATABASE_URL;
  if (!databaseUrl) {
    console.error("SAMESAKE_DATABASE_URL is required (set in .env or environment)");
    process.exit(1);
  }

  const project = `hello_search_${Math.random().toString(36).slice(2, 8)}`;
  console.log("hello-search — hybrid search smoke");
  console.log(`project: ${project}\n`);

  const matcher = createMatcher({
    databaseUrl,
    apiKey: "hello-search-key",
    migrate: "eager",
    embed: async ({ text, dim }) => stubEmbed(text, dim),
  });

  let schemaName = "";
  try {
    await matcher.migrate();
    const applied = await matcher.apply(project, { entities: [], collections: [products] });
    schemaName = applied.schema;
    console.log(`▸ apply collection schema... ✓ (${schemaName})`);

    const pushed = await matcher.pushDocuments(
      project,
      "products",
      DOCS.map((d) => ({ id: d.id, data: { title: d.title, brand: d.brand, price: d.price, category: d.category } }))
    );
    if (pushed.upserted !== 5) throw new Error(`expected 5 upserts, got ${pushed.upserted}`);
    console.log("▸ push 5 documents... ✓");

    const indexed = await matcher.index(project, "products");
    if (indexed.indexed !== 5) throw new Error(`expected 5 indexed, got ${indexed.indexed}`);
    console.log("▸ index with stub embed... ✓");

    const hybrid = await matcher.search(project, "products", {
      q: "running shoes",
      filters: { brand: "nike" },
      limit: 3,
    });
    if (hybrid.hits.length === 0) throw new Error("hybrid search returned no hits");
    if (hybrid.hits[0]!.id !== "1") {
      throw new Error(`expected top hit id=1, got ${hybrid.hits[0]!.id}`);
    }
    for (const h of hybrid.hits) {
      if (h.brand !== "nike") throw new Error(`filter leak: hit ${h.id} brand=${h.brand}`);
    }
    console.log("▸ hybrid search + brand filter... ✓");
    console.log(`  top: "${hybrid.hits[0]!.title}" (score ${hybrid.hits[0]!.score.toFixed(4)})`);

    const route = await matcher.fetch(
      new Request(
        `http://localhost/v1/projects/${project}/collections/products/search?q=wallet&limit=2`,
        { headers: { Authorization: "Bearer hello-search-key" } }
      )
    );
    if (!route.ok) throw new Error(`GET search failed: ${route.status}`);
    const body = (await route.json()) as { hits: { id: string }[] };
    if (!body.hits.some((h) => h.id === "3")) throw new Error("GET search missed wallet doc");
    console.log("▸ GET /collections/.../search route... ✓");

    console.log("\n5 passed, 0 failed");
    console.log("\n✓ hello-search is green.");
  } finally {
    if (schemaName) {
      const { db, close } = createDbFromUrl(databaseUrl);
      await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`));
      await close();
    }
    await matcher.close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
