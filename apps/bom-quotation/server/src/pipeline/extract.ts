// Layer 2 — LLM extraction. Messy markdown/grid → clean orderable line items.
// Drops headers, section titles, subtotals, notes, and page furniture.
import { generateStructured } from "../gemini.ts";
import { gridToText, type ParsedDoc } from "./parse.ts";
import type { RawBomLine } from "../../../shared/types.ts";

const SCHEMA = {
  type: "object",
  properties: {
    lines: {
      type: "array",
      items: {
        type: "object",
        properties: {
          description: { type: "string", description: "Verbatim item description" },
          qty: { type: ["number", "null"], description: "Quantity if stated, else null" },
          unit: { type: ["string", "null"], description: "Unit as stated: nos/m/coil/set/lot/roll…" },
          code: { type: ["string", "null"], description: "Client part code / reference if present" },
        },
        required: ["description", "qty", "unit", "code"],
      },
    },
  },
  required: ["lines"],
} as const;

const SYSTEM =
  "You read a bill of quantities / bill of materials from an electrical & MEP project and extract only the orderable supply line items. " +
  "Ignore document headers, company info, section/discipline titles, column headers, page numbers, subtotals, grand totals, and free-text notes. " +
  "Keep each item's description exactly as written (do not summarize or expand). One object per orderable line.";

export async function extractLines(doc: ParsedDoc): Promise<RawBomLine[]> {
  const content = doc.kind === "xlsx" ? gridToText(doc.rows ?? []) : (doc.markdown ?? "");
  if (!content.trim()) return [];
  const prompt = `Extract every orderable line item from this BOM document.\n\n---\n${content}\n---`;
  const out = await generateStructured<{
    lines: Array<{ description: string; qty: number | null; unit: string | null; code: string | null }>;
  }>(prompt, SCHEMA as unknown as Record<string, unknown>, SYSTEM);
  return (out.lines ?? [])
    .filter((l) => l.description?.trim())
    .map((l, i) => ({
      lineNo: i + 1,
      description: l.description.trim(),
      qty: l.qty,
      unit: l.unit,
      code: l.code,
      source: doc.kind,
    }));
}
