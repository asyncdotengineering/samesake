// Read a raw Cisco CCW export (.xlsx) into structured lines — the "how do we ingest what the
// customer hands us" step. The CCW "Price Estimate" sheet is a grid with a header row and then
// SKU rows interleaved with group headers, sub-headers, subtotals and term annotations; the job
// is to find the table and keep only the real line items.
//
// Format coupling is real: if Cisco renames a column we must FAIL LOUD, never silently quote $0.
// So columns are matched by a list of aliases (case-insensitive), and the required ones are
// validated up front — a recognised-format check, not a silent best-effort. For a truly
// format-agnostic ingest (any vendor's spreadsheet, no alias list), see the LLM `extract` step in
// the bom-quotation pipeline; this parser is the fast, deterministic path for a known format.
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
const lc = (s: unknown) => norm(s).toLowerCase();

// One canonical field → the header names we'll accept for it.
const FIELD_ALIASES = {
  partNumber: ["part number", "part #", "part no", "sku", "product number"],
  description: ["description", "product description", "item description"],
  listPrice: ["unit list price", "list price", "unit price"],
  qty: ["qty", "quantity", "qty."],
  ciscoDiscountPct: ["disc(%)", "discount(%)", "discount %", "disc %", "discount"],
  netCost: ["extended net price", "ext net price", "extended price", "extended net", "net total"],
} as const;
type Field = keyof typeof FIELD_ALIASES;

// A line item must have a SKU, a quantity, and an amount to mark up. Without these we can't quote.
const REQUIRED: Field[] = ["partNumber", "qty", "netCost"];

export function parseCiscoExport(input: string | Buffer): ParsedLine[] {
  const wb = read(typeof input === "string" ? readFileSync(input) : input);

  // Prefer the sheet that actually carries prices (CCW exports also ship a bare BOM tab).
  const sheetName =
    wb.SheetNames.find((n) =>
      utils
        .sheet_to_json<unknown[]>(wb.Sheets[n], { header: 1, defval: "" })
        .some((r) => (r as unknown[]).some((c) => (FIELD_ALIASES.listPrice as readonly string[]).includes(lc(c)))),
    ) ?? wb.SheetNames[0];

  const grid = utils.sheet_to_json<unknown[]>(wb.Sheets[sheetName], { header: 1, blankrows: false, defval: "" });
  const h = grid.findIndex((r) => (r as unknown[]).some((c) => (FIELD_ALIASES.partNumber as readonly string[]).includes(lc(c))));
  if (h < 0) {
    throw new Error(`Unrecognised Cisco export: no part-number header found in sheet "${sheetName}". Expected one of: ${FIELD_ALIASES.partNumber.join(", ")}`);
  }

  const header = (grid[h] as unknown[]).map(lc);
  const cols = {} as Record<Field, number>;
  for (const field of Object.keys(FIELD_ALIASES) as Field[]) {
    cols[field] = header.findIndex((cell) => (FIELD_ALIASES[field] as readonly string[]).includes(cell));
  }
  const missing = REQUIRED.filter((f) => cols[f] < 0);
  if (missing.length) {
    throw new Error(
      `Unrecognised Cisco export — missing required column(s): ${missing.join(", ")}.\n` +
        `Headers found: ${(grid[h] as unknown[]).map(norm).filter(Boolean).join(" | ")}\n` +
        `Add the new name to FIELD_ALIASES, or route this file through the LLM extract path.`,
    );
  }

  const out: ParsedLine[] = [];
  for (let i = h + 1; i < grid.length; i++) {
    const r = grid[i] as unknown[];
    const pn = norm(r[cols.partNumber]);
    const qty = Number(r[cols.qty]);
    // A real line has a SKU + a numeric qty. This drops group headers ("Group Name: …"),
    // deployment sub-headers, "Initial Term …" annotation rows, subtotal rows, and blanks.
    if (!pn || pn.startsWith("Group Name:") || pn.startsWith("Initial Term") || !Number.isFinite(qty) || qty <= 0) continue;
    out.push({
      partNumber: pn,
      description: cols.description >= 0 ? norm(r[cols.description]) : "",
      listPrice: cols.listPrice >= 0 ? Number(r[cols.listPrice]) || 0 : 0,
      qty,
      ciscoDiscountPct: cols.ciscoDiscountPct >= 0 ? Number(r[cols.ciscoDiscountPct]) || 0 : 0,
      netCost: Number(r[cols.netCost]) || 0,
    });
  }
  if (out.length === 0) throw new Error(`Found the header but no line items in sheet "${sheetName}" — format may have changed.`);
  return out;
}
