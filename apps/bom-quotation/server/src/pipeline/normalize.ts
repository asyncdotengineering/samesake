// Layer 3 — re-enrichment / normalization. The single highest-leverage step for
// match quality: it turns client shorthand ("3C x 2.5 sqmm Cu/PVC", "32A SP MCB",
// "ELCB 40A", "coil") into a canonical description + structured specs + canonical
// units, so both the query and the catalog speak the same language.
import { generateStructured } from "../gemini.ts";
import type { RawBomLine, NormalizedBomLine, ProductCategory } from "../../../shared/types.ts";

const CATEGORIES: ProductCategory[] = [
  "cable", "breaker", "conduit", "wiring-accessory", "lighting",
  "distribution-board", "switch-socket", "earthing", "other",
];

const SCHEMA = {
  type: "object",
  properties: {
    lines: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "number" },
          normalized: { type: "string", description: "Canonical catalog-search description, abbreviations expanded" },
          category: { type: "string", enum: CATEGORIES },
          qty: { type: "number" },
          unit: { type: "string", enum: ["nos", "m", "set", "lot"] },
          unitFactor: { type: "number", description: "Multiplier from stated unit to canonical (coil of cable→100, drum→500, else 1)" },
          cores: { type: ["number", "null"] },
          csaMm2: { type: ["number", "null"] },
          conductor: { type: ["string", "null"] },
          insulation: { type: ["string", "null"] },
          ratingA: { type: ["number", "null"] },
          poles: { type: ["string", "null"] },
          curve: { type: ["string", "null"] },
          breakingKa: { type: ["number", "null"] },
          sizeMm: { type: ["number", "null"] },
          watt: { type: ["number", "null"], description: "Luminaire wattage" },
          ways: { type: ["number", "null"], description: "Distribution-board ways" },
          notes: { type: "array", items: { type: "string" } },
        },
        required: ["index", "normalized", "category", "qty", "unit", "unitFactor", "notes"],
      },
    },
  },
  required: ["lines"],
} as const;

const SYSTEM =
  "You normalize electrical & MEP bill-of-material lines for catalog matching. Expand all trade shorthand: " +
  "Cu→copper, Al→aluminium, sqmm/mm2→mm², SP→single pole, DP→double pole, TP→triple pole, TPN→triple pole and neutral, " +
  "MCB→miniature circuit breaker, MCCB→moulded case circuit breaker, RCCB/ELCB→residual current circuit breaker, " +
  "DB→distribution board, PVC/XLPE insulation, C/B/D curve. Parse numeric specs (cores, CSA in mm², current rating in A, " +
  "poles, trip curve, breaking capacity kA, nominal size mm). Canonicalise units to nos/m/set/lot and set unitFactor " +
  "(a coil of cable = 100 m → unitFactor 100; a 500 m drum → 500; everything else 1). " +
  "Quantities default to 1 when absent. Keep 'normalized' concise and specification-led.";

type LlmLine = {
  index: number; normalized: string; category: ProductCategory; qty: number; unit: string; unitFactor: number;
  cores?: number | null; csaMm2?: number | null; conductor?: string | null; insulation?: string | null;
  ratingA?: number | null; poles?: string | null; curve?: string | null; breakingKa?: number | null;
  sizeMm?: number | null; watt?: number | null; ways?: number | null; notes?: string[];
};

export async function normalizeLines(raw: RawBomLine[]): Promise<NormalizedBomLine[]> {
  if (raw.length === 0) return [];
  const listing = raw
    .map((l, i) => `[${i}] "${l.description}" | qty=${l.qty ?? "?"} | unit=${l.unit ?? "?"} | code=${l.code ?? "-"}`)
    .join("\n");
  const out = await generateStructured<{ lines: LlmLine[] }>(
    `Normalize these BOM lines. Return one object per line, keyed by index.\n\n${listing}`,
    SCHEMA as unknown as Record<string, unknown>,
    SYSTEM
  );
  const byIndex = new Map(out.lines.map((l) => [l.index, l]));
  return raw.map((r, i): NormalizedBomLine => {
    const n = byIndex.get(i);
    const qty = n?.qty && n.qty > 0 ? n.qty : 1;
    const unitFactor = n?.unitFactor && n.unitFactor > 0 ? n.unitFactor : 1;
    const specs: NormalizedBomLine["specs"] = {};
    if (n) {
      if (n.cores != null) specs.cores = n.cores;
      if (n.csaMm2 != null) specs.csaMm2 = n.csaMm2;
      if (n.conductor) specs.conductor = n.conductor;
      if (n.insulation) specs.insulation = n.insulation;
      if (n.ratingA != null) specs.ratingA = n.ratingA;
      if (n.poles) specs.poles = n.poles;
      if (n.curve) specs.curve = n.curve;
      if (n.breakingKa != null) specs.breakingKa = n.breakingKa;
      if (n.sizeMm != null) specs.sizeMm = n.sizeMm;
      if (n.watt != null) specs.watt = n.watt;
      if (n.ways != null) specs.ways = n.ways;
    }
    return {
      ...r,
      normalized: n?.normalized?.trim() || r.description,
      qty: qty * unitFactor,
      unit: (n?.unit as NormalizedBomLine["unit"]) ?? "nos",
      unitFactor,
      category: n?.category ?? "other",
      specs,
      notes: n?.notes ?? [],
    };
  });
}
