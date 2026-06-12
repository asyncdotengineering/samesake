// Public + internal types for @samesake/server's createMatcher factory.
//
// Two surfaces:
//   - MatcherConfig — what the consumer passes to createMatcher(config).
//   - MatcherCtx    — what the internal modules consume. Built from the config.
//
// The split exists because consumers can pass either a Drizzle handle OR a
// database URL; the ctx always has a concrete db handle. Same for defaults:
// schema/prefix get defaults applied; the lazy migrations helper is constructed.
//
// As of v0.2 there are NO bundled AI providers. The consumer brings their own
// `embed` and (optionally) `parse` functions — see EmbedFn / ParseFn below.
// @samesake/server has zero opinions about which LLM stack you use.
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { Hono } from "hono";
import type { EntityDef } from "@samesake/core";
import type { z } from "zod";
import type { makeSystemTables } from "./db/schema/system.ts";
import type { LoggerFn, Observability } from "./core/observability.ts";
import type { PolicyConfig } from "./core/policy.ts";

export type { LoggerFn, LoggerEvent, MetricsSnapshot } from "./core/observability.ts";
export type { PolicyConfig, PolicySlot } from "./core/policy.ts";

// ── BYO AI: the two function contracts ──────────────────────────────────
/**
 * Inputs the matcher gives to the consumer's embed function.
 *   - `text`     — the string to embed (already trimmed / non-empty)
 *   - `model`    — the opaque model identifier from the entity's EmbeddingDef
 *   - `dim`      — the vector dimension the matcher expects back; throw or
 *                  the matcher will detect the mismatch and throw a clear error
 *   - `taskType` — opaque hint from EmbeddingDef.taskType (e.g. Gemini's
 *                  "SEMANTIC_SIMILARITY" / "RETRIEVAL_QUERY"). May be undefined.
 *   - `inputType`— "query" for a match-time query, "document" for an upsert.
 *                  Voyage cares; most providers don't. May be undefined.
 */
export interface EmbedImageInput {
  url?: string;
  bytes?: Uint8Array;
  mimeType?: string;
}

export interface EmbedRequest {
  text?: string;
  image?: EmbedImageInput;
  model: string;
  dim: number;
  taskType?: string;
  inputType?: "query" | "document";
}

export type EmbedFn = (req: EmbedRequest) => Promise<number[]>;

/**
 * Inputs the matcher gives to the consumer's parse function.
 *
 *   - `text`         — the string to parse
 *   - `schema`       — a Zod schema OWNED BY @samesake/server. The consumer's
 *                      function must return an object matching this schema.
 *                      The matcher validates the result on its own end too.
 *   - `instructions` — the system prompt to give the LLM. The matcher passes
 *                      either @samesake/server's default product-parse prompt
 *                      or the per-entity override from ParseDef.instructions.
 *   - `model`        — opaque model identifier from ParseDef.model (may be
 *                      undefined; consumer's function picks a default).
 *
 * The schema is product-specific in v0.2 (ParsedProductSchema). A future
 * release will allow per-entity custom schemas.
 */
export interface ParseRequest {
  text: string;
  schema: z.ZodTypeAny;
  instructions: string;
  model?: string;
}

export type ParseFn = (req: ParseRequest) => Promise<unknown>;

export interface GenerateRequest {
  model?: string;
  system?: string;
  prompt: string;
  images?: { mimeType: string; data: Uint8Array | string }[];
  schema: Record<string, unknown>;
}

export type GenerateFn = (req: GenerateRequest) => Promise<unknown>;

export interface JobRunner {
  run<T>(name: string, payload: unknown, fn: () => Promise<T>): Promise<T>;
}

export interface MigrationPlan {
  additions: string[];
  reindexRequired: string[];
  destructive: string[];
  notes: string[];
}

export interface ApplyOptions {
  allowDestructive?: boolean;
  dryRun?: boolean;
}

// ── What the consumer passes in ─────────────────────────────────────────
export interface MatcherConfig {
  /**
   * Drizzle handle. Provide this when you want the matcher to share your
   * existing DB connection (e.g. inside a CF Workers app where you already
   * have a Hyperdrive/Neon-serverless handle).
   *
   * Mutually exclusive with `databaseUrl`. One of the two is required.
   */
  db?: PostgresJsDatabase;

  /**
   * Postgres connection string. The matcher builds its own postgres-js
   * client + Drizzle handle from this. Use this for the standalone
   * deployment shape; use `db` when mounting inside another app.
   */
  databaseUrl?: string;

  /**
   * API key required by every HTTP route except `/v1/healthz`. Function-level
   * methods (matcher.match(...), etc.) bypass auth — they're trusted
   * in-process callers.
   */
  apiKey: string;

  /**
   * Postgres schema where the matcher's system tables + utility functions
   * live (samesake_projects, samesake_embed_cache, samesake_parse_cache,
   * samesake_normalise(), samesake_phonetic(), samesake_unit()). Default `public`.
   */
  schema?: string;

  /**
   * Prefix for per-project Postgres schemas. Default `project_` →
   * `project_<slug>` for each applied project.
   */
  projectPrefix?: string;

  /**
   * REQUIRED. Function that turns text into a vector. See EmbedFn / EmbedRequest.
   *
   * Examples (copy these into your project as `embedder.ts`):
   *
   *   // Vercel AI SDK + Gemini:
   *   import { embed } from "ai";
   *   import { google } from "@ai-sdk/google";
   *   const embedFn: EmbedFn = async ({ text, model, dim, taskType }) => {
   *     const { embedding } = await embed({
   *       model: google.textEmbedding(model),
   *       value: text,
   *       providerOptions: { google: { outputDimensionality: dim,
   *         taskType: taskType ?? "SEMANTIC_SIMILARITY" } },
   *     });
   *     return Array.from(embedding);
   *   };
   *
   *   // Local Ollama:
   *   const embedFn: EmbedFn = async ({ text, model }) => {
   *     const r = await fetch("http://localhost:11434/api/embeddings", {
   *       method: "POST",
   *       headers: { "Content-Type": "application/json" },
   *       body: JSON.stringify({ model, prompt: text }),
   *     });
   *     const { embedding } = await r.json() as { embedding: number[] };
   *     return embedding;
   *   };
   */
  embed: EmbedFn;

  /**
   * OPTIONAL. Required only when one of your entities declares a `parse:`
   * block (i.e. parse-shape entities like medications / inventory products).
   *
   * If omitted and an entity tries to use parse, the matcher throws a clear
   * "createMatcher's `parse` not configured" error at the call site.
   *
   * Example (Vercel AI SDK + Gemini structured-output):
   *
   *   import { generateObject } from "ai";
   *   import { google } from "@ai-sdk/google";
   *   const parseFn: ParseFn = async ({ text, schema, instructions, model }) => {
   *     const { object } = await generateObject({
   *       model: google.languageModel(model ?? "gemini-2.5-flash-lite"),
   *       schema, system: instructions,
   *       prompt: `Input: "${text}"`, temperature: 0,
   *     });
   *     return object;
   *   };
   */
  parse?: ParseFn;

  /**
   * OPTIONAL. Required when a collection declares an `enrich:` pipeline.
   * Schema-constrained JSON generation for enrichment stages, NLQ, and eval.
   */
  generate?: GenerateFn;

  jobs?: JobRunner;

  logger?: LoggerFn;

  policy?: PolicyConfig;

  /**
   * When to apply system migrations.
   *   - "lazy"  (default) — on the first HTTP request, via app middleware
   *   - "eager"           — synchronously inside createMatcher()
   *   - "manual"          — never automatic; call matcher.migrate() explicitly
   */
  migrate?: "lazy" | "eager" | "manual";
}

// ── What the internal modules consume ───────────────────────────────────
export interface MatcherCtx {
  db: PostgresJsDatabase;
  schema: string;            // system schema (always set; default applied)
  projectPrefix: string;     // per-project schema prefix (always set)
  apiKey: string;
  embed: EmbedFn;
  parse: ParseFn;
  generate: GenerateFn;
  generateConfigured: boolean;
  jobs: JobRunner;
  observability: Observability;
  policy: Required<PolicyConfig>;
  systemTables: ReturnType<typeof makeSystemTables>;
  ensureMigrations: () => Promise<void>;
}

// ── Lifecycle / public-facing matcher object ────────────────────────────
export interface ApplyResult {
  project: string;
  schema: string;
  appliedStatements: number;
  entities: string[];
  collections: string[];
  plan: MigrationPlan;
  dryRun?: boolean;
}

export interface ApplyInput {
  slug: string;
  entities: EntityDef[];
}
