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

  const project = `hello_spaces_${Math.random().toString(36).slice(2, 8)}`;
  console.log("hello-spaces — segmented vector weight flip");
  console.log(`project: ${project}\n`);

  const matcher = createMatcher({
    databaseUrl,
    apiKey: "hello-spaces-key",
    migrate: "eager",
    embed: async ({ text, dim }) => stubEmbed(text ?? "", dim),
  });

  let schemaName = "";
  try {
    await matcher.migrate();
    const applied = await matcher.apply(project, { entities: [], collections: [products] });
    schemaName = applied.schema;
    console.log(`▸ apply spaces collection... ✓ (${schemaName})`);

    await matcher.pushDocuments(
      project,
      "products",
      DOCS.map((d) => ({ id: d.id, data: { title: d.title, brand: d.brand, price: d.price, category: d.category } }))
    );
    console.log("▸ push 5 documents... ✓");

    const indexed = await matcher.index(project, "products");
    if (indexed.indexed !== 5) throw new Error(`expected 5 indexed, got ${indexed.indexed}`);
    console.log("▸ index space_vec... ✓");

    const q = "red running shoes";
    const styleHeavy = await matcher.search(project, "products", {
      q,
      limit: 5,
      weights: { fts: 0, cosine: 0, spaces: { style: 5, price: 0.1 } },
    });
    const priceHeavy = await matcher.search(project, "products", {
      q,
      limit: 5,
      weights: { fts: 0, cosine: 0, spaces: { style: 0.1, price: 5 } },
    });

    const styleTop = styleHeavy.hits[0]?.id;
    const priceTop = priceHeavy.hits[0]?.id;
    console.log(`▸ style-heavy top: id=${styleTop} "${styleHeavy.hits[0]?.title}"`);
    console.log(`▸ price-heavy top: id=${priceTop} "${priceHeavy.hits[0]?.title}"`);

    if (styleTop !== "1") {
      throw new Error(`style-heavy expected id=1 (red running shoes), got ${styleTop}`);
    }
    if (priceTop !== "5") {
      throw new Error(`price-heavy expected id=5 (red hat, cheapest item), got ${priceTop}`);
    }
    if (styleHeavy.hits.map((h) => h.id).join(",") === priceHeavy.hits.map((h) => h.id).join(",")) {
      throw new Error("weight flip did not change ordering");
    }
    console.log("▸ weight flip reorders results... ✓");

    console.log("\n4 passed, 0 failed");
    console.log("\n✓ hello-spaces is green.");
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
