import type { CollectionDef, CollectionFieldDef } from "@samesake/core";
import { totalSpaceDims } from "./spaces.ts";
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

    const fieldCols = [
      ...scopes.map((s) => `  ${scopeColumn(s)} text NOT NULL`),
      ...Object.entries(c.fields).map(([k, def]) => `  ${sanitiseIdent(k)} ${fieldSqlType(def)}`),
    ].join(",\n");

    const embedDim = c.embeddings
      ? Math.max(...Object.values(c.embeddings).map((e) => e.dim))
      : 1536;
    for (const [name, def] of Object.entries(c.embeddings ?? {})) {
      assertIndexableVectorDimension({
        owner: `collection ${c.name}`,
        field: `embeddings.${name}`,
        dimensions: def.dim,
        columnType: "halfvec",
      });
    }

    const spaceDimTotal =
      c.spaces && Object.keys(c.spaces).length > 0 ? totalSpaceDims(c.spaces) : 0;
    if (spaceDimTotal > 0) {
      assertIndexableVectorDimension({
        owner: `collection ${c.name}`,
        field: "spaces total",
        dimensions: spaceDimTotal,
        columnType: "halfvec",
      });
    }
    const spaceVecCol =
      spaceDimTotal > 0 ? `,\n        space_vec halfvec(${spaceDimTotal})` : "";

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
        embedding halfvec(${embedDim})${spaceVecCol},
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

    if (c.embeddings && Object.keys(c.embeddings).length > 0) {
      stmts.push(
        `CREATE INDEX IF NOT EXISTS c_${coll}_emb_idx ON ${table} USING hnsw (embedding halfvec_cosine_ops);`
      );
    }

    if (spaceDimTotal > 0) {
      stmts.push(
        `CREATE INDEX IF NOT EXISTS c_${coll}_space_vec_idx ON ${table} USING hnsw (space_vec halfvec_cosine_ops);`
      );
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
