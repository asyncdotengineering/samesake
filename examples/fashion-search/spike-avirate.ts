/**
 * Spike: prove intent-driven fashion search end-to-end on REAL store data.
 *
 * Reuses the fashion-search pipeline (ingest -> enrich -> index -> search)
 * on the two real store fixtures (Avirate Shopify + Clotho Woo, ~10 products),
 * with NO 4000-product guard. Real Gemini embeddings (gemini-embedding-2) + real
 * Gemini vision enrichment (gemini-3.1-flash-lite).
 *
 * Run:
 *   DATABASE_URL='postgresql://mithushancj@localhost:5432/samesake_spike' \
 *   FASHION_DATASET_DIR=/tmp/spike-dataset \
 *   bun --env-file=../../.env spike-avirate.ts
 */
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { createDbFromUrl, createMatcher, shopifyFeedFromJson, wooFeedFromJson } from "@samesake/server";
import { geminiEmbed, geminiGenerate } from "./gemini.ts";
import { COLLECTION, PROJECT, productsCollection } from "./samesake.config.ts";

// NOTE: we deliberately do NOT import ./ingest.ts — it calls main() unconditionally
// (no import.meta.main guard), so importing it would spin up a second eager-migrate
// matcher that races this one. Inline the ingest with the connector helpers instead.
async function ingestFixtures(matcher: ReturnType<typeof createMatcher>): Promise<void> {
  const avirate = JSON.parse(readFileSync("/tmp/spike-dataset/aviratefashion_shopify_p1.json", "utf8")) as { products: Record<string, unknown>[] };
  const clothoRaw = JSON.parse(readFileSync("/tmp/spike-dataset/clotho_woo_p1.json", "utf8"));
  const clotho = Array.isArray(clothoRaw) ? clothoRaw : (clothoRaw.products ?? []);
  const feeds: Array<{ domain: string; feed: { pull: () => AsyncIterable<{ id: string; data: Record<string, unknown> }> } }> = [
    { domain: "aviratefashion", feed: shopifyFeedFromJson({ products: avirate.products }, { domain: "aviratefashion", currency: "LKR" }) },
    { domain: "clotho", feed: wooFeedFromJson(clotho, { domain: "clotho", currency: "LKR" }) },
  ];
  const batch: Array<{ id: string; data: Record<string, unknown> }> = [];
  for (const { domain, feed } of feeds) {
    for await (const row of feed.pull()) {
      batch.push({ id: `${domain}:${row.id}`, data: { ...row.data, store_domain: domain, external_id: row.id } });
    }
  }
  const r = await matcher.pushDocuments(PROJECT, COLLECTION, batch);
  console.log(`  pushed ${r.upserted} products from ${feeds.length} store feeds`);
}

// Hard guarantee we never touch the Neon dev DB: force local, regardless of --env-file.
const LOCAL = "postgresql://mithushancj@localhost:5432/samesake_spike";
process.env.DATABASE_URL = LOCAL;

async function count(schema: string, where = "true"): Promise<number> {
  const { db, close } = createDbFromUrl(LOCAL);
  const rows = await db.execute<{ count: number }>(
    sql.raw(`SELECT count(*)::int AS count FROM ${schema}.c_${COLLECTION} WHERE ${where}`)
  );
  await close();
  return Number(rows[0]?.count ?? 0);
}

async function dumpEnriched(schema: string): Promise<void> {
  const { db, close } = createDbFromUrl(LOCAL);
  const rows = await db.execute<{ title: string; price: string; enriched: Record<string, unknown> }>(
    sql.raw(`SELECT data->>'title' AS title, data->>'price' AS price, enriched FROM ${schema}.c_${COLLECTION} ORDER BY title`)
  );
  await close();
  console.log(`\n================ ENRICHMENT (extracted features from image + description) ================`);
  for (const r of rows) {
    const e = (r.enriched ?? {}) as Record<string, unknown>;
    const pick = (k: string) => (Array.isArray(e[k]) ? (e[k] as unknown[]).join("/") : e[k]) ?? "—";
    console.log(`\n• ${r.title}  (LKR ${r.price})`);
    console.log(`    category=${pick("category")}  type=${pick("product_type")}  gender=${pick("gender")}`);
    console.log(`    colors=${pick("colors")}  pattern=${pick("pattern")}  material=${pick("material")}  fit=${pick("fit")}`);
    console.log(`    occasions=${pick("occasions")}  styles=${pick("styles")}`);
    const doc = String(e.embed_doc ?? "");
    if (doc) console.log(`    search_doc="${doc.slice(0, 140)}${doc.length > 140 ? "…" : ""}"`);
  }
}

const QUERIES: Array<{ label: string; opts: Record<string, unknown> }> = [
  { label: "use-case intent", opts: { q: "floral dress for a beach wedding", limit: 5 } },
  { label: "attribute intent", opts: { q: "off shoulder maxi dress", limit: 5 } },
  { label: "style intent", opts: { q: "something elegant for the office", limit: 5 } },
  { label: "price filter (NLQ)", opts: { q: "maxi dress under 7000", limit: 5 } },
  { label: "color + type", opts: { q: "red floral maxi", limit: 5 } },
  { label: "negation (NLQ)", opts: { q: "midi dress but not blue", limit: 5 } },
];

async function main() {
  console.log(`spike: intent fashion search on real store fixtures → ${LOCAL}\n`);
  const matcher = createMatcher({
    databaseUrl: LOCAL,
    apiKey: process.env.GEMINI_API_KEY!,
    migrate: "manual",
    embed: geminiEmbed,
    generate: geminiGenerate,
  });
  await matcher.migrate(); // exactly once — no eager/ensureProject double-migrate race
  const applied = await matcher.apply(PROJECT, { entities: [], collections: [productsCollection] });
  const schema = applied.schema;

  console.log("== ingest ==");
  await ingestFixtures(matcher);
  console.log(`ingested: ${await count(schema)}`);

  console.log("\n== enrich (vision + text → structured features) ==");
  for (let i = 0; i < 10; i++) {
    const pending = await count(schema, "enriched_at IS NULL");
    if (pending === 0) break;
    const r = await matcher.enrich(PROJECT, COLLECTION, { concurrency: 6, limit: pending });
    console.log(`  batch enriched=${r.enriched} failed=${r.failed} pending~${pending - r.enriched}`);
    if (r.enriched === 0) break;
  }
  console.log(`enriched: ${await count(schema, "enriched_at IS NOT NULL")}`);

  console.log("\n== index (gemini-embedding-2: text doc + image/visual space) ==");
  for (let i = 0; i < 10; i++) {
    const r = await matcher.index(PROJECT, COLLECTION, { limit: 500 });
    console.log(`  indexed batch ${r.indexed}`);
    if (r.indexed === 0) break;
  }
  console.log(`searchable: ${await count(schema, "indexed_at IS NOT NULL AND embedding IS NOT NULL")}`);

  await dumpEnriched(schema);

  console.log(`\n================ INTENT SEARCH ================`);
  for (const { label, opts } of QUERIES) {
    const res = await matcher.search(PROJECT, COLLECTION, opts);
    console.log(`\n💬 "${opts.q}"   [${label}]`);
    if (res.parsed && Object.keys(res.parsed).length) {
      console.log(`   NLQ parsed: ${JSON.stringify(res.parsed)}`);
    }
    if (res.relaxed) console.log(`   (filters relaxed — no exact match)`);
    if (!res.hits.length) console.log("   (no hits)");
    res.hits.forEach((h, i) => {
      const d = h.data as Record<string, unknown>;
      console.log(`   ${i + 1}. ${String(d.title).slice(0, 50).padEnd(50)} LKR ${String(d.price).padStart(7)}  score=${h.score.toFixed(4)}`);
    });
  }

  await matcher.close();
  console.log("\nspike complete");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
