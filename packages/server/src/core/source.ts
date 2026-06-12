/**
 * Resolve a source-expression against a data record.
 *
 * Forms:
 *   - "name"                      → data.name
 *   - "$name $variant"            → `${data.name ?? ""} ${data.variant ?? ""}`.trim()
 *   - "$brand|$item_canonical"    → first non-empty
 */
export function resolveSource(
  expression: string,
  data: Record<string, unknown>,
  parsed?: Record<string, unknown>
): string {
  const all = { ...data, ...(parsed ?? {}) };

  // Plain field name (no $)
  if (!expression.includes("$")) {
    const v = all[expression];
    return v == null ? "" : String(v);
  }

  // Pipe (|) means first non-empty
  if (expression.includes("|")) {
    for (const part of expression.split("|").map((s) => s.trim())) {
      const r = resolveSource(part, data, parsed);
      if (r) return r;
    }
    return "";
  }

  // Template expression — substitute $fieldname tokens
  return expression
    .replace(/\$([a-zA-Z_][a-zA-Z0-9_]*)/g, (_m, name) => {
      const v = all[name];
      return v == null ? "" : String(v);
    })
    .trim()
    .replace(/\s+/g, " ");
}
