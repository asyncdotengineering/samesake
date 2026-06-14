/**
 * Live path for the LK-snapshot subset tutorial — ingest + in-process hybrid eval.
 *
 * Uses a DEDICATED, empty project slug (`lk_subset`) so the eval is deterministic and
 * isolated — not mixed with whatever else lives in the shared database. (The example's
 * default `fashionparity` project may carry an orphaned catalog from a prior full ingest.)
 *
 * Steps:
 *   1. apply `lk_subset` with the same productsCollection config
 *   2. push the 30 raw snapshot products (ids match corpus ids: q1-1, ...)
 *   3. enrich (Gemini classify + extract, fetches product images) -> compose embed -> index
 *   4. run each corpus query through the live hybrid engine (matcher.search: NLQ + FTS +
 *      cosine ANN) and score relevance@3 + constraint compliance, same metrics as eval.ts
 *
 * Run:  bun --env-file=../../.env live-lk-subset.ts
 * Writes .samesake/fashion-eval-live.{json,md}.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createFashionMatcher } from "./samesake.config.ts";
import { productsCollection, COLLECTION } from "./samesake.config.ts";
import { composeEmbedDocs } from "./compose-embed.ts";
import { readFileSync, readdirSync } from "node:fs";

const SLUG = process.env.LK_SUBSET_PROJECT ?? "lk_subset";
const SUB = process.env.LK_SUBSET_OUT ?? join(import.meta.dir, "datasets", "lk-snapshot-subset");

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
          image_url: r.image ?? null,
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

async function main() {
  const matcher = createFashionMatcher();
  await matcher.migrate();
  const applied = await matcher.apply(SLUG, { entities: [], collections: [productsCollection] });

  const docs = rawDocs();
  console.log(`pushing ${docs.length} raw docs -> ${SLUG}/${COLLECTION}`);
  await matcher.pushDocuments(SLUG, COLLECTION, docs);

  console.log("== enrich (Gemini classify + extract) ==");
  for (let pass = 0; pass < 6; pass++) {
    const r = await matcher.enrich(SLUG, COLLECTION, { concurrency: 6, limit: docs.length });
    console.log(`  pass ${pass}: enriched=${r.enriched} failed=${r.failed}`);
    if (r.enriched === 0) break;
  }
  const composed = await composeEmbedDocs(applied.schema);
  console.log(`composed embed_doc for ${composed} products`);

  console.log("== index (embeddings) ==");
  let indexed = 0;
  while (true) {
    const r = await matcher.index(SLUG, COLLECTION, { limit: 100 });
    indexed += r.indexed;
    if (r.indexed === 0) break;
  }
  console.log(`indexed ${indexed} searchable products`);

  console.log("== live hybrid eval ==");
  const corpus = JSON.parse(await readFile(join(SUB, "corpus.json"), "utf8")) as { queries: EvalQuery[] };
  const rows = [];
  for (const query of corpus.queries) {
    const res = await matcher.search(SLUG, COLLECTION, {
      q: query.q,
      filters: query.filters,
      limit: 10,
    });
    const hits = res.hits as unknown as Record<string, unknown>[];
    const ids = hits.map((h) => String(h.id));
    rows.push({
      name: query.name,
      q: query.q,
      topIds: ids.slice(0, 5),
      relevanceAt3: relevanceAtK(ids, query.relevant, 3),
      constraintOverallAt5: hits.slice(0, 5).length ? hits.slice(0, 5).filter((h) => constraintOk(h, query.constraints)).length / hits.slice(0, 5).length : 0,
      zeroResult: hits.length === 0,
      relaxed: res.relaxed === true,
      parsed: res.parsed,
    });
  }
  await matcher.close();

  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const report = {
    engine: "live-hybrid (matcher.search: NLQ + FTS + cosine ANN)",
    project: SLUG,
    collection: COLLECTION,
    generatedAt: process.env.LK_NOW ?? new Date().toISOString(),
    metrics: {
      relevanceAt3: mean(rows.map((r) => r.relevanceAt3)),
      constraintOverallAt5: mean(rows.map((r) => r.constraintOverallAt5)),
      zeroResultRate: rows.filter((r) => r.zeroResult).length / rows.length,
      relaxationRate: rows.filter((r) => r.relaxed).length / rows.length,
    },
    rows,
  };
  await mkdir(".samesake", { recursive: true });
  await writeFile(".samesake/fashion-eval-live.json", JSON.stringify(report, null, 2));
  const md = [
    "# Fashion Search Eval — live hybrid",
    "",
    `Engine: ${report.engine}`,
    `Project: ${SLUG} (dedicated, ${docs.length} products)`,
    "",
    `- relevance@3: ${report.metrics.relevanceAt3.toFixed(2)}`,
    `- constraint overall@5: ${report.metrics.constraintOverallAt5.toFixed(2)}`,
    `- zero-result rate: ${report.metrics.zeroResultRate.toFixed(2)}`,
    `- relaxation rate: ${report.metrics.relaxationRate.toFixed(2)}`,
    "",
    "| query | top ids | relevance@3 | constraint@5 |",
    "| --- | --- | ---: | ---: |",
    ...rows.map((r) => `| ${r.name} ${r.q} | ${r.topIds.join(", ")} | ${r.relevanceAt3.toFixed(2)} | ${r.constraintOverallAt5.toFixed(2)} |`),
    "",
  ].join("\n");
  await writeFile(".samesake/fashion-eval-live.md", md);
  console.log(md);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
