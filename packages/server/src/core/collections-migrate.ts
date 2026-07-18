import type { CollectionDef, CollectionFieldDef } from "@samesake/core";
import { embeddingColumn, embeddingEntries, embeddingIndexName, evidenceEntries, evidenceTable } from "./aspects.ts";
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
    out[k] = {
      model: v.model,
      dim: v.dim,
      taskType: v.taskType ?? null,
      kind: v.kind ?? "text",
      evidence: v.evidence ?? false,
      describe: v.describe ?? null,
    };
  }
  return out;
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

  // The fts generated column bakes the language in; changing it means rebuilding
  // that column (and queries would silently mis-stem against the old index).
  const storedLang = stored.language ?? "english";
  const incomingLang = incoming.language ?? "english";
  if (storedLang !== incomingLang) {
    plan.destructive.push(
      `${coll}: FTS language change ${storedLang} → ${incomingLang} (fts column must be rebuilt — recreate the collection)`
    );
  }

  // Scope columns are NOT NULL and existing rows carry no values — tenancy
  // cannot be bolted onto a populated table in place.
  const storedScopes = (stored.scopes ?? []).join(",");
  const incomingScopes = (incoming.scopes ?? []).join(",");
  if (storedScopes !== incomingScopes) {
    plan.destructive.push(
      `${coll}: scopes change [${storedScopes}] → [${incomingScopes}] (recreate the collection)`
    );
  }

  // Offer-dedup config diff. Adding dedup is additive (cluster columns + indexes +
  // suggestions table land via ensureCollectionSystemColumns's IF-NOT-EXISTS DDL);
  // removing it drops that state (destructive); changing channels/thresholds needs a
  // rebuild (a note, not a schema change).
  const storedDedup = stored.dedup;
  const incomingDedup = incoming.dedup;
  const storedGroup = storedDedup ? (storedDedup.groupField ?? "product_group") : null;
  const incomingGroup = incomingDedup ? (incomingDedup.groupField ?? "product_group") : null;
  if (!storedDedup && incomingDedup) {
    plan.additions.push(`${coll}: add dedup (cluster columns, indexes, suggestions table)`);
  } else if (storedDedup && !incomingDedup) {
    const g = sanitiseIdent(storedGroup!);
    plan.destructive.push(
      `${coll}: dedup removed (drops ${g}, dedup_score, dedup_checked_at, and the suggestions table)`
    );
    alterStatements.push(`ALTER TABLE ${table} DROP COLUMN IF EXISTS ${g}`);
    alterStatements.push(`ALTER TABLE ${table} DROP COLUMN IF EXISTS dedup_score`);
    alterStatements.push(`ALTER TABLE ${table} DROP COLUMN IF EXISTS dedup_checked_at`);
    alterStatements.push(`DROP TABLE IF EXISTS ${table}_dedup_suggestions`);
  } else if (storedDedup && incomingDedup) {
    if (storedGroup !== incomingGroup) {
      plan.destructive.push(
        `${coll}: dedup.groupField ${storedGroup} → ${incomingGroup} (cluster column renamed — recreate the collection)`
      );
    } else if (
      JSON.stringify(storedDedup.channels) !== JSON.stringify(incomingDedup.channels) ||
      storedDedup.autoLink !== incomingDedup.autoLink ||
      storedDedup.suggest !== incomingDedup.suggest
    ) {
      plan.notes.push(
        `${coll}: dedup channels/thresholds changed — re-run matcher.dedup({ rebuild: true }) to re-cluster`
      );
    }
  }

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
      columnType: "halfvec",
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

  const storedFirst = storedEmbKeys[0] ? storedEmb[storedEmbKeys[0]] : undefined;
  const incomingFirst = incomingEmbKeys[0] ? incomingEmb[incomingEmbKeys[0]] : undefined;
  const storedDim = storedFirst?.dim ?? 0;
  const incomingDim = incomingFirst?.dim ?? 0;

  if (storedEmbKeys.length === 0 && incomingFirst) {
    alterStatements.push(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS embedding halfvec(${incomingDim})`);
    alterStatements.push(`CREATE INDEX IF NOT EXISTS ${indexName(coll, "emb_idx")} ON ${table} USING hnsw (embedding halfvec_cosine_ops)`);
    plan.additions.push(`${coll}: add embedding halfvec(${incomingDim}) + HNSW`);
    reindex = true;
    plan.reindexRequired.push(`${coll}: new embedding requires backfill`);
  } else if (storedDim > 0 && incomingDim > 0 && storedDim !== incomingDim) {
    plan.destructive.push(`${coll}.embedding: dimension change ${storedDim} → ${incomingDim}`);
    alterStatements.push(`DROP INDEX IF EXISTS ${indexName(coll, "emb_idx")}`);
    alterStatements.push(`ALTER TABLE ${table} DROP COLUMN IF EXISTS embedding`);
    alterStatements.push(`ALTER TABLE ${table} ADD COLUMN embedding halfvec(${incomingDim})`);
    alterStatements.push(`CREATE INDEX IF NOT EXISTS ${indexName(coll, "emb_idx")} ON ${table} USING hnsw (embedding halfvec_cosine_ops)`);
    reindex = true;
    plan.reindexRequired.push(`${coll}: embedding dimension changed — column recreated`);
  }

  for (const [index, [name, def]] of embeddingEntries(incoming).entries()) {
    if (index === 0 || def.evidence === true) continue;
    const column = embeddingColumn(name, index);
    if (!(name in storedEmb)) {
      alterStatements.push(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} halfvec(${def.dim})`);
      alterStatements.push(`CREATE INDEX IF NOT EXISTS ${embeddingIndexName(coll, name, index)} ON ${table} USING hnsw (${column} halfvec_cosine_ops)`);
      plan.additions.push(`${coll}.embeddings.${name}: add ${column} halfvec(${def.dim}) + HNSW`);
      reindex = true;
      plan.reindexRequired.push(`${coll}: new aspect "${name}" requires backfill`);
    }
  }

  for (const [index, [name, def]] of embeddingEntries(stored).entries()) {
    if (name in incomingEmb) continue;
    if (index === 0) {
      plan.destructive.push(`${coll}.embeddings.${name}: first embedding removed`);
      continue;
    }
    if (def.evidence === true) {
      plan.destructive.push(`${coll}.embeddings.${name}: evidence aspect removed`);
      continue;
    }
    const column = embeddingColumn(name, index);
    alterStatements.push(`DROP INDEX IF EXISTS ${embeddingIndexName(coll, name, index)}`);
    alterStatements.push(`ALTER TABLE ${table} DROP COLUMN IF EXISTS ${column}`);
    plan.destructive.push(`${coll}.embeddings.${name}: aspect removed`);
  }

  const incomingEvidence = evidenceEntries(incoming);
  const storedEvidence = evidenceEntries(stored);
  if (storedEvidence.length > 0 && incomingEvidence.length === 0) {
    alterStatements.push(`DROP TABLE IF EXISTS ${evidenceTable(schema, coll)}`);
    plan.destructive.push(`${coll}.evidence: all evidence aspects removed`);
  }
  if (incomingEvidence.length > 0) {
    const dims = new Set(incomingEvidence.map(([, def]) => def.dim));
    if (dims.size !== 1) throw new Error(`collection ${coll}: evidence embeddings must share one dimension`);
    const evTable = evidenceTable(schema, coll);
    const scopeCols = (incoming.scopes ?? []).map((scope) => `  scope_${sanitiseIdent(scope)} text NOT NULL,\n`).join("");
    alterStatements.push(`CREATE TABLE IF NOT EXISTS ${evTable} (\n${scopeCols}  doc_id text NOT NULL REFERENCES ${table}(id) ON DELETE CASCADE,\n  aspect text NOT NULL,\n  ord int NOT NULL,\n  vec halfvec(${incomingEvidence[0]![1].dim}) NOT NULL,\n  src text,\n  PRIMARY KEY (doc_id, aspect, ord)\n)`);
    if (incomingEvidence.length === 1) {
      alterStatements.push(`CREATE INDEX IF NOT EXISTS c_${sanitiseIdent(coll)}_evidence_vec_idx ON ${evTable} USING hnsw (vec halfvec_cosine_ops)`);
    } else {
      for (const [name] of incomingEvidence) {
        alterStatements.push(`CREATE INDEX IF NOT EXISTS c_${sanitiseIdent(coll)}_evidence_${sanitiseIdent(name)}_idx ON ${evTable} USING hnsw (vec halfvec_cosine_ops) WHERE aspect = '${name.replace(/'/g, "''")}'`);
      }
    }
    reindex = true;
    plan.reindexRequired.push(`${coll}: evidence aspects require backfill`);
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
