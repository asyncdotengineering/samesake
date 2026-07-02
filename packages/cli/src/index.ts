// @samesake/cli — thin wrapper over the matcher.
// Most commands resolve to a single fetch() against ${SAMESAKE_URL}.
// `migrate` is the exception — it talks to Postgres directly via
// @samesake/server's prepareMigrations(), so you can run it as a deploy
// step BEFORE the matcher service is up.
// Shebang is added by tsup at build time (banner: { js: "#!/usr/bin/env node" })
// so it lives only in dist/ — not duplicated when running from source.
import { createMatcher, prepareMigrations, indicPhonetic } from "@samesake/server";
import type { EmbedFn } from "@samesake/server";

/** Built-in phonetic provider when a config declares phonetic entities (dev/serve convenience). */
function phoneticOpt(project: { entities?: ReadonlyArray<{ phonetic?: Record<string, unknown> }> }): { phonetic?: typeof indicPhonetic } {
  return (project.entities ?? []).some((e) => e.phonetic && Object.keys(e.phonetic).length > 0)
    ? { phonetic: indicPhonetic }
    : {};
}
import type { CollectionDef, EntityDef, ProjectConfig } from "@samesake/core";
import { loadProjectConfig } from "./config-loader.ts";
import { readFileSync, existsSync, writeFileSync, watch } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { MatchResult } from "@samesake/core";

// ── Server response shapes ──────────────────────────────────────────────
interface ApplyResponse {
  schema: string;
  appliedStatements: number;
  entities: string[];
  collections?: string[];
  plan?: {
    additions: string[];
    reindexRequired: string[];
    destructive: string[];
    notes: string[];
  };
  dryRun?: boolean;
}
interface SeedResponse {
  ids: string[];
}
interface ErrorBody {
  error?: string;
  message?: string;
}
interface ProjectSummary {
  slug: string;
  schemaName: string;
  entities: string[];
  createdAt: string;
  updatedAt: string;
}
interface ListProjectsResponse {
  projects: ProjectSummary[];
}
interface HealthzResponse {
  status: string;
  postgres: string | null;
  extensions: string[];
  uptime_seconds: number;
}
interface ExplainResponse {
  query: { text: string; normalised: string };
  candidate: { entityId: string; name: string };
  scores: {
    cosSim: { value: number | null; weight: number; contribution: number };
    trgmSim: { value: number; weight: number; contribution: number };
    phonEq: { value: boolean; weight: number; contribution: number };
    phoneEq: { value: boolean; weight: number; contribution: number };
    aliasHit: { value: boolean; weight: number; contribution: number };
  };
  combined: number;
  decision: "auto-link" | "suggest" | "below-threshold";
  decisiveChannels: string[];
  thresholds: { autoLink: number; suggest: number };
}
interface CalibrateResponse {
  threshold: number;
  f1: number;
  precision: number;
  recall: number;
  sampleSize: number;
  positives: number;
  negatives: number;
  curve: Array<{ threshold: number; f1: number; precision: number; recall: number }>;
}
interface DuplicatesResponse {
  clusters: Array<{
    representative: { entityId: string; name: string };
    members: Array<{ entityId: string; name: string }>;
    totalCount: number;
    estimatedConfidence: number;
  }>;
}
interface VariantsResponse {
  suggestions: Array<{
    proposedBase: { brand: string | null; itemCanonical: string; suggestedName: string };
    detectedAxes: Array<{ axis: "size" | "variant"; distinctValues: string[] }>;
    members: Array<{
      entityId: string;
      name: string;
      variant: string | null;
      size: { value: number | null; unit: string | null };
    }>;
    totalCount: number;
  }>;
}

// ── Globals ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const cmd = args[0];

const URL = process.env.SAMESAKE_URL ?? "http://localhost:3030";
const KEY = process.env.SAMESAKE_API_KEY ?? "dev-key-please-change";
const PROJECT = process.env.SAMESAKE_PROJECT;

function header(): Record<string, string> {
  return { Authorization: `Bearer ${KEY}` };
}

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

// ── Flag parsing ────────────────────────────────────────────────────────
function parseFlags(rest: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) {
        out[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = rest[i + 1];
        if (next && !next.startsWith("--")) {
          out[a.slice(2)] = next;
          i++;
        } else {
          out[a.slice(2)] = "true";
        }
      }
    }
  }
  return out;
}

/** --scope k=v --scope k2=v2 → { k: v, k2: v2 } */
function parseScopeArgs(rest: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--scope" || a.startsWith("--scope=")) {
      const v = a.startsWith("--scope=") ? a.slice("--scope=".length) : rest[++i];
      if (v && v.includes("=")) {
        const [k, val] = v.split("=", 2);
        if (k && val !== undefined) out[k] = val;
      }
    }
  }
  return out;
}

// ── HTTP helpers ────────────────────────────────────────────────────────
async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${URL}${path}`, { headers: header() });
  const body = await r.json();
  if (!r.ok) fail(`GET ${path} failed: ${JSON.stringify(body)}`);
  return body as T;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${URL}${path}`, {
    method: "POST",
    headers: { ...header(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const resp = await r.json();
  if (!r.ok) fail(`POST ${path} failed: ${JSON.stringify(resp)}`);
  return resp as T;
}

async function del<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${URL}${path}`, {
    method: "DELETE",
    headers: { ...header(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const resp = await r.json();
  if (!r.ok) fail(`DELETE ${path} failed: ${JSON.stringify(resp)}`);
  return resp as T;
}

// ── Commands ────────────────────────────────────────────────────────────
async function cmdHelp(): Promise<void> {
  console.log(`
samesake — commerce search and entity resolution CLI

USAGE
  samesake <command> [options]

PROJECT LIFECYCLE
  init           --name=NAME [--out=PATH]                Scaffold a new samesake.config.ts
  apply          --project=NAME --config=PATH            Apply schema to a project
  list-projects                                          List every applied project
  seed           --project=NAME --file=PATH              Load JSON test data

MATCHING & FEEDBACK
  match          --project=NAME --kind=K --text=T --scope k=v
                 [--limit=N] [--json]                    Run a single match
  explain        --project=NAME --kind=K --query-text=T --candidate-id=ID
                 --scope k=v [--phone=P] [--json]        Per-channel scoring breakdown
  confirm        --project=NAME --kind=K --query-text=T --chosen=ID --scope k=v
                                                         Mark a candidate as correct (writes alias)
  decline        --project=NAME --kind=K --query-text=T --declined=ID --scope k=v
                                                         Mark a candidate as wrong (penalty)

ANALYSIS
  calibrate      --project=NAME --kind=K --scope k=v [--min-sample=N] [--json]
                                                         F1-optimise the auto-link threshold
  duplicates     --project=NAME [--kind=K] [--scope k=v]
                 [--score-floor=0.95] [--min-cluster=2] [--limit=100] [--json]
                                                         List dedup clusters
  variants       --project=NAME [--kind=K] [--scope k=v]
                 [--min-cluster=3] [--limit=50] [--json]
                                                         List variant suggestions (parse-shape only)

DEV & EVAL
  dev            --config=PATH --project=NAME [--port=8788]
                                                         Load config, migrate+apply, serve matcher on port, watch+re-apply on change
  eval           --golden=FILE --project=NAME --collection=COL [--base=URL]
                                                         Run golden queries against search (retrieval only — no LLM judge)

OPERATIONS
  healthz                                                Check matcher health
  doctor                                                 Full env + service + projects health report
  migrate        --db=URL [--schema=public]              Apply system DDL directly to Postgres (no matcher needed).
                                                         Run BEFORE booting the app — the prisma-migrate-deploy /
                                                         drizzle-kit-push pattern. Idempotent, safe in CI.
  migrate        --project=NAME --config=PATH --plan     Show collection schema migration plan (dry-run).
  migrate        --project=NAME --config=PATH --apply    Apply collection schema migrations.
                 [--allow-destructive] [--db=URL]

SEARCH PIPELINE
  ingest         --project=NAME --collection=COL          Pull configured sources into collection
  enrich         --project=NAME --collection=COL          Run enrichment pipeline on pending docs
                 [--concurrency=N] [--limit=N]
  index          --project=NAME --collection=COL          Embed + populate filter columns
  remove         --project=NAME --collection=COL --ids=ID1,ID2
                                                          Delete documents by id
  search-explain --project=NAME --collection=COL --q=QUERY [--json]
                                                          Per-channel search ranking breakdown
  calibrate-search --project=NAME --collection=COL --queries=FILE.json [--limit=N] [--json]
                                                          Sweep mode/weight configs on graded relevance
                                                          (labels in FILE, else the LLM judges) → recommend
  rotate-key     --project=NAME                             Issue a new per-project API key (master only)
  review-list    --project=NAME --collection=COL [--limit=20] [--max-confidence=0.7]
                                                          List low-confidence enrichments for review
  review-correct --project=NAME --collection=COL --id=DOC --field=value [...]
                                                          Apply human corrections (arrays comma-separated)
                 [--limit=N]

GLOBAL ENV
  SAMESAKE_URL              (default http://localhost:3030)
  SAMESAKE_API_KEY          (default dev-key-please-change)
  SAMESAKE_PROJECT          default --project for every command
  SAMESAKE_DATABASE_URL     used by 'migrate' if --db is omitted
  SAMESAKE_SCHEMA           used by 'migrate' if --schema is omitted (default "public")

EXAMPLES
  # Deploy pipeline: migrate first, then start the app.
  samesake migrate --db=$SAMESAKE_DATABASE_URL --schema=public
  bun apps/matcher/src/index.ts &

  # Author + use a project
  samesake init --name=mystore --out=./samesake.config.ts
  samesake apply --project=hello --config=examples/hello/samesake.config.ts
  samesake seed --project=hello --file=examples/hello/seed.json
  samesake match --project=hello --kind=customer --text="Smyth" --scope tenantId=acme
  samesake explain --project=hello --kind=customer --query-text=Smyth --candidate-id=1 --scope tenantId=acme
  samesake calibrate --project=hello --kind=customer --scope tenantId=acme
  samesake doctor
`);
}

async function cmdHealthz(): Promise<void> {
  const r = await fetch(`${URL}/v1/healthz`);
  const body = await r.json();
  console.log(JSON.stringify(body, null, 2));
}

async function cmdApply(flags: Record<string, string>): Promise<void> {
  const project = flags.project ?? PROJECT ?? fail("--project is required");
  const configPath = flags.config ?? fail("--config is required");
  const config = await loadProjectConfig(configPath);

  console.log(
    `Applying ${config.entities.length} entit${config.entities.length === 1 ? "y" : "ies"} and ` +
      `${config.collections.length} collection${config.collections.length === 1 ? "" : "s"} to project '${project}'...`
  );
  const body = await post<ApplyResponse>(`/v1/projects/${project}/schema/apply`, {
    entities: config.entities,
    collections: config.collections,
  });
  console.log(`✓ Applied schema to ${body.schema}`);
  console.log(`  - ${body.appliedStatements} DDL statements`);
  console.log(`  - entities: ${body.entities.join(", ") || "(none)"}`);
  console.log(`  - collections: ${(body.collections ?? []).join(", ") || "(none)"}`);
}

async function cmdSeed(flags: Record<string, string>): Promise<void> {
  const project = flags.project ?? PROJECT ?? fail("--project is required");
  const file = flags.file ?? fail("--file is required");
  const abs = resolve(file);
  if (!existsSync(abs)) fail(`file not found: ${abs}`);
  const data = JSON.parse(readFileSync(abs, "utf8")) as {
    entityType: string;
    items: Array<{ id?: string; scope: Record<string, string>; data: Record<string, unknown> }>;
  };
  console.log(`Seeding ${data.items.length} ${data.entityType} into '${project}'...`);
  const start = Date.now();
  const body = await post<SeedResponse>(
    `/v1/projects/${project}/entities/${data.entityType}/upsert-batch`,
    { items: data.items }
  );
  const dur = ((Date.now() - start) / 1000).toFixed(2);
  console.log(`✓ ${body.ids.length} rows seeded in ${dur}s`);
}

async function cmdMatch(flags: Record<string, string>, rest: string[]): Promise<void> {
  const project = flags.project ?? PROJECT ?? fail("--project is required");
  const kind = flags.kind ?? fail("--kind is required");
  const text = flags.text ?? fail("--text is required");
  const scope = parseScopeArgs(rest);
  const limit = flags.limit ? Number(flags.limit) : 5;

  const m = await post<MatchResult>(`/v1/projects/${project}/match`, {
    kind, text, scope, opts: { limit },
  });

  if (flags.json === "true") {
    console.log(JSON.stringify(m, null, 2));
    return;
  }

  console.log(`Top ${m.candidates.length} candidates for "${text}" (scope: ${JSON.stringify(scope)})`);
  console.log("");
  for (let i = 0; i < m.candidates.length; i++) {
    const c = m.candidates[i]!;
    const name = c.name.length > 36 ? c.name.slice(0, 33) + "..." : c.name;
    console.log(
      `  ${i + 1}. [id=${c.entityId.padStart(3)}] ${name.padEnd(36)}  combined: ${c.combined.toFixed(3)}` +
        `   cos: ${c.components.cosSim?.toFixed(2) ?? "  --"}` +
        `   trgm: ${c.components.trgmSim.toFixed(2)}` +
        `   phon: ${c.components.phonEq ? "✓" : "·"}` +
        `   alias: ${c.components.aliasHit ? "✓" : "·"}`
    );
  }
  if (m.resolved) {
    console.log("");
    console.log(`Resolved: ${m.resolved.entityId} (auto-link, confidence ${m.resolved.confidence.toFixed(3)})`);
  }
}

async function cmdExplain(flags: Record<string, string>, rest: string[]): Promise<void> {
  const project = flags.project ?? PROJECT ?? fail("--project is required");
  const kind = flags.kind ?? fail("--kind is required");
  const queryText = flags["query-text"] ?? flags.text ?? fail("--query-text is required");
  const candidateId = flags["candidate-id"] ?? flags.candidate ?? fail("--candidate-id is required");
  const scope = parseScopeArgs(rest);
  const phone = flags.phone;

  const r = await post<ExplainResponse>(`/v1/projects/${project}/explain`, {
    kind, queryText, candidateId, scope, phone,
  });

  if (flags.json === "true") {
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  console.log(`Query:     "${r.query.text}"  →  normalised "${r.query.normalised}"`);
  console.log(`Candidate: ${r.candidate.name} (id=${r.candidate.entityId})`);
  console.log("");
  console.log(`Channel        Value          Weight   Contribution`);
  console.log(`────────────   ────────────   ──────   ────────────`);
  const fmt = (v: number | boolean | null): string => {
    if (v === null) return "(null)";
    if (typeof v === "boolean") return v ? "true" : "false";
    return v.toFixed(3);
  };
  const row = (label: string, s: { value: number | boolean | null; weight: number; contribution: number }): void => {
    console.log(`${label.padEnd(14)} ${fmt(s.value).padEnd(14)} ${s.weight.toFixed(2).padEnd(8)} ${s.contribution.toFixed(3)}`);
  };
  row("cosine", r.scores.cosSim);
  row("trigram", r.scores.trgmSim);
  row("phonetic-eq", r.scores.phonEq);
  row("phone-exact", r.scores.phoneEq);
  row("alias-hit", r.scores.aliasHit);
  console.log("");
  console.log(`Combined:  ${r.combined.toFixed(3)}`);
  console.log(`Decision:  ${r.decision}   (auto-link ≥ ${r.thresholds.autoLink}, suggest ≥ ${r.thresholds.suggest})`);
  if (r.decisiveChannels.length > 0) {
    console.log(`Decisive channels: ${r.decisiveChannels.join(", ")}`);
  }
}

async function cmdConfirm(flags: Record<string, string>, rest: string[]): Promise<void> {
  const project = flags.project ?? PROJECT ?? fail("--project is required");
  const kind = flags.kind ?? fail("--kind is required");
  const queryText = flags["query-text"] ?? flags.text ?? fail("--query-text is required");
  const chosen = flags.chosen ?? null;
  const scope = parseScopeArgs(rest);

  const body = await post<{ ok: boolean }>(`/v1/projects/${project}/confirm`, {
    kind, queryText, scope, chosenEntityId: chosen,
  });
  console.log(`✓ ${JSON.stringify(body)}`);
}

async function cmdDecline(flags: Record<string, string>, rest: string[]): Promise<void> {
  const project = flags.project ?? PROJECT ?? fail("--project is required");
  const kind = flags.kind ?? fail("--kind is required");
  const queryText = flags["query-text"] ?? flags.text ?? fail("--query-text is required");
  const declined = flags.declined ?? flags.declinedId ?? fail("--declined=ID is required");
  const scope = parseScopeArgs(rest);

  const body = await post<{ ok: boolean }>(`/v1/projects/${project}/decline`, {
    kind, queryText, scope, declinedEntityId: declined,
  });
  console.log(`✓ ${JSON.stringify(body)}`);
}

async function cmdCalibrate(flags: Record<string, string>, rest: string[]): Promise<void> {
  const project = flags.project ?? PROJECT ?? fail("--project is required");
  const kind = flags.kind ?? fail("--kind is required");
  const scope = parseScopeArgs(rest);
  const minSampleSize = flags["min-sample"] ? Number(flags["min-sample"]) : undefined;

  const r = await post<CalibrateResponse>(`/v1/projects/${project}/calibrate`, {
    kind, scope, minSampleSize,
  });

  if (flags.json === "true") {
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  console.log(`Calibrated auto-link threshold for ${kind} @ ${JSON.stringify(scope)}`);
  console.log("");
  console.log(`  threshold:    ${r.threshold.toFixed(3)}`);
  console.log(`  F1:           ${r.f1.toFixed(3)}`);
  console.log(`  precision:    ${r.precision.toFixed(3)}`);
  console.log(`  recall:       ${r.recall.toFixed(3)}`);
  console.log(`  sample size:  ${r.sampleSize}  (${r.positives} positives, ${r.negatives} negatives)`);
}

async function cmdDuplicates(flags: Record<string, string>, rest: string[]): Promise<void> {
  const project = flags.project ?? PROJECT ?? fail("--project is required");
  const kind = flags.kind ?? "customer";
  const scope = parseScopeArgs(rest);
  const params = new URLSearchParams();
  params.set("kind", kind);
  if (Object.keys(scope).length > 0) params.set("scope", JSON.stringify(scope));
  if (flags["score-floor"]) params.set("scoreFloor", flags["score-floor"]);
  if (flags["min-cluster"]) params.set("minClusterSize", flags["min-cluster"]);
  if (flags.limit) params.set("limit", flags.limit);

  const r = await get<DuplicatesResponse>(`/v1/projects/${project}/duplicates?${params.toString()}`);

  if (flags.json === "true") {
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  if (r.clusters.length === 0) {
    console.log("No duplicate clusters above floor.");
    return;
  }
  console.log(`${r.clusters.length} cluster${r.clusters.length === 1 ? "" : "s"} for ${kind}:`);
  for (const c of r.clusters) {
    console.log(`\n  cluster (n=${c.totalCount}, min-score=${c.estimatedConfidence.toFixed(3)})`);
    for (const m of c.members) {
      console.log(`    [id=${m.entityId.padStart(3)}] ${m.name}`);
    }
  }
}

async function cmdVariants(flags: Record<string, string>, rest: string[]): Promise<void> {
  const project = flags.project ?? PROJECT ?? fail("--project is required");
  const kind = flags.kind ?? "asset";
  const scope = parseScopeArgs(rest);
  const params = new URLSearchParams();
  params.set("kind", kind);
  if (Object.keys(scope).length > 0) params.set("scope", JSON.stringify(scope));
  if (flags["min-cluster"]) params.set("minClusterSize", flags["min-cluster"]);
  if (flags.limit) params.set("limit", flags.limit);

  const r = await get<VariantsResponse>(`/v1/projects/${project}/variant-suggestions?${params.toString()}`);

  if (flags.json === "true") {
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  if (r.suggestions.length === 0) {
    console.log("No variant suggestions. (Only parse-shape entities produce these.)");
    return;
  }
  console.log(`${r.suggestions.length} variant suggestion${r.suggestions.length === 1 ? "" : "s"}:`);
  for (const s of r.suggestions) {
    console.log(`\n  ${s.proposedBase.suggestedName}  (${s.totalCount} members)`);
    const axes = s.detectedAxes.map((a) => `${a.axis}:[${a.distinctValues.join(",")}]`).join("  ");
    if (axes) console.log(`    axes:    ${axes}`);
    for (const m of s.members) {
      const sz = m.size.value !== null ? `${m.size.value}${m.size.unit ?? ""}` : "";
      console.log(`    [id=${m.entityId.padStart(3)}] ${m.name.padEnd(40)}  variant=${m.variant ?? "·"}  size=${sz || "·"}`);
    }
  }
}

async function cmdListProjects(flags: Record<string, string>): Promise<void> {
  const r = await get<ListProjectsResponse>(`/v1/projects`);
  if (flags.json === "true") {
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  if (r.projects.length === 0) {
    console.log("No projects applied yet. Use `samesake apply` to create one.");
    return;
  }
  console.log(`${r.projects.length} project${r.projects.length === 1 ? "" : "s"} applied:`);
  for (const p of r.projects) {
    const date = p.updatedAt.slice(0, 10);
    const ents = p.entities.length > 0 ? p.entities.join(", ") : "(no entities)";
    console.log(`  ${p.slug.padEnd(24)} ${date}   ${p.entities.length} entit${p.entities.length === 1 ? "y" : "ies"}: ${ents}`);
  }
}

async function cmdSearchExplain(flags: Record<string, string>): Promise<void> {
  const project = flags.project ?? PROJECT ?? fail("--project is required");
  const collection = flags.collection ?? fail("--collection is required");
  const q = flags.q ?? fail("--q is required");
  const body = await post<Record<string, unknown>>(
    `/v1/projects/${project}/collections/${collection}/search/explain`,
    { q, limit: flags.limit ? Number(flags.limit) : undefined }
  );
  if (flags.json === "true") {
    console.log(JSON.stringify(body, null, 2));
    return;
  }
  console.log(`explain: ${q}`);
  const docs = (body.docs as Array<Record<string, unknown>>) ?? [];
  for (const d of docs.slice(0, 10)) {
    console.log(
      `  id=${d.id} rrf=${Number(d.rrf_score).toFixed(4)} fts=${d.fts_rank ?? "·"} cos=${d.cosine_rank ?? "·"} spc=${d.spaces_rank ?? "·"}`
    );
  }
}

async function cmdCalibrateSearch(flags: Record<string, string>): Promise<void> {
  const project = flags.project ?? PROJECT ?? fail("--project is required");
  const collection = flags.collection ?? fail("--collection is required");
  const file = flags.queries ?? fail('--queries <file.json> is required: [{"q":"...","relevant":{"id":3}}, ...] (relevant optional → LLM judges)');
  const queries = JSON.parse(await Bun.file(file).text()) as unknown[];
  const body = await post<{
    recommended: { name: string };
    results: Array<{ config: string; ndcg: number; gradeAt: number; judged: number }>;
  }>(`/v1/projects/${project}/collections/${collection}/search/calibrate`, {
    queries,
    limit: flags.limit ? Number(flags.limit) : undefined,
  });
  if (flags.json === "true") {
    console.log(JSON.stringify(body, null, 2));
    return;
  }
  console.log(`recommended config: ${body.recommended.name}`);
  for (const r of body.results) {
    console.log(`  ${r.config.padEnd(10)} nDCG@5=${r.ndcg.toFixed(3)} grade@5=${r.gradeAt.toFixed(2)} judged=${r.judged}`);
  }
}

async function cmdRotateKey(flags: Record<string, string>): Promise<void> {
  const project = flags.project ?? PROJECT ?? fail("--project is required");
  const body = await post<{ apiKey: string }>(`/v1/projects/${project}/rotate-key`, {});
  console.log(body.apiKey);
}

async function cmdIngest(flags: Record<string, string>): Promise<void> {
  const project = flags.project ?? PROJECT ?? fail("--project is required");
  const collection = flags.collection ?? fail("--collection is required");
  const body = await post<{ upserted: number; connectors?: string[] }>(
    `/v1/projects/${project}/collections/${collection}/ingest`,
    {}
  );
  console.log(`✓ ingested ${body.upserted} documents${body.connectors ? ` from ${body.connectors.join(", ")}` : ""}`);
}

async function cmdEnrich(flags: Record<string, string>): Promise<void> {
  const project = flags.project ?? PROJECT ?? fail("--project is required");
  const collection = flags.collection ?? fail("--collection is required");
  const body = await post<{ enriched: number; skipped: number; failed: number }>(
    `/v1/projects/${project}/collections/${collection}/enrich`,
    {
      concurrency: flags.concurrency ? Number(flags.concurrency) : undefined,
      limit: flags.limit ? Number(flags.limit) : undefined,
    }
  );
  console.log(`✓ enriched ${body.enriched} (skipped ${body.skipped}, failed ${body.failed})`);
}

async function cmdReviewList(flags: Record<string, string>): Promise<void> {
  const project = flags.project ?? PROJECT ?? fail("--project is required");
  const collection = flags.collection ?? fail("--collection is required");
  const qs = new URLSearchParams();
  if (flags.limit) qs.set("limit", flags.limit);
  if (flags["max-confidence"]) qs.set("max_confidence", flags["max-confidence"]);
  const rows = await get<
    { id: string; title: string | null; category: string | null; confidence: number | null; uncertain_fields: string[]; corrected: boolean }[]
  >(`/v1/projects/${project}/collections/${collection}/review?${qs}`);
  if (!rows.length) {
    console.log("no low-confidence enrichments — nothing to review");
    return;
  }
  for (const r of rows) {
    const conf = r.confidence == null ? " n/a" : r.confidence.toFixed(2);
    const unc = r.uncertain_fields.length ? ` uncertain: ${r.uncertain_fields.join(",")}` : "";
    console.log(`${r.id.padEnd(10)} conf=${conf} ${String(r.category).padEnd(12)} ${(r.title ?? "").slice(0, 50)}${unc}${r.corrected ? " [corrected]" : ""}`);
  }
}

async function cmdReviewCorrect(flags: Record<string, string>): Promise<void> {
  const project = flags.project ?? PROJECT ?? fail("--project is required");
  const collection = flags.collection ?? fail("--collection is required");
  const id = flags.id ?? fail("--id is required");
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(flags)) {
    if (["project", "collection", "id"].includes(k)) continue;
    fields[k] = v.includes(",") ? v.split(",").map((x) => x.trim()) : v;
  }
  if (!Object.keys(fields).length) fail("supply corrections as --field=value (arrays comma-separated)");
  const body = await post<{ corrected: string[] }>(
    `/v1/projects/${project}/collections/${collection}/review/${id}`,
    { fields }
  );
  console.log(`✓ corrected ${body.corrected.join(", ")} on ${id} (doc re-indexes on next \`index\` run)`);
}

async function cmdRemove(flags: Record<string, string>): Promise<void> {
  const project = flags.project ?? PROJECT ?? fail("--project is required");
  const collection = flags.collection ?? fail("--collection is required");
  const ids = (flags.ids ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!ids.length) fail("--ids is required (comma-separated document ids)");
  const body = await del<{ removed: number }>(
    `/v1/projects/${project}/collections/${collection}/documents`,
    { ids }
  );
  console.log(`✓ removed ${body.removed} document${body.removed === 1 ? "" : "s"}`);
}

async function cmdIndex(flags: Record<string, string>): Promise<void> {
  const project = flags.project ?? PROJECT ?? fail("--project is required");
  const collection = flags.collection ?? fail("--collection is required");
  const body = await post<{ indexed: number }>(
    `/v1/projects/${project}/collections/${collection}/index`,
    { limit: flags.limit ? Number(flags.limit) : undefined }
  );
  console.log(`✓ indexed ${body.indexed} documents`);
}

function stubDevEmbed(text: string | undefined, dim: number): number[] {
  const t = text ?? "";
  const out = new Array(dim).fill(0);
  for (let i = 0; i < t.length; i++) {
    out[i % dim] = (out[i % dim]! + t.charCodeAt(i) * 0.001) % 1;
  }
  const norm = Math.sqrt(out.reduce((s, x) => s + x * x, 0)) || 1;
  return out.map((x) => x / norm);
}

async function resolveDevEmbed(configPath: string): Promise<EmbedFn> {
  const abs = resolve(configPath);
  const mod = await import(pathToFileURL(abs).href);
  const direct = mod.embed ?? mod.embedFn;
  if (typeof direct === "function") return direct as EmbedFn;

  const stubPath = join(dirname(abs), "stub-embed.ts");
  if (existsSync(stubPath)) {
    const stubMod = await import(pathToFileURL(stubPath).href);
    if (typeof stubMod.stubEmbed === "function") {
      return async ({ text, dim }) => stubMod.stubEmbed(text ?? "", dim);
    }
  }

  return async ({ text, dim }) => stubDevEmbed(text, dim);
}

async function applyDevConfig(
  matcher: ReturnType<typeof createMatcher>,
  project: string,
  config: ProjectConfig,
  label: string
): Promise<void> {
  const dry = await matcher.apply(project, config, { dryRun: true });
  console.log(`[dev] migration plan (${label}):`);
  console.log(JSON.stringify(dry.plan, null, 2));
  const applied = await matcher.apply(project, config, { dryRun: false });
  console.log(`[dev] applied ${applied.appliedStatements} statements → ${applied.schema}`);
}

async function cmdDev(flags: Record<string, string>): Promise<void> {
  const configPath = flags.config ?? fail("--config is required");
  const project = flags.project ?? PROJECT ?? fail("--project is required");
  const port = flags.port ? Number(flags.port) : 8788;
  const databaseUrl =
    flags.db ?? process.env.SAMESAKE_DATABASE_URL;
  if (!databaseUrl) fail("SAMESAKE_DATABASE_URL required (or --db=)");

  const configAbs = resolve(configPath);
  const embed = await resolveDevEmbed(configPath);
  const config = await loadProjectConfig(configPath);
  const matcher = createMatcher({
    databaseUrl,
    apiKey: flags["api-key"] ?? KEY,
    embed,
    migrate: "eager",
    ...phoneticOpt(config.project),
  });

  await matcher.migrate();
  await applyDevConfig(matcher, project, config.project, "boot");

  const server = Bun.serve({
    port,
    fetch: matcher.fetch,
  });
  console.log(`[dev] listening on http://localhost:${port} (project=${project})`);
  console.log(`[dev] watching ${configAbs}`);

  const configBase = basename(configAbs);
  let debounce: ReturnType<typeof setTimeout> | null = null;
  const scheduleReapply = (): void => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(async () => {
      try {
        console.log("[dev] config changed — re-applying...");
        const next = await loadProjectConfig(configPath);
        await applyDevConfig(matcher, project, next.project, "watch");
      } catch (e) {
        console.error(`[dev] re-apply failed: ${e instanceof Error ? e.message : e}`);
      }
    }, 300);
  };
  if (typeof Bun !== "undefined" && "watch" in Bun && typeof Bun.watch === "function") {
    Bun.watch(configAbs, { persistent: true }, () => scheduleReapply());
  } else {
    watch(dirname(configAbs), (_event, filename) => {
      if (filename === configBase) scheduleReapply();
    });
  }

  process.on("SIGINT", async () => {
    server.stop();
    await matcher.close();
    process.exit(0);
  });
  await new Promise(() => {});
}

interface GoldenQuery {
  id: string;
  query: string;
  type?: string;
}

interface GoldenFile {
  queries: GoldenQuery[];
}

async function cmdEval(flags: Record<string, string>): Promise<void> {
  const goldenPath = flags.golden ?? fail("--golden is required");
  const base = (flags.base ?? URL).replace(/\/$/, "");
  const project = flags.project ?? PROJECT ?? fail("--project is required");
  const collection = flags.collection ?? fail("--collection is required");
  const apiKey = flags["api-key"] ?? KEY;

  const abs = resolve(goldenPath);
  if (!existsSync(abs)) fail(`golden file not found: ${abs}`);
  const golden = JSON.parse(readFileSync(abs, "utf8")) as GoldenFile;
  if (!golden.queries?.length) fail("golden file has no queries");

  console.log(`eval: ${golden.queries.length} queries → ${base}/v1/projects/${project}/collections/${collection}/search`);
  console.log("");
  console.log(`${"id".padEnd(12)} ${"ms".padStart(6)} ${"hits".padStart(5)}  top`);
  console.log(`${"─".repeat(12)} ${"─".repeat(6)} ${"─".repeat(5)}  ${"─".repeat(24)}`);

  for (const gq of golden.queries) {
    const url = `${base}/v1/projects/${project}/collections/${collection}/search?q=${encodeURIComponent(gq.query)}&limit=10`;
    const start = Date.now();
    const r = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    const ms = Date.now() - start;
    if (!r.ok) {
      const body = await r.text();
      fail(`query ${gq.id} failed (${r.status}): ${body.slice(0, 200)}`);
    }
    const body = (await r.json()) as { hits?: Array<{ id?: string; title?: string }> };
    const hits = body.hits ?? [];
    const top = hits[0]?.title ?? hits[0]?.id ?? "—";
    console.log(`${gq.id.padEnd(12)} ${String(ms).padStart(6)} ${String(hits.length).padStart(5)}  ${String(top).slice(0, 40)}`);
  }

  console.log("");
  console.log("Retrieval only — no LLM judge. Graded evals (ESCI, mean@10) belong in your consumer harness.");
  console.log("Reference: docs/context/spike/eval-search.js");
}

async function cmdMigrate(flags: Record<string, string>): Promise<void> {
  const project = flags.project ?? PROJECT;
  const configPath = flags.config;
  const isProjectMigrate = !!(project && configPath && (flags.plan === "true" || flags.apply === "true"));

  if (isProjectMigrate) {
    const databaseUrl =
      flags.db ?? process.env.SAMESAKE_DATABASE_URL;
    if (!databaseUrl) {
      fail("--db=postgres://... required (or set SAMESAKE_DATABASE_URL)");
    }
    const dryRun = flags.apply !== "true";
    const config = await loadProjectConfig(configPath!);
    const matcher = createMatcher({
      databaseUrl,
      apiKey: flags["api-key"] ?? KEY,
      migrate: "eager",
      embed: async () => [0],
      ...phoneticOpt(config.project),
    });
    await matcher.migrate();
    const r = await matcher.apply(project!, config.project, {
      dryRun,
      allowDestructive: flags["allow-destructive"] === "true",
    });
    await matcher.close();
    console.log(JSON.stringify({ schema: r.schema, dryRun: r.dryRun ?? dryRun, plan: r.plan, appliedStatements: r.appliedStatements }, null, 2));
    if (!dryRun) {
      console.log(`✓ applied ${r.appliedStatements} statements to ${r.schema}`);
    }
    return;
  }

  const databaseUrl = flags.db ?? process.env.SAMESAKE_DATABASE_URL;
  if (!databaseUrl) {
    fail("--db=postgres://... required (or set SAMESAKE_DATABASE_URL)");
  }
  const schema = flags.schema ?? process.env.SAMESAKE_SCHEMA ?? "public";
  console.log(`Applying samesake system DDL to schema '${schema}'...`);
  const start = Date.now();
  await prepareMigrations({ databaseUrl, schema });
  console.log(`✓ migrations applied in ${Date.now() - start}ms`);
}

async function cmdDoctor(): Promise<void> {
  console.log("samesake doctor\n");

  // Environment
  console.log("Environment:");
  console.log(`  SAMESAKE_URL       ${URL}`);
  console.log(`  SAMESAKE_API_KEY   ${process.env.SAMESAKE_API_KEY ? "set" : "MISSING (using default — set it for production)"}`);
  console.log(`  SAMESAKE_PROJECT   ${PROJECT ?? "(unset)"}\n`);

  // Matcher health
  console.log("Matcher health:");
  try {
    const h = await get<HealthzResponse>("/v1/healthz");
    console.log(`  Status:            ${h.status}`);
    console.log(`  Postgres:          ${(h.postgres ?? "?").split(",")[0]}`);
    console.log(`  Extensions:        ${h.extensions.join(", ") || "(none)"}`);
    console.log(`  Uptime:            ${h.uptime_seconds}s\n`);
  } catch (e) {
    console.log(`  ✗ Could not reach matcher at ${URL}`);
    console.log(`    ${e instanceof Error ? e.message : e}\n`);
    return;
  }

  // Projects
  try {
    const r = await get<ListProjectsResponse>("/v1/projects");
    console.log(`Projects applied: ${r.projects.length}`);
    for (const p of r.projects) {
      console.log(`  - ${p.slug.padEnd(24)} (${p.entities.length} entit${p.entities.length === 1 ? "y" : "ies"})`);
    }
  } catch (e) {
    console.log(`  ✗ Could not list projects: ${e instanceof Error ? e.message : e}`);
  }
}

const INIT_TEMPLATE = (name: string): string => `// samesake.config.ts — entities for project '${name}'.
//
// Apply via:
//   bunx samesake apply --project=${name} --config=./samesake.config.ts
import { entity, fields, Scorers } from "@samesake/core";

export const customer = entity("customer", {
  fields: {
    name: fields.text({ required: true }),
    phone: fields.text({ optional: true }),
  },
  scopes: ["tenantId"],
  embeddings: {
    name_emb: { source: "name", model: "gemini-embedding-001", dim: 768 },
  },
  phonetic: {
    name_phon: { source: "name", algorithm: "indic-soundex" },
  },
  scoring: {
    channels: [
      Scorers.phoneExact({ field: "phone", weight: 1.0 }),
      Scorers.cosine({ embedding: "name_emb", weight: 0.6 }),
      Scorers.trigram({ field: "name", weight: 0.25, latinOnlyPartial: true }),
      Scorers.aliasHit({ weight: 0.4 }),
      Scorers.phoneticEq({ phonetic: "name_phon", weight: 0.2 }),
    ],
  },
});
`;

async function cmdInit(flags: Record<string, string>): Promise<void> {
  const name = flags.name ?? fail("--name is required (e.g. --name=mystore)");
  if (!/^[a-z][a-z0-9_-]{0,62}$/i.test(name)) {
    fail(`invalid project name: ${name} (must match /^[a-z][a-z0-9_-]+$/)`);
  }
  const out = resolve(flags.out ?? "./samesake.config.ts");
  if (existsSync(out) && flags.force !== "true") {
    fail(`${out} already exists — pass --force to overwrite`);
  }
  writeFileSync(out, INIT_TEMPLATE(name));
  console.log(`✓ Wrote ${out}`);
  console.log(`\nNext steps:`);
  console.log(`  1. Review ${out}`);
  console.log(`  2. samesake apply --project=${name} --config=${out}`);
  console.log(`  3. samesake seed --project=${name} --file=seed.json`);
}

async function main(): Promise<void> {
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    await cmdHelp();
    return;
  }
  const rest = args.slice(1);
  const flags = parseFlags(rest);
  switch (cmd) {
    case "healthz": await cmdHealthz(); break;
    case "doctor": await cmdDoctor(); break;
    case "init": await cmdInit(flags); break;
    case "migrate": await cmdMigrate(flags); break;
    case "apply": await cmdApply(flags); break;
    case "seed": await cmdSeed(flags); break;
    case "list-projects": await cmdListProjects(flags); break;
    case "ingest": await cmdIngest(flags); break;
    case "enrich": await cmdEnrich(flags); break;
    case "index": await cmdIndex(flags); break;
    case "remove": await cmdRemove(flags); break;
    case "search-explain": await cmdSearchExplain(flags); break;
    case "calibrate-search": await cmdCalibrateSearch(flags); break;
    case "rotate-key": await cmdRotateKey(flags); break;
    case "review-list": await cmdReviewList(flags); break;
    case "review-correct": await cmdReviewCorrect(flags); break;
    case "match": await cmdMatch(flags, rest); break;
    case "explain": await cmdExplain(flags, rest); break;
    case "confirm": await cmdConfirm(flags, rest); break;
    case "decline": await cmdDecline(flags, rest); break;
    case "calibrate": await cmdCalibrate(flags, rest); break;
    case "duplicates": await cmdDuplicates(flags, rest); break;
    case "variants": await cmdVariants(flags, rest); break;
    case "dev": await cmdDev(flags); break;
    case "eval": await cmdEval(flags); break;
    default:
      fail(`unknown command: ${cmd}. try 'samesake help'`);
  }
}

await main();
