import type {
  CollectionDef,
  ConstraintTrace,
  ConstraintTraceItem,
  ConstraintTraceKind,
  ConstraintTraceSource,
} from "@samesake/core";
import type { FilterClause, FilterOperator, SearchFilters } from "./search-filter.ts";

function cloneFilters(filters: SearchFilters | undefined): SearchFilters {
  return filters ? JSON.parse(JSON.stringify(filters)) as SearchFilters : {};
}

function isOperatorObject(
  value: FilterClause
): value is Partial<Record<FilterOperator, string | number | boolean | string[] | number[]>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function operatorKind(op: FilterOperator): ConstraintTraceKind {
  switch (op) {
    case "$ne":
      return "not_eq";
    case "$gt":
    case "$gte":
      return "min";
    case "$lt":
    case "$lte":
      return "max";
    case "$in":
      return "in";
    case "$nin":
      return "not_in";
    case "$contains":
      return "contains";
    case "$exclude":
    case "$not":
      return "exclude";
    case "$eq":
    default:
      return "eq";
  }
}

function defaultKind(value: FilterClause): ConstraintTraceKind {
  if (typeof value === "boolean") return "boolean";
  if (Array.isArray(value)) return "contains";
  return "eq";
}

export function traceFilterItems(
  def: CollectionDef,
  filters: SearchFilters | undefined,
  source: ConstraintTraceSource
): ConstraintTraceItem[] {
  const items: ConstraintTraceItem[] = [];
  for (const [field, value] of Object.entries(filters ?? {})) {
    const soft = def.fields[field]?.soft === true;
    if (isOperatorObject(value)) {
      const ops = Object.entries(value) as Array<[FilterOperator, unknown]>;
      const hasMin = ops.some(([op]) => op === "$gt" || op === "$gte");
      const hasMax = ops.some(([op]) => op === "$lt" || op === "$lte");
      if (hasMin && hasMax) {
        items.push({ field, source, kind: "range", value, soft });
        continue;
      }
      for (const [operator, operatorValue] of ops) {
        items.push({
          field,
          source,
          kind: operatorKind(operator),
          operator,
          value: operatorValue,
          soft,
        });
      }
      continue;
    }
    items.push({ field, source, kind: defaultKind(value), value, soft });
  }
  return items;
}

export function relaxedSoftFields(def: CollectionDef, filters: SearchFilters, softFieldsUsed: string[]): string[] {
  return [...new Set([
    ...softFieldsUsed,
    ...Object.keys(filters).filter((field) => def.fields[field]?.soft === true),
  ])].sort();
}

export function buildConstraintTrace(
  def: CollectionDef,
  input: {
    semanticQuery?: string;
    derivedFilters: SearchFilters;
    explicitFilters?: SearchFilters;
    appliedFilters: SearchFilters;
    relaxedFields?: string[];
    excludedTerms?: string[];
    budgetHints?: Record<string, "cheap" | "premium">;
  }
): ConstraintTrace {
  const explicitFilters = input.explicitFilters ?? {};
  const items = [
    ...traceFilterItems(def, input.derivedFilters, "nlq"),
    ...traceFilterItems(def, explicitFilters, "explicit"),
  ];

  for (const [field, hint] of Object.entries(input.budgetHints ?? {})) {
    const alreadyDerived = Object.hasOwn(input.derivedFilters, field);
    const explicitlySet = Object.hasOwn(explicitFilters, field);
    if (!alreadyDerived && !explicitlySet && Object.hasOwn(input.appliedFilters, field)) {
      items.push({
        field,
        source: "budget_hint",
        kind: hint === "cheap" ? "max" : "min",
        value: input.appliedFilters[field],
        soft: def.fields[field]?.soft === true,
      });
    }
  }

  return {
    semanticQuery: input.semanticQuery,
    items,
    derivedFilters: cloneFilters(input.derivedFilters),
    explicitFilters: cloneFilters(explicitFilters),
    appliedFilters: cloneFilters(input.appliedFilters),
    relaxedFields: [...new Set(input.relaxedFields ?? [])].sort(),
    excludedTerms: [...(input.excludedTerms ?? [])],
    budgetHints: { ...(input.budgetHints ?? {}) },
  };
}
