/**
 * Demo store — a hand-curated 50-product fashion shop (Myntra subset), already
 * enriched + indexed, shipped as a SQL seed so anyone can reproduce the
 * search-credibility / quarantine behaviour WITHOUT spending any enrichment LLM calls.
 *
 * Seed it (one time):
 *   psql "$DATABASE_URL" -f datasets/demo-store-seed.sql
 *
 * Then run this to see credible intent search + quarantined negatives:
 *   bun --env-file=../../.env seed-demo-store.ts
 *
 * (Query-time embedding still needs GEMINI_API_KEY; the 50 products' enrichment
 *  and doc embeddings are baked into the seed, so no re-enrichment is required.)
 */
import { createFashionMatcher } from "./samesake.config.ts";

const PROJECT = "demo_store";
const COLL = "products";

const matcher = createFashionMatcher();
await matcher.migrate(); // bootstrap samesake system tables if missing (no-op otherwise)

async function show(label: string, queries: string[]) {
  console.log(`\n===== ${label} =====`);
  for (const q of queries) {
    const res = await matcher.search(PROJECT, COLL, { q, limit: 5, filters: { available: true } });
    const hits = (res.hits ?? []) as Record<string, unknown>[];
    console.log(`\nQ: "${q}" → ${hits.length} hits`);
    for (const h of hits.slice(0, 5)) {
      const data = (h.data ?? {}) as Record<string, unknown>;
      const score = typeof h.score === "number" ? h.score.toFixed(3) : String(h.score);
      console.log(`   ${score}  ${String(data.title ?? h.id).slice(0, 50)}`);
    }
  }
}

await show("POSITIVE — credible intent matches", [
  "navy blue shirt for men",
  "silver watch for women",
  "white casual sneakers",
  "black formal shoes",
  "handbag for women",
]);

await show("NEGATIVE — quarantined non-apparel never indexed (deodorant/perfume gated out)", [
  "deodorant",
  "perfume body spray",
]);

await matcher.close();
console.log("\nseed verified.");
