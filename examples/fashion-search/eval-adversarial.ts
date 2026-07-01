/**
 * RED-TEAM / devil's-advocate search eval — deliberately built to FAIL the engine.
 *
 *   bun --env-file=../../.env eval-adversarial.ts
 *
 * Runs adversarial / out-of-distribution / numerical / contradictory / injection / degenerate /
 * polysemy queries against the live fashionparity engine. Each query is isolated in try/catch so a
 * crash is a FINDING, not an aborted run. Checks that are appropriate per expectation:
 *   - numerical: price-constraint VIOLATION rate against stated bounds (deterministic)
 *   - ood/empty: FALSE-POSITIVE rate (framework judge grades a returned item relevant when it must not)
 *   - injection/degenerate/contradiction: must not crash; behavior observed
 *   - relevant/polysemy/compositional: relevance grade (framework judge, gemini-3.1-flash-lite)
 *
 * Output: evals/runs/<ts>-adversarial.{json,md} with a ranked FAILURES list.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeLlmJudge, candidateSummary } from "@samesake/server";
import { createFashionMatcher, productsCollection } from "./samesake.config.ts";
import { geminiGenerate, STAGE2_MODEL, EMB_MODEL } from "./gemini.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const RUNS_DIR = join(REPO_ROOT, "evals", "runs");
const QUERIES = join(REPO_ROOT, "evals", "adversarial-queries.json");
const PROJECT = "fashionparity";
const COLLECTION = "products";
const K = 5;

interface AQ {
  id: string;
  bucket: string;
  query: string;
  expect: "relevant" | "empty" | "graceful";
  bounds?: { min?: number; max?: number };
  note?: string;
}

const priceOf = (h: Record<string, unknown>): number | null => {
  const d = (h.data ?? {}) as Record<string, unknown>;
  const p = typeof h.price === "number" ? h.price : typeof d.price === "number" ? (d.price as number) : null;
  return p;
};
const titleOf = (h: Record<string, unknown>): string => {
  const d = (h.data ?? {}) as Record<string, unknown>;
  return String(d.title ?? h.id ?? "").slice(0, 60);
};

async function main(): Promise<void> {
  const { queries } = JSON.parse(await readFile(QUERIES, "utf8")) as { queries: AQ[] };
  const matcher = createFashionMatcher();
  await matcher.migrate();
  await matcher.apply(PROJECT, { entities: [], collections: [productsCollection] });
  const judge = makeLlmJudge(geminiGenerate, { model: STAGE2_MODEL, onError: () => {} });

  interface Row extends AQ {
    error: string | null;
    hits: number;
    latencyMs: number;
    prices: (number | null)[];
    titles: string[];
    maxGrade: number | null;
    meanGrade: number | null;
    priceViolations: number;
    verdict: string;
    detail: string;
  }
  const rows: Row[] = [];

  for (const q of queries) {
    const t0 = Date.now();
    let error: string | null = null;
    let hits: Array<Record<string, unknown>> = [];
    try {
      const res = (await matcher.search(PROJECT, COLLECTION, { q: q.query, limit: K })) as { hits?: Array<Record<string, unknown>> };
      hits = res.hits ?? [];
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const latencyMs = Date.now() - t0;
    const prices = hits.map(priceOf);
    const titles = hits.map(titleOf);

    // Price-bounds violation (deterministic).
    let priceViolations = 0;
    if (q.bounds) {
      for (const p of prices) {
        if (p === null) continue;
        if (q.bounds.min !== undefined && p < q.bounds.min) priceViolations++;
        else if (q.bounds.max !== undefined && p > q.bounds.max) priceViolations++;
      }
    }

    // Judge relevance only where it is meaningful (relevant-expected, or empty-expected to catch
    // false positives). Grades are 0 (irrelevant) / 1 (moderate) / 2 (high).
    let maxGrade: number | null = null;
    let meanGrade: number | null = null;
    if (!error && hits.length && (q.expect === "relevant" || q.expect === "empty")) {
      const candidates = hits.map((h) => ({ id: String(h.id), text: candidateSummary((h.data ?? {}) as Record<string, unknown>, String(h.id)), data: (h.data ?? {}) as Record<string, unknown> }));
      const judged = await judge.grade(q.query, candidates);
      const grades = judged.map((j) => j.grade);
      if (grades.length) {
        maxGrade = Math.max(...grades);
        meanGrade = Math.round((grades.reduce((a, b) => a + b, 0) / grades.length) * 100) / 100;
      }
    }

    // Verdict.
    const isValidationError = error && /non-empty q or image/i.test(error);
    let verdict = "pass";
    let detail = "";
    if (error && !isValidationError) {
      verdict = "CRASH";
      detail = error.slice(0, 160);
    } else if (isValidationError) {
      verdict = "ok-validation";
      detail = "rejected empty query (controlled)";
    } else if (q.bounds && priceViolations > 0) {
      verdict = "PRICE-VIOLATION";
      detail = `${priceViolations}/${prices.filter((p) => p !== null).length} hits outside [${q.bounds.min ?? "-"}, ${q.bounds.max ?? "-"}]: ${prices.join(",")}`;
    } else if (q.expect === "empty") {
      if (hits.length === 0) { verdict = "pass"; detail = "correctly empty"; }
      else if (maxGrade !== null && maxGrade >= 1) { verdict = "FALSE-POSITIVE"; detail = `returned judge-relevant items (maxGrade=${maxGrade}) for an out-of-scope query: ${titles.slice(0, 3).join(" | ")}`; }
      else { verdict = "junk-shown"; detail = `${hits.length} irrelevant items shown (judge maxGrade=${maxGrade}) — no-results would be better: ${titles.slice(0, 2).join(" | ")}`; }
    } else if (q.expect === "relevant") {
      if (meanGrade === null) { verdict = hits.length ? "unjudged" : "WEAK"; detail = hits.length ? "" : "no results for an answerable query"; }
      else if (meanGrade >= 1) { verdict = "pass"; detail = `meanGrade=${meanGrade}`; }
      else { verdict = "WEAK"; detail = `meanGrade=${meanGrade} (< 1) top: ${titles.slice(0, 2).join(" | ")}`; }
    } else {
      // graceful
      verdict = "pass";
      detail = `no crash; ${hits.length} hits${q.bounds ? `, ${priceViolations} price-violations` : ""}`;
    }

    rows.push({ ...q, error, hits: hits.length, latencyMs, prices, titles, maxGrade, meanGrade, priceViolations, verdict, detail });
  }

  await matcher.close();

  // Aggregate.
  const rank: Record<string, number> = { CRASH: 0, "PRICE-VIOLATION": 1, "FALSE-POSITIVE": 2, WEAK: 3, "junk-shown": 4 };
  const findings = rows.filter((r) => r.verdict in rank).sort((a, b) => rank[a.verdict]! - rank[b.verdict]!);
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.verdict] = (counts[r.verdict] ?? 0) + 1;
  const byBucket: Record<string, { n: number; findings: number }> = {};
  for (const r of rows) {
    const b = (byBucket[r.bucket] ??= { n: 0, findings: 0 });
    b.n++;
    if (r.verdict in rank) b.findings++;
  }

  const artifact = {
    suite: "adversarial-red-team",
    project: PROJECT,
    k: K,
    models: { embed: EMB_MODEL, judge: STAGE2_MODEL },
    totals: { queries: rows.length, ...counts },
    byBucket,
    findings: findings.map((f) => ({ id: f.id, bucket: f.bucket, query: f.query, expect: f.expect, verdict: f.verdict, detail: f.detail })),
    rows,
  };
  await mkdir(RUNS_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const base = join(RUNS_DIR, `${ts}-adversarial`);
  await writeFile(`${base}.json`, JSON.stringify(artifact, null, 2) + "\n");

  const md = [
    `# Red-team (adversarial) search eval — ${PROJECT}`,
    ``,
    `Judge \`${STAGE2_MODEL}\` · embed \`${EMB_MODEL}\` · ${rows.length} queries · k=${K}`,
    ``,
    `**Verdict counts:** ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" · ")}`,
    ``,
    `## Findings (${findings.length}) — most severe first`,
    findings.length ? "" : "_none_",
    ...findings.map((f) => `- **[${f.verdict}]** \`${f.id}\` (${f.bucket}) "${f.query}"\n  - ${f.detail}`),
    ``,
    `## By bucket`,
    `| bucket | n | findings |`,
    `|---|---|---|`,
    ...Object.entries(byBucket).map(([b, v]) => `| ${b} | ${v.n} | ${v.findings} |`),
    ``,
    `## All queries`,
    `| id | bucket | expect | verdict | hits | lat(ms) | detail |`,
    `|---|---|---|---|---|---|---|`,
    ...rows.map((r) => `| ${r.id} | ${r.bucket} | ${r.expect} | ${r.verdict} | ${r.hits} | ${r.latencyMs} | ${r.detail.slice(0, 80)} |`),
    ``,
  ].join("\n");
  await writeFile(`${base}.md`, md + "\n");

  console.log(md);
  console.log(`\nartifact: ${base}.json`);
}

await main();
