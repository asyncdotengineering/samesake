import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { CollectionDef, CollectionFieldDef } from "@samesake/core";
import { sanitiseIdent } from "../../core/schema-gen.ts";
import { getPgClient } from "../../core/db-utils.ts";

const FACET_VALUE_CAP = 25;
const RANGE_BUCKETS = 6;

export interface FacetBucket {
  lo: number;
  hi: number;
  count: number;
}

export interface FacetRangeResult {
  min: number | null;
  max: number | null;
  buckets: FacetBucket[];
}

export interface FacetCountResult {
  values: Array<{ value: string; count: number }>;
}

export type FacetResult = FacetCountResult | FacetRangeResult;

function facetFieldDef(def: CollectionDef, name: string): CollectionFieldDef | null {
  const field = def.fields[name];
  if (!field?.facet) return null;
  return field;
}

function validateFacetFields(def: CollectionDef, facets: string[]): string[] {
  const valid: string[] = [];
  for (const name of facets) {
    if (!def.fields[name]) {
      const declared = Object.keys(def.fields)
        .filter((k) => def.fields[k]?.facet)
        .sort()
        .join(", ");
      throw new Error(
        `Unknown facet field "${name}". Facet fields: ${declared || "(none)"}`
      );
    }
    if (!def.fields[name]?.facet) {
      throw new Error(`Field "${name}" is not declared as a facet`);
    }
    valid.push(name);
  }
  return valid;
}

function isRangeFacet(field: CollectionFieldDef): boolean {
  return field.type === "number" && field.facet === "range";
}

export async function computeFacets(
  db: PostgresJsDatabase,
  table: string,
  def: CollectionDef,
  where: string,
  params: unknown[],
  facetNames: string[]
): Promise<Record<string, FacetResult>> {
  if (!facetNames.length) return {};

  const names = validateFacetFields(def, facetNames);
  const out: Record<string, FacetResult> = {};

  for (const name of names) {
    const field = facetFieldDef(def, name)!;
    const col = sanitiseIdent(name);

    if (isRangeFacet(field)) {
      out[name] = await computeRangeFacet(db, table, col, where, params);
      continue;
    }

    if (field.type === "boolean") {
      out[name] = await computeBooleanFacet(db, table, col, where, params);
      continue;
    }

    if (field.type === "array") {
      out[name] = await computeArrayFacet(db, table, col, where, params);
      continue;
    }

    out[name] = await computeScalarFacet(db, table, col, where, params);
  }

  return out;
}

async function computeBooleanFacet(
  db: PostgresJsDatabase,
  table: string,
  col: string,
  where: string,
  params: unknown[]
): Promise<FacetCountResult> {
  const rows = await getPgClient(db, "facet query").unsafe(
    `SELECT CASE WHEN ${col} THEN 'true' ELSE 'false' END AS value, count(*)::int AS count
     FROM ${table}
     WHERE ${where} AND ${col} IS NOT NULL
     GROUP BY ${col}
     ORDER BY count DESC, value ASC
     LIMIT ${FACET_VALUE_CAP}`,
    params
  );
  return {
    values: rows.map((r) => ({
      value: String(r.value),
      count: Number(r.count),
    })),
  };
}

async function computeScalarFacet(
  db: PostgresJsDatabase,
  table: string,
  col: string,
  where: string,
  params: unknown[]
): Promise<FacetCountResult> {
  const rows = await getPgClient(db, "facet query").unsafe(
    `SELECT ${col}::text AS value, count(*)::int AS count
     FROM ${table}
     WHERE ${where} AND ${col} IS NOT NULL
     GROUP BY ${col}
     ORDER BY count DESC, value ASC
     LIMIT ${FACET_VALUE_CAP}`,
    params
  );
  return {
    values: rows.map((r) => ({
      value: String(r.value),
      count: Number(r.count),
    })),
  };
}

async function computeArrayFacet(
  db: PostgresJsDatabase,
  table: string,
  col: string,
  where: string,
  params: unknown[]
): Promise<FacetCountResult> {
  const rows = await getPgClient(db, "facet query").unsafe(
    `SELECT val AS value, count(*)::int AS count
     FROM ${table}, unnest(${col}) AS val
     WHERE ${where} AND ${col} IS NOT NULL
     GROUP BY val
     ORDER BY count DESC, val ASC
     LIMIT ${FACET_VALUE_CAP}`,
    params
  );
  return {
    values: rows.map((r) => ({
      value: String(r.value),
      count: Number(r.count),
    })),
  };
}

async function computeRangeFacet(
  db: PostgresJsDatabase,
  table: string,
  col: string,
  where: string,
  params: unknown[]
): Promise<FacetRangeResult> {
  const stats = await getPgClient(db, "facet query").unsafe(
    `SELECT min(${col})::float AS lo, max(${col})::float AS hi, count(*)::int AS n
     FROM ${table}
     WHERE ${where} AND ${col} IS NOT NULL`,
    params
  );

  const lo = stats[0]?.lo != null ? Number(stats[0].lo) : null;
  const hi = stats[0]?.hi != null ? Number(stats[0].hi) : null;
  const n = Number(stats[0]?.n ?? 0);

  if (n === 0 || lo == null || hi == null) {
    return { min: lo, max: hi, buckets: [] };
  }

  if (lo === hi) {
    return {
      min: lo,
      max: hi,
      buckets: [{ lo, hi, count: n }],
    };
  }

  const width = (hi - lo) / RANGE_BUCKETS;
  const bucketRows = await getPgClient(db, "facet query").unsafe(
    `SELECT
       least(${RANGE_BUCKETS - 1}, greatest(0, floor((${col} - $${params.length + 1}) / $${params.length + 2})))::int AS bucket,
       count(*)::int AS count
     FROM ${table}
     WHERE ${where} AND ${col} IS NOT NULL
     GROUP BY bucket
     ORDER BY bucket`,
    [...params, lo, width]
  );

  const counts = new Map<number, number>();
  for (const r of bucketRows) {
    counts.set(Number(r.bucket), Number(r.count));
  }

  const buckets: FacetBucket[] = [];
  for (let i = 0; i < RANGE_BUCKETS; i++) {
    const bLo = lo + i * width;
    const bHi = i === RANGE_BUCKETS - 1 ? hi : lo + (i + 1) * width;
    buckets.push({
      lo: bLo,
      hi: bHi,
      count: counts.get(i) ?? 0,
    });
  }

  return { min: lo, max: hi, buckets };
}
