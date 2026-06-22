// Generates a realistic *client* BOM — the messy input a contractor emails in —
// as both XLSX and PDF, so the pipeline can be demoed on either. Deliberately
// uses trade shorthand (3C, sqmm, Cu/PVC, SP, ELCB, SPN, coil) and one item the
// catalog does not carry, to exercise extraction, normalization, spec-gating,
// and the human-review path.
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { utils, write } from "xlsx";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const OUT = join(import.meta.dir, "../data/sample-bom");
mkdirSync(OUT, { recursive: true });

const HEADER = ["Item", "Description", "Qty", "Unit"];
const ROWS: Array<[number, string, number, string]> = [
  [1, "3C x 2.5 sqmm Cu/PVC power cable", 250, "m"],
  [2, "2.5mm flexible wire copper", 1, "coil"],
  [3, "32A SP MCB Schneider C curve", 8, "nos"],
  [4, "63A TP MCB 10kA", 1, "nos"],
  [5, "ELCB 40A 30mA double pole", 2, "nos"],
  [6, "Wiring conduit 20mm PVC heavy", 300, "m"],
  [7, "Junction box 4x4 with cover", 30, "nos"],
  [8, "13A switched socket outlet single", 24, "nos"],
  [9, "1 gang 1 way switch", 18, "nos"],
  [10, "LED panel light 18W recessed", 40, "nos"],
  [11, "9W LED bulb B22 daylight", 60, "nos"],
  [12, "8 way SPN distribution board flush", 2, "nos"],
  [13, "Copper earth rod 16mm 4ft", 4, "nos"],
  [14, "Cable gland 20mm brass", 50, "nos"],
  [15, "PVC insulation tape black", 20, "nos"],
  [16, "Smoke detector 2 wire conventional", 6, "nos"],
];

// ── XLSX ───────────────────────────────────────────────────────────────────
const ws = utils.aoa_to_sheet([
  ["GREENFIELD APARTMENTS — ELECTRICAL BOM"],
  ["Client: Horizon Construction (Pvt) Ltd", "", "Tender: GA/EL/2026/07"],
  [],
  HEADER,
  ...ROWS,
  [],
  ["Note: Supply only. Delivery to Malabe site. Please quote your best rates."],
]);
const wb = utils.book_new();
utils.book_append_sheet(wb, ws, "BOM");
writeFileSync(join(OUT, "bom.xlsx"), write(wb, { type: "buffer", bookType: "xlsx" }));

// ── PDF ──────────────────────────────────────────────────────────────────--
const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
const bold = await doc.embedFont(StandardFonts.HelveticaBold);
const page = doc.addPage([595, 842]);
let y = 800;
const M = 44;
const t = (s: string, x: number, yy: number, size = 9, f = font, c = rgb(0.1, 0.1, 0.1)) =>
  page.drawText(s, { x, y: yy, size, font: f, color: c });

t("HORIZON CONSTRUCTION (PVT) LTD", M, y, 14, bold);
y -= 16;
t("Bill of Quantities — Electrical (Supply Only)", M, y, 10, font, rgb(0.35, 0.35, 0.35));
y -= 12;
t("Project: Greenfield Apartments, Malabe   ·   Tender: GA/EL/2026/07", M, y, 8, font, rgb(0.45, 0.45, 0.45));
y -= 22;
page.drawRectangle({ x: M, y: y - 4, width: 595 - 2 * M, height: 16, color: rgb(0.92, 0.92, 0.92) });
const cx = [M + 2, M + 30, M + 360, M + 430];
HEADER.forEach((h, i) => t(h, cx[i]!, y, 9, bold));
y -= 18;
for (const [no, desc, qty, unit] of ROWS) {
  t(String(no), cx[0]!, y, 8);
  t(desc, cx[1]!, y, 8);
  t(String(qty), cx[2]!, y, 8);
  t(unit, cx[3]!, y, 8);
  y -= 14;
}
y -= 14;
t("Note: Supply only. Delivery to Malabe site. Please quote your best rates.", M, y, 8, font, rgb(0.4, 0.4, 0.4));
writeFileSync(join(OUT, "bom.pdf"), await doc.save());

console.log(`Sample BOM written:\n  ${join(OUT, "bom.xlsx")}\n  ${join(OUT, "bom.pdf")}\n  (${ROWS.length} lines)`);
