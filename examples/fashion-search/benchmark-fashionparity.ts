/**
 * Label-free benchmark of the live hybrid engine against the fashionparity catalog.
 *
 * Runs the 48 golden queries (evals/golden-queries-fashion-lk.json) as NATURAL LANGUAGE
 * (no explicit filters — NLQ must parse intent/budget itself) over the real ~5.5k-product
 * catalog and reports objective + behavioural metrics by query type:
 *   - price-violation@5  (budget queries: results above the stated max_price)
 *   - zero-result rate, relaxation rate, mean result count
 *   - latency (mean / p50 / max)
 *
 * No relevance labels exist for this catalog, so relevance@k is not computed here.
 *
 * Run: bun --env-file=../../.env benchmark-fashionparity.ts
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createFashionMatcher, COLLECTION } from "./samesake.config.ts";

const SLUG = process.env.BENCH_PROJECT ?? "fashionparity";
const GOLDEN = join(import.meta.dir, "..", "..", "evals", "golden-queries-fashion-lk.json");

type GoldenQuery = { id: string; type: string; query: string; constraints?: { max_price?: number } };

const pct = (a: number[], p: number) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor((a.length - 1) * p))] : 0);
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

async function main() {
  const golden = JSON.parse(await readFile(GOLDEN, "utf8")) as { queries: GoldenQuery[] };
  const matcher = createFashionMatcher();

  const rows: Array<{
    id: string; type: string; query: string; n: number; latencyMs: number;
    zeroResult: boolean; relaxed: boolean; maxPrice?: number; violationsAt5?: number; topPrices: number[];
  }> = [];

  for (const gq of golden.queries) {
    const t0 = performance.now();
    const res = await matcher.search(SLUG, COLLECTION, { q: gq.query, limit: 10 });
    const latencyMs = Math.round(performance.now() - t0);
    const hits = res.hits as unknown as Record<string, unknown>[];
    const top5 = hits.slice(0, 5).map((h) => Number(h.price)).filter((p) => Number.isFinite(p));
    const maxPrice = gq.constraints?.max_price;
    const violationsAt5 = maxPrice != null && top5.length ? top5.filter((p) => p > maxPrice).length / top5.length : undefined;
    rows.push({
      id: gq.id, type: gq.type, query: gq.query, n: hits.length, latencyMs,
      zeroResult: hits.length === 0, relaxed: res.relaxed === true,
      maxPrice, violationsAt5, topPrices: top5.slice(0, 5),
    });
  }
  await matcher.close();

  const types = [...new Set(rows.map((r) => r.type))].sort();
  const byType = types.map((t) => {
    const rs = rows.filter((r) => r.type === t);
    return {
      type: t, queries: rs.length,
      meanLatencyMs: Math.round(mean(rs.map((r) => r.latencyMs))),
      zeroResultRate: +(rs.filter((r) => r.zeroResult).length / rs.length).toFixed(2),
      relaxationRate: +(rs.filter((r) => r.relaxed).length / rs.length).toFixed(2),
      meanResults: +mean(rs.map((r) => r.n)).toFixed(1),
    };
  });
  const priceRows = rows.filter((r) => r.violationsAt5 !== undefined);
  const lat = rows.map((r) => r.latencyMs);

  const report = {
    engine: "live-hybrid (matcher.search: NLQ + FTS + cosine ANN)",
    project: SLUG, collection: COLLECTION,
    catalogQueries: rows.length,
    metrics: {
      latencyMs: { mean: Math.round(mean(lat)), p50: pct(lat, 0.5), p95: pct(lat, 0.95), max: Math.max(...lat) },
      zeroResultRate: +(rows.filter((r) => r.zeroResult).length / rows.length).toFixed(2),
      relaxationRate: +(rows.filter((r) => r.relaxed).length / rows.length).toFixed(2),
      priceViolationAt5: priceRows.length ? +mean(priceRows.map((r) => r.violationsAt5!)).toFixed(2) : null,
      priceQueriesFullyCompliant: priceRows.length ? +(priceRows.filter((r) => r.violationsAt5 === 0).length / priceRows.length).toFixed(2) : null,
    },
    byType, rows,
  };

  await mkdir(".samesake", { recursive: true });
  await writeFile(".samesake/fashionparity-benchmark.json", JSON.stringify(report, null, 2));
  const md = [
    `# fashionparity benchmark — ${rows.length} golden queries over ${SLUG}`,
    "",
    `Engine: ${report.engine}`,
    `- latency: mean ${report.metrics.latencyMs.mean}ms · p50 ${report.metrics.latencyMs.p50}ms · p95 ${report.metrics.latencyMs.p95}ms · max ${report.metrics.latencyMs.max}ms`,
    `- zero-result rate: ${report.metrics.zeroResultRate}`,
    `- relaxation rate: ${report.metrics.relaxationRate}`,
    `- price-violation@5 (NL budget queries): ${report.metrics.priceViolationAt5}`,
    `- price queries fully compliant: ${report.metrics.priceQueriesFullyCompliant}`,
    "",
    "| type | queries | mean latency | zero-result | relaxation | mean results |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...byType.map((b) => `| ${b.type} | ${b.queries} | ${b.meanLatencyMs}ms | ${b.zeroResultRate} | ${b.relaxationRate} | ${b.meanResults} |`),
    "",
    "## Budget queries (price-violation@5)",
    "| query | max_price | violations@5 | top-5 prices |",
    "| --- | ---: | ---: | --- |",
    ...priceRows.map((r) => `| ${r.query} | ${r.maxPrice} | ${(r.violationsAt5! * 100).toFixed(0)}% | ${r.topPrices.join(", ")} |`),
    "",
  ].join("\n");
  await writeFile(".samesake/fashionparity-benchmark.md", md);
  console.log(md);
}

main().catch((e) => { console.error(e); process.exit(1); });
