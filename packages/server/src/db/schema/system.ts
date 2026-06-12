// Fluent Drizzle schema for samesake's system tables.
//
// makeSystemTables(schemaName) builds the table set for any schema name —
// `public` (Drizzle's pgTable, since pgSchema("public") throws) or any
// other (pgSchema(name).table). Called once by createMatcher with the
// configured schema; returned tables are bound to that schema for the
// lifetime of the matcher.
//
// Both fluent query API AND DDL (via tableToDDL in src/db/ddl.ts) are
// derived from these declarations.
import { pgTable, pgSchema, text, jsonb, timestamp, index, numeric, customType, serial } from "drizzle-orm/pg-core";

// pgvector column without a fixed dimension. Drizzle's stock `vector(...)`
// requires `dimensions: N`, but our embed cache is heterogeneous-dim across
// providers (768 Gemini, 1024 Voyage, 1536 OpenAI). On the wire we always
// pass the `[0.1,0.2,...]` text form; PostgreSQL casts implicitly. customType
// preserves the `vector` SQL type so existing installs stay consistent.
const vectorAnyDim = customType<{ data: string; driverData: string }>({
  dataType: () => "vector",
});

export function makeSystemTables(schemaName: string) {
  // pgSchema("public") throws by design — public is implicit. tbl() returns
  // the right table factory either way: bare pgTable for public, schema.table
  // otherwise. The cast through unknown unifies PgTableFn<undefined> and
  // PgTableFn<string> (identical runtime contracts, different generic).
  const tbl: typeof pgTable =
    schemaName === "public"
      ? pgTable
      : (pgSchema(schemaName).table as unknown as typeof pgTable);

  const samesakeProjects = tbl("samesake_projects", {
    slug: text("slug").primaryKey(),
    schemaName: text("schema_name").notNull().unique(),
    configHash: text("config_hash"),
    configJson: jsonb("config_json").$type<unknown[]>(),
    apiKey: text("api_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  });

  const samesakeEmbedCache = tbl(
    "samesake_embed_cache",
    {
      cacheKey: text("cache_key").primaryKey(),
      embedding: vectorAnyDim("embedding"),
      model: text("model").notNull(),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    },
    (t) => [index("samesake_embed_cache_exp_idx").on(t.expiresAt)]
  );

  const samesakeParseCache = tbl(
    "samesake_parse_cache",
    {
      cacheKey: text("cache_key").primaryKey(),
      payload: jsonb("payload").notNull(),
      model: text("model").notNull(),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    },
    (t) => [index("samesake_parse_cache_exp_idx").on(t.expiresAt)]
  );

  const samesakeStageCache = tbl(
    "samesake_stage_cache",
    {
      cacheKey: text("cache_key").primaryKey(),
      stageName: text("stage_name").notNull(),
      payload: jsonb("payload").notNull(),
      model: text("model").notNull(),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    },
    (t) => [index("samesake_stage_cache_exp_idx").on(t.expiresAt)]
  );

  const samesakeUnitsAlias = tbl("samesake_units_alias", {
    aliasNorm: text("alias_norm").primaryKey(),
    canonical: text("canonical").notNull(),
    family: text("family").notNull(),
    factorToCanonical: numeric("factor_to_canonical").notNull().default("1"),
  });

  const samesakeCorrections = tbl(
    "samesake_corrections",
    {
      id: serial("id").primaryKey(),
      project: text("project").notNull(),
      collection: text("collection").notNull(),
      docId: text("doc_id").notNull(),
      field: text("field").notNull(),
      oldValue: jsonb("old_value"),
      newValue: jsonb("new_value").notNull(),
      docTitle: text("doc_title"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [index("samesake_corrections_coll_idx").on(t.project, t.collection)]
  );

  return {
    samesakeProjects,
    samesakeEmbedCache,
    samesakeParseCache,
    samesakeStageCache,
    samesakeUnitsAlias,
    samesakeCorrections,
  };
}

export type SystemTables = ReturnType<typeof makeSystemTables>;
