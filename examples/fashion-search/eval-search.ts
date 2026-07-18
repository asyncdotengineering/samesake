/**
 * Search-relevance eval on the REAL corpus (fashionparity, ~5.5k products), scored framework-direct
 * via matcher.evaluateSearch — the ESCI LLM-as-judge (gpt-4.1-mini, cross-family vs the Gemini
 * enrichment) grades each hit E/S/C/I → 3/2/1/0. Nothing about ranking is hand-rolled here; this runner only groups the
 * framework's per-query output into buckets and writes a phase-tagged artifact for pre/post compare.
 *
 *   bun --env-file=../../.env eval-search.ts --phase=baseline      # before Phase-1 fixes
 *   bun --env-file=../../.env eval-search.ts --phase=postfix       # after
 *
 * Metrics per query type: mean grade@k (0–3, primary — comparable to BENCHMARKS mean@k), nDCG@k
 * (ordering within the judged pool), no-results rate.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createFashionMatcher, productsCollection } from "./samesake.config.ts";
import { STAGE2_MODEL, EMB_MODEL } from "./gemini.ts";
import { JUDGE_MODEL, openaiGenerate } from "./openai.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const RUNS_DIR = join(REPO_ROOT, "evals", "runs");
const GOLDEN = join(REPO_ROOT, "evals", "golden-queries-fashion-lk.json");
const TYPO = join(REPO_ROOT, "evals", "search-queries-typo.json");
const PROJECT = "fashionparity";
const COLLECTION = "products";

const args = process.argv.slice(2);
const flag = (k: string, d: string) => (args.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d);
const PHASE = flag("phase", "baseline");
const K = Number(flag("limit", "5"));
const QUERIES = Number(flag("queries", "0")); // 0 = all
const FIXTURE = args.includes("--fixture");

interface Q { id: string; type: string; query: string }

interface FixtureProduct {
  id: string;
  title: string;
  brand: string;
  category: string;
  colors: string[];
  material: string;
  price: number;
  available: boolean;
}

interface FixtureQuery {
  id: string;
  type: string;
  query: string;
  filters?: Record<string, unknown>;
  relevant: string[];
}

const fixtureProducts: FixtureProduct[] = [
  { id: "red-dress", title: "red cotton summer dress", brand: "Luna", category: "dresses", colors: ["red"], material: "cotton", price: 72, available: true },
  { id: "blue-dress", title: "blue linen office dress", brand: "Aster", category: "dresses", colors: ["blue"], material: "linen", price: 118, available: true },
  { id: "black-jeans", title: "black denim straight jeans", brand: "North", category: "bottoms", colors: ["black"], material: "denim", price: 64, available: true },
  { id: "sold-red", title: "red party dress", brand: "Aster", category: "dresses", colors: ["red"], material: "polyester", price: 140, available: false },
];

const fixtureQueries: FixtureQuery[] = [
  { id: "keyword", type: "keyword", query: "red dress", filters: { available: true }, relevant: ["red-dress"] },
  { id: "color-required", type: "color-required", query: "office dress in blue", filters: { colors: ["blue"], available: true }, relevant: ["blue-dress"] },
  { id: "color-excluded", type: "color-excluded", query: "straight jeans not blue", filters: { available: true }, relevant: ["black-jeans"] },
  { id: "price-cap", type: "price-cap", query: "dress under 100", filters: { price: { $lte: 100 }, available: true }, relevant: ["red-dress"] },
  { id: "empty", type: "empty", query: "laptop", filters: { available: true }, relevant: [] },
];

function fixtureTokens(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function fixturePassesFilters(product: FixtureProduct, filters: Record<string, unknown> = {}): boolean {
  for (const [field, expected] of Object.entries(filters)) {
    const actual = product[field as keyof FixtureProduct];
    if (expected && typeof expected === "object" && !Array.isArray(expected)) {
      const ops = expected as Record<string, unknown>;
      if (typeof ops.$lte === "number" && !(typeof actual === "number" && actual <= ops.$lte)) return false;
      if (typeof ops.$gte === "number" && !(typeof actual === "number" && actual >= ops.$gte)) return false;
      continue;
    }
    if (Array.isArray(expected)) {
      if (!Array.isArray(actual) || !expected.some((value) => actual.includes(value))) return false;
    } else if (actual !== expected) {
      return false;
    }
  }
  return true;
}

function fixtureSearch(query: FixtureQuery): FixtureProduct[] {
  const terms = fixtureTokens(query.query);
  return fixtureProducts
    .filter((product) => fixturePassesFilters(product, query.filters))
    .map((product) => {
      const text = fixtureTokens(`${product.title} ${product.brand} ${product.category} ${product.colors.join(" ")} ${product.material}`);
      return { product, score: terms.reduce((total, term) => total + (text.includes(term) ? 1 : 0), 0) };
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.product.id.localeCompare(right.product.id))
    .map(({ product }) => product);
}

function fixtureMetrics(rows: Array<{ query: FixtureQuery; hits: FixtureProduct[] }>, k = 10) {
  const byType = new Map<string, typeof rows>();
  for (const row of rows) (byType.get(row.query.type) ?? (byType.set(row.query.type, []), byType.get(row.query.type)!)).push(row);
  const metrics = (subset: typeof rows) => {
    const meanAt10 = subset.length === 0 ? 0 : subset.reduce((sum, row) => {
      const relevant = row.hits.slice(0, k).filter((hit) => row.query.relevant.includes(hit.id)).length;
      return sum + relevant / Math.max(1, Math.min(k, row.query.relevant.length || 1));
    }, 0) / subset.length;
    const pAt5 = subset.length === 0 ? 0 : subset.reduce((sum, row) => {
      const relevant = row.hits.slice(0, 5).filter((hit) => row.query.relevant.includes(hit.id)).length;
      return sum + relevant / 5;
    }, 0) / subset.length;
    return {
      meanAt10: Math.round(meanAt10 * 1000) / 1000,
      pAt5: Math.round(pAt5 * 1000) / 1000,
      zeroResultRate: subset.length === 0 ? 0 : subset.filter((row) => row.hits.length === 0).length / subset.length,
      hitAt10: subset.length === 0 ? 0 : subset.filter((row) => row.hits.slice(0, k).some((hit) => row.query.relevant.includes(hit.id))).length / subset.length,
    };
  };
  return {
    overall: metrics(rows),
    byType: Object.fromEntries([...byType.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([type, subset]) => [type, metrics(subset)])),
  };
}

async function runFixture(): Promise<void> {
  const selected = QUERIES > 0 ? fixtureQueries.slice(0, QUERIES) : fixtureQueries;
  const rows = selected.map((query) => ({ query, hits: fixtureSearch(query) }));
  const common = fixtureMetrics(rows, 10);
  const artifact = {
    phase: PHASE,
    mode: "fixture",
    corpus: { products: fixtureProducts.length, queries: rows.length },
    k: 10,
    common,
    perQuery: rows.map(({ query, hits }) => ({ id: query.id, type: query.type, q: query.query, hits: hits.length, topIds: hits.slice(0, 10).map((hit) => hit.id) })),
  };
  await mkdir(RUNS_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const base = join(RUNS_DIR, `${ts}-search-${PHASE}-fixture`);
  await writeFile(`${base}.json`, JSON.stringify(artifact, null, 2) + "\n");
  const md = [
    `# Search eval — ${PHASE} fixture`,
    "",
    `**Overall:** mean@10 ${common.overall.meanAt10} · P@5 ${common.overall.pAt5} · zero-results ${(common.overall.zeroResultRate * 100).toFixed(0)}% · Hit@10 ${common.overall.hitAt10.toFixed(3)}`,
    "",
    "| query type | mean@10 | P@5 | zero-results | Hit@10 |",
    "|---|---:|---:|---:|---:|",
    ...Object.entries(common.byType).map(([type, value]) => `| ${type} | ${value.meanAt10} | ${value.pAt5} | ${(value.zeroResultRate * 100).toFixed(0)}% | ${value.hitAt10.toFixed(3)} |`),
    "",
  ].join("\n");
  await writeFile(`${base}.md`, md + "\n");
  console.log(md);
  console.log(`artifact: ${base}.json`);
}

async function loadQueries(): Promise<Q[]> {
  const g = JSON.parse(await readFile(GOLDEN, "utf8")) as { queries: Q[] };
  const t = JSON.parse(await readFile(TYPO, "utf8")) as { queries: Q[] };
  const all = [...g.queries, ...t.queries];
  return QUERIES > 0 ? all.slice(0, QUERIES) : all;
}

function mean(xs: number[]): number {
  return xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1000) / 1000 : 0;
}

async function main(): Promise<void> {
  if (FIXTURE) {
    await runFixture();
    return;
  }
  const queries = await loadQueries();
  const byQ = new Map(queries.map((q) => [q.query, q]));
  const matcher = createFashionMatcher();
  await matcher.migrate();
  // Load the collection config in-process (production path): NLQ schema/instructions are functions
  // that can't be rehydrated from the DB, so without apply the engine falls back to a derived NLQ
  // schema. Apply is non-destructive here (fashionparity was seeded with this same config).
  await matcher.apply(PROJECT, { entities: [], collections: [productsCollection] });

  // Framework-direct: evaluateSearch runs each query through the real search + LLM judge.
  const res = await matcher.evaluateSearch(PROJECT, COLLECTION, {
    queries: queries.map((q) => ({ q: q.query })),
    limit: K,
    judge: { model: JUDGE_MODEL, generate: openaiGenerate },
  });

  // Group the framework's per-query output into query-type buckets.
  const buckets = new Map<string, { grade: number[]; ndcg: number[]; noResult: number; n: number }>();
  const perQuery = res.perQuery.map((p) => {
    const meta = byQ.get(p.q);
    const type = meta?.type ?? "unknown";
    const b = buckets.get(type) ?? { grade: [], ndcg: [], noResult: 0, n: 0 };
    b.grade.push(p.gradeAt);
    b.ndcg.push(p.ndcg);
    b.n++;
    if (!p.topIds.length) b.noResult++;
    buckets.set(type, b);
    // topIds persisted so pre/post retrieval can be diffed exactly (a bucket grade delta is only
    // a real change if the returned ids changed; otherwise it is single-LLM-judge re-grade noise).
    return { id: meta?.id ?? "?", type, q: p.q, gradeAt: p.gradeAt, ndcg: p.ndcg, hits: p.topIds.length, topIds: p.topIds };
  });

  const bucketRows = [...buckets.entries()]
    .map(([type, b]) => ({ type, n: b.n, meanGrade: mean(b.grade), ndcg: mean(b.ndcg), noResultRate: Math.round((b.noResult / b.n) * 100) / 100 }))
    .sort((a, b) => a.type.localeCompare(b.type));

  const overall = {
    meanGrade: mean(perQuery.map((p) => p.gradeAt)),
    ndcg: mean(perQuery.map((p) => p.ndcg)),
    noResultRate: Math.round((perQuery.filter((p) => p.hits === 0).length / perQuery.length) * 100) / 100,
    queries: perQuery.length,
    judged: res.judged,
  };

  const artifact = {
    phase: PHASE,
    project: PROJECT,
    collection: COLLECTION,
    k: K,
    models: { embed: EMB_MODEL, generate: STAGE2_MODEL, judge: JUDGE_MODEL },
    overall,
    buckets: bucketRows,
    perQuery,
  };

  await mkdir(RUNS_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const base = join(RUNS_DIR, `${ts}-search-${PHASE}`);
  await writeFile(`${base}.json`, JSON.stringify(artifact, null, 2) + "\n");

  const md = [
    `# Search eval — ${PHASE} (${PROJECT}, k=${K})`,
    ``,
    `Judge: \`${JUDGE_MODEL}\` (cross-family) · generate: \`${STAGE2_MODEL}\` · embed: \`${EMB_MODEL}\` · ${overall.queries} queries · ${overall.judged} judgments`,
    ``,
    `**Overall:** mean grade@${K} ${overall.meanGrade} · nDCG@${K} ${overall.ndcg} · no-results ${(overall.noResultRate * 100).toFixed(0)}%`,
    ``,
    `| query type | n | mean grade@${K} | nDCG@${K} | no-results |`,
    `|---|---|---|---|---|`,
    ...bucketRows.map((b) => `| ${b.type} | ${b.n} | ${b.meanGrade} | ${b.ndcg} | ${(b.noResultRate * 100).toFixed(0)}% |`),
    `| **overall** | ${overall.queries} | **${overall.meanGrade}** | ${overall.ndcg} | ${(overall.noResultRate * 100).toFixed(0)}% |`,
    ``,
  ].join("\n");
  await writeFile(`${base}.md`, md + "\n");

  await matcher.close();
  console.log(md);
  console.log(`\nartifact: ${base}.json`);
}

await main();
