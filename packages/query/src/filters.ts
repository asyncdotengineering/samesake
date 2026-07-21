// The filter-request brain — store-agnostic. This module owns the public
// filter AST (`FilterOperator` / `FilterClause` / `SearchFilters`) and the
// pure `SearchFilters -> ConstraintPredicate[]` normaliser (validation only;
// no SQL, no `$N`, no db handle). The predicate->SQL compiler lives in
// @samesake/server, which re-exports these symbols so existing importers
// resolve unchanged. Depends only on @samesake/core.
import type { CollectionDef, CollectionFieldDef, ConstraintPredicate, ConstraintTraceSource } from "@samesake/core";
import { ClientError } from "@samesake/core";

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
