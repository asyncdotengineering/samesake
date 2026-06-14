import { mkdir, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { COLLECTION, PROJECT } from "./samesake.config.ts";

type Product = {
  id: string;
  title: string;
  brand: string;
  category: string;
  colors: string[];
  material: string;
  available: boolean;
};

type EvalQuery = {
  name: string;
  q: string;
  filters?: Record<string, unknown>;
  relevant: string[];
  image?: string;
};

const fixture: Product[] = [
  { id: "red-dress", title: "red cotton summer dress", brand: "Luna", category: "dresses", colors: ["red"], material: "cotton", available: true },
  { id: "blue-dress", title: "blue linen office dress", brand: "Aster", category: "dresses", colors: ["blue"], material: "linen", available: true },
  { id: "black-jeans", title: "black denim straight jeans", brand: "North", category: "bottoms", colors: ["black"], material: "denim", available: true },
  { id: "sold-red", title: "red party dress", brand: "Aster", category: "dresses", colors: ["red"], material: "polyester", available: false },
];

const queries: EvalQuery[] = [
  { name: "keyword", q: "red dress", filters: { available: true }, relevant: ["red-dress"] },
  { name: "constraint", q: "office dress", filters: { colors: ["blue"], available: true }, relevant: ["blue-dress"] },
  { name: "image", q: "", image: "red", filters: { available: true }, relevant: ["red-dress"] },
  { name: "full", q: "cotton summer dress", image: "red", filters: { category: "dresses", available: true }, relevant: ["red-dress"] },
];

function terms(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function passesFilters(p: Product, filters: Record<string, unknown> = {}): boolean {
  for (const [key, value] of Object.entries(filters)) {
    const raw = (p as unknown as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      if (!Array.isArray(raw) || !value.some((v) => raw.includes(v))) return false;
      continue;
    }
    if (raw !== value) return false;
  }
  return true;
}

function localSearch(query: EvalQuery): Product[] {
  const qTerms = terms(query.q);
  return fixture
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
}

async function remoteSearch(query: EvalQuery): Promise<Product[]> {
  const base = process.env.FASHION_SEARCH_BASE;
  const apiKey = process.env.API_KEY ?? process.env.GEMINI_API_KEY;
  if (!base || !apiKey) return localSearch(query);

  const started = Date.now();
  const res = await fetch(`${base.replace(/\/$/, "")}/v1/projects/${PROJECT}/collections/${COLLECTION}/fashion-search`, {
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
  if (!res.ok) throw new Error(`fashion-search eval request failed ${res.status}: ${await res.text()}`);
  const body = await res.json() as { hits: Array<Record<string, unknown>> };
  const latency = Date.now() - started;
  return body.hits.map((h) => ({
    id: String(h.id),
    title: String(h.title ?? ""),
    brand: String(h.brand ?? ""),
    category: String(h.category ?? ""),
    colors: Array.isArray(h.colors) ? h.colors.map(String) : [],
    material: String(h.material ?? ""),
    available: h.available === true,
    latency,
  } as Product));
}

function relevanceAtK(ids: string[], relevant: string[], k: number): number {
  if (!relevant.length) return 0;
  return ids.slice(0, k).filter((id) => relevant.includes(id)).length / Math.min(k, relevant.length);
}

async function main() {
  const started = Date.now();
  const rows = [];
  for (const query of queries) {
    const hits = await remoteSearch(query);
    const ids = hits.map((h) => h.id);
    rows.push({
      name: query.name,
      q: query.q,
      topIds: ids.slice(0, 5),
      relevanceAt3: relevanceAtK(ids, query.relevant, 3),
      constraintCompliance: hits.every((h) => passesFilters(h, query.filters)) ? 1 : 0,
      zeroResult: hits.length === 0,
    });
  }

  const datasetDir = process.env.FASHION_DATASET_DIR;
  const datasetFiles = datasetDir && existsSync(datasetDir)
    ? readdirSync(datasetDir).filter((f) => f.endsWith(".json") || f.endsWith(".jsonl")).length
    : 0;
  const report = {
    engine: process.env.FASHION_SEARCH_BASE ? "remote-fashion-search" : "local-deterministic-fixture",
    project: PROJECT,
    collection: COLLECTION,
    generatedAt: new Date().toISOString(),
    dataset: datasetFiles ? { dir: datasetDir, files: datasetFiles } : { fixtureProducts: fixture.length },
    metrics: {
      relevanceAt3: rows.reduce((sum, r) => sum + r.relevanceAt3, 0) / rows.length,
      constraintCompliance: rows.reduce((sum, r) => sum + r.constraintCompliance, 0) / rows.length,
      zeroResultRate: rows.filter((r) => r.zeroResult).length / rows.length,
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
    `Dataset: ${datasetFiles ? `${datasetFiles} files from ${datasetDir}` : `${fixture.length} deterministic fixture products`}`,
    "",
    `- relevance@3: ${report.metrics.relevanceAt3.toFixed(2)}`,
    `- constraint compliance: ${report.metrics.constraintCompliance.toFixed(2)}`,
    `- zero-result rate: ${report.metrics.zeroResultRate.toFixed(2)}`,
    `- latency: ${report.metrics.latencyMs}ms`,
    `- estimated cost: $${report.metrics.estimatedCostUsd.toFixed(2)}`,
    "",
    "| query | top ids | relevance@3 | constraints |",
    "| --- | --- | ---: | ---: |",
    ...rows.map((r) => `| ${r.name} | ${r.topIds.join(", ")} | ${r.relevanceAt3.toFixed(2)} | ${r.constraintCompliance.toFixed(2)} |`),
    "",
  ].join("\n");
  await writeFile(".samesake/fashion-eval.md", md);
  console.log(md);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
