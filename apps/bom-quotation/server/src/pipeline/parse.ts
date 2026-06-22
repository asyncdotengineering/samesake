// Layer 1 — document → raw content.
//   PDF  → liteparse (@llamaindex/liteparse), local, markdown with tables.
//   XLSX → SheetJS, rows as a grid.
// XLSX uses SheetJS directly (cleaner structured rows than routing through
// liteparse/LibreOffice); liteparse is loaded lazily so the spreadsheet path
// works even if its native deps aren't present.
import { readFileSync } from "node:fs";
import { read, utils } from "xlsx";
import { LiteParse } from "@llamaindex/liteparse";

export interface ParsedDoc {
  kind: "pdf" | "xlsx";
  /** Markdown rendering (PDF). */
  markdown?: string;
  /** Cell grid (XLSX). */
  rows?: string[][];
}

export async function parseDocument(path: string): Promise<ParsedDoc> {
  const lower = path.toLowerCase();
  if (lower.endsWith(".xlsx") || lower.endsWith(".xls") || lower.endsWith(".csv")) return parseXlsx(path);
  return parsePdf(path);
}

function parseXlsx(path: string): ParsedDoc {
  const wb = read(readFileSync(path));
  const sheet = wb.Sheets[wb.SheetNames[0]!]!;
  const grid = utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false, defval: "" });
  const rows = grid.map((r) => r.map((c) => String(c ?? "").trim()));
  return { kind: "xlsx", rows };
}

async function parsePdf(path: string): Promise<ParsedDoc> {
  const lp = new LiteParse({ outputFormat: "markdown" });
  const result = await lp.parse(path);
  return { kind: "pdf", markdown: result.text };
}

/** Render an XLSX grid as TSV for the LLM extractor. */
export function gridToText(rows: string[][]): string {
  return rows.map((r) => r.join("\t")).join("\n");
}
