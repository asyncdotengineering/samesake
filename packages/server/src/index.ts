// Public entry for @samesake/server v0.2.
//
// v0.2 is the createMatcher(config) factory: consumers pass the db handle
// (or databaseUrl), apiKey, an `embed` function, and (optionally) a `parse`
// function. The matcher returns a Matcher object with function-level methods
// + a Web-standard fetch handler + the underlying Hono app.
//
// No module-level env reads. No bundled AI provider SDKs. The matcher has
// zero opinions about which LLM stack the consumer uses — bring your own
// embed/parse functions via createMatcher's config.
export { createMatcher, type Matcher } from "./createMatcher.ts";
// Opt-in phonetic matching: pass `phonetic: indicPhonetic` (or your own PhoneticProvider).
export { indicPhonetic, type PhoneticProvider } from "./db/postgres/phonetic.ts";
export type {
  MatcherConfig,
  MatcherCtx,
  ApplyResult,
  ApplyInput,
  // The BYO-AI function contracts — consumers import these to type their
  // embed / parse closures.
  EmbedFn,
  EmbedRequest,
  ParseFn,
  ParseRequest,
  GenerateFn,
  GenerateRequest,
  RerankFn,
  RerankRequest,
  RerankCandidate,
  GroundImageFn,
  GroundImageRequest,
  GroundImageResult,
  MigrationPlan,
  ApplyOptions,
  LoggerFn,
  LoggerEvent,
  MetricsSnapshot,
  PolicyConfig,
  PolicySlot,
} from "./types.ts";
export type { SearchExplainResult, ExplainDocBreakdown, SearchOpts } from "./core/search.ts";
export type { FacetResult, FacetCountResult, FacetRangeResult, FacetBucket } from "./db/postgres/facets.ts";
export type {
  SearchEvalQuery,
  SearchEvalConfig,
  SearchEvalResult,
  CalibrateResult,
} from "./core/calibrate-search.ts";
export type {
  EvalOpts,
  EvalResult,
  GoldenQuery,
  MetricKey,
  PerQuery,
} from "./core/eval/run.ts";
export type {
  RelevanceJudge,
  JudgedHit,
  FacetGrades,
} from "./core/eval/judge.ts";
export { makeLlmJudge, candidateSummary, FASHION_JUDGE_SYSTEM } from "./core/eval/judge.ts";
export { fashionRerank } from "./core/rerank.ts";
export type { RerankBlendWeights } from "./core/rerank.ts";
export { DEFAULT_RERANK_BLEND_WEIGHTS } from "./core/rerank.ts";
export { calibrateJudge, isJudgeTrusted } from "./core/eval/calibrate.ts";
export {
  ndcgAtK,
  mrr,
  hitAtK,
  nullRate,
  constraintViolations,
} from "./core/eval/metrics.ts";
export {
  agentToolDescriptors,
  agentToolsOpenApi,
  agentFindProductsRequestSchema,
  agentFindProductsResponseSchema,
} from "./core/agent-tools.ts";
export type { FashionCatalogSyncEvent } from "./core/fashion-search.ts";

// Parse schema + default prompt — exported so consumers can:
//   1. Type their parse function's return value against ParsedProduct
//   2. Reuse the default product-parse system prompt as a base when writing
//      their own per-entity instructions
//   3. Validate parse-cache contents in their own scripts if needed
export {
  ParsedProductSchema,
  type ParsedProduct,
  DEFAULT_PRODUCT_PARSE_INSTRUCTIONS,
} from "./core/parse.ts";

// DDL emitter — pure utility, useful for consumers that maintain their own
// pgTable declarations and want consistent DDL emission across their schema
// and the matcher's.
export { tableToDDL, tablesToDDL } from "./db/ddl.ts";

// Connection helper — exposed for consumers using the standalone runner
// pattern who want to build their Drizzle handle the same way the matcher
// would have, then pass it as `db` to createMatcher.
export { createDbFromUrl, asJsonb } from "./db/client.ts";

// ── Standalone migrations ───────────────────────────────────────────────
// Apply samesake's system DDL without constructing a full matcher. Use
// this from a CI script or a deploy step BEFORE the app starts up — the
// "run migrations before booting" pattern Prisma / Drizzle Kit / Rails
// already use.
//
//   import { prepareMigrations } from "@samesake/server";
//   await prepareMigrations({ databaseUrl: process.env.DB_URL });
//
// Idempotent — safe to run on every deploy. Uses the same getSystemDDL()
// as createMatcher's lazy/eager migration paths; one source of truth.
export { prepareMigrations } from "./prepare-migrations.ts";

export {
  shopifyFeedConnector,
  shopifyFeedFromJson,
  shopifyFeedFromFile,
} from "./connectors/shopify.ts";
export {
  wooStoreFeedConnector,
  wooFeedFromJson,
  wooFeedFromFile,
} from "./connectors/woocommerce.ts";
export { jsonlFeedConnector, jsonlFeedFromLines } from "./connectors/jsonl.ts";
export type { PullConnector } from "./connectors/index.ts";
export {
  normalizeShopify,
  normalizeWoo,
  computeContentHash,
} from "./connectors/normalize.ts";
