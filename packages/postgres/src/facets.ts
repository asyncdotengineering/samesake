import type { CollectionDef } from "@samesake/core";
import type { FacetBucket, FacetResult } from "@samesake/query";
import type { PostgresAdapter } from "./adapter.ts";
import { ident } from "./ident.ts";
import { buildFilterSql } from "./filter-sql.ts";
import type { CollectionBackendOptions } from "./types.ts";

const VALUE_CAP = 25;
const BUCKET_COUNT = 6;

function facetField(def: CollectionDef, field: string) {
  const value = def.fields[field];
  if (!value) throw new Error(`Unknown facet field "${field}"`);
  if (!value.facet) throw new Error(`Field "${field}" is not declared as a facet`);
  return value;
}

export function createFacets(adapter: PostgresAdapter, options: CollectionBackendOptions) {
  return async (request: {
    fields: string[];
    filters: import("@samesake/query").RetrievalPlan["filters"];
    scope?: Record<string, string>;
  }): Promise<Record<string, FacetResult>> => {
    const scope = request.scope ?? options.scope;
    const compiled = buildFilterSql(request.filters, options.collection, 1);
    const whereParts = compiled.where === "true" ? [] : [compiled.where];
    const params = [...compiled.params];
    for (const [field, value] of Object.entries(scope ?? {})) {
      params.push(value);
      whereParts.push(`scope_${ident(field.replace(/^scope_/, ""))} = $${params.length}`);
    }
    const where = whereParts.length ? whereParts.join(" AND ") : "true";
    const result: Record<string, FacetResult> = {};
    for (const fieldName of request.fields) {
      const field = facetField(options.collection, fieldName);
      const col = ident(fieldName);
      if (field.type === "number" && field.facet === "range") {
        result[fieldName] = await rangeFacet(adapter, options.table, col, where, params);
      } else if (field.type === "boolean") {
        result[fieldName] = await countFacet(adapter, options.table, `CASE WHEN ${col} THEN 'true' ELSE 'false' END`, where, params);
      } else if (field.type === "array") {
        result[fieldName] = await countFacet(adapter, options.table, `val`, where, params, `, unnest(${col}) AS val`);
      } else {
        result[fieldName] = await countFacet(adapter, options.table, `${col}::text`, where, params);
      }
    }
    return result;
  };
}

async function countFacet(
  adapter: PostgresAdapter,
  table: string,
  expression: string,
  where: string,
  params: unknown[],
  from = ""
): Promise<{ values: Array<{ value: string; count: number }> }> {
  const rows = await adapter.query(
    `SELECT ${expression} AS value, count(*)::int AS count FROM ${table}${from} WHERE ${where} GROUP BY value ORDER BY count DESC, value ASC LIMIT ${VALUE_CAP}`,
    params
  );
  return { values: rows.map((row) => ({ value: String(row.value), count: Number(row.count) })) };
}

async function rangeFacet(
  adapter: PostgresAdapter,
  table: string,
  col: string,
  where: string,
  params: unknown[]
): Promise<{ count: number; min: number | null; max: number | null; avg: number | null; buckets: FacetBucket[] }> {
  const rows = await adapter.query(
    `SELECT min(${col})::float AS min, max(${col})::float AS max, avg(${col})::float AS avg, count(*)::int AS count FROM ${table} WHERE ${where} AND ${col} IS NOT NULL`,
    params
  );
  const row = rows[0];
  const count = Number(row?.count ?? 0);
  const min = row?.min == null ? null : Number(row.min);
  const max = row?.max == null ? null : Number(row.max);
  const avg = row?.avg == null ? null : Number(row.avg);
  if (!count || min == null || max == null) return { count, min, max, avg, buckets: [] };
  if (min === max) return { count, min, max, avg, buckets: [{ lo: min, hi: max, count }] };

  const width = (max - min) / BUCKET_COUNT;
  const bucketRows = await adapter.query(
    `SELECT least(${BUCKET_COUNT - 1}, greatest(0, floor((${col} - $${params.length + 1}) / $${params.length + 2})))::int AS bucket, count(*)::int AS count FROM ${table} WHERE ${where} AND ${col} IS NOT NULL GROUP BY bucket ORDER BY bucket`,
    [...params, min, width]
  );
  const counts = new Map(bucketRows.map((entry) => [Number(entry.bucket), Number(entry.count)]));
  const buckets = Array.from({ length: BUCKET_COUNT }, (_, index) => ({
    lo: min + index * width,
    hi: index === BUCKET_COUNT - 1 ? max : min + (index + 1) * width,
    count: counts.get(index) ?? 0,
  }));
  return { count, min, max, avg, buckets };
}
