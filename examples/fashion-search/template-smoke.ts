/**
 * Live smoke for the core fashion enrichment TEMPLATE builders — proves fashion.enrichPipeline()
 * + fashion.fields() + composeFashionEmbedDoc + fashion.nlq actually enrich real products and
 * power attribute-aware search, with zero hand-written taxonomy/schemas.
 *
 * Run:  bun --env-file=../../.env template-smoke.ts
 */
import { sql } from "drizzle-orm";
import {
  fashion,
  fashionSearchFields,
  fashionSpaces,
  fashionEnrichPipeline,
  collection,
  Channels,
} from "@samesake/core";
import { createMatcher, createDbFromUrl } from "@samesake/server";
import { geminiEmbed, geminiGenerate } from "./gemini.ts";

const SLUG = process.env.TS_PROJECT ?? "template_smoke";
const COLL = "smoke";

const smoke = collection(COLL, {
  fields: fashionSearchFields(),
  indexing: fashion.indexing(),
  embeddings: { doc: { model: "gemini-embedding-2", dim: 1536, taskType: "RETRIEVAL_DOCUMENT" } },
  spaces: fashionSpaces({ visual: false }), // text-only smoke; visual proven in repro-visual
  enrich: fashionEnrichPipeline(),
  search: {
    channels: [Channels.fts({ fields: ["title"], weight: 1 }), Channels.cosine({ embedding: "doc", weight: 1 })],
    combiner: "rrf",
    nlq: { instructions: fashion.nlq.instructions, schema: fashion.nlq.schema() },
  },
});

const DOCS = [
  { id: "d1", data: { title: "Crimson Wrap Maxi Dress", vendor: "Avirate", price: 5280, available: true, description: "A deep red floor-length wrap dress for evening parties." } },
  { id: "d2", data: { title: "Heritage Linen Shirt", vendor: "AnationZ", price: 5490, available: true, description: "A men's short-sleeve linen shirt in stone, breathable for warm days." } },
  { id: "d3", data: { title: "Bolt Denim Trucker Jacket", vendor: "Levis", price: 8900, available: true, description: "A classic blue denim jacket." } },
  { id: "d4", data: { title: "Sunbeam Cotton Sundress", vendor: "Spring", price: 2990, available: true, description: "A bright yellow floral cotton sundress with thin straps." } },
];

async function main() {
  if (!process.env.DATABASE_URL || !process.env.GEMINI_API_KEY) throw new Error("DATABASE_URL and GEMINI_API_KEY required");
  const matcher = createMatcher({ databaseUrl: process.env.DATABASE_URL, apiKey: process.env.GEMINI_API_KEY, migrate: "eager", embed: geminiEmbed, generate: geminiGenerate });
  await matcher.migrate();
  const applied = await matcher.apply(SLUG, { entities: [], collections: [smoke] });
  await matcher.pushDocuments(SLUG, COLL, DOCS);

  for (let i = 0; i < 4; i++) { const r = await matcher.enrich(SLUG, COLL, { concurrency: 4, limit: 10 }); if (r.enriched === 0) break; }
  while ((await matcher.index(SLUG, COLL, { limit: 50 })).indexed > 0) {}

  console.log("=== enriched attributes (from the core template) ===");
  const { db, close } = createDbFromUrl(process.env.DATABASE_URL!);
  const rows = await db.execute<{ id: string; data: unknown; enriched: unknown }>(sql.raw(`SELECT id, data, enriched FROM ${applied.schema}.c_${COLL} ORDER BY id`));
  const colorsById: Record<string, string[]> = {};
  for (const r of rows) {
    const d = (typeof r.data === "string" ? JSON.parse(r.data) : r.data) as Record<string, unknown>;
    const e = (typeof r.enriched === "string" ? JSON.parse(r.enriched) : r.enriched) as Record<string, unknown>;
    colorsById[r.id] = (e?.colors as string[]) ?? [];
    console.log(`  ${String(d.title).padEnd(28)} → category=${e?.category} colors=${JSON.stringify(e?.colors)} occasions=${JSON.stringify(e?.occasions)} gender=${e?.gender}`);
  }
  await close();

  const checks: Array<{ q: string; want: string; note: string }> = [
    { q: "red dress", want: "d1", note: "color+category from enrichment" },
    { q: "linen shirt for men", want: "d2", note: "material+gender via NLQ+enrichment" },
    { q: "yellow summer dress", want: "d4", note: "color+occasion" },
  ];
  console.log("\n=== search (attribute-aware) ===");
  let pass = 0;
  for (const c of checks) {
    const res = await matcher.search(SLUG, COLL, { q: c.q, limit: 3 });
    const top = res.hits[0]?.id;
    const ok = top === c.want;
    if (ok) pass++;
    console.log(`  ${ok ? "PASS" : "FAIL"}  "${c.q}" → top=${top} (want ${c.want}) [${c.note}]`);
  }
  // The headline: enrichment recovered structured color even though the title says "Crimson", not "red".
  const crimsonGotRed = (colorsById.d1 ?? []).includes("red");
  console.log(`\n  ${crimsonGotRed ? "PASS" : "FAIL"}  enrichment normalized "Crimson" title → colors includes "red"`);
  await matcher.close();
  if (pass < 2 || !crimsonGotRed) { console.error("\nsmoke FAILED"); process.exit(1); }
  console.log("\ntemplate smoke OK");
}
main().catch((e) => { console.error(e); process.exit(1); });
