import type { CollectionDef, CollectionFieldDef } from "@samesake/core";
import { ClientError } from "../errors.ts";
import { sanitiseIdent } from "./schema-gen.ts";

export type FilterOperator =
  | "$eq"
  | "$ne"
  | "$gt"
  | "$gte"
  | "$lt"
  | "$lte"
  | "$in"
  | "$nin"
  | "$contains"
  | "$exclude"
  | "$not";

export type FilterClause =
  | string
  | number
  | boolean
  | string[]
  | number[]
  | Partial<Record<FilterOperator, string | number | boolean | string[] | number[]>>;

export type SearchFilters = Record<string, FilterClause>;

export interface FilterCompileOpts {
  soft: boolean;
  excludeSoft?: boolean;
  excludeTerms?: string[];
}

export interface CompiledFilter {
  where: string;
  params: unknown[];
  softFieldsUsed: string[];
}

function isOperatorObject(
  v: FilterClause
): v is Partial<Record<FilterOperator, string | number | boolean | string[] | number[]>> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function filterableFields(def: CollectionDef): Map<string, CollectionFieldDef> {
  const m = new Map<string, CollectionFieldDef>();
  for (const [k, f] of Object.entries(def.fields)) {
    if (f.filterable) m.set(k, f);
  }
  return m;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertNumeric(val: unknown, field: string, op: string): asserts val is number {
  if (typeof val !== "number" || Number.isNaN(val)) {
    throw new ClientError(
      "invalid_filter_value",
      `Filter ${op} on field "${field}" requires a numeric value`
    );
  }
}

function filterClientError(code: string, message: string): never {
  throw new ClientError(code, message);
}

export function buildFilterSql(
  filters: SearchFilters,
  def: CollectionDef,
  opts: FilterCompileOpts,
  startIndex: number
): CompiledFilter {
  const allowed = filterableFields(def);
  const clauses: string[] = [];
  const params: unknown[] = [];
  const softFieldsUsed: string[] = [];
  const next = () => `$${startIndex + params.length}`;

  for (const [field, raw] of Object.entries(filters)) {
    const fieldDef = allowed.get(field);
    if (!fieldDef) {
      const valid = [...allowed.keys()].sort().join(", ");
      filterClientError(
        "unknown_filter_field",
        `Unknown filter field "${field}". Filterable fields: ${valid || "(none)"}`
      );
    }

    if (fieldDef.soft && opts.excludeSoft) continue;
    if (fieldDef.soft && opts.soft) softFieldsUsed.push(field);

    const col = sanitiseIdent(field);
    const isArray = fieldDef.type === "array";

    if (!isOperatorObject(raw)) {
      if (isArray && Array.isArray(raw)) {
        clauses.push(`${col} && ${next()}::text[]`);
        params.push(raw);
        continue;
      }
      if (fieldDef.type === "enum" && fieldDef.alsoMatch?.length && typeof raw === "string") {
        const eqParam = next();
        params.push(raw);
        const anyParam = next();
        params.push([...fieldDef.alsoMatch]);
        clauses.push(`(${col} = ${eqParam} OR ${col} = ANY(${anyParam}::text[]))`);
        continue;
      }
      if (fieldDef.type === "text" || fieldDef.type === "enum") {
        clauses.push(`${col} = ${next()}`);
        params.push(raw);
        continue;
      }
      if (fieldDef.type === "number") {
        assertNumeric(raw, field, "=");
        clauses.push(`${col} = ${next()}::numeric`);
        params.push(raw);
        continue;
      }
      if (fieldDef.type === "boolean") {
        if (typeof raw !== "boolean") {
          filterClientError(
            "invalid_filter_value",
            `Filter on field "${field}" requires a boolean value`
          );
        }
        clauses.push(`${col} = ${next()}::boolean`);
        params.push(raw);
        continue;
      }
    }

    const ops = raw as Partial<Record<FilterOperator, unknown>>;
    for (const [op, val] of Object.entries(ops)) {
      switch (op as FilterOperator) {
        case "$eq":
          if (isArray) {
            clauses.push(`${col} = ${next()}`);
            params.push(val);
          } else if (fieldDef.type === "number") {
            assertNumeric(val, field, "$eq");
            clauses.push(`${col} = ${next()}::numeric`);
            params.push(val);
          } else if (fieldDef.type === "boolean") {
            if (typeof val !== "boolean") {
              filterClientError(
                "invalid_filter_value",
                `Filter $eq on field "${field}" requires a boolean value`
              );
            }
            clauses.push(`${col} = ${next()}::boolean`);
            params.push(val);
          } else if (
            fieldDef.type === "enum" &&
            fieldDef.alsoMatch?.length &&
            typeof val === "string"
          ) {
            const eqParam = next();
            params.push(val);
            const anyParam = next();
            params.push([...fieldDef.alsoMatch]);
            clauses.push(`(${col} = ${eqParam} OR ${col} = ANY(${anyParam}::text[]))`);
          } else {
            clauses.push(`${col} = ${next()}`);
            params.push(val);
          }
          break;
        case "$ne":
          clauses.push(`(${col} IS NULL OR ${col} <> ${next()})`);
          params.push(val);
          break;
        case "$gt":
          assertNumeric(val, field, "$gt");
          clauses.push(`${col} > ${next()}::numeric`);
          params.push(val);
          break;
        case "$gte":
          assertNumeric(val, field, "$gte");
          clauses.push(`${col} >= ${next()}::numeric`);
          params.push(val);
          break;
        case "$lt":
          assertNumeric(val, field, "$lt");
          clauses.push(`${col} < ${next()}::numeric`);
          params.push(val);
          break;
        case "$lte":
          assertNumeric(val, field, "$lte");
          clauses.push(`${col} <= ${next()}::numeric`);
          params.push(val);
          break;
        case "$in":
          clauses.push(`${col} = ANY(${next()}::text[])`);
          params.push(val);
          break;
        case "$nin":
          clauses.push(`(${col} IS NULL OR NOT (${col} = ANY(${next()}::text[])))`);
          params.push(val);
          break;
        case "$contains":
          if (isArray) {
            clauses.push(`${col} && ${next()}::text[]`);
            params.push(val);
          } else {
            clauses.push(`${col} ILIKE '%' || ${next()} || '%'`);
            params.push(val);
          }
          break;
        case "$exclude":
          if (isArray) {
            clauses.push(`NOT (${col} && ${next()}::text[])`);
            params.push(val);
          } else {
            filterClientError(
              "invalid_filter_operator",
              `Operator $exclude is only supported on array fields (field "${field}")`
            );
          }
          break;
        case "$not":
          if (fieldDef.type === "text") {
            clauses.push(`(${col} IS NULL OR ${col} !~* ${next()})`);
            params.push(escapeRegex(String(val)));
          } else {
            filterClientError(
              "invalid_filter_operator",
              `Operator $not is only supported on text fields (field "${field}")`
            );
          }
          break;
        default:
          filterClientError(
            "unknown_filter_operator",
            `Unknown filter operator "${op}" on field "${field}"`
          );
      }
    }
  }

  for (const term of opts.excludeTerms ?? []) {
    const searchableCols = Object.entries(def.fields)
      .filter(([, f]) => f.type === "text" && f.searchable)
      .map(([k]) => `coalesce(${sanitiseIdent(k)}, '')`);
    const textExpr =
      searchableCols.length > 0
        ? `(coalesce(doc, '') || ' ' || ${searchableCols.join(" || ' ' || ")})`
        : "coalesce(doc, '')";
    clauses.push(`${textExpr} !~* ${next()}`);
    params.push(escapeRegex(term));
  }

  return {
    where: clauses.length ? clauses.join(" AND ") : "true",
    params,
    softFieldsUsed,
  };
}
