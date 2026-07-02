import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { COLLECTION, PROJECT } from "./samesake.config.ts";

type Product = {
  id: string;
  title: string;
  brand: string;
  category: string;
  colors: string[];
  material: string;
  price: number;
  available: boolean;
};

type ConstraintSpec = {
  maxPrice?: number;
  requiredColors?: string[];
  excludedColors?: string[];
  available?: boolean;
};

type EvalQuery = {
  name: string;
  q: string;
  filters?: Record<string, unknown>;
  constraints?: ConstraintSpec;
  relevant: string[];
  image?: string;
};

type EvalCorpus = {
  products: Product[];
  queries: EvalQuery[];
  source: { kind: "fixture"; products: number; queries: number } | { kind: "files"; dir: string; files: number };
};

type SearchRun = {
  hits: Product[];
  relaxed: boolean;
  latencyMs: number;
};

const fixture: Product[] = [
  { id: "red-dress", title: "red cotton summer dress", brand: "Luna", category: "dresses", colors: ["red"], material: "cotton", price: 72, available: true },
  { id: "blue-dress", title: "blue linen office dress", brand: "Aster", category: "dresses", colors: ["blue"], material: "linen", price: 118, available: true },
  { id: "black-jeans", title: "black denim straight jeans", brand: "North", category: "bottoms", colors: ["black"], material: "denim", price: 64, available: true },
  { id: "sold-red", title: "red party dress", brand: "Aster", category: "dresses", colors: ["red"], material: "polyester", price: 140, available: false },
];

const queries: EvalQuery[] = [
  { name: "keyword", q: "red dress", filters: { available: true }, constraints: { available: true }, relevant: ["red-dress"] },
  { name: "color-required", q: "office dress in blue", filters: { colors: ["blue"], available: true }, constraints: { requiredColors: ["blue"], available: true }, relevant: ["blue-dress"] },
  { name: "color-excluded", q: "straight jeans not blue", filters: { colors: { $nin: ["blue"] }, available: true }, constraints: { excludedColors: ["blue"], available: true }, relevant: ["black-jeans"] },
  { name: "price-cap", q: "dress under 100", filters: { price: { $lte: 100 }, available: true }, constraints: { maxPrice: 100, available: true }, relevant: ["red-dress"] },
  { name: "image", q: "", image: "red", filters: { available: true }, constraints: { available: true }, relevant: ["red-dress"] },
  { name: "full", q: "cotton summer dress", image: "red", filters: { category: "dresses", available: true }, constraints: { available: true }, relevant: ["red-dress"] },
];

function isProduct(value: unknown): value is Product {
  const p = value as Product;
  return !!p &&
    typeof p.id === "string" &&
    typeof p.title === "string" &&
    typeof p.brand === "string" &&
    typeof p.category === "string" &&
    Array.isArray(p.colors) &&
    typeof p.material === "string" &&
    typeof p.price === "number" &&
    typeof p.available === "boolean";
}

function isEvalQuery(value: unknown): value is EvalQuery {
  const q = value as EvalQuery;
  return !!q &&
    typeof q.name === "string" &&
    typeof q.q === "string" &&
    Array.isArray(q.relevant);
}

function normalizeCorpusRecord(record: unknown, out: { products: Product[]; queries: EvalQuery[] }): void {
  if (Array.isArray(record)) {
    for (const item of record) normalizeCorpusRecord(item, out);
    return;
  }
  if (!record || typeof record !== "object") return;
  const obj = record as Record<string, unknown>;
  if (Array.isArray(obj.products)) {
    for (const product of obj.products) {
      if (isProduct(product)) out.products.push(product);
    }
  }
  if (Array.isArray(obj.queries)) {
    for (const query of obj.queries) {
      if (isEvalQuery(query)) out.queries.push(query);
    }
  }
  if (obj.type === "product" && isProduct(obj.data)) out.products.push(obj.data);
  if (obj.type === "query" && isEvalQuery(obj.data)) out.queries.push(obj.data);
  if (isProduct(record)) out.products.push(record);
  if (isEvalQuery(record)) out.queries.push(record);
}

async function readJsonOrJsonl(path: string): Promise<unknown[]> {
  const raw = await readFile(path, "utf8");
  if (path.endsWith(".jsonl")) {
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown);
  }
  return [JSON.parse(raw) as unknown];
}

async function loadCorpus(): Promise<EvalCorpus> {
  const datasetDir = process.env.FASHION_DATASET_DIR;
  if (!datasetDir || !existsSync(datasetDir) || !statSync(datasetDir).isDirectory()) {
    return { products: fixture, queries, source: { kind: "fixture", products: fixture.length, queries: queries.length } };
  }

  const files = readdirSync(datasetDir)
    .filter((f) => f.endsWith(".json") || f.endsWith(".jsonl"))
    .sort();
  const out: { products: Product[]; queries: EvalQuery[] } = { products: [], queries: [] };
  for (const file of files) {
    for (const record of await readJsonOrJsonl(join(datasetDir, file))) {
      normalizeCorpusRecord(record, out);
    }
  }

  if (!out.products.length || !out.queries.length) {
    throw new Error(
      `FASHION_DATASET_DIR=${datasetDir} must contain JSON/JSONL Product records and EvalQuery records`
    );
  }

  return { products: out.products, queries: out.queries, source: { kind: "files", dir: datasetDir, files: files.length } };
}

function terms(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function passesFilters(p: Product, filters: Record<string, unknown> = {}): boolean {
  for (const [key, value] of Object.entries(filters)) {
    const raw = (p as unknown as Record<string, unknown>)[key];
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const op = value as Record<string, unknown>;
      if (typeof op.$lte === "number" && !(typeof raw === "number" && raw <= op.$lte)) return false;
      if (typeof op.$lt === "number" && !(typeof raw === "number" && raw < op.$lt)) return false;
      if (typeof op.$gte === "number" && !(typeof raw === "number" && raw >= op.$gte)) return false;
      if (typeof op.$gt === "number" && !(typeof raw === "number" && raw > op.$gt)) return false;
      const nin = op.$nin;
      if (Array.isArray(nin)) {
        if (Array.isArray(raw) && raw.some((v) => nin.includes(v))) return false;
        if (!Array.isArray(raw) && nin.includes(raw)) return false;
      }
      continue;
    }
    if (Array.isArray(value)) {
      if (!Array.isArray(raw) || !value.some((v) => raw.includes(v))) return false;
      continue;
    }
    if (raw !== value) return false;
  }
  return true;
}

function checkConstraints(p: Product, constraints: ConstraintSpec = {}): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (constraints.maxPrice !== undefined) out.price = p.price <= constraints.maxPrice;
  if (constraints.available !== undefined) out.available = p.available === constraints.available;
  if (constraints.requiredColors?.length) {
    out.colorRequired = constraints.requiredColors.some((c) => p.colors.includes(c));
  }
  if (constraints.excludedColors?.length) {
    out.colorExcluded = constraints.excludedColors.every((c) => !p.colors.includes(c));
  }
  return out;
}

function constraintMetrics(hits: Product[], constraints: ConstraintSpec = {}, k = 5): Record<string, number> {
  const top = hits.slice(0, k);
  if (!top.length) return { overall: 0, perfect: 0 };
  const checked = top.map((p) => checkConstraints(p, constraints));
  const keys = Array.from(new Set(checked.flatMap((r) => Object.keys(r))));
  const metrics: Record<string, number> = {};
  for (const key of keys) {
    const vals = checked.map((r) => r[key]).filter((v): v is boolean => typeof v === "boolean");
    metrics[key] = vals.length ? vals.filter(Boolean).length / vals.length : 1;
  }
  const perProduct = checked.map((r) => {
    const vals = Object.values(r);
    return vals.length ? vals.every(Boolean) : true;
  });
  metrics.overall = perProduct.filter(Boolean).length / perProduct.length;
  metrics.perfect = perProduct.every(Boolean) ? 1 : 0;
  return metrics;
}

function localSearch(products: Product[], query: EvalQuery): SearchRun {
  const started = Date.now();
  const qTerms = terms(query.q);
  const hits = products
    .filter((p) => passesFilters(p, query.filters))
    .map((p) => {
      const haystack = terms(`${p.title} ${p.brand} ${p.category} ${p.colors.join(" ")} ${p.material}`);
      let score = qTerms.reduce((sum, t) => sum + (haystack.includes(t) ? 1 : 0), 0);
      if (query.image && p.colors.includes(query.image)) score += 2;
      return { p, score };
    })
    .filter((x) => x.score > 0 || query.image)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.p);
  return { hits, relaxed: false, latencyMs: Date.now() - started };
}

async function remoteSearch(products: Product[], query: EvalQuery): Promise<SearchRun> {
  const base = process.env.FASHION_SEARCH_BASE;
  const apiKey = process.env.SAMESAKE_API_KEY ?? process.env.GEMINI_API_KEY;
  if (!base || !apiKey) return localSearch(products, query);

  const started = Date.now();
  const res = await fetch(`${base.replace(/\/$/, "")}/v1/projects/${PROJECT}/collections/${COLLECTION}/shop-search`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      q: query.q,
      filters: query.filters,
      image: query.image ? { url: query.image } : undefined,
      limit: 10,
      debug: true,
      recoverNoResults: true,
    }),
  });
  if (!res.ok) throw new Error(`shop-search eval request failed ${res.status}: ${await res.text()}`);
  const body = await res.json() as {
    hits: Array<Record<string, unknown>>;
    fallback?: { reason: string; relaxedFilters: string[] };
    constraintTrace?: { relaxedFields?: string[] };
  };
  const latency = Date.now() - started;
  return {
    hits: body.hits.map((h) => ({
      id: String(h.id),
      title: String(h.title ?? ""),
      brand: String(h.brand ?? ""),
      category: String(h.category ?? ""),
      colors: Array.isArray(h.colors) ? h.colors.map(String) : [],
      material: String(h.material ?? ""),
      available: h.available === true,
      price: Number(h.price ?? 0),
    })),
    relaxed: !!body.fallback || !!body.constraintTrace?.relaxedFields?.length,
    latencyMs: latency,
  };
}

function relevanceAtK(ids: string[], relevant: string[], k: number): number {
  if (!relevant.length) return 0;
  return ids.slice(0, k).filter((id) => relevant.includes(id)).length / Math.min(k, relevant.length);
}

async function main() {
  const started = Date.now();
  const corpus = await loadCorpus();
  const rows: Array<{
    name: string;
    q: string;
    topIds: string[];
    relevanceAt3: number;
    constraintCompliance: number;
    constraintMetrics: Record<string, number>;
    zeroResult: boolean;
    relaxed: boolean;
    latencyMs: number;
  }> = [];
  for (const query of corpus.queries) {
    const run = await remoteSearch(corpus.products, query);
    const hits = run.hits;
    const ids = hits.map((h) => h.id);
    const constraints = constraintMetrics(hits, query.constraints);
    rows.push({
      name: query.name,
      q: query.q,
      topIds: ids.slice(0, 5),
      relevanceAt3: relevanceAtK(ids, query.relevant, 3),
      constraintCompliance: hits.every((h) => passesFilters(h, query.filters)) ? 1 : 0,
      constraintMetrics: constraints,
      zeroResult: hits.length === 0,
      relaxed: run.relaxed,
      latencyMs: run.latencyMs,
    });
  }

  const constraintKeys = Array.from(
    new Set(rows.flatMap((r) => Object.keys(r.constraintMetrics).filter((k) => k !== "overall" && k !== "perfect")))
  ).sort();
  const constraintByType = Object.fromEntries(
    constraintKeys.map((key) => [
      key,
      rows.reduce((sum, r) => sum + (r.constraintMetrics[key] ?? 1), 0) / rows.length,
    ])
  );
  const report = {
    engine: process.env.FASHION_SEARCH_BASE ? "remote-shop-search" : "local-deterministic-fixture",
    project: PROJECT,
    collection: COLLECTION,
    generatedAt: new Date().toISOString(),
    dataset: corpus.source,
    metrics: {
      relevanceAt3: rows.reduce((sum, r) => sum + r.relevanceAt3, 0) / rows.length,
      constraintCompliance: rows.reduce((sum, r) => sum + r.constraintCompliance, 0) / rows.length,
      constraintOverallAt5: rows.reduce((sum, r) => sum + r.constraintMetrics.overall, 0) / rows.length,
      perfectConstraintAt5: rows.reduce((sum, r) => sum + r.constraintMetrics.perfect, 0) / rows.length,
      constraintByType,
      zeroResultRate: rows.filter((r) => r.zeroResult).length / rows.length,
      relaxationRate: rows.filter((r) => r.relaxed).length / rows.length,
      meanLatencyMs: rows.reduce((sum, r) => sum + r.latencyMs, 0) / rows.length,
      latencyMs: Date.now() - started,
      estimatedCostUsd: 0,
    },
    rows,
  };

  await mkdir(".samesake", { recursive: true });
  await writeFile(".samesake/fashion-eval.json", JSON.stringify(report, null, 2));
  const md = [
    "# Fashion Search Eval",
    "",
    `Engine: ${report.engine}`,
    `Dataset: ${corpus.source.kind === "files" ? `${corpus.source.files} files from ${corpus.source.dir}` : `${corpus.source.products} deterministic fixture products / ${corpus.source.queries} queries`}`,
    "",
    `- relevance@3: ${report.metrics.relevanceAt3.toFixed(2)}`,
    `- constraint compliance: ${report.metrics.constraintCompliance.toFixed(2)}`,
    `- constraint overall@5: ${report.metrics.constraintOverallAt5.toFixed(2)}`,
    `- perfect constraint@5: ${report.metrics.perfectConstraintAt5.toFixed(2)}`,
    ...Object.entries(report.metrics.constraintByType).map(([k, v]) => `- ${k}@5: ${v.toFixed(2)}`),
    `- zero-result rate: ${report.metrics.zeroResultRate.toFixed(2)}`,
    `- relaxation rate: ${report.metrics.relaxationRate.toFixed(2)}`,
    `- mean latency: ${report.metrics.meanLatencyMs.toFixed(0)}ms`,
    `- latency: ${report.metrics.latencyMs}ms`,
    `- estimated cost: $${report.metrics.estimatedCostUsd.toFixed(2)}`,
    "",
    "| query | top ids | relevance@3 | constraints |",
    "| --- | --- | ---: | ---: |",
    ...rows.map((r) => `| ${r.name} | ${r.topIds.join(", ")} | ${r.relevanceAt3.toFixed(2)} | ${r.constraintMetrics.overall.toFixed(2)} |`),
    "",
  ].join("\n");
  await writeFile(".samesake/fashion-eval.md", md);
  console.log(md);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
