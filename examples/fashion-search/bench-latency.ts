import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createFashionMatcher, COLLECTION, PROJECT } from "./samesake.config.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const RUNS_DIR = join(REPO_ROOT, "evals", "runs");
const GOLDEN = join(REPO_ROOT, "evals", "golden-queries-fashion-lk.json");
const args = process.argv.slice(2);
const flag = (key: string, fallback: string) => args.find((arg) => arg.startsWith(`--${key}=`))?.split("=")[1] ?? fallback;
const PHASE = flag("phase", "baseline");
const DOCS = Number(flag("docs", "5000"));
const PERCENTILE = Number(flag("p", "95"));
const SAMPLES = Number(flag("samples", "20"));
const WARM = args.includes("--warm");
const EXCLUDE_REWRITES = args.includes("--exclude-rewrites");

type GoldenQuery = { id: string; query: string };

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p / 100))]!;
}

async function main(): Promise<void> {
  const { queries } = JSON.parse(await readFile(GOLDEN, "utf8")) as { queries: GoldenQuery[] };
  const matcher = createFashionMatcher();
  await matcher.migrate();

  const seed = queries.slice(0, Math.max(1, Math.min(5, queries.length)));
  if (WARM) {
    for (const query of seed) {
      await matcher.search(PROJECT, COLLECTION, { q: query.query, limit: 10, cache: false });
    }
  }

  const rows: Array<{ id: string; query: string; latencyMs: number; rewritten: boolean }> = [];
  for (let i = 0; i < SAMPLES; i++) {
    const query = seed[i % seed.length]!;
    const started = performance.now();
    const result = await matcher.search(PROJECT, COLLECTION, { q: query.query, limit: 10, cache: false });
    rows.push({
      id: query.id,
      query: query.query,
      latencyMs: Math.round(performance.now() - started),
      rewritten: !!result.rewritten,
    });
  }
  await matcher.close();

  const measured = EXCLUDE_REWRITES ? rows.filter((row) => !row.rewritten) : rows;
  const latencies = measured.map((row) => row.latencyMs);
  const p = percentile(latencies, PERCENTILE);
  const artifact = {
    phase: PHASE,
    project: PROJECT,
    collection: COLLECTION,
    docs: DOCS,
    warm: WARM,
    excludeRewrites: EXCLUDE_REWRITES,
    samples: rows.length,
    measuredSamples: measured.length,
    percentile: PERCENTILE,
    p95Ms: p,
    rows,
  };
  await mkdir(RUNS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = join(RUNS_DIR, `${stamp}-latency-${PHASE}`);
  await writeFile(`${base}.json`, JSON.stringify(artifact, null, 2) + "\n");
  console.log(`# Latency — ${PHASE}`);
  console.log(`docs=${DOCS} samples=${rows.length} measured=${measured.length} p${PERCENTILE}=${p}ms`);
  console.log(`artifact: ${base}.json`);
}

await main();
