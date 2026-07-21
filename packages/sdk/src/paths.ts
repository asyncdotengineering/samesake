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
