import { eq, desc, sql } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import type { CollectionDef, EntityDef, ProjectConfig } from "@samesake/core";
import type { ApplyOptions, MatcherCtx, MigrationPlan } from "../types.ts";
import type { SchemaGen } from "./schema-gen.ts";
import type { CollectionsSchemaGen } from "./collections-schema-gen.ts";
import { mergeMigrationPlans, planCollectionMigration } from "./collections-migrate.ts";
import { assertIdent, assertNoIdentCollisions } from "@samesake/core";
import { ClientError } from "../errors.ts";
import { sanitiseIdent } from "./schema-gen.ts";
import { collectionTableName, getPgClient } from "./db-utils.ts";
import { normalizeSchema } from "./schema-input.ts";

function validateProjectConfig(config: ProjectConfig): void {
  const entityNames = (config.entities ?? []).map((e) => e.name).filter(Boolean) as string[];
  const collectionNames = (config.collections ?? []).map((c) => c.name).filter(Boolean) as string[];

  assertNoIdentCollisions(entityNames, "entity");
  assertNoIdentCollisions(collectionNames, "collection");

  for (const e of config.entities ?? []) {
    if (!e.name) continue;
    assertIdent(e.name, "entity");
    for (const s of e.scopes ?? []) assertIdent(s, "scope");
    assertNoIdentCollisions(Object.keys(e.fields ?? {}), "field");
    for (const k of Object.keys(e.embeddings ?? {})) assertIdent(k, "embedding");
    for (const k of Object.keys(e.phonetic ?? {})) assertIdent(k, "phonetic");
  }

  for (const c of config.collections ?? []) {
    if (!c.name) continue;
    assertIdent(c.name, "collection");
    assertNoIdentCollisions(Object.keys(c.fields ?? {}), "field");
    for (const k of Object.keys(c.embeddings ?? {})) assertIdent(k, "embedding");
    for (const k of Object.keys(c.spaces ?? {})) assertIdent(k, "space");
  }
}

export interface ProjectSummary {
  slug: string;
  schemaName: string;
  entities: string[];
  collections: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ProjectRow {
  slug: string;
  schema_name: string;
  config_json: ProjectConfig;
}

// nlq.schema may be declared as a zod schema, but a collection's config is
// persisted as JSON and reloaded cross-process at search time. Convert it to
// JSON Schema here — before serialiseConfig / liveCollections — so a zod schema
// survives the round-trip. Enrich stage schemas are functions evaluated
// in-process and are intentionally left untouched.
function normaliseCollectionSchema(c: CollectionDef): CollectionDef {
  const schema = c.search?.nlq?.schema;
  if (!schema) return c;
  return { ...c, search: { ...c.search!, nlq: { ...c.search!.nlq, schema: normalizeSchema(schema) } } };
}

function normaliseConfig(input: EntityDef[] | ProjectConfig): ProjectConfig {
  if (Array.isArray(input)) return { entities: input, collections: [] };
  return {
    entities: input.entities ?? [],
    collections: (input.collections ?? []).map(normaliseCollectionSchema),
  };
}

export function makeProjectsService(
  ctx: MatcherCtx,
  schemaGen: SchemaGen,
  collectionsSchemaGen: CollectionsSchemaGen
) {
  const { db, systemTables } = ctx;
  const projects = systemTables.samesakeProjects;
  const liveCollections = new Map<string, CollectionDef>();
  // Short-TTL cache so a single request's many getProject() sub-calls (resolveProductImage,
  // getCollectionDef, search, explain, loadMetadata) collapse to one SELECT. Invalidated on apply.
  const projectCache = new Map<string, { row: ProjectRow | null; at: number }>();
  const PROJECT_CACHE_TTL_MS = 2_000;

  function collectionKey(projectSlug: string, collectionName: string): string {
    return `${projectSlug}:${collectionName}`;
  }

  function serialiseConfig(config: ProjectConfig): ProjectConfig {
    return JSON.parse(JSON.stringify(config)) as ProjectConfig;
  }

  async function collectionTableExists(schema: string, collectionName: string): Promise<boolean> {
    const table = `c_${sanitiseIdent(collectionName)}`;
    const rows = await getPgClient(db, "projects migration").unsafe(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2 LIMIT 1`,
      [schema, table]
    );
    return rows.length > 0;
  }

  async function applyProject(
    projectSlug: string,
    input: EntityDef[] | ProjectConfig,
    opts?: ApplyOptions
  ): Promise<{
    project: string;
    schema: string;
    appliedStatements: number;
    entities: string[];
    collections: string[];
    plan: MigrationPlan;
    dryRun?: boolean;
  }> {
    const config = normaliseConfig(input);
    try {
      validateProjectConfig(config);
    } catch (e) {
      if (e instanceof Error) {
        throw new ClientError("invalid_identifier", e.message);
      }
      throw e;
    }
    const dryRun = opts?.dryRun ?? false;
    const allowDestructive = opts?.allowDestructive ?? false;

    projectCache.delete(projectSlug); // read fresh existing config, ignore any cached row
    const existing = await getProject(projectSlug);
    const storedCollections = new Map<string, CollectionDef>();
    for (const c of existing?.config_json.collections ?? []) {
      if (c.name) storedCollections.set(c.name, c);
    }

    const { projectSchema, statements: entityStmts } = schemaGen.generateProjectDDL(
      projectSlug,
      config.entities ?? []
    );

    const collectionMigrations = [];
    const createStmts: string[] = [];

    for (const c of config.collections ?? []) {
      if (!c.name) continue;
      const exists = await collectionTableExists(projectSchema, c.name);
      const migration = planCollectionMigration(projectSchema, storedCollections.get(c.name) ?? null, c, exists);
      collectionMigrations.push(migration);
      if (!exists) {
        createStmts.push(...collectionsSchemaGen.generateCollectionsDDL(projectSlug, [c]).statements);
      }
    }

    const plan = mergeMigrationPlans(collectionMigrations);

    if (dryRun) {
      return {
        project: projectSlug,
        schema: projectSchema,
        appliedStatements: 0,
        entities: (config.entities ?? []).map((e) => e.name!),
        collections: (config.collections ?? []).map((c) => c.name!),
        plan,
        dryRun: true,
      };
    }

    if (plan.destructive.length > 0 && !allowDestructive) {
      throw new Error(
        `destructive migration changes require allowDestructive: true:\n` +
          plan.destructive.map((d) => `  - ${d}`).join("\n")
      );
    }

    const statements = [
      ...entityStmts,
      ...createStmts,
      ...collectionMigrations.flatMap((m) => [...m.alterStatements, ...m.backfillStatements]),
      ...(config.collections ?? []).flatMap((c) =>
        c.name ? collectionsSchemaGen.ensureCollectionSystemColumns(projectSchema, c.name, c) : []
      ),
    ];

    for (const stmt of statements) {
      try {
        await db.execute(sql.raw(stmt));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`apply failed on stmt:\n${stmt}\n\nerror: ${msg}`);
      }
    }

    for (const m of collectionMigrations) {
      if (!m.reindex) continue;
      const table = collectionTableName(projectSchema, m.collection);
      await getPgClient(db, "projects migration").unsafe(
        `UPDATE ${table} SET indexed_at = NULL WHERE indexed_at IS NOT NULL`
      );
    }

    const configHash = createHash("sha1").update(JSON.stringify(config)).digest("hex");
    const persisted = serialiseConfig(config);

    for (const c of config.collections ?? []) {
      if (c.name) liveCollections.set(collectionKey(projectSlug, c.name), c);
    }

    await db
      .insert(projects)
      .values({
        slug: projectSlug,
        schemaName: projectSchema,
        configHash,
        configJson: persisted as unknown as unknown[],
      })
      .onConflictDoUpdate({
        target: projects.slug,
        set: {
          schemaName: projectSchema,
          configHash,
          configJson: persisted as unknown as unknown[],
          updatedAt: sql`now()`,
        },
      });

    projectCache.delete(projectSlug); // config changed; force next read from DB

    return {
      project: projectSlug,
      schema: projectSchema,
      appliedStatements: statements.length,
      entities: (config.entities ?? []).map((e) => e.name!),
      collections: (config.collections ?? []).map((c) => c.name!),
      plan,
    };
  }

  async function getProject(slug: string): Promise<ProjectRow | null> {
    const cached = projectCache.get(slug);
    if (cached && Date.now() - cached.at < PROJECT_CACHE_TTL_MS) return cached.row;
    const rows = await db
      .select({ slug: projects.slug, schemaName: projects.schemaName, configJson: projects.configJson })
      .from(projects)
      .where(eq(projects.slug, slug))
      .limit(1);
    const r = rows[0];
    if (!r) {
      projectCache.set(slug, { row: null, at: Date.now() });
      return null;
    }
    const raw = r.configJson as unknown;
    const config: ProjectConfig = Array.isArray(raw)
      ? { entities: raw as EntityDef[], collections: [] }
      : ((raw as ProjectConfig | null) ?? { entities: [], collections: [] });
    const row: ProjectRow = { slug: r.slug, schema_name: r.schemaName, config_json: config };
    projectCache.set(slug, { row, at: Date.now() });
    return row;
  }

  async function getEntityDef(projectSlug: string, entityKind: string): Promise<EntityDef | null> {
    const p = await getProject(projectSlug);
    if (!p) return null;
    return (p.config_json.entities ?? []).find((e) => e.name === entityKind) ?? null;
  }

  async function getCollectionDef(projectSlug: string, collectionName: string): Promise<CollectionDef | null> {
    const live = liveCollections.get(collectionKey(projectSlug, collectionName));
    if (live) return live;
    const p = await getProject(projectSlug);
    if (!p) return null;
    return (p.config_json.collections ?? []).find((c) => c.name === collectionName) ?? null;
  }

  async function getProjectApiKey(slug: string): Promise<string | null> {
    const rows = await db
      .select({ apiKey: projects.apiKey })
      .from(projects)
      .where(eq(projects.slug, slug))
      .limit(1);
    return rows[0]?.apiKey ?? null;
  }

  async function rotateProjectKey(slug: string): Promise<{ apiKey: string }> {
    const existing = await getProject(slug);
    if (!existing) throw new Error(`project "${slug}" not found`);
    const apiKey = `pk_${randomBytes(16).toString("hex")}`;
    await db.update(projects).set({ apiKey, updatedAt: sql`now()` }).where(eq(projects.slug, slug));
    return { apiKey };
  }

  async function listProjects(): Promise<ProjectSummary[]> {
    const rows = await db
      .select({
        slug: projects.slug,
        schemaName: projects.schemaName,
        configJson: projects.configJson,
        createdAt: projects.createdAt,
        updatedAt: projects.updatedAt,
      })
      .from(projects)
      .orderBy(desc(projects.updatedAt));

    return rows.map((r) => {
      const raw = r.configJson as unknown;
      const config: ProjectConfig = Array.isArray(raw)
        ? { entities: raw as EntityDef[], collections: [] }
        : ((raw as ProjectConfig | null) ?? { entities: [], collections: [] });
      return {
        slug: r.slug,
        schemaName: r.schemaName,
        entities: (config.entities ?? []).map((e) => e.name ?? "(unnamed)"),
        collections: (config.collections ?? []).map((c) => c.name ?? "(unnamed)"),
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      };
    });
  }

  return {
    applyProject,
    getProject,
    getEntityDef,
    getCollectionDef,
    listProjects,
    getProjectApiKey,
    rotateProjectKey,
  };
}

export type ProjectsService = ReturnType<typeof makeProjectsService>;
