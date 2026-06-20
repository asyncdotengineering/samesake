import { createHash } from "node:crypto";
import type { CollectionDef, CollectionFieldDef } from "@samesake/core";
import { totalSpaceDims } from "./spaces.ts";
import { sanitiseIdent } from "./schema-gen.ts";
import { assertIndexableVectorDimension } from "./vector-dim.ts";

export interface MigrationPlan {
  additions: string[];
  reindexRequired: string[];
  destructive: string[];
  notes: string[];
}

export interface CollectionMigration {
  collection: string;
  alterStatements: string[];
  backfillStatements: string[];
  reindex: boolean;
  plan: MigrationPlan;
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

function canonicalEmbeddings(c: CollectionDef): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c.embeddings ?? {})) {
    out[k] = { model: v.model, dim: v.dim, taskType: v.taskType ?? null };
  }
  return out;
}

function canonicalSpaces(c: CollectionDef): Record<string, unknown> {
  return c.spaces ?? {};
}

function jsonPathExpr(root: "data" | "enriched", path: string): string {
  const parts = path.split(".").map((p) => p.replace(/'/g, "''"));
  if (parts.length === 1) return `${root}->>'${parts[0]!}'`;
  return `${root} #>> '{${parts.join(",")}}'`;
}

function backfillExpr(fieldName: string, def: CollectionFieldDef): string {
  const path = def.path ?? fieldName;
  if (path.startsWith("enriched.")) return jsonPathExpr("enriched", path.slice("enriched.".length));
  return jsonPathExpr("data", path);
}

function castBackfill(def: CollectionFieldDef, expr: string): string {
  switch (def.type) {
    case "number":
      return `(${expr})::numeric`;
    case "boolean":
      return `(${expr})::boolean`;
    case "array":
      return `CASE WHEN ${expr} IS NULL THEN NULL ELSE string_to_array(${expr}, ',') END`;
    default:
      return expr;
  }
}

function tableRef(schema: string, collection: string): string {
  return `${schema}.c_${sanitiseIdent(collection)}`;
}

function indexName(collection: string, suffix: string): string {
  return `c_${sanitiseIdent(collection)}_${suffix}`;
}

export function planCollectionMigration(
  schema: string,
  stored: CollectionDef | null,
  incoming: CollectionDef,
  tableExists: boolean
): CollectionMigration {
  const coll = incoming.name!;
  const table = tableRef(schema, coll);
  const plan: MigrationPlan = { additions: [], reindexRequired: [], destructive: [], notes: [] };
  const alterStatements: string[] = [];
  const backfillStatements: string[] = [];
  let reindex = false;

  if (!tableExists || !stored) {
    plan.notes.push(`collection "${coll}": create new table`);
    return { collection: coll, alterStatements, backfillStatements, reindex, plan };
  }

  const storedFields = stored.fields ?? {};
  const incomingFields = incoming.fields ?? {};
  const storedEmb = stored.embeddings ?? {};
  const incomingEmb = incoming.embeddings ?? {};
  const storedSpaces = stored.spaces ?? {};
  const incomingSpaces = incoming.spaces ?? {};

  for (const [name, def] of Object.entries(incomingFields)) {
    const prev = storedFields[name];
    if (!prev) {
      const col = sanitiseIdent(name);
      alterStatements.push(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col} ${fieldSqlType(def)}`);
      backfillStatements.push(
        `UPDATE ${table} SET ${col} = ${castBackfill(def, backfillExpr(name, def))} WHERE ${col} IS NULL AND enriched_at IS NOT NULL`
      );
      plan.additions.push(`${coll}.${name}: add column ${col}`);
      if (def.filterable) {
        alterStatements.push(`CREATE INDEX IF NOT EXISTS ${indexName(coll, `${col}_idx`)} ON ${table} (${col})`);
        plan.additions.push(`${coll}.${name}: btree index on ${col}`);
      }
      continue;
    }
    if (fieldSqlType(prev) !== fieldSqlType(def)) {
      plan.destructive.push(`${coll}.${name}: type change ${prev.type} → ${def.type}`);
    }
  }

  for (const name of Object.keys(storedFields)) {
    if (!(name in incomingFields)) plan.destructive.push(`${coll}.${name}: field removed`);
  }

  const storedEmbKeys = Object.keys(storedEmb);
  const incomingEmbKeys = Object.keys(incomingEmb);
  for (const [name, def] of Object.entries(incomingEmb)) {
    assertIndexableVectorDimension({
      owner: `collection ${coll}`,
      field: `embeddings.${name}`,
      dimensions: def.dim,
    });
  }
  const storedEmbCanon = JSON.stringify(canonicalEmbeddings(stored));
  const incomingEmbCanon = JSON.stringify(canonicalEmbeddings(incoming));
  if (storedEmbCanon !== incomingEmbCanon && incomingEmbKeys.length > 0) {
    reindex = true;
    plan.reindexRequired.push(`${coll}: embedding definition changed`);
  }
  for (const key of storedEmbKeys) {
    if (!(key in incomingEmb)) plan.destructive.push(`${coll}.embeddings.${key}: embedding removed`);
  }

  const storedDim = storedEmbKeys.length ? Math.max(...Object.values(storedEmb).map((e) => e.dim)) : 0;
  const incomingDim = incomingEmbKeys.length ? Math.max(...Object.values(incomingEmb).map((e) => e.dim)) : 0;

  if (storedEmbKeys.length === 0 && incomingEmbKeys.length > 0) {
    alterStatements.push(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS embedding vector(${incomingDim})`);
    alterStatements.push(`CREATE INDEX IF NOT EXISTS ${indexName(coll, "emb_idx")} ON ${table} USING hnsw (embedding vector_cosine_ops)`);
    plan.additions.push(`${coll}: add embedding vector(${incomingDim}) + HNSW`);
  } else if (storedDim > 0 && incomingDim > 0 && storedDim !== incomingDim) {
    plan.destructive.push(`${coll}.embedding: dimension change ${storedDim} → ${incomingDim}`);
    alterStatements.push(`DROP INDEX IF EXISTS ${indexName(coll, "emb_idx")}`);
    alterStatements.push(`ALTER TABLE ${table} DROP COLUMN IF EXISTS embedding`);
    alterStatements.push(`ALTER TABLE ${table} ADD COLUMN embedding vector(${incomingDim})`);
    alterStatements.push(`CREATE INDEX IF NOT EXISTS ${indexName(coll, "emb_idx")} ON ${table} USING hnsw (embedding vector_cosine_ops)`);
    reindex = true;
    plan.reindexRequired.push(`${coll}: embedding dimension changed — column recreated`);
  }

  const storedSpaceDim = Object.keys(storedSpaces).length ? totalSpaceDims(storedSpaces) : 0;
  const incomingSpaceDim = Object.keys(incomingSpaces).length ? totalSpaceDims(incomingSpaces) : 0;
  if (incomingSpaceDim > 0) {
    assertIndexableVectorDimension({
      owner: `collection ${coll}`,
      field: "spaces total",
      dimensions: incomingSpaceDim,
    });
  }
  const storedSpaceHash = createHash("sha1").update(JSON.stringify(canonicalSpaces(stored))).digest("hex");
  const incomingSpaceHash = createHash("sha1").update(JSON.stringify(canonicalSpaces(incoming))).digest("hex");

  if (Object.keys(storedSpaces).length > 0 && Object.keys(incomingSpaces).length === 0) {
    plan.destructive.push(`${coll}.spaces: all spaces removed (drop space_vec)`);
  }
  for (const name of Object.keys(storedSpaces)) {
    if (!(name in incomingSpaces)) plan.destructive.push(`${coll}.spaces.${name}: space removed`);
  }
  if (storedSpaceHash !== incomingSpaceHash && incomingSpaceDim > 0) {
    reindex = true;
    plan.reindexRequired.push(`${coll}: spaces definition changed`);
  }
  if (storedSpaceDim === 0 && incomingSpaceDim > 0) {
    alterStatements.push(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS space_vec vector(${incomingSpaceDim})`);
    alterStatements.push(`CREATE INDEX IF NOT EXISTS ${indexName(coll, "space_vec_idx")} ON ${table} USING hnsw (space_vec vector_cosine_ops)`);
    plan.additions.push(`${coll}: add space_vec vector(${incomingSpaceDim}) + HNSW`);
    reindex = true;
    plan.reindexRequired.push(`${coll}: new spaces require backfill`);
  } else if (storedSpaceDim > 0 && incomingSpaceDim > 0 && storedSpaceDim !== incomingSpaceDim) {
    plan.destructive.push(`${coll}.space_vec: dimension change ${storedSpaceDim} → ${incomingSpaceDim}`);
    alterStatements.push(`DROP INDEX IF EXISTS ${indexName(coll, "space_vec_idx")}`);
    alterStatements.push(`ALTER TABLE ${table} DROP COLUMN IF EXISTS space_vec`);
    alterStatements.push(`ALTER TABLE ${table} ADD COLUMN space_vec vector(${incomingSpaceDim})`);
    alterStatements.push(`CREATE INDEX IF NOT EXISTS ${indexName(coll, "space_vec_idx")} ON ${table} USING hnsw (space_vec vector_cosine_ops)`);
    reindex = true;
    plan.reindexRequired.push(`${coll}: space_vec dimension changed — column recreated`);
  }
  if (storedSpaceDim > 0 && incomingSpaceDim === 0) {
    alterStatements.push(`DROP INDEX IF EXISTS ${indexName(coll, "space_vec_idx")}`);
    alterStatements.push(`ALTER TABLE ${table} DROP COLUMN IF EXISTS space_vec`);
  }

  return { collection: coll, alterStatements, backfillStatements, reindex, plan };
}

export function mergeMigrationPlans(plans: CollectionMigration[]): MigrationPlan {
  const merged: MigrationPlan = { additions: [], reindexRequired: [], destructive: [], notes: [] };
  for (const p of plans) {
    merged.additions.push(...p.plan.additions);
    merged.reindexRequired.push(...p.plan.reindexRequired);
    merged.destructive.push(...p.plan.destructive);
    merged.notes.push(...p.plan.notes);
  }
  return merged;
}
