import type {
  CollectionDef,
  ConstraintPlan,
  ConstraintPredicate,
  ConstraintTrace,
  ConstraintTraceItem,
  ConstraintTraceKind,
  ConstraintTraceSource,
  GroundedValueDecision,
  RelaxationStep,
  RewriteRecord,
} from "@samesake/core";
import { normalizeFiltersToConstraintPredicates, type SearchFilters } from "./search-filter.ts";

function cloneFilters(filters: SearchFilters | undefined): SearchFilters {
  return filters ? JSON.parse(JSON.stringify(filters)) as SearchFilters : {};
}

function predicateKind(predicate: ConstraintPredicate): ConstraintTraceKind {
  switch (predicate.operator) {
    case "ne":
      return "not_eq";
    case "gt":
    case "gte":
      return "min";
    case "lt":
    case "lte":
      return "max";
    case "in":
      return "in";
    case "nin":
      return "not_in";
    case "contains":
      return "contains";
    case "exclude":
    case "not":
      return "exclude";
    case "eq":
    default:
      if (predicate.fieldType === "boolean") return "boolean";
      return "eq";
  }
}

export function traceFilterItems(
  def: CollectionDef,
  filters: SearchFilters | undefined,
  source: ConstraintTraceSource
): ConstraintTraceItem[] {
  return predicatesToTraceItems(normalizeFiltersToConstraintPredicates(filters ?? {}, def, source));
}

export function relaxedSoftFields(def: CollectionDef, filters: SearchFilters, softFieldsUsed: string[]): string[] {
  return [...new Set([
    ...softFieldsUsed,
    ...Object.keys(filters).filter((field) => def.fields[field]?.soft === true),
  ])].sort();
}

function sourceForAppliedField(
  field: string,
  input: {
    derivedFilters: SearchFilters;
    deterministicFilters?: SearchFilters;
    explicitFilters: SearchFilters;
    appliedFilters: SearchFilters;
    budgetHints?: Record<string, "cheap" | "premium">;
  }
): ConstraintTraceSource {
  if (Object.hasOwn(input.explicitFilters, field)) return "explicit";
  if (Object.hasOwn(input.deterministicFilters ?? {}, field)) return "deterministic";
  if (
    Object.hasOwn(input.budgetHints ?? {}, field) &&
    !Object.hasOwn(input.derivedFilters, field) &&
    Object.hasOwn(input.appliedFilters, field)
  ) {
    return "budget_hint";
  }
  return "nlq";
}

function buildConstraintPlan(
  def: CollectionDef,
  input: {
    derivedFilters: SearchFilters;
    deterministicFilters?: SearchFilters;
    explicitFilters: SearchFilters;
    appliedFilters: SearchFilters;
    relaxedFields?: string[];
    excludedTerms?: string[];
    budgetHints?: Record<string, "cheap" | "premium">;
  }
): ConstraintPlan {
  const predicates: ConstraintPredicate[] = [];
  for (const [field, value] of Object.entries(input.appliedFilters)) {
    predicates.push(
      ...normalizeFiltersToConstraintPredicates(
        { [field]: value } as SearchFilters,
        def,
        sourceForAppliedField(field, input)
      )
    );
  }
  return {
    predicates,
    excludedTerms: [...(input.excludedTerms ?? [])],
    relaxedFields: [...new Set(input.relaxedFields ?? [])].sort(),
  };
}

function predicatesToTraceItems(predicates: ConstraintPredicate[]): ConstraintTraceItem[] {
  return predicates.map((predicate) => ({
    field: predicate.field,
    source: predicate.source ?? "explicit",
    kind: predicateKind(predicate),
    operator: predicate.operator,
    value: predicate.value,
    soft: predicate.soft,
  }));
}

export function buildConstraintTrace(
  def: CollectionDef,
  input: {
    semanticQuery?: string;
    derivedFilters: SearchFilters;
    deterministicFilters?: SearchFilters;
    explicitFilters?: SearchFilters;
    appliedFilters: SearchFilters;
    relaxedFields?: string[];
    relaxationSteps?: RelaxationStep[];
    groundedValues?: Record<string, GroundedValueDecision[]>;
    rewritten?: RewriteRecord;
    excludedTerms?: string[];
    budgetHints?: Record<string, "cheap" | "premium">;
  }
): ConstraintTrace {
  const explicitFilters = input.explicitFilters ?? {};
  const plan = buildConstraintPlan(def, {
    derivedFilters: input.derivedFilters,
    deterministicFilters: input.deterministicFilters ?? {},
    explicitFilters,
    appliedFilters: input.appliedFilters,
    relaxedFields: input.relaxedFields,
    excludedTerms: input.excludedTerms,
    budgetHints: input.budgetHints,
  });

  return {
    semanticQuery: input.semanticQuery,
    items: predicatesToTraceItems(plan.predicates),
    plan,
    derivedFilters: cloneFilters(input.derivedFilters),
    explicitFilters: cloneFilters(explicitFilters),
    appliedFilters: cloneFilters(input.appliedFilters),
    relaxedFields: [...new Set(input.relaxedFields ?? [])].sort(),
    excludedTerms: [...(input.excludedTerms ?? [])],
    budgetHints: { ...(input.budgetHints ?? {}) },
    deterministicFilters: cloneFilters(input.deterministicFilters),
    groundedValues: JSON.parse(JSON.stringify(input.groundedValues ?? {})) as Record<string, GroundedValueDecision[]>,
    relaxationSteps: [...(input.relaxationSteps ?? [])],
    ...(input.rewritten ? { rewritten: input.rewritten } : {}),
  };
}
