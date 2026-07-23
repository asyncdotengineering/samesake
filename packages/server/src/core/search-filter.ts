import type { CollectionDef } from "@samesake/core";
import { ClientError } from "../errors.ts";
import { sanitiseIdent } from "./schema-gen.ts";
import { normalizeFiltersToConstraintPredicates } from "@samesake/query";
import type { SearchFilters } from "@samesake/query";

// Re-export the brain symbols so existing ./search-filter.ts importers
// (search.ts, constraint-trace.ts, search-query.ts) resolve unchanged.
// The pure AST + normaliser live in @samesake/query; only the predicate->SQL
// compiler stays here.
export {
  normalizeFiltersToConstraintPredicates,
  type SearchFilters,
  type FilterClause,
  type FilterOperator,
} from "@samesake/query";

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

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
