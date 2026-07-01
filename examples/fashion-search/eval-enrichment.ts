/**
 * Enrichment-accuracy eval — the ENRICHMENT twin of eval.ts (which measures search relevance).
 *
 * Search relevance is a downstream symptom; this measures the root cause: did the classify+extract
 * pipeline pull the RIGHT structured attributes? It scores the pipeline's `enriched.*` output
 * against a human-labeled gold set (evals/golden-enrichment-fashion-lk.json) with per-attribute
 * precision / recall / F1, so any change to enrich prompts, taxonomy, or the confidence gate can be
 * gated on measured extraction accuracy — not vibes.
 *
 * Modes:
 *   bun --env-file=../../.env eval-enrichment.ts              # real: score the seeded demo_store corpus (needs DB)
 *   bun eval-enrichment.ts --fixture                          # offline: score the bundled captured predictions (no DB/LLM)
 *   bun eval-enrichment.ts --bootstrap [products.json]        # emit a blank gold template to label a new corpus
 *
 * The --fixture and real paths produce the SAME numbers on the demo corpus, because the fixture is
 * the demo_store pipeline output captured verbatim from Postgres.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fashion } from "@samesake/core";
import { scoreEnrichment, type GoldRow, type PredictedRow, type EnrichEvalResult } from "@samesake/server";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const GOLD_PATH = join(REPO_ROOT, "evals", "golden-enrichment-fashion-lk.json");
const FIXTURE_PATH = join(REPO_ROOT, "evals", "fixtures", "enrichment-demo-store-predicted.json");
const RUNS_DIR = join(REPO_ROOT, "evals", "runs");
const PROJECT = "demo_store";
const COLLECTION = "products";

interface GoldFile {
  version: number;
  products: GoldRow[];
}

// Attribute specs are the framework's baked-in fashion defaults (@samesake/core), not hand-rolled
// here — the scorer only scores attributes a product's gold actually labels.
const ATTRS = fashion.evalAttributes();

async function loadGold(): Promise<GoldFile> {
  return JSON.parse(await readFile(GOLD_PATH, "utf8")) as GoldFile;
}

function pct(n: number): string {
  return (n * 100).toFixed(1).padStart(5) + "%";
}

function renderReport(r: EnrichEvalResult, mode: string): string {
  const lines: string[] = [];
  lines.push(`# Enrichment-accuracy eval (${mode})`);
  lines.push("");
  lines.push(`Corpus: ${PROJECT}/${COLLECTION} — ${r.coverage.gold} gold products, ${r.coverage.matched} matched, ${r.coverage.withEnriched} enriched, ${r.coverage.missing} missing.`);
  lines.push(`Status breakdown: ${JSON.stringify(r.coverage.byStatus)}`);
  lines.push("");
  lines.push("| attribute | precision | recall | F1 | TP | FP | FN | support | scored |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const a of r.attributes) {
    lines.push(
      `| ${a.attribute} | ${pct(a.precision)} | ${pct(a.recall)} | ${pct(a.f1)} | ${a.tp} | ${a.fp} | ${a.fn} | ${a.support} | ${a.scored} |`
    );
  }
  lines.push(
    `| **overall (micro)** | ${pct(r.overall.microPrecision)} | ${pct(r.overall.microRecall)} | ${pct(r.overall.microF1)} | | | | | |`
  );
  lines.push(`| **macro F1** | | | ${pct(r.overall.macroF1)} | | | | | |`);
  lines.push("");
  if (r.diffs.length) {
    lines.push(`## Disagreements (${r.diffs.length} products)`);
    lines.push("");
    for (const d of r.diffs) {
      const errs = d.errors
        .map((e) => `${e.attribute}: gold=[${e.gold}] pred=[${e.predicted}]${e.missed.length ? ` missed=[${e.missed}]` : ""}${e.hallucinated.length ? ` extra=[${e.hallucinated}]` : ""}`)
        .join("; ");
      lines.push(`- **${d.id}** (${d.status}) ${d.title ?? ""}\n  - ${errs}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

async function writeArtifacts(r: EnrichEvalResult, mode: string): Promise<string> {
  await mkdir(RUNS_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const base = join(RUNS_DIR, `${ts}-enrichment-${mode}`);
  await writeFile(`${base}.json`, JSON.stringify({ mode, project: PROJECT, collection: COLLECTION, ...r }, null, 2) + "\n");
  const md = renderReport(r, mode);
  await writeFile(`${base}.md`, md + "\n");
  return md;
}

async function runFixture(): Promise<void> {
  const gold = await loadGold();
  const fixture = JSON.parse(await readFile(FIXTURE_PATH, "utf8")) as {
    products: Array<{ id: string; title?: string; pipeline_status?: string; gate_reason?: string | null; enriched: Record<string, unknown> | null }>;
  };
  const predicted: PredictedRow[] = fixture.products.map((p) => ({
    id: p.id,
    enriched: p.enriched,
    pipeline_status: p.pipeline_status,
    gate_reason: p.gate_reason ?? null,
  }));
  const r = scoreEnrichment(gold.products, predicted, ATTRS);
  console.log(await writeArtifacts(r, "fixture"));
}

async function runReal(): Promise<void> {
  const { createFashionMatcher } = await import("./samesake.config.ts");
  const gold = await loadGold();
  const matcher = createFashionMatcher();
  await matcher.migrate();
  // evaluateEnrichment reads an already-enriched, already-registered corpus — it does NOT re-apply
  // or re-migrate the collection (that would risk a destructive DDL change on the curated seed).
  // The demo store is registered by its seed (see datasets/demo-store-seed.sql).
  const r = await matcher.evaluateEnrichment(PROJECT, COLLECTION, { gold: gold.products, attributes: ATTRS });
  console.log(await writeArtifacts(r, "live"));
  await matcher.close();
}

async function runBootstrap(inputPath?: string): Promise<void> {
  // Emit a blank gold template ({id, title, labels:{}}) so a new corpus can be labeled. Reads an
  // array of {id, title} or {id, data:{title}} — defaults to the demo fixture.
  const path = inputPath ?? FIXTURE_PATH;
  const raw = JSON.parse(await readFile(path, "utf8"));
  const rows: Array<Record<string, unknown>> = Array.isArray(raw) ? raw : raw.products ?? [];
  const template = {
    version: 1,
    notes: "Blank gold template — fill each product's labels with enum values, then score with eval-enrichment.ts.",
    attributes_scored: { category: "single", gender: "single", colors: "multi", pattern: "single", is_apparel_product: "single" },
    products: rows.map((p) => ({
      id: String(p.id),
      title: (p.title as string) ?? ((p.data as Record<string, unknown>)?.title as string) ?? "",
      labels: {},
    })),
  };
  const out = join(REPO_ROOT, "evals", "golden-enrichment.template.json");
  await writeFile(out, JSON.stringify(template, null, 2) + "\n");
  console.log(`wrote blank gold template (${template.products.length} products) → ${out}`);
}

const args = process.argv.slice(2);
if (args.includes("--bootstrap")) {
  const i = args.indexOf("--bootstrap");
  await runBootstrap(args[i + 1] && !args[i + 1]!.startsWith("--") ? args[i + 1] : undefined);
} else if (args.includes("--fixture")) {
  await runFixture();
} else {
  await runReal();
}
