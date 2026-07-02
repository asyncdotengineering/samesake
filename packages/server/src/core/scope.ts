// Tenancy enforcement: every read/write on a scoped collection must carry the
// full scope. One resolver so push/search/facets/remove all fail the same way.
import type { CollectionDef } from "@samesake/core";
import { collectionScopes, scopeColumn } from "./collections-schema-gen.ts";

/**
 * Validate a caller-supplied scope against the collection's declared scopes.
 * Returns a sanitised column→value map (empty for unscoped collections).
 */
export function resolveScope(
  def: CollectionDef,
  collectionName: string,
  scope: Record<string, string> | undefined,
  op: string
): Record<string, string> {
  const declared = collectionScopes(def);
  const provided = scope ?? {};
  const providedKeys = Object.keys(provided);

  if (declared.length === 0) {
    if (providedKeys.length > 0) {
      throw new Error(
        `collection "${collectionName}" declares no scopes — remove scope from ${op}`
      );
    }
    return {};
  }

  const cols: Record<string, string> = {};
  for (const key of declared) {
    const value = provided[key];
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(
        `collection "${collectionName}" declares scopes [${declared.join(", ")}] — ${op} requires scope.${key}`
      );
    }
    cols[scopeColumn(key)] = value;
  }
  for (const key of providedKeys) {
    if (!declared.includes(key)) {
      throw new Error(
        `collection "${collectionName}": unknown scope key "${key}" (declared: [${declared.join(", ")}])`
      );
    }
  }
  return cols;
}

/** Append scope equality conditions to a compiled WHERE + positional params. */
export function appendScopeSql(
  where: string,
  params: unknown[],
  scopeCols: Record<string, string>
): { where: string; params: unknown[] } {
  let outWhere = where;
  const outParams = [...params];
  for (const [col, value] of Object.entries(scopeCols)) {
    outParams.push(value);
    const cond = `${col} = $${outParams.length}`;
    outWhere = outWhere === "true" ? cond : `${outWhere} AND ${cond}`;
  }
  return { where: outWhere, params: outParams };
}
