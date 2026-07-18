import type { CollectionDef, CollectionFieldDef } from "@samesake/core";
import { embeddingColumn, embeddingEntries, embeddingIndexName, evidenceEntries, evidenceTable } from "./aspects.ts";
import { sanitiseIdent } from "./schema-gen.ts";
import { assertIndexableVectorDimension } from "./vector-dim.ts";

export interface CollectionsSchemaGenConfig {
  projectPrefix: string;
  /** Schema holding samesake's utility functions (samesake_normalise, samesake_phonetic_tokens). */
  systemSchema: string;
  /** Whether createMatcher was given a PhoneticProvider (gates search.phonetic collections). */
  hasPhonetic: boolean;
}

const FTS_LANGUAGE = /^[a-z_]{1,63}$/;
const SCOPE_KEY = /^[a-z_][a-z0-9_]{0,60}$/;

/** Validated scope keys for a collection (empty when unscoped). */
export function collectionScopes(c: Pick<CollectionDef, "scopes" | "name" | "fields">): string[] {
  const scopes = c.scopes ?? [];
  for (const key of scopes) {
    if (!SCOPE_KEY.test(key)) {
      throw new Error(
        `collection ${c.name ?? "?"}: invalid scope key "${key}" — must match /^[a-z_][a-z0-9_]*$/`
      );
    }
    if (c.fields && `scope_${key}` in c.fields) {
      throw new Error(
        `collection ${c.name ?? "?"}: declared field "scope_${key}" collides with scope "${key}"`
      );
    }
  }
  return scopes;
}

export function scopeColumn(key: string): string {
  return sanitiseIdent(`scope_${key}`);
}

/** Cluster-id column for a dedup-enabled collection (default "product_group"). */
export function dedupGroupField(c: Pick<CollectionDef, "dedup">): string {
  return c.dedup?.groupField ?? "product_group";
}

const DEDUP_RESERVED = new Set([
  "id",
  "data",
  "enriched",
  "content_hash",
  "doc",
  "rerank_doc",
  "embedding",
  "fts",
  "dedup_score",
  "dedup_checked_at",
]);

/**
 * Validate a collection's `dedup` config against its declared fields/scopes.
 * Throws (naming the offending field) — same discipline as {@link collectionScopes}.
 */
export function validateDedupConfig(c: CollectionDef): void {
  const dedup = c.dedup;
  if (!dedup) return;
  const name = c.name ?? "?";
  const fieldNames = new Set(Object.keys(c.fields ?? {}));
  const scopes = collectionScopes(c);
  const group = dedup.groupField ?? "product_group";

  if (fieldNames.has(group)) {
    throw new Error(`collection ${name}: dedup.groupField "${group}" collides with a declared field`);
  }
  if (scopes.includes(group)) {
    throw new Error(`collection ${name}: dedup.groupField "${group}" collides with scope "${group}"`);
  }
  if (DEDUP_RESERVED.has(group)) {
    throw new Error(`collection ${name}: dedup.groupField "${group}" is a reserved column name`);
  }

  let weighted = 0;
  let exactKeys = 0;
  for (const ch of dedup.channels ?? []) {
    if (ch.kind === "exactKey") {
      exactKeys++;
      if (!fieldNames.has(ch.field)) {
        throw new Error(`collection ${name}: dedup exactKey field "${ch.field}" is not a declared field`);
      }
      const ftype = c.fields[ch.field]?.type;
      if (ftype !== "text" && ftype !== "enum") {
        throw new Error(
          `collection ${name}: dedup exactKey field "${ch.field}" must be a text or enum field (got ${ftype})`
        );
      }
    } else if (ch.kind === "trigram") {
      weighted++;
      if (!fieldNames.has(ch.field)) {
        throw new Error(`collection ${name}: dedup trigram field "${ch.field}" is not a declared field`);
      }
      if (!(ch.weight > 0)) {
        throw new Error(`collection ${name}: dedup trigram weight for "${ch.field}" must be > 0`);
      }
    } else if (ch.kind === "cosine") {
      weighted++;
      if (!(ch.weight > 0)) {
        throw new Error(`collection ${name}: dedup cosine weight must be > 0`);
      }
      if (!c.embeddings || Object.keys(c.embeddings).length === 0) {
        throw new Error(`collection ${name}: dedup cosine channel requires a declared embeddings key`);
      }
    }
  }
  if (weighted === 0 && exactKeys === 0) {
    throw new Error(`collection ${name}: dedup requires at least one weighted channel or one exactKey`);
  }
  if (!(dedup.autoLink > 0 && dedup.autoLink <= 1)) {
    throw new Error(`collection ${name}: dedup.autoLink must be in (0, 1], got ${dedup.autoLink}`);
  }
  if (dedup.suggest !== undefined && !(dedup.suggest > 0 && dedup.suggest <= dedup.autoLink)) {
    throw new Error(
      `collection ${name}: dedup.suggest (${dedup.suggest}) must be in (0, autoLink=${dedup.autoLink}]`
    );
  }
  for (const f of dedup.offerFields ?? []) {
    if (!fieldNames.has(f)) {
      throw new Error(`collection ${name}: dedup.offerFields "${f}" is not a declared field`);
    }
  }
}

/**
 * Additive DDL for a dedup-enabled collection: cluster-state columns, the group
 * btree, a trgm GIN per trigram channel, an exactKey btree (unless the field is
 * already `filterable`), and the suggestions table. All `IF NOT EXISTS`, so it is
 * safe both for a fresh collection and for adding `dedup` to an existing one.
 */
export function dedupDDL(schema: string, collectionName: string, c: CollectionDef): string[] {
  const dedup = c.dedup;
  if (!dedup) return [];
  validateDedupConfig(c);
  const coll = sanitiseIdent(collectionName);
  const table = `${schema}.c_${coll}`;
  const group = sanitiseIdent(dedup.groupField ?? "product_group");

  const stmts: string[] = [
    `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${group} text;`,
    `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS dedup_score real;`,
    `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS dedup_checked_at timestamptz;`,
    `CREATE INDEX IF NOT EXISTS c_${coll}_${group}_idx ON ${table} (${group});`,
  ];

  const filterable = new Set(
    Object.entries(c.fields)
      .filter(([, d]) => d.filterable)
      .map(([k]) => sanitiseIdent(k))
  );
  for (const ch of dedup.channels) {
    if (ch.kind === "trigram") {
      const col = sanitiseIdent(ch.field);
      stmts.push(
        `CREATE INDEX IF NOT EXISTS c_${coll}_${col}_trgm_idx ON ${table} USING gin (${col} gin_trgm_ops);`
      );
    } else if (ch.kind === "exactKey" && !filterable.has(sanitiseIdent(ch.field))) {
      const col = sanitiseIdent(ch.field);
      stmts.push(`CREATE INDEX IF NOT EXISTS c_${coll}_${col}_idx ON ${table} (${col});`);
    }
  }

  stmts.push(
    `CREATE TABLE IF NOT EXISTS ${table}_dedup_suggestions (
      row_id text NOT NULL,
      candidate_group text NOT NULL,
      score real NOT NULL,
      status text NOT NULL DEFAULT 'open',
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (row_id, candidate_group)
    );`
  );
  return stmts;
}

/** The collection's FTS regconfig, validated. Default "english". */
export function ftsLanguage(c: Pick<CollectionDef, "language" | "name">): string {
  const lang = c.language ?? "english";
  if (!FTS_LANGUAGE.test(lang)) {
    throw new Error(
      `collection ${c.name ?? "?"}: invalid language "${lang}" — must match /^[a-z_]+$/ (a Postgres text-search config, e.g. "english", "german", "simple")`
    );
  }
  return lang;
}

function fieldSqlType(def: CollectionFieldDef): string {
  switch (def.type) {
    case "text":
    case "enum":
      return "text";
    case "number":
      return "numeric";
    case "boolean":
      return "boolean";
    case "array":
      return "text[]";
    default:
      return "text";
  }
}

function ftsGeneratedColumnDdl(c: CollectionDef, sys: string): string {
  // Weighted lexical surface: fts_src_a carries title-class text (weight A, ranks
  // above everything else in ts_rank_cd), fts_src carries the rest (weight B).
  // samesake_normalise folds accents/case/punct so "café" ≡ "cafe" in any
  // language; the collection's `language` picks the stemmer.
  const lang = ftsLanguage(c);
  return (
    `fts tsvector GENERATED ALWAYS AS (` +
    `setweight(to_tsvector('${lang}', ${sys}.samesake_normalise(coalesce(fts_src_a, ''))), 'A') || ` +
    `setweight(to_tsvector('${lang}', ${sys}.samesake_normalise(coalesce(fts_src, ''))), 'B')` +
    `) STORED`
  );
}

function ftsPhonColumnDdl(sys: string): string {
  // Cross-script lexical fallback: per-token phonetic codes of the fts sources,
  // matched with the 'simple' config (codes are already language-neutral).
  return (
    `fts_phon tsvector GENERATED ALWAYS AS (` +
    `to_tsvector('simple', ${sys}.samesake_phonetic_tokens(coalesce(fts_src_a, '') || ' ' || coalesce(fts_src, '')))` +
    `) STORED`
  );
}

export function makeCollectionsSchemaGen(config: CollectionsSchemaGenConfig) {
  const PREFIX = config.projectPrefix;
  const SYS = sanitiseIdent(config.systemSchema);

  function assertPhoneticAvailable(c: CollectionDef): boolean {
    if (!c.search?.phonetic) return false;
    if (!config.hasPhonetic) {
      throw new Error(
        `collection ${c.name}: search.phonetic requires a phonetic provider — pass createMatcher({ phonetic: indicPhonetic }) (or your own PhoneticProvider)`
      );
    }
    return true;
  }

  function projectSchemaName(slug: string): string {
    const safe = slug.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
    return `${PREFIX}${safe}`;
  }

  function collectionTableDDL(schema: string, c: CollectionDef): string[] {
    if (!c.name) throw new Error("collection must have a name");
    const coll = sanitiseIdent(c.name);
    const table = `${schema}.c_${coll}`;
    const wantPhon = assertPhoneticAvailable(c);
    const scopes = collectionScopes(c);
    validateDedupConfig(c);

    const fieldCols = [
      ...scopes.map((s) => `  ${scopeColumn(s)} text NOT NULL`),
      ...Object.entries(c.fields).map(([k, def]) => `  ${sanitiseIdent(k)} ${fieldSqlType(def)}`),
    ].join(",\n");

    const embEntries = embeddingEntries(c);
    const embedDim = embEntries.length > 0 ? embEntries[0]![1].dim : 1536;
    for (const [name, def] of embEntries) {
      assertIndexableVectorDimension({
        owner: `collection ${c.name}`,
        field: `embeddings.${name}`,
        dimensions: def.dim,
        columnType: "halfvec",
      });
    }

    const embeddingCols = embEntries.slice(1)
      .map(([name, def], index) =>
        def.evidence === true ? null : `,\n        ${embeddingColumn(name, index + 1)} halfvec(${def.dim})`
      )
      .filter((value): value is string => value !== null)
      .join("");

    const stmts: string[] = [];

    stmts.push(`
      CREATE TABLE IF NOT EXISTS ${table} (
        id text PRIMARY KEY,
        data jsonb NOT NULL,
        enriched jsonb,
        content_hash text NOT NULL,
${fieldCols ? fieldCols + ",\n" : ""}        doc text,
        rerank_doc text,
        fts_src text,
        fts_src_a text,
        gate_reason text,
        ${ftsGeneratedColumnDdl(c, SYS)},${wantPhon ? `\n        ${ftsPhonColumnDdl(SYS)},` : ""}
        embedding halfvec(${embedDim})${embeddingCols},
        ingested_at timestamptz NOT NULL DEFAULT now(),
        enriched_at timestamptz,
        indexed_at timestamptz,
        updated_at timestamptz NOT NULL DEFAULT now(),
        pipeline_status text NOT NULL DEFAULT 'pending',
        attempt_count int NOT NULL DEFAULT 0,
        last_error text,
        next_attempt_at timestamptz,
        image_etag text,
        image_checked_at timestamptz
      );
    `);

    if (scopes.length > 0) {
      stmts.push(
        `CREATE INDEX IF NOT EXISTS c_${coll}_scope_idx ON ${table} (${scopes.map(scopeColumn).join(", ")});`
      );
    }

    stmts.push(`CREATE INDEX IF NOT EXISTS c_${coll}_fts_idx ON ${table} USING gin (fts);`);
    if (wantPhon) {
      stmts.push(`CREATE INDEX IF NOT EXISTS c_${coll}_fts_phon_idx ON ${table} USING gin (fts_phon);`);
    }

    for (const [name, def] of embEntries) {
      if (def.evidence === true) continue;
      const index = embEntries.findIndex(([key]) => key === name);
      stmts.push(
        `CREATE INDEX IF NOT EXISTS ${embeddingIndexName(coll, name, index)} ON ${table} USING hnsw (${embeddingColumn(name, index)} halfvec_cosine_ops);`
      );
    }

    const evEntries = evidenceEntries(c);
    if (evEntries.length > 0) {
      const dims = new Set(evEntries.map(([, def]) => def.dim));
      if (dims.size !== 1) {
        throw new Error(`collection ${c.name}: evidence embeddings must share one dimension`);
      }
      const evTable = evidenceTable(schema, c.name);
      const scopeCols = scopes.map((scope) => `  ${scopeColumn(scope)} text NOT NULL,\n`).join("");
      stmts.push(`
        CREATE TABLE IF NOT EXISTS ${evTable} (
${scopeCols}          doc_id text NOT NULL REFERENCES ${table}(id) ON DELETE CASCADE,
          aspect text NOT NULL,
          ord int NOT NULL,
          vec halfvec(${evEntries[0]![1].dim}) NOT NULL,
          src text,
          PRIMARY KEY (doc_id, aspect, ord)
        );
      `);
      if (evEntries.length === 1) {
        stmts.push(`CREATE INDEX IF NOT EXISTS c_${coll}_evidence_vec_idx ON ${evTable} USING hnsw (vec halfvec_cosine_ops);`);
      } else {
        for (const [name] of evEntries) {
          stmts.push(
            `CREATE INDEX IF NOT EXISTS c_${coll}_evidence_${sanitiseIdent(name)}_idx ON ${evTable} USING hnsw (vec halfvec_cosine_ops) WHERE aspect = '${name.replace(/'/g, "''")}';`
          );
        }
      }
    }

    for (const [name, def] of Object.entries(c.fields)) {
      if (def.filterable) {
        const col = sanitiseIdent(name);
        stmts.push(`CREATE INDEX IF NOT EXISTS c_${coll}_${col}_idx ON ${table} (${col});`);
      }
    }

    return stmts;
  }

  function ensureCollectionSystemColumns(
    schema: string,
    collectionName: string,
    def?: CollectionDef
  ): string[] {
    const coll = sanitiseIdent(collectionName);
    const table = `${schema}.c_${coll}`;
    const stmts: string[] = [
      `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS pipeline_status text NOT NULL DEFAULT 'pending';`,
      `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS attempt_count int NOT NULL DEFAULT 0;`,
      `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS last_error text;`,
      `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;`,
      `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS image_etag text;`,
      `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS image_checked_at timestamptz;`,
      `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS rerank_doc text;`,
      `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS fts_src text;`,
      `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS fts_src_a text;`,
      `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS gate_reason text;`,
      `UPDATE ${table} SET pipeline_status='ready' WHERE pipeline_status='pending' AND (indexed_at IS NOT NULL OR enriched_at IS NOT NULL);`,
    ];

    // Enabling search.phonetic on an existing collection is additive: the
    // generated column backfills itself from the stored fts sources.
    if (def && assertPhoneticAvailable(def)) {
      stmts.push(
        `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${ftsPhonColumnDdl(SYS)};`,
        `CREATE INDEX IF NOT EXISTS c_${sanitiseIdent(collectionName)}_fts_phon_idx ON ${table} USING gin (fts_phon);`
      );
    }

    // Offer-dedup: cluster-state columns + indexes + suggestions table. Idempotent
    // (all IF NOT EXISTS), so adding `dedup` to an existing collection is additive.
    if (def?.dedup) {
      stmts.push(...dedupDDL(schema, collectionName, def));
    }

    return stmts;
  }

  function generateCollectionsDDL(
    projectSlug: string,
    collections: CollectionDef[]
  ): { projectSchema: string; statements: string[] } {
    const schema = projectSchemaName(projectSlug);
    const stmts: string[] = [];
    for (const c of collections) {
      stmts.push(...collectionTableDDL(schema, c));
    }
    return { projectSchema: schema, statements: stmts };
  }

  return { projectSchemaName, collectionTableDDL, ensureCollectionSystemColumns, generateCollectionsDDL };
}

export type CollectionsSchemaGen = ReturnType<typeof makeCollectionsSchemaGen>;
