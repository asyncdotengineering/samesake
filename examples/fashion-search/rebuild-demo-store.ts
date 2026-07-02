/**
 * Hand-curated 50-product single store (Myntra subset) → OUR fashion enrich pipeline
 * (2-stage Gemini classify+extract reading each product image) → index → search.
 * Tests (a) credible results for real intents, (b) negatives/quarantine: bad queries
 * and non-apparel items must NOT surface.
 *
 *   bun --env-file=../../.env _demo-store.ts
 */
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { createDbFromUrl } from "@samesake/server";
import { createFashionMatcher, productsCollection } from "./samesake.config.ts";

const PROJECT = "demo_store";
const COLL = "products";
const products = JSON.parse(readFileSync(new URL("./datasets/demo-store-products.json", import.meta.url), "utf8")) as {
  id: string;
  data: Record<string, unknown>;
}[];

const matcher = createFashionMatcher();
await matcher.migrate();
const applied = await matcher.apply(PROJECT, { entities: [], collections: [productsCollection] });
console.log(`applied ${applied.schema} — pushing ${products.length} products`);

await matcher.pushDocuments(
  PROJECT,
  COLL,
  products.map((p) => ({ id: p.id, data: p.data }))
);

console.log("enriching (our 2-stage Gemini pipeline, reading images)…");
for (let i = 0; i < 10; i++) {
  const r = await matcher.enrich(PROJECT, COLL, { concurrency: 6, limit: 50 });
  process.stdout.write(`  pass ${i}: enriched=${r.enriched} `);
  if (r.enriched === 0) break;
}
console.log("\nindexing…");
while ((await matcher.index(PROJECT, COLL, { limit: 50 })).indexed > 0) {}

// ---- pipeline outcome: what got indexed vs quarantined ----
const { db, close } = createDbFromUrl(process.env.SAMESAKE_DATABASE_URL!);
const rows = (await db.execute(
  sql.raw(
    `SELECT id, data->>'title' AS title, pipeline_status, gate_reason,
            enriched->>'category' AS category, enriched->>'gender' AS gender,
            enriched->'colors' AS colors, enriched->>'is_apparel_product' AS is_apparel
     FROM ${applied.schema}.c_products ORDER BY pipeline_status, title`
  )
)) as unknown as Record<string, string>[];

const ready = rows.filter((r) => r.pipeline_status === "ready");
const quarantined = rows.filter((r) => r.pipeline_status === "quarantined");
console.log(`\n=== pipeline: ${ready.length} ready / ${quarantined.length} quarantined / ${rows.length} total ===`);
console.log("\n--- QUARANTINED (gate kept these out of search) ---");
for (const r of quarantined) console.log(`  ${String(r.title).padEnd(42)} reason=${r.gate_reason}`);
console.log("\n--- READY sample (our enrichment) ---");
for (const r of ready.slice(0, 12))
  console.log(`  ${String(r.title).slice(0, 40).padEnd(40)} → cat=${r.category} gender=${r.gender} colors=${r.colors}`);

// ---- search credibility ----
async function run(label: string, queries: string[]) {
  console.log(`\n========== ${label} ==========`);
  for (const q of queries) {
    const res = await matcher.search(PROJECT, COLL, { q, limit: 5, filters: { available: true } });
    const hits = (res.hits ?? []) as Record<string, unknown>[];
    console.log(`\nQ: "${q}" → ${hits.length} hits`);
    for (const h of hits.slice(0, 5)) {
      const data = (h.data ?? {}) as Record<string, unknown>;
      const enr = (h.enriched ?? {}) as Record<string, unknown>;
      const score = typeof h.score === "number" ? h.score.toFixed(3) : String(h.score);
      console.log(`   ${score}  ${String(data.title ?? h.id).slice(0, 46).padEnd(46)} [${enr.category}/${enr.gender}]`);
    }
  }
}

await run("POSITIVE (expect credible matches)", [
  "navy blue shirt for men",
  "watch for women",
  "blue denim jeans",
  "white casual sneakers",
  "black formal shoes",
  "handbag for women",
  "sandals for the beach",
  "sports running shoes",
]);

await run("NEGATIVE (expect nothing / no false positives)", [
  "deodorant",
  "perfume body spray",
  "laptop computer",
  "winter wool overcoat",
  "kids toys",
  "gold diamond ring",
]);

await close();
await matcher.close();
console.log("\ndone.");
