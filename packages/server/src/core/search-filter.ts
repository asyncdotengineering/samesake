import type { CollectionDef, CollectionFieldDef, ConstraintPredicate, ConstraintTraceSource } from "@samesake/core";
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
  columnPrefix?: string;
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

function allowedFieldOrThrow(allowed: Map<string, CollectionFieldDef>, field: string): CollectionFieldDef {
  const fieldDef = allowed.get(field);
  if (fieldDef) return fieldDef;
  const valid = [...allowed.keys()].sort().join(", ");
  filterClientError(
    "unknown_filter_field",
    `Unknown filter field "${field}". Filterable fields: ${valid || "(none)"}`
  );
}

function assertBoolean(val: unknown, field: string, op?: string): asserts val is boolean {
  if (typeof val !== "boolean") {
    const label = op ? ` ${op}` : "";
    filterClientError("invalid_filter_value", `Filter${label} on field "${field}" requires a boolean value`);
  }
}

function filterOperatorToConstraintOperator(op: FilterOperator): ConstraintPredicate["operator"] {
  switch (op) {
    case "$eq":
      return "eq";
    case "$ne":
      return "ne";
    case "$gt":
      return "gt";
    case "$gte":
      return "gte";
    case "$lt":
      return "lt";
    case "$lte":
      return "lte";
    case "$in":
      return "in";
    case "$nin":
      return "nin";
    case "$contains":
      return "contains";
    case "$exclude":
      return "exclude";
    case "$not":
      return "not";
  }
}

export function normalizeFiltersToConstraintPredicates(
  filters: SearchFilters,
  def: CollectionDef,
  source?: ConstraintTraceSource
): ConstraintPredicate[] {
  const allowed = filterableFields(def);
  const predicates: ConstraintPredicate[] = [];

  for (const [field, raw] of Object.entries(filters)) {
    const fieldDef = allowedFieldOrThrow(allowed, field);
    const soft = fieldDef.soft === true;

    if (!isOperatorObject(raw)) {
      if (fieldDef.type === "array" && Array.isArray(raw)) {
        predicates.push({ field, fieldType: fieldDef.type, operator: "contains", value: raw, source, soft });
        continue;
      }
      if (fieldDef.type === "text" || fieldDef.type === "enum") {
        predicates.push({ field, fieldType: fieldDef.type, operator: "eq", value: raw, source, soft });
        continue;
      }
      if (fieldDef.type === "number") {
        assertNumeric(raw, field, "=");
        predicates.push({ field, fieldType: fieldDef.type, operator: "eq", value: raw, source, soft });
        continue;
      }
      if (fieldDef.type === "boolean") {
        assertBoolean(raw, field);
        predicates.push({ field, fieldType: fieldDef.type, operator: "eq", value: raw, source, soft });
        continue;
      }
    }

    const ops = raw as Partial<Record<FilterOperator, unknown>>;
    for (const [op, val] of Object.entries(ops)) {
      switch (op as FilterOperator) {
        case "$eq":
          if (fieldDef.type === "number") assertNumeric(val, field, "$eq");
          if (fieldDef.type === "boolean") assertBoolean(val, field, "$eq");
          predicates.push({ field, fieldType: fieldDef.type, operator: "eq", value: val, source, soft });
          break;
        case "$ne":
          predicates.push({ field, fieldType: fieldDef.type, operator: "ne", value: val, source, soft });
          break;
        case "$gt":
          assertNumeric(val, field, "$gt");
          predicates.push({ field, fieldType: fieldDef.type, operator: "gt", value: val, source, soft });
          break;
        case "$gte":
          assertNumeric(val, field, "$gte");
          predicates.push({ field, fieldType: fieldDef.type, operator: "gte", value: val, source, soft });
          break;
        case "$lt":
          assertNumeric(val, field, "$lt");
          predicates.push({ field, fieldType: fieldDef.type, operator: "lt", value: val, source, soft });
          break;
        case "$lte":
          assertNumeric(val, field, "$lte");
          predicates.push({ field, fieldType: fieldDef.type, operator: "lte", value: val, source, soft });
          break;
        case "$in":
        case "$nin":
        case "$contains":
        case "$exclude":
        case "$not":
          predicates.push({
            field,
            fieldType: fieldDef.type,
            operator: filterOperatorToConstraintOperator(op as FilterOperator),
            value: val,
            source,
            soft,
          });
          break;
        default:
          filterClientError(
            "unknown_filter_operator",
            `Unknown filter operator "${op}" on field "${field}"`
          );
      }
    }
  }

  return predicates;
}

export function buildFilterSql(
  filters: SearchFilters,
  def: CollectionDef,
  opts: FilterCompileOpts,
  startIndex: number
): CompiledFilter {
  const predicates = normalizeFiltersToConstraintPredicates(filters, def);
  const clauses: string[] = [];
  const params: unknown[] = [];
  const softFieldsUsed: string[] = [];
  const next = () => `$${startIndex + params.length}`;

  for (const predicate of predicates) {
    if (predicate.soft && opts.excludeSoft) continue;
    if (predicate.soft && opts.soft) softFieldsUsed.push(predicate.field);

    const fieldDef = def.fields[predicate.field]!;
    const col = opts.columnPrefix
      ? `${opts.columnPrefix}.${sanitiseIdent(predicate.field)}`
      : sanitiseIdent(predicate.field);
    const isArray = predicate.fieldType === "array";

    switch (predicate.operator) {
      case "eq":
        if (isArray) {
          clauses.push(`${col} = ${next()}`);
          params.push(predicate.value);
        } else if (predicate.fieldType === "number") {
          clauses.push(`${col} = ${next()}::numeric`);
          params.push(predicate.value);
        } else if (predicate.fieldType === "boolean") {
          clauses.push(`${col} = ${next()}::boolean`);
          params.push(predicate.value);
        } else if (
          predicate.fieldType === "enum" &&
          fieldDef.type === "enum" &&
          fieldDef.alsoMatch?.length &&
          typeof predicate.value === "string"
        ) {
          const eqParam = next();
          params.push(predicate.value);
          const anyParam = next();
          params.push([...fieldDef.alsoMatch]);
          clauses.push(`(${col} = ${eqParam} OR ${col} = ANY(${anyParam}::text[]))`);
        } else {
          clauses.push(`${col} = ${next()}`);
          params.push(predicate.value);
        }
        break;
      case "ne":
        clauses.push(`(${col} IS NULL OR ${col} <> ${next()})`);
        params.push(predicate.value);
        break;
      case "gt":
        clauses.push(`${col} > ${next()}::numeric`);
        params.push(predicate.value);
        break;
      case "gte":
        clauses.push(`${col} >= ${next()}::numeric`);
        params.push(predicate.value);
        break;
      case "lt":
        clauses.push(`${col} < ${next()}::numeric`);
        params.push(predicate.value);
        break;
      case "lte":
        clauses.push(`${col} <= ${next()}::numeric`);
        params.push(predicate.value);
        break;
      case "in": {
        const arrayType =
          predicate.fieldType === "number" ? "numeric" : predicate.fieldType === "boolean" ? "boolean" : "text";
        clauses.push(`${col} = ANY(${next()}::${arrayType}[])`);
        params.push(predicate.value);
        break;
      }
      case "nin": {
        const arrayType =
          predicate.fieldType === "number" ? "numeric" : predicate.fieldType === "boolean" ? "boolean" : "text";
        clauses.push(`(${col} IS NULL OR NOT (${col} = ANY(${next()}::${arrayType}[])))`);
        params.push(predicate.value);
        break;
      }
      case "contains":
        if (isArray) {
          clauses.push(`${col} && ${next()}::text[]`);
          params.push(predicate.value);
        } else {
          clauses.push(`${col} ILIKE '%' || ${next()} || '%'`);
          params.push(predicate.value);
        }
        break;
      case "exclude":
        if (isArray) {
          clauses.push(`NOT (${col} && ${next()}::text[])`);
          params.push(predicate.value);
        } else {
          filterClientError(
            "invalid_filter_operator",
            `Operator $exclude is only supported on array fields (field "${predicate.field}")`
          );
        }
        break;
      case "not":
        if (predicate.fieldType === "text") {
          clauses.push(`(${col} IS NULL OR ${col} !~* ${next()})`);
          params.push(escapeRegex(String(predicate.value)));
        } else {
          filterClientError(
            "invalid_filter_operator",
            `Operator $not is only supported on text fields (field "${predicate.field}")`
          );
        }
        break;
    }
  }

  for (const term of opts.excludeTerms ?? []) {
    const searchableCols = Object.entries(def.fields)
      .filter(([, f]) => f.type === "text" && f.searchable)
      .map(([k]) => `coalesce(${opts.columnPrefix ? `${opts.columnPrefix}.` : ""}${sanitiseIdent(k)}, '')`);
    const textExpr =
      searchableCols.length > 0
        ? `(coalesce(${opts.columnPrefix ? `${opts.columnPrefix}.` : ""}doc, '') || ' ' || ${searchableCols.join(" || ' ' || ")})`
        : `coalesce(${opts.columnPrefix ? `${opts.columnPrefix}.` : ""}doc, '')`;
    clauses.push(`${textExpr} !~* ${next()}`);
    params.push(escapeRegex(term));
  }

  return {
    where: clauses.length ? clauses.join(" AND ") : "true",
    params,
    softFieldsUsed,
  };
}
