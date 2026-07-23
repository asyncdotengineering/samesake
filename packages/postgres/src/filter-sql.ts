import type { CollectionDef, ConstraintPredicate } from "@samesake/core";
import { ident } from "./ident.ts";

export interface CompiledFilterSql {
  where: string;
  params: unknown[];
}

export function buildFilterSql(
  predicates: ConstraintPredicate[],
  def: CollectionDef,
  startIndex = 1,
  columnPrefix?: string
): CompiledFilterSql {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const next = () => `$${startIndex + params.length}`;

  for (const predicate of predicates) {
    if (!def.fields[predicate.field]) throw new Error(`Unknown filter field "${predicate.field}"`);
    const col = `${columnPrefix ? `${ident(columnPrefix)}.` : ""}${ident(predicate.field)}`;
    const array = predicate.fieldType === "array";
    switch (predicate.operator) {
      case "eq":
        clauses.push(`${col} = ${next()}`);
        params.push(predicate.value);
        break;
      case "ne":
        clauses.push(`(${col} IS NULL OR ${col} <> ${next()})`);
        params.push(predicate.value);
        break;
      case "gt":
      case "gte":
      case "lt":
      case "lte": {
        const op = { gt: ">", gte: ">=", lt: "<", lte: "<=" }[predicate.operator];
        clauses.push(`${col} ${op} ${next()}::numeric`);
        params.push(predicate.value);
        break;
      }
      case "in":
        clauses.push(`${col} = ANY(${next()}::${predicate.fieldType === "number" ? "numeric" : "text"}[])`);
        params.push(predicate.value);
        break;
      case "nin":
        clauses.push(`(${col} IS NULL OR NOT (${col} = ANY(${next()}::${predicate.fieldType === "number" ? "numeric" : "text"}[])))`);
        params.push(predicate.value);
        break;
      case "contains":
        clauses.push(array ? `${col} && ${next()}::text[]` : `${col} ILIKE '%' || ${next()} || '%'`);
        params.push(predicate.value);
        break;
      case "exclude":
        if (!array) throw new Error(`Operator $exclude requires an array field ("${predicate.field}")`);
        clauses.push(`NOT (${col} && ${next()}::text[])`);
        params.push(predicate.value);
        break;
      case "not":
        if (predicate.fieldType !== "text") throw new Error(`Operator $not requires a text field ("${predicate.field}")`);
        clauses.push(`(${col} IS NULL OR ${col} !~* ${next()})`);
        params.push(String(predicate.value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        break;
    }
  }

  return { where: clauses.length ? clauses.join(" AND ") : "true", params };
}
