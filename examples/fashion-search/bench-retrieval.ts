/**
 * Benchmark + tradeoff evaluation with UNBIASED, hand-assigned graded relevance, across two
 * domains — fashion and electronics (out-of-domain). Unlike eval-configs-lk (whose labels are a
 * keyword snapshot's own results, so they reward keyword behavior), every label here is assigned
 * by true relevance regardless of word overlap. Real gemini-embedding-2 vectors.
 *
 * Sweeps configs (flat / intent / similar / keyword / semantic) and reports nDCG@5 + recall@5.
 * Run TWICE to A/B the FTS lexical strategy:
 *   bun --env-file=../../.env bench-retrieval.ts                  # soft-OR (AND-first)
 *   SAMESAKE_FTS_STRICT=1 bun --env-file=../../.env bench-retrieval.ts   # strict-AND baseline
 */
import { collection, f, Channels } from "@samesake/core";
import { createMatcher } from "@samesake/server";
import { geminiEmbed, geminiGenerate } from "./gemini.ts";

const SLUG = process.env.BENCH_PROJECT ?? "bench_retrieval";
type Doc = { id: string; title: string; description: string };
type Query = { name: string; q: string; kind: string; rel: Record<string, number> }; // grade 0-3

function coll(name: string) {
  return collection(name, {
    fields: { title: f.text({ searchable: true }), description: f.text() },
    embeddings: { doc: { source: "$title. $description", model: "gemini-embedding-2", dim: 1536, taskType: "RETRIEVAL_DOCUMENT" } },
    search: {
      channels: [Channels.fts({ fields: ["title"], weight: 1 }), Channels.cosine({ embedding: "doc", weight: 1 })],
      combiner: "rrf",
    },
  });
}

// ── Electronics (out-of-domain) ─────────────────────────────────────────
const ELECTRONICS: Doc[] = [
  { id: "e1", title: "AirZ Pro Wireless Earbuds", description: "True wireless in-ear earbuds with active noise cancellation and a 30-hour charging case." },
  { id: "e2", title: "Sport Run Buds", description: "Sweatproof secure-fit earphones built for running and gym workouts." },
  { id: "e3", title: "StudioMax Over-Ear Headphones", description: "Premium over-ear headphones with hybrid ANC for travel and focus." },
  { id: "e4", title: "Bolt Gaming Laptop 15", description: "RTX gaming laptop with a 16-core CPU and a 165Hz display." },
  { id: "e5", title: "UltraBook Air 13", description: "Thin and light laptop for everyday work and travel." },
  { id: "e6", title: "ClearCam 4K Webcam", description: "4K webcam with autofocus for video calls and live streaming." },
  { id: "e7", title: "MeetMate USB Headset", description: "Noise-cancelling headset with a boom mic for conference and video calls." },
  { id: "e8", title: "PowerCore 20k Battery", description: "20000mAh portable charger with fast USB-C output." },
  { id: "e9", title: "GlowKey Mechanical Keyboard", description: "RGB hot-swap mechanical keyboard for gaming and typing." },
  { id: "e10", title: "Pixel View Monitor 27", description: "27-inch 4K IPS monitor for creative work." },
  { id: "e11", title: "TrailMate Action Camera", description: "Waterproof 4K action camera for outdoor adventures." },
  { id: "e12", title: "SoundBrick Bluetooth Speaker", description: "Portable waterproof bluetooth speaker with 24-hour battery." },
  { id: "e13", title: "DeskPro USB-C Hub", description: "7-port USB-C hub with HDMI and card reader." },
  { id: "e14", title: "Quiet Comfort Travel Headphones", description: "Wireless over-ear headphones with best-in-class noise cancellation for flights." },
  { id: "e15", title: "Budget Wired Earphones", description: "Simple wired earbuds with an inline mic." },
  { id: "e16", title: "Streamer Ring Light", description: "LED ring light for video calls and streaming." },
];
const ELECTRONICS_Q: Query[] = [
  { name: "ec-mismatch", kind: "intent/vocab-mismatch", q: "wireless noise cancelling earbuds for running",
    rel: { e1: 3, e2: 2, e3: 1, e14: 1 } },
  { name: "ec-exact", kind: "exact", q: "gaming laptop", rel: { e4: 3, e5: 1, e9: 1 } },
  { name: "ec-usecase", kind: "use-case", q: "something for video calls", rel: { e6: 3, e7: 3, e16: 2 } },
  { name: "ec-similar", kind: "similar", q: "noise cancelling headphones", rel: { e3: 3, e14: 3, e7: 2, e1: 2 } },
  { name: "ec-attr", kind: "attribute", q: "portable charger", rel: { e8: 3 } },
  { name: "ec-stream", kind: "use-case", q: "gear for a streaming setup", rel: { e16: 3, e6: 2, e9: 1, e12: 1 } },
];

// ── Fashion (in-domain control) ─────────────────────────────────────────
const FASHION: Doc[] = [
  { id: "f1", title: "Midnight Slip Gown", description: "An ink-dark bias-cut satin floor-length evening gown with thin straps." },
  { id: "f2", title: "Onyx Evening Drape", description: "A charcoal fluid chiffon evening dress for upscale night events." },
  { id: "f3", title: "Eclipse Satin Maxi", description: "A jet floor-length satin dress with a draped open back." },
  { id: "f4", title: "Sunrise Linen Shirt", description: "A men's breathable linen short-sleeve shirt for summer." },
  { id: "f5", title: "Harbour Linen Shirt", description: "A men's relaxed-fit linen button-down in sky blue." },
  { id: "f6", title: "Cotton Oxford Shirt", description: "A men's crisp cotton oxford shirt for the office." },
  { id: "f7", title: "Stonewash Straight Jeans", description: "Classic mid-rise straight-leg denim jeans." },
  { id: "f8", title: "Canvas Court Sneakers", description: "White low-top canvas sneakers for everyday wear." },
  { id: "f9", title: "Sunflower Cotton Sundress", description: "A bright yellow floral cotton sundress with thin straps." },
  { id: "f10", title: "Camel Wool Blazer", description: "A tailored camel wool blazer for the office." },
];
const FASHION_Q: Query[] = [
  { name: "fa-similar", kind: "similar", q: "black evening dress", rel: { f1: 3, f2: 3, f3: 3 } },
  { name: "fa-exact", kind: "exact/intent", q: "linen shirt men", rel: { f4: 3, f5: 3, f6: 1 } },
  { name: "fa-usecase", kind: "use-case", q: "outfit for the office", rel: { f6: 3, f10: 3, f7: 1 } },
  { name: "fa-attr", kind: "attribute", q: "cotton sundress", rel: { f9: 3 } },
];

const CONFIGS: Array<{ name: string; opts: Record<string, unknown> }> = [
  { name: "flat", opts: { weights: { fts: 1, cosine: 1 } } },
  { name: "intent", opts: { mode: "intent" } },
  { name: "similar", opts: { mode: "similar" } },
  { name: "keyword", opts: { weights: { fts: 1, cosine: 0 } } },
  { name: "semantic", opts: { weights: { fts: 0, cosine: 1 } } },
];
const K = 5;

function dcg(g: number[]) { return g.reduce((s, x, i) => s + x / Math.log2(i + 2), 0); }
function ndcg(ids: string[], rel: Record<string, number>, k: number) {
  const g = ids.slice(0, k).map((id) => rel[id] ?? 0);
  const ideal = Object.values(rel).sort((a, b) => b - a).slice(0, k);
  const idcg = dcg(ideal);
  return idcg === 0 ? 0 : dcg(g) / idcg;
}
function recall(ids: string[], rel: Record<string, number>, k: number) {
  const relevant = Object.entries(rel).filter(([, g]) => g >= 2).map(([id]) => id);
  if (!relevant.length) return 0;
  const top = new Set(ids.slice(0, k));
  return relevant.filter((id) => top.has(id)).length / relevant.length;
}
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

async function runDomain(matcher: ReturnType<typeof createMatcher>, name: string, docs: Doc[], queries: Query[]): Promise<Record<string, { ndcg: number; recall: number }>> {
  await matcher.apply(SLUG, { entities: [], collections: [coll(name)] });
  await matcher.pushDocuments(SLUG, name, docs.map((d) => ({ id: d.id, data: { title: d.title, description: d.description } })));
  while ((await matcher.index(SLUG, name, { limit: 100 })).indexed > 0) {}

  console.log(`\n##### DOMAIN: ${name}  (FTS=${process.env.SAMESAKE_FTS_STRICT === "1" ? "strict-AND" : "soft-OR"}) #####`);
  console.log(`${"config".padEnd(9)} | ${"nDCG@5".padStart(7)} ${"recall@5".padStart(9)}`);
  console.log("-".repeat(30));
  const agg: Record<string, { ndcg: number[]; rec: number[] }> = {};
  const perQ: Record<string, Record<string, number>> = {};
  for (const cfg of CONFIGS) {
    agg[cfg.name] = { ndcg: [], rec: [] };
    for (const query of queries) {
      const res = await matcher.search(SLUG, name, { q: query.q, ...cfg.opts, limit: K });
      const ids = res.hits.map((h) => h.id);
      const nd = ndcg(ids, query.rel, K);
      const rc = recall(ids, query.rel, K);
      agg[cfg.name]!.ndcg.push(nd);
      agg[cfg.name]!.rec.push(rc);
      (perQ[query.name] ??= {})[cfg.name] = nd;
    }
    console.log(`${cfg.name.padEnd(9)} | ${mean(agg[cfg.name]!.ndcg).toFixed(3).padStart(7)} ${mean(agg[cfg.name]!.rec).toFixed(3).padStart(9)}`);
  }
  console.log("\nper-query nDCG@5:");
  console.log(`${"query".padEnd(13)} ${"kind".padEnd(20)} | ` + CONFIGS.map((c) => c.name.padStart(8)).join(" "));
  for (const query of queries) {
    console.log(`${query.name.padEnd(13)} ${query.kind.padEnd(20)} | ` + CONFIGS.map((c) => (perQ[query.name]![c.name] ?? 0).toFixed(2).padStart(8)).join(" "));
  }
  const out: Record<string, { ndcg: number; recall: number }> = {};
  for (const cfg of CONFIGS) out[cfg.name] = { ndcg: mean(agg[cfg.name]!.ndcg), recall: mean(agg[cfg.name]!.rec) };
  return out;
}

// Standing acceptance gate (post-mortem: judge ranking on unbiased relevance, not word-overlap).
// Floors sit below observed soft-OR numbers with margin. The keyword floor is the regression
// guard for the inert-FTS class — strict-AND drops it to ~0.36/0.48.
const GATES: Array<{ domain: string; config: string; metric: "ndcg" | "recall"; min: number }> = [
  { domain: "electronics", config: "flat", metric: "ndcg", min: 0.88 },
  { domain: "electronics", config: "intent", metric: "ndcg", min: 0.88 },
  { domain: "electronics", config: "keyword", metric: "ndcg", min: 0.80 },
  { domain: "electronics", config: "flat", metric: "recall", min: 0.90 },
  { domain: "fashion_mini", config: "flat", metric: "ndcg", min: 0.95 },
  { domain: "fashion_mini", config: "intent", metric: "ndcg", min: 0.95 },
  { domain: "fashion_mini", config: "similar", metric: "ndcg", min: 0.95 },
  { domain: "fashion_mini", config: "keyword", metric: "ndcg", min: 0.80 },
];

async function main() {
  if (!process.env.DATABASE_URL || !process.env.GEMINI_API_KEY) throw new Error("DATABASE_URL and GEMINI_API_KEY required");
  const matcher = createMatcher({
    databaseUrl: process.env.DATABASE_URL, apiKey: process.env.GEMINI_API_KEY,
    migrate: "eager", embed: geminiEmbed, generate: geminiGenerate,
  });
  await matcher.migrate();
  const results: Record<string, Record<string, { ndcg: number; recall: number }>> = {};
  results.electronics = await runDomain(matcher, "electronics", ELECTRONICS, ELECTRONICS_Q);
  results.fashion_mini = await runDomain(matcher, "fashion_mini", FASHION, FASHION_Q);
  await matcher.close();

  console.log("\n##### ACCEPTANCE GATE #####");
  let failed = 0;
  for (const g of GATES) {
    const v = results[g.domain]?.[g.config]?.[g.metric] ?? 0;
    const ok = v >= g.min;
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${g.domain}.${g.config}.${g.metric} = ${v.toFixed(3)} (min ${g.min})`);
  }
  if (failed > 0) {
    console.error(`\n${failed} gate(s) FAILED — ranking change regressed unbiased relevance.`);
    process.exit(1);
  }
  console.log("\nall gates passed.");
}
main().catch((e) => { console.error(e); process.exit(1); });
