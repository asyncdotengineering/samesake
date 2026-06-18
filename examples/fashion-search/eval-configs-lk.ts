/**
 * Differential intent eval: does shifting channel weight away from keyword (toward
 * semantic) degrade INTENT-based search — the project's core purpose?
 *
 * Real fashion productsCollection (NLQ ON, real enrichment), real LK intent queries
 * (q1..q10), swept across channel weightings. Text-only enrichment (image_url stripped)
 * for determinism + cost; this isolates the FTS-vs-cosine reweight (the visual layer is a
 * separate experiment, needs SPACES_VISUAL=1).
 *
 * CAVEAT: the relevance labels here are the keyword snapshot's own results, so this eval is
 * KEYWORD-BIASED — it rewards keyword behavior and will misjudge ranking changes (it once showed
 * a fake intent "regression" for soft-OR). For gating ranking changes use `bench-retrieval.ts`
 * (unbiased hand labels, multi-domain) or `matcher.calibrateSearch` (LLM-as-judge). This script
 * is kept as a parity/diagnostic signal, not the gate.
 *
 * Metrics per (query, config):
 *   - relevance@3 : fraction of the snapshot's relevant ids found in top-3
 *   - constraint@5: fraction of top-5 satisfying the query's hard constraints
 *
 * Seeding is incremental: enrich/index skip already-done rows, so re-runs are cheap.
 *
 * Run:  bun --env-file=../../.env eval-configs-lk.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createFashionMatcher, productsCollection, COLLECTION } from "./samesake.config.ts";
import { composeEmbedDocs } from "./compose-embed.ts";

const SLUG = process.env.LK_CFG_PROJECT ?? "lk_cfg";
const SUB = join(import.meta.dir, "datasets", "lk-snapshot-subset");

type Product = { id: string; title: string; brand: string; category: string; colors: string[]; material: string; price: number; available: boolean };
type EvalQuery = { name: string; q: string; filters?: Record<string, unknown>; constraints?: { maxPrice?: number; available?: boolean }; relevant: string[] };

function rawDocs(): { id: string; data: Record<string, unknown> }[] {
  const dir = join(SUB, "source");
  const files = readdirSync(dir).filter((f) => /^q\d+\.json$/.test(f)).sort((a, b) => Number(a.replace(/\D/g, "")) - Number(b.replace(/\D/g, "")));
  const docs: { id: string; data: Record<string, unknown> }[] = [];
  for (const file of files) {
    const key = file.replace(".json", "");
    const snap = JSON.parse(readFileSync(join(dir, file), "utf8")) as { results: Record<string, unknown>[] };
    snap.results.forEach((r, i) => {
      docs.push({
        id: `${key}-${i + 1}`,
        data: {
          title: r.title ?? "",
          vendor: r.vendor ?? r.source ?? "unknown",
          price: typeof r.price_numeric === "number" ? r.price_numeric : Number(r.price) || 0,
          available: r.available === true,
          image_url: null, // text-only enrichment for determinism
          url: r.url ?? null,
          description: r.description ?? null,
          raw_tags: Array.isArray(r.tags) ? r.tags : [],
          raw_type: r.product_type ?? null,
          store_domain: r.source ?? null,
        },
      });
    });
  }
  return docs;
}

function relevanceAtK(ids: string[], relevant: string[], k: number): number {
  if (!relevant.length) return 0;
  return ids.slice(0, k).filter((id) => relevant.includes(id)).length / Math.min(k, relevant.length);
}
function constraintOk(hit: Record<string, unknown>, c: EvalQuery["constraints"] = {}): boolean {
  if (c.maxPrice !== undefined && !(Number(hit.price) <= c.maxPrice)) return false;
  if (c.available !== undefined && hit.available !== c.available) return false;
  return true;
}
const tokenCount = (q: string) => q.trim().split(/\s+/).filter(Boolean).length;
const nlqRuns = (q: string) => !(tokenCount(q) <= 2 && !/\d/.test(q));

const CONFIGS: Array<{ name: string; opts: Record<string, unknown> }> = [
  { name: "flat-old", opts: { weights: { fts: 1, cosine: 1 } } }, // OLD keyword-biased default
  { name: "intent", opts: { mode: "intent" } }, // NEW default for text queries
  { name: "similar", opts: { mode: "similar" } }, // similarity mode (keyword off)
  { name: "keyword", opts: { weights: { fts: 1, cosine: 0 } } }, // pure FTS, for contrast
];

async function main() {
  if (!process.env.DATABASE_URL || !process.env.GEMINI_API_KEY) throw new Error("DATABASE_URL and GEMINI_API_KEY required");
  const matcher = createFashionMatcher();
  await matcher.migrate();
  const applied = await matcher.apply(SLUG, { entities: [], collections: [productsCollection] });

  const docs = rawDocs();
  await matcher.pushDocuments(SLUG, COLLECTION, docs);

  // enrich (incremental) -> compose embed_doc -> index (incremental)
  for (let pass = 0; pass < 8; pass++) {
    const r = await matcher.enrich(SLUG, COLLECTION, { concurrency: 6, limit: docs.length });
    if (r.enriched === 0) break;
  }
  await composeEmbedDocs(applied.schema);
  let indexed = 0;
  while (true) {
    const r = await matcher.index(SLUG, COLLECTION, { limit: 100 });
    indexed += r.indexed;
    if (r.indexed === 0) break;
  }
  console.log(`seeded: ${docs.length} docs, ${indexed} (re)indexed this run\n`);

  const corpus = JSON.parse(readFileSync(join(SUB, "corpus.json"), "utf8")) as { queries: EvalQuery[] };

  // results[queryName][configName] = { rel3, con5 }
  const results: Record<string, Record<string, { rel3: number; con5: number }>> = {};
  for (const query of corpus.queries) {
    results[query.name] = {};
    for (const cfg of CONFIGS) {
      const res = await matcher.search(SLUG, COLLECTION, { q: query.q, filters: query.filters, ...cfg.opts, limit: 10 });
      const hits = res.hits as unknown as Record<string, unknown>[];
      const ids = hits.map((h) => String(h.id));
      const top5 = hits.slice(0, 5);
      results[query.name]![cfg.name] = {
        rel3: relevanceAtK(ids, query.relevant, 3),
        con5: top5.length ? top5.filter((h) => constraintOk(h, query.constraints)).length / top5.length : 0,
      };
    }
  }
  await matcher.close();

  // ── scorecard: relevance@3 per config ──
  const header = `${"query".padEnd(8)} ${"NLQ".padEnd(4)} ${"toks".padEnd(4)} | ` + CONFIGS.map((c) => c.name.padStart(9)).join(" ") + "   q-text";
  console.log("relevance@3 by config (intent retrieval quality)");
  console.log(header);
  console.log("-".repeat(header.length));
  const agg: Record<string, number[]> = Object.fromEntries(CONFIGS.map((c) => [c.name, []]));
  for (const query of corpus.queries) {
    const cells = CONFIGS.map((c) => {
      const v = results[query.name]![c.name]!.rel3;
      agg[c.name]!.push(v);
      return v.toFixed(2).padStart(9);
    });
    const nlqFlag = nlqRuns(query.q) ? "on" : "SKIP";
    console.log(`${query.name.padEnd(8)} ${nlqFlag.padEnd(4)} ${String(tokenCount(query.q)).padEnd(4)} | ${cells.join(" ")}   "${query.q}"`);
  }
  console.log("-".repeat(header.length));
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const meanCells = CONFIGS.map((c) => mean(agg[c.name]!).toFixed(2).padStart(9)).join(" ");
  console.log(`${"MEAN".padEnd(8)} ${"".padEnd(4)} ${"".padEnd(4)} | ${meanCells}`);

  // Δ vs default, restricted to NLQ-SKIP (short) queries — the exactness-sensitive ones
  const shortQs = corpus.queries.filter((q) => !nlqRuns(q.q));
  const longQs = corpus.queries.filter((q) => nlqRuns(q.q));
  const meanFor = (qs: EvalQuery[], cfg: string) => mean(qs.map((q) => results[q.name]![cfg]!.rel3));
  console.log(`\nrelevance@3 split  (NLQ-SKIP n=${shortQs.length} vs NLQ-on n=${longQs.length}):`);
  for (const c of CONFIGS) {
    console.log(`  ${c.name.padEnd(9)}  short=${meanFor(shortQs, c.name).toFixed(2)}  long=${meanFor(longQs, c.name).toFixed(2)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
