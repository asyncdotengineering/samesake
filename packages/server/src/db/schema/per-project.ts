// Per-project system tables — same column shape across projects, only the
// schema name varies. pgSchema(runtimeName) handles the dynamic namespace
// while the column types are fully typed at compile time.
//
// Use:
//   const t = perProjectTables(projectSchemaName(slug));
//   await db.select().from(t.matchCandidate).where(eq(t.matchCandidate.queryKind, kind));
//
// Why a factory rather than a top-level export: Drizzle's pgSchema() binds
// the schema name at construction. samesake applies many projects per
// process, each in its own schema, so we build the table set per call.
//
// Both query API (via the returned tables) AND DDL (via tableToDDL in
// src/db/ddl.ts) are derived from these declarations.
//
// What's NOT here:
//   - entity_<kind> and entity_<kind>_match — column list is user-defined
//     at runtime, no way to statically type them; those stay as sql templates.
import {
  pgSchema, bigint, text, jsonb, timestamp, integer, boolean, numeric,
  doublePrecision, index, primaryKey, unique, check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export function perProjectTables(schemaName: string) {
  const s = pgSchema(schemaName);

  const nameAlias = s.table(
    "name_alias",
    {
      id: bigint("id", { mode: "bigint" }).generatedByDefaultAsIdentity().primaryKey(),
      scopeJson: jsonb("scope_json").$type<Record<string, string>>().notNull(),
      entityKind: text("entity_kind").notNull(),
      entityId: bigint("entity_id", { mode: "bigint" }).notNull(),
      alias: text("alias").notNull(),
      aliasNormalised: text("alias_normalised").notNull(),
      source: text("source").notNull(),
      confidence: doublePrecision("confidence"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      unique("name_alias_scope_kind_alias_unique").on(t.scopeJson, t.entityKind, t.aliasNormalised),
      index("name_alias_lookup_idx").on(t.entityKind, t.aliasNormalised),
    ]
  );

  const matchCandidate = s.table(
    "match_candidate",
    {
      id: bigint("id", { mode: "bigint" }).generatedByDefaultAsIdentity().primaryKey(),
      scopeJson: jsonb("scope_json").$type<Record<string, string>>().notNull(),
      queryText: text("query_text").notNull(),
      queryKind: text("query_kind").notNull(),
      sourceTable: text("source_table"),
      sourceId: text("source_id"),
      candidateId: bigint("candidate_id", { mode: "bigint" }).notNull(),
      combinedScore: numeric("combined_score", { precision: 4, scale: 3 }).notNull(),
      cosineScore: numeric("cosine_score", { precision: 4, scale: 3 }),
      trgmScore: numeric("trgm_score", { precision: 4, scale: 3 }),
      phoneticScore: numeric("phonetic_score", { precision: 4, scale: 3 }),
      aliasHit: boolean("alias_hit"),
      phoneEq: boolean("phone_eq"),
      components: jsonb("components").notNull().default({}),
      rankPos: integer("rank_pos").notNull(),
      outcome: text("outcome"),
      outcomeAt: timestamp("outcome_at", { withTimezone: true }),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      check("match_candidate_query_text_len", sql`length(${t.queryText}) <= 500`),
      index("match_candidate_query_idx").on(t.queryText, t.queryKind, t.createdAt),
    ]
  );

  const pairHistory = s.table(
    "pair_history",
    {
      scopeJson: jsonb("scope_json").$type<Record<string, string>>().notNull(),
      entityKind: text("entity_kind").notNull(),
      entityId: bigint("entity_id", { mode: "bigint" }).notNull(),
      aliasNormalised: text("alias_normalised").notNull(),
      confirmCount: integer("confirm_count").notNull().default(0),
      declineCount: integer("decline_count").notNull().default(0),
      lastAt: timestamp("last_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      primaryKey({ columns: [t.scopeJson, t.entityKind, t.entityId, t.aliasNormalised] }),
      index("pair_history_lookup_idx").on(t.entityKind, t.aliasNormalised),
    ]
  );

  const scopeThresholds = s.table(
    "scope_thresholds",
    {
      scopeJson: jsonb("scope_json").$type<Record<string, string>>().notNull(),
      entityKind: text("entity_kind").notNull(),
      autoLinkThreshold: doublePrecision("auto_link_threshold").notNull(),
      suggestThreshold: doublePrecision("suggest_threshold").notNull().default(0.55),
      f1AtThreshold: doublePrecision("f1_at_threshold"),
      precisionAt: doublePrecision("precision_at"),
      recallAt: doublePrecision("recall_at"),
      sampleSize: integer("sample_size"),
      calibratedAt: timestamp("calibrated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [primaryKey({ columns: [t.scopeJson, t.entityKind] })]
  );

  return { nameAlias, matchCandidate, pairHistory, scopeThresholds };
}

export type PerProjectTables = ReturnType<typeof perProjectTables>;
