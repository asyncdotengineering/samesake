import type { CollectionFieldDef } from "./types.ts";

/** Read a possibly-dotted path (e.g. "enriched.color") out of a nested record. */
export function getByPath(root: Record<string, unknown>, path: string): unknown {
  if (!path.includes(".")) return root[path];
  let cur: unknown = root;
  for (const part of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * Resolve one collection field's value from a row's raw `data` / `enriched`.
 * A field's source path defaults to its name; an `enriched.`-prefixed path reads
 * from the enriched attributes instead of the raw data.
 */
export function resolveFieldValue(
  name: string,
  fieldDef: CollectionFieldDef,
  data: Record<string, unknown>,
  enriched: Record<string, unknown> | null
): unknown {
  const path = fieldDef.path ?? name;
  if (path.startsWith("enriched.")) return getByPath(enriched ?? {}, path.slice("enriched.".length));
  return getByPath(data, path);
}

/** Project every declared field into its column value (`undefined` normalised to `null`). */
export function projectFields(
  fields: Record<string, CollectionFieldDef>,
  data: Record<string, unknown>,
  enriched: Record<string, unknown> | null
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, fieldDef] of Object.entries(fields)) {
    const value = resolveFieldValue(name, fieldDef, data, enriched);
    out[name] = value === undefined ? null : value;
  }
  return out;
}
