import type { CollectionDef, CollectionFieldDef } from "@samesake/core";
import { totalSpaceDims } from "./spaces.ts";
import { sanitiseIdent } from "./schema-gen.ts";
import { assertIndexableVectorDimension } from "./vector-dim.ts";

export interface CollectionsSchemaGenConfig {
  projectPrefix: string;
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

function ftsGeneratedColumnDdl(_fields: Record<string, CollectionFieldDef>): string {
  return `fts tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(fts_src, ''))) STORED`;
}

export function makeCollectionsSchemaGen(config: CollectionsSchemaGenConfig) {
  const PREFIX = config.projectPrefix;

  function projectSchemaName(slug: string): string {
    const safe = slug.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
    return `${PREFIX}${safe}`;
  }

  function collectionTableDDL(schema: string, c: CollectionDef): string[] {
    if (!c.name) throw new Error("collection must have a name");
    const coll = sanitiseIdent(c.name);
    const table = `${schema}.c_${coll}`;

    const fieldCols = Object.entries(c.fields)
      .map(([k, def]) => `  ${sanitiseIdent(k)} ${fieldSqlType(def)}`)
      .join(",\n");

    const embedDim = c.embeddings
      ? Math.max(...Object.values(c.embeddings).map((e) => e.dim))
      : 1536;
    for (const [name, def] of Object.entries(c.embeddings ?? {})) {
      assertIndexableVectorDimension({
        owner: `collection ${c.name}`,
        field: `embeddings.${name}`,
        dimensions: def.dim,
      });
    }

    const spaceDimTotal =
      c.spaces && Object.keys(c.spaces).length > 0 ? totalSpaceDims(c.spaces) : 0;
    if (spaceDimTotal > 0) {
      assertIndexableVectorDimension({
        owner: `collection ${c.name}`,
        field: "spaces total",
        dimensions: spaceDimTotal,
      });
    }
    const spaceVecCol =
      spaceDimTotal > 0 ? `,\n        space_vec vector(${spaceDimTotal})` : "";

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
        gate_reason text,
        ${ftsGeneratedColumnDdl(c.fields)},
        embedding vector(${embedDim})${spaceVecCol},
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

    stmts.push(`CREATE INDEX IF NOT EXISTS c_${coll}_fts_idx ON ${table} USING gin (fts);`);

    if (c.embeddings && Object.keys(c.embeddings).length > 0) {
      stmts.push(
        `CREATE INDEX IF NOT EXISTS c_${coll}_emb_idx ON ${table} USING hnsw (embedding vector_cosine_ops);`
      );
    }

    if (spaceDimTotal > 0) {
      stmts.push(
        `CREATE INDEX IF NOT EXISTS c_${coll}_space_vec_idx ON ${table} USING hnsw (space_vec vector_cosine_ops);`
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
      `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS gate_reason text;`,
      `UPDATE ${table} SET pipeline_status='ready' WHERE pipeline_status='pending' AND (indexed_at IS NOT NULL OR enriched_at IS NOT NULL);`,
    ];

    void def;

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
