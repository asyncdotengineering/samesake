// Layer 6 — assemble the quotation and render the PDF.
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { priceLine } from "./price.ts";
import type {
  MatchedLine, Quotation, QuoteLine, QuoteTotals, Company, CustomerRef, PricingRules,
} from "../../../shared/types.ts";

const round = (x: number, d: number): number => {
  const f = 10 ** d;
  return Math.round(x * f) / f;
};

export function assembleQuotation(
  matched: MatchedLine[],
  company: Company,
  customer: CustomerRef,
  rules: PricingRules,
  quoteNo: string,
  today: Date
): Quotation {
  const priced = matched.filter((m) => m.status === "matched" && m.chosen).map((m) => priceLine(m, customer, rules));
  const unresolved = matched.filter((m) => m.status !== "matched");

  const subtotal = round(priced.reduce((s, l) => s + l.lineTotal, 0), rules.priceDecimals);
  const listTotal = priced.reduce((s, l) => s + l.listPrice * l.qty, 0);
  const discountTotal = round(listTotal - subtotal, rules.priceDecimals);
  const taxes = rules.taxes.map((t) => ({ label: t.label, rate: t.rate, amount: round(subtotal * t.rate, rules.priceDecimals) }));
  const grandTotal = round(subtotal + taxes.reduce((s, t) => s + t.amount, 0), rules.priceDecimals);

  const valid = new Date(today);
  valid.setDate(valid.getDate() + rules.validityDays);

  const totals: QuoteTotals = { subtotal, discountTotal, taxes, grandTotal, currency: company.currency };
  const notes: string[] = [];
  if (unresolved.length) notes.push(`${unresolved.length} line(s) need confirmation before this quote is final.`);
  const maxLead = Math.max(0, ...priced.map((l) => l.leadDays));
  if (maxLead > 0) notes.push(`Lead time up to ${maxLead} working days on some items.`);

  return {
    quoteNo,
    date: today.toISOString().slice(0, 10),
    validUntil: valid.toISOString().slice(0, 10),
    company,
    customer,
    lines: priced,
    unresolved,
    totals,
    notes,
  };
}

// ── PDF rendering (pdf-lib, standard fonts — no external font files) ─────────

const money = (n: number, ccy: string): string =>
  `${ccy} ${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export async function renderQuotationPdf(q: Quotation): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let page = doc.addPage([595, 842]); // A4
  const M = 40;
  let y = 800;

  // pdf-lib's standard fonts are WinAnsi (CP1252); map the few non-encodable glyphs.
  const san = (s: string): string => s.replace(/≥/g, ">=").replace(/≤/g, "<=").replace(/→/g, "->");
  const text = (s: string, x: number, yy: number, size = 9, f: PDFFont = font, color = rgb(0.1, 0.1, 0.1)) =>
    page.drawText(san(s), { x, y: yy, size, font: f, color });

  // Header
  text(q.company.logoText, M, y, 22, bold, rgb(0.06, 0.36, 0.7));
  text("QUOTATION", 595 - M - bold.widthOfTextAtSize("QUOTATION", 16), y + 2, 16, bold);
  y -= 16;
  text(q.company.name, M, y, 9, bold);
  text(`No.  ${q.quoteNo}`, 595 - M - 150, y, 9);
  y -= 12;
  for (const ln of [q.company.address, `${q.company.phone}  ·  ${q.company.email}`, `Reg. ${q.company.registration}`]) {
    text(ln, M, y, 8, font, rgb(0.4, 0.4, 0.4));
    y -= 11;
  }
  text(`Date  ${q.date}`, 595 - M - 150, y + 22, 9);
  text(`Valid until  ${q.validUntil}`, 595 - M - 150, y + 11, 9);

  y -= 14;
  page.drawLine({ start: { x: M, y }, end: { x: 595 - M, y }, thickness: 1, color: rgb(0.85, 0.85, 0.85) });
  y -= 18;
  text("To:", M, y, 9, bold);
  text(`${q.customer.name}  (${q.customer.tier})`, M + 24, y, 9);
  y -= 22;

  // Table
  const cols = [
    { h: "#", x: M, w: 22, align: "l" as const },
    { h: "Code", x: M + 22, w: 86, align: "l" as const },
    { h: "Description", x: M + 108, w: 210, align: "l" as const },
    { h: "Qty", x: M + 318, w: 50, align: "r" as const },
    { h: "Unit Price", x: M + 368, w: 70, align: "r" as const },
    { h: "Amount", x: M + 438, w: 77, align: "r" as const },
  ];
  const drawRow = (cells: string[], yy: number, f: PDFFont, size = 8) => {
    cols.forEach((c, i) => {
      const s = san(cells[i] ?? "");
      const w = f.widthOfTextAtSize(s, size);
      const x = c.align === "r" ? c.x + c.w - w : c.x;
      page.drawText(s, { x, y: yy, size, font: f, color: rgb(0.12, 0.12, 0.12) });
    });
  };
  page.drawRectangle({ x: M, y: y - 4, width: 595 - 2 * M, height: 16, color: rgb(0.93, 0.95, 0.99) });
  drawRow(cols.map((c) => c.h), y, bold, 8);
  y -= 18;

  const ensureSpace = () => {
    if (y < 120) {
      page = doc.addPage([595, 842]);
      y = 800;
    }
  };
  for (const l of q.lines) {
    ensureSpace();
    drawRow(
      [String(l.lineNo), l.code, truncate(l.description, 46), `${l.qty} ${l.unit}`, fmt(l.unitPrice), fmt(l.lineTotal)],
      y, font, 8
    );
    y -= 13;
    if (l.priceTrace.length) {
      text(l.priceTrace.join("  ·  "), M + 108, y + 1, 6.5, font, rgb(0.55, 0.55, 0.55));
      y -= 9;
    }
  }

  // Totals
  y -= 8;
  page.drawLine({ start: { x: M + 318, y }, end: { x: 595 - M, y }, thickness: 0.5, color: rgb(0.8, 0.8, 0.8) });
  y -= 14;
  const totalRow = (label: string, val: string, f: PDFFont = font, size = 9) => {
    text(label, M + 318, y, size, f);
    const w = f.widthOfTextAtSize(val, size);
    text(val, 595 - M - w, y, size, f);
    y -= 14;
  };
  totalRow("Subtotal", money(q.totals.subtotal, q.totals.currency));
  if (q.totals.discountTotal > 0) totalRow("Total savings", `- ${money(q.totals.discountTotal, q.totals.currency)}`);
  for (const t of q.totals.taxes) totalRow(`${t.label} (${Math.round(t.rate * 100)}%)`, money(t.amount, q.totals.currency));
  y -= 2;
  totalRow("GRAND TOTAL", money(q.totals.grandTotal, q.totals.currency), bold, 11);

  // Notes
  if (q.notes.length) {
    y -= 10;
    text("Notes", M, y, 9, bold);
    y -= 12;
    for (const n of q.notes) {
      text(`•  ${n}`, M, y, 8, font, rgb(0.4, 0.4, 0.4));
      y -= 11;
    }
  }
  text("This is a system-generated quotation. E.&O.E.", M, 40, 7, font, rgb(0.6, 0.6, 0.6));

  return doc.save();
}

const fmt = (n: number): string => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const truncate = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + "…" : s);
