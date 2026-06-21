// createMatcher(config) — the public factory.
//
// Composes the service factories (projects, schema-gen, embed, parse, match,
// calibrate, explain, variants, upsert) bound to a single consumer-supplied
// MatcherCtx, builds the Hono app on top, and returns a Matcher object with
// THREE surfaces:
//
//   1. Function-level methods (matcher.match(...), matcher.confirm(...))
//      — in-process consumers, no HTTP overhead.
//
//   2. Web-standard fetch handler (matcher.fetch(request))
//      — universal HTTP mount across Bun/Node/CF Workers/Vercel/Deno.
//
//   3. The Hono app (matcher.app) for .route() composition.
//
// The migration story is lazy by default: the first HTTP request awaits
// matcher.migrate() via middleware. Pass migrate:"eager" to start migrations
// during construction (await matcher.migrate() before serving if you need a
// hard startup gate), or migrate:"manual" to skip request-time middleware and
// require an explicit `await matcher.migrate()` or CLI deploy step.
//
// BYO AI (v0.2): config.embed is REQUIRED — the consumer supplies the
// embedding function. config.parse is OPTIONAL; if any entity declares a
// `parse:` block and config.parse is missing, the matcher throws lazily at
// the call site with a clear error message naming the missing config slot.
import { Hono } from "hono";
import type { MatcherConfig, MatcherCtx, ParseFn, GenerateFn } from "./types.ts";
import { createDbFromUrl } from "./db/client.ts";
import { makeSystemTables } from "./db/schema/system.ts";
import { runSystemMigrations } from "./db/migrations.ts";
import { makeSchemaGen } from "./core/schema-gen.ts";
import { makeCollectionsSchemaGen } from "./core/collections-schema-gen.ts";
import { makeProjectsService } from "./core/projects.ts";
import { makeEmbedService } from "./core/embed.ts";
import { makeParseService } from "./core/parse.ts";
import { makeMatchService } from "./core/match.ts";
import { makeSearchService } from "./core/search.ts";
import { makeAgentToolsService } from "./core/agent-tools.ts";
import { makeIngestService } from "./core/ingest.ts";
import { makeEnrichPipelineService } from "./core/enrich-pipeline.ts";
import { makeRevalidateImagesService } from "./core/revalidate-images.ts";
import { makeReviewService } from "./core/review.ts";
import { makeEmbedIndexService } from "./core/embed-index.ts";
import { makeRetryService } from "./core/retry.ts";
import { makeFashionSearchService } from "./core/fashion-search.ts";
import { makeCalibrateService } from "./core/calibrate.ts";
import { makeCalibrateSearchService } from "./core/calibrate-search.ts";
import { makeEvalService } from "./core/eval/run.ts";
import { makeExplainService } from "./core/explain.ts";
import { makeVariantsService } from "./core/variants.ts";
import { makeUpsertService } from "./core/upsert.ts";
import { buildApp } from "./app-builder.ts";
import { inProcessRunner } from "./jobs/in-process.ts";
import { createObservability } from "./core/observability.ts";
import type { MetricsSnapshot } from "./core/observability.ts";
import { resolvePolicy } from "./core/policy.ts";

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/i;

export interface Matcher {
  // Function-level API (in-process, no HTTP)
  match: ReturnType<typeof makeMatchService>["runMatch"];
  matchBatch: ReturnType<typeof makeMatchService>["runMatchBatch"];
  confirm: ReturnType<typeof makeMatchService>["runConfirm"];
  decline: ReturnType<typeof makeMatchService>["runDecline"];
  dedup: ReturnType<typeof makeMatchService>["runDedup"];
  setScopeThresholds: ReturnType<typeof makeMatchService>["setScopeThresholds"];
  calibrate: ReturnType<typeof makeCalibrateService>["runCalibrate"];
  explain: ReturnType<typeof makeExplainService>["runExplain"];
  variants: ReturnType<typeof makeVariantsService>["runVariants"];
  apply: ReturnType<typeof makeProjectsService>["applyProject"];
  upsertOne: ReturnType<typeof makeUpsertService>["upsertOne"];
  upsertBatch: ReturnType<typeof makeUpsertService>["upsertBatch"];
  listProjects: ReturnType<typeof makeProjectsService>["listProjects"];
  getProject: ReturnType<typeof makeProjectsService>["getProject"];
  getEntityDef: ReturnType<typeof makeProjectsService>["getEntityDef"];
  getCollectionDef: ReturnType<typeof makeProjectsService>["getCollectionDef"];
  search: ReturnType<typeof makeSearchService>["search"];
  evaluateSearch: ReturnType<typeof makeCalibrateSearchService>["evaluateSearch"];
  calibrateSearch: ReturnType<typeof makeCalibrateSearchService>["calibrateSearch"];
  findProducts: ReturnType<typeof makeAgentToolsService>["findProducts"];
  findSimilarProducts: ReturnType<typeof makeAgentToolsService>["findSimilarProducts"];
  agentToolDescriptors: ReturnType<typeof makeAgentToolsService>["toolDescriptors"];
  agentToolsOpenApi: ReturnType<typeof makeAgentToolsService>["openApi"];
  fashionSearch: ReturnType<typeof makeFashionSearchService>["fashionSearch"];
  syncFashionCatalogEvent: ReturnType<typeof makeFashionSearchService>["syncFashionCatalogEvent"];
  indexDocuments: ReturnType<typeof makeSearchService>["indexDocuments"];
  ingest: ReturnType<typeof makeIngestService>["ingestCollection"];
  pushDocuments: ReturnType<typeof makeIngestService>["upsertDocuments"];
  removeDocuments: ReturnType<typeof makeIngestService>["removeDocuments"];
  enrich: ReturnType<typeof makeEnrichPipelineService>["enrichCollection"];
  reviewList: ReturnType<typeof makeReviewService>["reviewList"];
  reviewCorrect: ReturnType<typeof makeReviewService>["reviewCorrect"];
  index: ReturnType<typeof makeEmbedIndexService>["indexCollection"];
  searchExplain: ReturnType<typeof makeSearchService>["searchExplain"];
  runEval: ReturnType<typeof makeEvalService>["runEval"];
  revalidateImages: ReturnType<typeof makeRevalidateImagesService>["revalidateImages"];
  retryFailed: ReturnType<typeof makeRetryService>["retryFailed"];
  metrics: () => MetricsSnapshot;
  rotateProjectKey: ReturnType<typeof makeProjectsService>["rotateProjectKey"];

  // Universal HTTP fetch handler — drop into Bun.serve, CF Workers, Vercel,
  // Deno, or mount via Hono's `.route()` (use .app for the Hono instance).
  fetch: (request: Request) => Promise<Response>;

  // Hono app for composition.
  app: Hono;

  // Lifecycle
  migrate: () => Promise<void>;
  close: () => Promise<void>;
}

/**
 * Default `parse` function — fires only when an entity actually tries to use
 * parse. Names the missing config slot AND shows the recipe inline.
 */
const defaultParse: ParseFn = async () => {
  throw new Error(
    "createMatcher's `parse` is not configured, but an entity declared a `parse:` block.\n\n" +
    "Wire it up by providing a function that calls your LLM with the schema + instructions:\n\n" +
    "  import { createMatcher } from \"@samesake/server\";\n" +
    "  import { generateObject } from \"ai\";\n" +
    "  import { google } from \"@ai-sdk/google\";\n\n" +
    "  const matcher = createMatcher({\n" +
    "    /* ...db, apiKey, embed... */\n" +
    "    parse: async ({ text, schema, instructions, model }) => {\n" +
    "      const { object } = await generateObject({\n" +
    "        model: google.languageModel(model ?? \"gemini-2.5-flash-lite\"),\n" +
    "        schema, system: instructions,\n" +
    "        prompt: `Input: \"${text}\"`, temperature: 0,\n" +
    "      });\n" +
    "      return object;\n" +
    "    },\n" +
    "  });\n\n" +
    "Or, if no entity in your project uses parse, remove the `parse:` block from your entity config."
  );
};

const defaultGenerate: GenerateFn = async () => {
  throw new Error(
    "createMatcher's `generate` is not configured, but a collection declared an `enrich:` pipeline.\n\n" +
      "Wire it up by providing a function that calls your LLM with schema-constrained JSON output:\n\n" +
      "  import { createMatcher } from \"@samesake/server\";\n\n" +
      "  const matcher = createMatcher({\n" +
      "    /* ...db, apiKey, embed... */\n" +
      "    generate: async ({ model, prompt, images, schema }) => {\n" +
      "      // call your LLM with responseSchema\n" +
      "      return parsedJson;\n" +
      "    },\n" +
      "  });\n\n" +
      "Or remove the `enrich:` block from collections that do not need enrichment."
  );
};

export function createMatcher(config: MatcherConfig): Matcher {
  // Resolve the db handle.
  if (!config.db && !config.databaseUrl) {
    throw new Error("createMatcher: provide either `db` (Drizzle handle) or `databaseUrl` (connection string)");
  }
  if (config.db && config.databaseUrl) {
    throw new Error("createMatcher: provide only ONE of `db` or `databaseUrl`, not both");
  }

  if (typeof config.embed !== "function") {
    throw new Error(
      "createMatcher: `embed` is required.\n\n" +
      "Provide a function that turns text into a vector. Example using Vercel AI SDK + Gemini:\n\n" +
      "  import { embed } from \"ai\";\n" +
      "  import { google } from \"@ai-sdk/google\";\n\n" +
      "  createMatcher({\n" +
      "    /* ...db, apiKey... */\n" +
      "    embed: async ({ text, model, dim, taskType }) => {\n" +
      "      const { embedding } = await embed({\n" +
      "        model: google.textEmbedding(model),\n" +
      "        value: text,\n" +
      "        providerOptions: { google: { outputDimensionality: dim,\n" +
      "          taskType: taskType ?? \"SEMANTIC_SIMILARITY\" } },\n" +
      "      });\n" +
      "      return Array.from(embedding);\n" +
      "    },\n" +
      "  });"
    );
  }

  const built = config.databaseUrl
    ? createDbFromUrl(config.databaseUrl)
    : { db: config.db!, close: async () => { /* consumer owns the handle */ } };

  const schema = config.schema ?? "public";
  const projectPrefix = config.projectPrefix ?? "project_";

  if (!IDENT.test(schema)) {
    throw new Error(`createMatcher: invalid schema "${schema}" — must match /^[a-z_][a-z0-9_]+$/i`);
  }
  if (!IDENT.test(projectPrefix)) {
    throw new Error(`createMatcher: invalid projectPrefix "${projectPrefix}" — must match /^[a-z_][a-z0-9_]+$/i`);
  }
  if (!config.apiKey || config.apiKey.length < 8) {
    throw new Error("createMatcher: apiKey is required and must be at least 8 chars");
  }

  const observability = createObservability({ logger: config.logger });

  // Build the ctx. ensureMigrations is wired below after we have it.
  let migrationsPromise: Promise<void> | null = null;
  const ctx: MatcherCtx = {
    db: built.db,
    schema,
    projectPrefix,
    apiKey: config.apiKey,
    embed: config.embed,
    parse: config.parse ?? defaultParse,
    generate: config.generate ?? defaultGenerate,
    generateConfigured: typeof config.generate === "function",
    rerank: config.rerank,
    groundImage: config.groundImage,
    jobs: config.jobs ?? inProcessRunner,
    observability,
    policy: resolvePolicy(config.policy),
    systemTables: makeSystemTables(schema),
    ensureMigrations: () => {
      if (!migrationsPromise) {
        migrationsPromise = runSystemMigrations(ctx).catch((e) => {
          migrationsPromise = null;
          throw e;
        });
      }
      return migrationsPromise;
    },
  };

  // Compose services. Order matters — later services depend on earlier ones.
  const schemaGen = makeSchemaGen({ sys: schema, projectPrefix });
  const collectionsSchemaGen = makeCollectionsSchemaGen({ projectPrefix });
  const projectsService = makeProjectsService(ctx, schemaGen, collectionsSchemaGen);
  const embedService = makeEmbedService(ctx);
  const parseService = makeParseService(ctx);
  const matchService = makeMatchService(ctx, embedService, parseService, projectsService, schemaGen);
  const searchService = makeSearchService(ctx, embedService, projectsService);
  const calibrateSearchService = makeCalibrateSearchService(ctx, searchService);
  const evalService = makeEvalService(ctx, searchService);
  const agentToolsService = makeAgentToolsService(ctx, projectsService, searchService);
  const ingestService = makeIngestService(ctx, projectsService);
  const fashionSearchService = makeFashionSearchService(ctx, projectsService, searchService, ingestService);
  const enrichService = makeEnrichPipelineService(ctx, projectsService);
  const revalidateImagesService = makeRevalidateImagesService(ctx, projectsService);
  const reviewService = makeReviewService(ctx, projectsService);
  const embedIndexService = makeEmbedIndexService(ctx, embedService, projectsService);
  const retryService = makeRetryService(ctx, projectsService, enrichService, embedIndexService);
  const calibrateService = makeCalibrateService(ctx, schemaGen);
  const explainService = makeExplainService(ctx, embedService, projectsService, schemaGen);
  const variantsService = makeVariantsService(ctx, projectsService, schemaGen);
  const upsertService = makeUpsertService(ctx, embedService, parseService, schemaGen);

  // Build the Hono app on top of the function-level services.
  const app = buildApp({
    apiKey: config.apiKey,
    ensureMigrations: ctx.ensureMigrations,
    runMigrationsOnRequest: config.migrate !== "manual",
    observability,
    services: {
      match: matchService,
      search: searchService,
      calibrateSearch: calibrateSearchService,
      agentTools: agentToolsService,
      fashionSearch: fashionSearchService,
      ingest: ingestService,
      enrich: enrichService,
      review: reviewService,
      embedIndex: embedIndexService,
      calibrate: calibrateService,
      explain: explainService,
      variants: variantsService,
      upsert: upsertService,
      projects: projectsService,
    },
    db: built.db,
  });

  // migrate() respects the config.migrate mode.
  const migrate = ctx.ensureMigrations;

  // Eager mode: trigger migrations now. Callers that need a hard startup gate
  // can await matcher.migrate(), which observes the same promise.
  if (config.migrate === "eager") {
    void migrate();
  }

  return {
    match: matchService.runMatch,
    matchBatch: matchService.runMatchBatch,
    confirm: matchService.runConfirm,
    decline: matchService.runDecline,
    dedup: matchService.runDedup,
    setScopeThresholds: matchService.setScopeThresholds,
    calibrate: calibrateService.runCalibrate,
    explain: explainService.runExplain,
    variants: variantsService.runVariants,
    apply: projectsService.applyProject,
    upsertOne: upsertService.upsertOne,
    upsertBatch: upsertService.upsertBatch,
    listProjects: projectsService.listProjects,
    getProject: projectsService.getProject,
    getEntityDef: projectsService.getEntityDef,
    getCollectionDef: projectsService.getCollectionDef,
    search: searchService.search,
    evaluateSearch: calibrateSearchService.evaluateSearch,
    calibrateSearch: calibrateSearchService.calibrateSearch,
    findProducts: agentToolsService.findProducts,
    findSimilarProducts: agentToolsService.findSimilarProducts,
    agentToolDescriptors: agentToolsService.toolDescriptors,
    agentToolsOpenApi: agentToolsService.openApi,
    fashionSearch: fashionSearchService.fashionSearch,
    syncFashionCatalogEvent: fashionSearchService.syncFashionCatalogEvent,
    indexDocuments: searchService.indexDocuments,
    ingest: ingestService.ingestCollection,
    pushDocuments: ingestService.upsertDocuments,
    removeDocuments: ingestService.removeDocuments,
    enrich: enrichService.enrichCollection,
    index: embedIndexService.indexCollection,
    reviewList: reviewService.reviewList,
    reviewCorrect: reviewService.reviewCorrect,
    searchExplain: searchService.searchExplain,
    runEval: evalService.runEval,
    revalidateImages: revalidateImagesService.revalidateImages,
    retryFailed: retryService.retryFailed,
    metrics: () => observability.metrics(),
    rotateProjectKey: projectsService.rotateProjectKey,
    fetch: app.fetch.bind(app) as (request: Request) => Promise<Response>,
    app,
    migrate,
    close: built.close,
  };
}
