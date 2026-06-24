// Read a raw Cisco CCW export (.xlsx) into structured lines — the "how do we ingest what the
// customer hands us" step. The CCW "Price Estimate" sheet is a grid with a header row and then
// SKU rows interleaved with group headers, sub-headers, subtotals and term annotations; the job
// is to find the table and keep only the real line items.
import { readFileSync } from "node:fs";
import { read, utils } from "xlsx";

export interface ParsedLine {
  partNumber: string;
  description: string;
  listPrice: number;
  qty: number;
  /** Cisco's discount off list — handy to validate our classification in the field. */
  ciscoDiscountPct: number;
  /** Extended net = Cisco's cost for the line (term already applied). We mark this up. */
  netCost: number;
}

const norm = (s: unknown) => String(s ?? "").trim();

export function parseCiscoExport(path: string): ParsedLine[] {
  const wb = read(readFileSync(path));
  // Prefer the sheet that actually carries prices (CCW exports also ship a bare BOM tab).
  const sheetName =
    wb.SheetNames.find((n) =>
      utils
        .sheet_to_json<unknown[]>(wb.Sheets[n], { header: 1, defval: "" })
        .some((r) => (r as unknown[]).some((c) => norm(c) === "Unit List Price")),
    ) ?? wb.SheetNames[0];

  const grid = utils.sheet_to_json<unknown[]>(wb.Sheets[sheetName], { header: 1, blankrows: false, defval: "" });
  const h = grid.findIndex((r) => (r as unknown[]).some((c) => norm(c) === "Part Number"));
  if (h < 0) throw new Error(`no "Part Number" header row found in sheet "${sheetName}"`);

  const header = (grid[h] as unknown[]).map(norm);
  const col = (name: string) => header.indexOf(name);
  const cPart = col("Part Number");
  const cDesc = col("Description");
  const cList = col("Unit List Price");
  const cQty = col("Qty");
  const cDisc = col("Disc(%)");
  const cExt = col("Extended Net Price");

  const out: ParsedLine[] = [];
  for (let i = h + 1; i < grid.length; i++) {
    const r = grid[i] as unknown[];
    const pn = norm(r[cPart]);
    const qty = Number(r[cQty]);
    // A real line has a SKU + a numeric qty. This drops group headers ("Group Name: …"),
    // deployment sub-headers, "Initial Term …" annotation rows, subtotal rows, and blanks.
    if (!pn || pn.startsWith("Group Name:") || pn.startsWith("Initial Term") || !Number.isFinite(qty) || qty <= 0) continue;
    out.push({
      partNumber: pn,
      description: norm(r[cDesc]),
      listPrice: Number(r[cList]) || 0,
      qty,
      ciscoDiscountPct: Number(r[cDisc]) || 0,
      netCost: Number(r[cExt]) || 0,
    });
  }
  return out;
}
