// Layer 3 — re-enrichment / normalization. Turns client shorthand ("3C x 2.5 sqmm Cu/PVC",
// "32A SP MCB", "ELCB 40A", "coil") into a canonical description + structured specs + canonical
// units. The extraction schema AND the prompt are built from the active rule pack — the pack's
// attributes, categories, synonyms, and units — so this layer is vertical-agnostic.
import { generateStructured } from "../gemini.ts";
import { activePack } from "../rulepack/load.ts";
import type { RawBomLine, NormalizedBomLine, LineSpecs } from "../../../shared/types.ts";
import type { RulePack } from "../rulepack/schema.ts";

function buildSchema(pack: RulePack): Record<string, unknown> {
  const props: Record<string, unknown> = {
    index: { type: "number" },
    normalized: { type: "string", description: "Canonical, abbreviation-expanded description" },
    category: pack.categories.length ? { type: "string", enum: pack.categories } : { type: "string" },
    qty: { type: "number" },
    unit: { type: "string", enum: ["nos", "m", "set", "lot"] },
    unitFactor: { type: "number", description: "Multiplier from the stated unit to the canonical one, else 1" },
    notes: { type: "array", items: { type: "string" } },
  };
  for (const a of pack.attributes) {
    props[a.key] = {
      type: a.type === "number" ? ["number", "null"] : ["string", "null"],
      description: a.label + (a.values ? ` (one of: ${a.values.join(", ")})` : ""),
    };
  }
  return {
    type: "object",
    properties: {
      lines: {
        type: "array",
        items: {
          type: "object",
          properties: props,
          required: ["index", "normalized", "category", "qty", "unit", "unitFactor", "notes"],
        },
      },
    },
    required: ["lines"],
  };
}

function buildSystem(pack: RulePack): string {
  const expansions = Object.values(pack.synonyms).flatMap((m) =>
    Object.entries(m).map(([variant, canonical]) => `${variant}→${canonical}`)
  );
  const specList = pack.attributes
    .map((a) => `${a.key} (${a.label})${a.values ? ` ∈ {${a.values.join(", ")}}` : ""}`)
    .join("; ");
  const unitList = Object.entries(pack.units).map(([u, f]) => `${u}=${f}`).join(", ");
  return [
    `You normalize ${pack.vertical} bill-of-material lines for catalog matching.`,
    expansions.length ? `Expand trade shorthand and canonicalize values: ${expansions.join(", ")}.` : "",
    specList ? `Parse these specs when present, using the canonical enum values shown: ${specList}.` : "",
    `Canonicalise units to nos/m/set/lot and set unitFactor` +
      (unitList ? ` (${unitList}; everything else 1).` : " (default 1)."),
    `Quantities default to 1 when absent. Keep 'normalized' concise and specification-led.`,
  ]
    .filter(Boolean)
    .join(" ");
}

export async function normalizeLines(raw: RawBomLine[]): Promise<NormalizedBomLine[]> {
  if (raw.length === 0) return [];
  const pack = activePack();
  const listing = raw
    .map((l, i) => `[${i}] "${l.description}" | qty=${l.qty ?? "?"} | unit=${l.unit ?? "?"} | code=${l.code ?? "-"}`)
    .join("\n");
  const out = await generateStructured<{ lines: Array<Record<string, unknown>> }>(
    `Normalize these BOM lines. Return one object per line, keyed by index.\n\n${listing}`,
    buildSchema(pack),
    buildSystem(pack)
  );
  const byIndex = new Map(out.lines.map((l) => [Number(l.index), l]));

  return raw.map((r, i): NormalizedBomLine => {
    const n = byIndex.get(i);
    const qtyRaw = typeof n?.qty === "number" && n.qty > 0 ? n.qty : 1;
    const unitFactor = typeof n?.unitFactor === "number" && n.unitFactor > 0 ? n.unitFactor : 1;
    const specs: LineSpecs = {};
    if (n) {
      for (const a of pack.attributes) {
        const v = n[a.key];
        if (v == null || v === "") continue;
        (specs as Record<string, unknown>)[a.key] = a.type === "number" ? Number(v) : String(v);
      }
    }
    return {
      ...r,
      normalized: (typeof n?.normalized === "string" && n.normalized.trim()) || r.description,
      qty: qtyRaw * unitFactor,
      unit: (typeof n?.unit === "string" ? n.unit : "nos") as NormalizedBomLine["unit"],
      unitFactor,
      category: (typeof n?.category === "string" ? n.category : "other") as NormalizedBomLine["category"],
      specs,
      notes: Array.isArray(n?.notes) ? (n!.notes as string[]) : [],
    };
  });
}
