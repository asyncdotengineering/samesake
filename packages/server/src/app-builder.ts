// Build the Hono app from the matcher's service bundle.
//
// Routes are thin wrappers around the function-level methods: they parse the
// HTTP request via @hono/zod-validator, call the corresponding service
// method, return JSON. The auth middleware reads the apiKey from the ctx
// (closure capture), not from any env var.
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { ClientError } from "./errors.ts";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { EntityDef, ProjectConfig } from "@samesake/core";
import type { MatchService } from "./core/match.ts";
import type { SearchService } from "./core/search.ts";
import type { CalibrateSearchService } from "./core/calibrate-search.ts";
import type { AgentToolsService } from "./core/agent-tools.ts";
import type { FashionSearchService } from "./core/fashion-search.ts";
import type { IngestService } from "./core/ingest.ts";
import type { EnrichPipelineService } from "./core/enrich-pipeline.ts";
import type { ReviewService } from "./core/review.ts";
import type { EmbedIndexService } from "./core/embed-index.ts";
import type { CalibrateService } from "./core/calibrate.ts";
import type { ExplainService } from "./core/explain.ts";
import type { VariantsService } from "./core/variants.ts";
import type { UpsertService } from "./core/upsert.ts";
import type { ProjectsService } from "./core/projects.ts";
import type { Observability } from "./core/observability.ts";

export interface AppDeps {
  apiKey: string;
  ensureMigrations: () => Promise<void>;
  runMigrationsOnRequest?: boolean;
  observability: Observability;
  db: PostgresJsDatabase;
  services: {
    match: MatchService;
    search: SearchService;
    calibrateSearch: CalibrateSearchService;
    agentTools: AgentToolsService;
    fashionSearch: FashionSearchService;
    ingest: IngestService;
    enrich: EnrichPipelineService;
    review: ReviewService;
    embedIndex: EmbedIndexService;
    calibrate: CalibrateService;
    explain: ExplainService;
    variants: VariantsService;
    upsert: UpsertService;
    projects: ProjectsService;
  };
}

// ── Validation schemas (Zod) ────────────────────────────────────────────
const ScopeSchema = z.record(z.string(), z.string());

const ApplyBody = z.object({
  entities: z.array(z.any()).optional(),
  collections: z.array(z.any()).optional(),
  dryRun: z.boolean().optional(),
  allowDestructive: z.boolean().optional(),
});

const UpsertBody = z.object({
  id: z.string().optional(),
  scope: ScopeSchema,
  data: z.record(z.string(), z.unknown()),
});

const UpsertBatchBody = z.object({
  items: z.array(UpsertBody),
});

const MatchBody = z.object({
  kind: z.string(),
  text: z.string().max(500),
  scope: ScopeSchema,
  opts: z.object({
    limit: z.number().optional(),
    phone: z.string().optional(),
  }).optional(),
});

const ConfirmBody = z.object({
  kind: z.string(),
  queryText: z.string(),
  scope: ScopeSchema,
  chosenEntityId: z.union([z.string(), z.null()]),
});

const DeclineBody = z.object({
  kind: z.string(),
  queryText: z.string(),
  scope: ScopeSchema,
  declinedEntityId: z.string(),
});

const CalibrateBody = z.object({
  kind: z.string(),
  scope: ScopeSchema,
  minSampleSize: z.number().optional(),
});

const ExplainBody = z.object({
  kind: z.string(),
  queryText: z.string(),
  candidateId: z.string(),
  scope: ScopeSchema,
  phone: z.string().optional(),
});

const MatchBatchBody = z.object({
  kind: z.string(),
  scope: ScopeSchema,
  queries: z.array(
    z.object({
      queryText: z.string().max(500),
      phone: z.string().optional(),
      ref: z.string().optional(),
    })
  ),
});

function readBearer(c: { req: { header(name: string): string | undefined } }): string {
  const auth = c.req.header("authorization") ?? c.req.header("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    throw new HTTPException(401, { message: "missing Bearer token" });
  }
  return auth.slice("Bearer ".length).trim();
}

export function buildApp(deps: AppDeps): Hono {
  const { apiKey, ensureMigrations, runMigrationsOnRequest = true, observability, db, services } = deps;
  const app = new Hono();

  // Lazy migrations on first request.
  if (runMigrationsOnRequest) {
    app.use("*", async (c, next) => {
      await ensureMigrations();
      await next();
    });
  }

  function requireMasterKey(c: { req: { header(name: string): string | undefined } }): void {
    const provided = readBearer(c);
    if (provided !== apiKey) {
      throw new HTTPException(401, { message: "invalid API key" });
    }
  }

  async function requireProjectKey(
    c: { req: { header(name: string): string | undefined; param(name: string): string } },
    project: string
  ): Promise<void> {
    const provided = readBearer(c);
    if (provided === apiKey) return;
    const projectKey = await services.projects.getProjectApiKey(project);
    if (projectKey && provided === projectKey) return;
    throw new HTTPException(401, { message: "invalid API key" });
  }

  app.get("/v1/healthz", async (c) => {
    const ext = await db.execute<{ extname: string; extversion: string }>(sql`
      SELECT extname, extversion FROM pg_extension
      WHERE extname IN ('vector', 'pg_trgm', 'unaccent', 'fuzzystrmatch')
      ORDER BY extname
    `);
    const ver = await db.execute<{ ver: string }>(sql`SELECT version() AS ver`);
    return c.json({
      status: "ok",
      postgres: ver[0]?.ver ?? null,
      extensions: ext.map((e) => `${e.extname} ${e.extversion}`),
      uptime_seconds: Math.round(process.uptime()),
    });
  });

  app.get("/v1/metrics", async (c) => {
    requireMasterKey(c);
    return c.json(observability.metrics());
  });

  app.get("/v1/projects", async (c) => {
    requireMasterKey(c);
    return c.json({ projects: await services.projects.listProjects() });
  });

  app.post("/v1/projects/:project/schema/apply", zValidator("json", ApplyBody), async (c) => {
    requireMasterKey(c);
    const { project } = c.req.param();
    const body = c.req.valid("json");
    const config: ProjectConfig = {
      entities: (body.entities ?? []) as EntityDef[],
      collections: body.collections ?? [],
    };
    const r = await services.projects.applyProject(project, config, {
      dryRun: body.dryRun,
      allowDestructive: body.allowDestructive,
    });
    return c.json(r);
  });

  const SearchBody = z.object({
    q: z.string().optional(),
    image: z
      .object({
        url: z.string().optional(),
        bytesBase64: z.string().optional(),
        mimeType: z.string().optional(),
      })
      .optional(),
    filters: z.record(z.string(), z.unknown()).optional(),
    weights: z
      .record(
        z.string(),
        z.union([z.number(), z.record(z.string(), z.number())])
      )
      .optional(),
    mode: z.enum(["intent", "similar"]).optional(),
    rerank: z.boolean().optional(),
    diversify: z.boolean().optional(),
    limit: z.number().optional(),
    offset: z.number().optional(),
    facets: z.array(z.string()).optional(),
  });

  const FashionSearchBody = z.object({
    q: z.string().optional(),
    image: z.object({
      url: z.string().optional(),
      bytesBase64: z.string().optional(),
      mimeType: z.string().optional(),
      productId: z.string().optional(),
    }).optional(),
    filters: z.record(z.string(), z.unknown()).optional(),
    weights: z
      .record(
        z.string(),
        z.union([z.number(), z.record(z.string(), z.number())])
      )
      .optional(),
    rankingPolicy: z.record(z.string(), z.unknown()).optional(),
    personalization: z.record(z.string(), z.unknown()).optional(),
    limit: z.number().optional(),
    offset: z.number().optional(),
    debug: z.boolean().optional(),
    explain: z.boolean().optional(),
    recoverNoResults: z.boolean().optional(),
  });

  const FashionSyncBody = z.object({
    type: z.enum([
      "product.upsert",
      "product.delete",
      "variant.upsert",
      "inventory.update",
      "price.update",
      "image.update",
    ]),
    id: z.string(),
    data: z.record(z.string(), z.unknown()).optional(),
    changes: z.record(z.string(), z.unknown()).optional(),
  });

  const AgentImageBody = z.union([
    z.object({ kind: z.literal("url"), url: z.string() }),
    z.object({ kind: z.literal("bytes"), bytesBase64: z.string(), mimeType: z.string().optional() }),
    z.object({ kind: z.literal("product_image"), productId: z.string(), imageField: z.string().optional() }),
  ]);

  const FindProductsBody = z.object({
    intent: z.string().optional(),
    image: AgentImageBody.optional(),
    constraints: z.record(z.string(), z.unknown()).optional(),
    shopperContext: z.record(z.string(), z.unknown()).optional(),
    constraintMode: z.enum(["best_effort", "strict"]).optional(),
    explain: z.boolean().optional(),
    limit: z.number().optional(),
    productId: z.string().optional(),
  });

  const DocumentsBody = z.object({
    documents: z.array(
      z.object({
        id: z.string(),
        data: z.record(z.string(), z.unknown()),
      })
    ),
  });

  app.post("/v1/projects/:project/rotate-key", async (c) => {
    requireMasterKey(c);
    const { project } = c.req.param();
    return c.json(await services.projects.rotateProjectKey(project));
  });

  app.post("/v1/projects/:project/collections/:collection/ingest", async (c) => {
    const { project, collection } = c.req.param();
    await requireProjectKey(c, project);
    return c.json(await services.ingest.ingestCollection(project, collection));
  });

  app.post(
    "/v1/projects/:project/collections/:collection/documents",
    zValidator("json", DocumentsBody),
    async (c) => {
      const { project, collection } = c.req.param();
      await requireProjectKey(c, project);
      const body = c.req.valid("json");
      return c.json(
        await services.ingest.upsertDocuments(project, collection, body.documents)
      );
    }
  );

  app.post("/v1/projects/:project/collections/:collection/enrich", async (c) => {
    const { project, collection } = c.req.param();
    await requireProjectKey(c, project);
    const body = (await c.req.json().catch(() => ({}))) as {
      concurrency?: number;
      limit?: number;
    };
    return c.json(
      await services.enrich.enrichCollection(project, collection, {
        concurrency: body.concurrency,
        limit: body.limit,
      })
    );
  });

  app.get("/v1/projects/:project/collections/:collection/review", async (c) => {
    const { project, collection } = c.req.param();
    await requireProjectKey(c, project);
    const limit = Number(c.req.query("limit") ?? 20);
    const maxConfidence = Number(c.req.query("max_confidence") ?? 0.7);
    return c.json(await services.review.reviewList(project, collection, { limit, maxConfidence }));
  });

  app.post("/v1/projects/:project/collections/:collection/review/:docId", async (c) => {
    const { project, collection, docId } = c.req.param();
    await requireProjectKey(c, project);
    const body = (await c.req.json()) as { fields: Record<string, unknown> };
    return c.json(await services.review.reviewCorrect(project, collection, docId, body.fields ?? {}));
  });

  app.post("/v1/projects/:project/collections/:collection/index", async (c) => {
    const { project, collection } = c.req.param();
    await requireProjectKey(c, project);
    const body = (await c.req.json().catch(() => ({}))) as { limit?: number };
    return c.json(
      await services.embedIndex.indexCollection(project, collection, {
        limit: body.limit,
      })
    );
  });

  app.get("/v1/projects/:project/collections/:collection/search", async (c) => {
    const { project, collection } = c.req.param();
    await requireProjectKey(c, project);
    const q = c.req.query();
    return c.json(
      await services.search.search(project, collection, {
        q: q.q ?? "",
        limit: q.limit ? Number(q.limit) : undefined,
        offset: q.offset ? Number(q.offset) : undefined,
      })
    );
  });

  app.post(
    "/v1/projects/:project/collections/:collection/search",
    zValidator("json", SearchBody),
    async (c) => {
      const { project, collection } = c.req.param();
      await requireProjectKey(c, project);
      const body = c.req.valid("json");
      return c.json(
        await services.search.search(project, collection, {
          q: body.q ?? "",
          image: body.image,
          filters: body.filters as Record<string, import("./core/search.ts").FilterClause> | undefined,
          weights: body.weights as import("./core/search.ts").SearchOpts["weights"],
          mode: body.mode,
          rerank: body.rerank,
          diversify: body.diversify,
          limit: body.limit,
          offset: body.offset,
          facets: body.facets,
        })
      );
    }
  );

  app.post(
    "/v1/projects/:project/collections/:collection/search/explain",
    zValidator("json", SearchBody),
    async (c) => {
      const { project, collection } = c.req.param();
      await requireProjectKey(c, project);
      const body = c.req.valid("json");
      return c.json(
        await services.search.searchExplain(project, collection, {
          q: body.q ?? "",
          image: body.image,
          filters: body.filters as Record<string, import("./core/search.ts").FilterClause> | undefined,
          weights: body.weights as import("./core/search.ts").SearchOpts["weights"],
          mode: body.mode,
          limit: body.limit,
          offset: body.offset,
        })
      );
    }
  );

  // Unbiased self-evaluation + calibration — judge ranking on relevance, not word-overlap.
  const SearchEvalBody = z.object({
    queries: z.array(
      z.object({
        q: z.string().optional(),
        filters: z.record(z.string(), z.unknown()).optional(),
        relevant: z.record(z.string(), z.number()).optional(),
      })
    ),
    limit: z.number().optional(),
  });

  app.post(
    "/v1/projects/:project/collections/:collection/search/evaluate",
    zValidator("json", SearchEvalBody.extend({ config: z.object({ name: z.string(), mode: z.enum(["intent", "similar"]).optional(), weights: z.record(z.string(), z.union([z.number(), z.record(z.string(), z.number())])).optional() }).optional() })),
    async (c) => {
      const { project, collection } = c.req.param();
      await requireProjectKey(c, project);
      const body = c.req.valid("json");
      return c.json(
        await services.calibrateSearch.evaluateSearch(project, collection, {
          queries: body.queries as Parameters<CalibrateSearchService["evaluateSearch"]>[2]["queries"],
          config: body.config as Parameters<CalibrateSearchService["evaluateSearch"]>[2]["config"],
          limit: body.limit,
        })
      );
    }
  );

  app.post(
    "/v1/projects/:project/collections/:collection/search/calibrate",
    zValidator("json", SearchEvalBody),
    async (c) => {
      const { project, collection } = c.req.param();
      await requireProjectKey(c, project);
      const body = c.req.valid("json");
      return c.json(
        await services.calibrateSearch.calibrateSearch(project, collection, {
          queries: body.queries as Parameters<CalibrateSearchService["calibrateSearch"]>[2]["queries"],
          limit: body.limit,
        })
      );
    }
  );

  app.get("/v1/agent-tools/tools.json", async (c) => {
    requireMasterKey(c);
    return c.json({ tools: services.agentTools.toolDescriptors() });
  });

  app.get("/v1/agent-tools/openapi.json", async (c) => {
    requireMasterKey(c);
    return c.json(services.agentTools.openApi());
  });

  app.post(
    "/v1/projects/:project/collections/:collection/agent/find-products",
    zValidator("json", FindProductsBody),
    async (c) => {
      const { project, collection } = c.req.param();
      await requireProjectKey(c, project);
      const body = c.req.valid("json");
      return c.json(await services.agentTools.findProducts(project, collection, body));
    }
  );

  app.post(
    "/v1/projects/:project/collections/:collection/agent/find-similar-products",
    zValidator("json", FindProductsBody),
    async (c) => {
      const { project, collection } = c.req.param();
      await requireProjectKey(c, project);
      const body = c.req.valid("json");
      return c.json(await services.agentTools.findSimilarProducts(project, collection, body));
    }
  );

  app.post(
    "/v1/projects/:project/collections/:collection/fashion-search",
    zValidator("json", FashionSearchBody),
    async (c) => {
      const { project, collection } = c.req.param();
      await requireProjectKey(c, project);
      const body = c.req.valid("json");
      return c.json(
        await services.fashionSearch.fashionSearch(project, collection, body as Parameters<typeof services.fashionSearch.fashionSearch>[2])
      );
    }
  );

  app.post(
    "/v1/projects/:project/collections/:collection/fashion-sync",
    zValidator("json", FashionSyncBody),
    async (c) => {
      const { project, collection } = c.req.param();
      await requireProjectKey(c, project);
      const body = c.req.valid("json");
      return c.json(await services.fashionSearch.syncFashionCatalogEvent(project, collection, body));
    }
  );

  app.get("/v1/projects/:project/schema", async (c) => {
    requireMasterKey(c);
    const { project } = c.req.param();
    const p = await services.projects.getProject(project);
    if (!p) return c.json({ error: "project_not_found" }, 404);
    return c.json(p);
  });

  app.post("/v1/projects/:project/entities/:type/upsert", zValidator("json", UpsertBody), async (c) => {
    await requireProjectKey(c, c.req.param("project"));
    const { project, type } = c.req.param();
    const body = c.req.valid("json");
    const entity = await services.projects.getEntityDef(project, type);
    if (!entity) return c.json({ error: "entity_kind_not_found" }, 404);
    const r = await services.upsert.upsertOne({ project, entity }, body);
    return c.json(r);
  });

  app.post("/v1/projects/:project/entities/:type/upsert-batch", zValidator("json", UpsertBatchBody), async (c) => {
    await requireProjectKey(c, c.req.param("project"));
    const { project, type } = c.req.param();
    const body = c.req.valid("json");
    const entity = await services.projects.getEntityDef(project, type);
    if (!entity) return c.json({ error: "entity_kind_not_found" }, 404);
    const r = await services.upsert.upsertBatch({ project, entity }, body.items);
    return c.json(r);
  });

  app.post("/v1/projects/:project/match", zValidator("json", MatchBody), async (c) => {
    await requireProjectKey(c, c.req.param("project"));
    const { project } = c.req.param();
    const body = c.req.valid("json");
    return c.json(await services.match.runMatch({ project, ...body }));
  });

  app.post("/v1/projects/:project/confirm", zValidator("json", ConfirmBody), async (c) => {
    await requireProjectKey(c, c.req.param("project"));
    const { project } = c.req.param();
    const body = c.req.valid("json");
    return c.json(await services.match.runConfirm({ project, ...body }));
  });

  app.post("/v1/projects/:project/decline", zValidator("json", DeclineBody), async (c) => {
    await requireProjectKey(c, c.req.param("project"));
    const { project } = c.req.param();
    const body = c.req.valid("json");
    return c.json(await services.match.runDecline({ project, ...body }));
  });

  app.post("/v1/projects/:project/calibrate", zValidator("json", CalibrateBody), async (c) => {
    await requireProjectKey(c, c.req.param("project"));
    const { project } = c.req.param();
    const body = c.req.valid("json");
    return c.json(await services.calibrate.runCalibrate({ project, ...body }));
  });

  app.post("/v1/projects/:project/explain", zValidator("json", ExplainBody), async (c) => {
    await requireProjectKey(c, c.req.param("project"));
    const { project } = c.req.param();
    const body = c.req.valid("json");
    return c.json(await services.explain.runExplain({ project, ...body }));
  });

  app.get("/v1/projects/:project/duplicates", async (c) => {
    await requireProjectKey(c, c.req.param("project"));
    const { project } = c.req.param();
    const q = c.req.query();
    const kind = q.kind ?? "customer";
    let scope: Record<string, string>;
    try {
      scope = JSON.parse(q.scope ?? "{}");
    } catch {
      scope = {};
    }
    return c.json(
      await services.match.runDedup({
        project,
        kind,
        scope,
        scoreFloor: q.scoreFloor ? Number(q.scoreFloor) : undefined,
        minClusterSize: q.minClusterSize ? Number(q.minClusterSize) : undefined,
        limit: q.limit ? Number(q.limit) : undefined,
      })
    );
  });

  app.post("/v1/projects/:project/match-batch", zValidator("json", MatchBatchBody), async (c) => {
    await requireProjectKey(c, c.req.param("project"));
    const { project } = c.req.param();
    const body = c.req.valid("json");
    return c.json(await services.match.runMatchBatch({ project, ...body }));
  });

  app.get("/v1/projects/:project/variant-suggestions", async (c) => {
    await requireProjectKey(c, c.req.param("project"));
    const { project } = c.req.param();
    const q = c.req.query();
    const kind = q.kind ?? "asset";
    let scope: Record<string, string>;
    try {
      scope = JSON.parse(q.scope ?? "{}");
    } catch {
      scope = {};
    }
    return c.json(
      await services.variants.runVariants({
        project,
        kind,
        scope,
        minClusterSize: q.minClusterSize ? Number(q.minClusterSize) : undefined,
        limit: q.limit ? Number(q.limit) : undefined,
      })
    );
  });

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: "unauthorized", message: err.message }, err.status);
    }
    if (err instanceof ClientError) {
      return c.json({ error: err.code, message: err.message }, 400);
    }
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: "internal", message: msg }, 500);
  });

  return app;
}
