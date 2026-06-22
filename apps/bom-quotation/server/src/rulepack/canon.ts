import type { RulePack } from "./schema.ts";

// Synonym keys are stored normalized (lowercased, spaces/dashes stripped); normalize the
// incoming value the same way before lookup.
const norm = (v: unknown): string => String(v).toLowerCase().replace(/[\s-]/g, "");

/** Map a raw attribute value to its canonical form via the pack's synonyms for `group`
 *  (e.g. "single pole" / "1P" → "SP"). Unknown values pass through unchanged. */
export function canon(pack: RulePack, group: string, value: unknown): string {
  if (value == null) return "";
  const map = pack.synonyms[group];
  if (!map) return String(value);
  return map[norm(value)] ?? String(value);
}
