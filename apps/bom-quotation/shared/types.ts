// Domain types shared between the Hono backend and the TanStack Start frontend.
// The whole product is "lift-and-shift": swap data/company.json + data/catalog.json
// + data/pricing-rules.json and this same pipeline quotes for any distributor.

// ── BOM ingestion ────────────────────────────────────────────────────────

/** A raw line as it came off the client's BOM (PDF row or spreadsheet row). */
export interface RawBomLine {
  /** 1-based line number as it appeared in the source document. */
  lineNo: number;
  /** The verbatim description text. */
  description: string;
  /** Quantity as stated (may be missing/garbled — re-derived in normalize). */
  qty?: number | string | null;
  /** Unit as stated ("nos", "m", "coil", "set"…). */
  unit?: string | null;
  /** Any client-supplied part code / reference. */
  code?: string | null;
  /** Source provenance for audit. */
  source: "pdf" | "xlsx";
}

/** Structured specs extracted + normalized from a BOM line (electrical/MEP domain). */
export interface LineSpecs {
  /** Cable cores (e.g. 3 for "3C"). */
  cores?: number;
  /** Cross-sectional area in mm² (e.g. 2.5 for "2.5 sqmm"). */
  csaMm2?: number;
  /** Conductor material, canonical ("copper" | "aluminium"). */
  conductor?: string;
  /** Insulation, canonical ("pvc" | "xlpe" | "frls"…). */
  insulation?: string;
  /** Breaker/device current rating in amps (e.g. 32 for "32A"). */
  ratingA?: number;
  /** Poles ("SP" | "DP" | "TP" | "TPN" | "4P"). */
  poles?: string;
  /** Trip curve ("B" | "C" | "D"). */
  curve?: string;
  /** Breaking capacity in kA. */
  breakingKa?: number;
  /** Nominal size for conduit/pipe in mm (e.g. 20 for "20mm"). */
  sizeMm?: number;
  /** Luminaire wattage (e.g. 18 for "18W"). */
  watt?: number;
  /** Distribution-board ways (e.g. 8 for "8 way"). */
  ways?: number;
  /** Free-form leftover attributes the LLM surfaced but we didn't canonicalize. */
  extra?: Record<string, string | number>;
}

/** A BOM line after LLM extraction + the normalization / re-enrichment layer. */
export interface NormalizedBomLine extends RawBomLine {
  /** Canonical, normalized search text handed to the matcher. */
  normalized: string;
  qty: number;
  /** Canonical unit ("nos" | "m" | "set" | "lot"). */
  unit: string;
  /** Per-unit multiplier applied to qty for catalog units (coil→100m ⇒ 100). */
  unitFactor: number;
  category: ProductCategory;
  specs: LineSpecs;
  /** Notes from normalization (e.g. "coil expanded to 100 m"). */
  notes: string[];
}

export type ProductCategory =
  | "cable"
  | "breaker"
  | "conduit"
  | "wiring-accessory"
  | "lighting"
  | "distribution-board"
  | "switch-socket"
  | "earthing"
  | "other";

// ── Catalog ──────────────────────────────────────────────────────────────

export interface CatalogPart {
  /** Internal SKU / part code. */
  code: string;
  description: string;
  brand: string;
  category: ProductCategory;
  /** Selling unit ("nos" | "m" | "set"…). */
  unit: string;
  /** List (pre-discount) unit price in the company's currency. */
  listPrice: number;
  /** Lead time in days (0 = ex-stock). */
  leadDays: number;
  /** Canonical specs for gated matching. */
  specs: LineSpecs;
  /** Alternative names / abbreviations clients use. */
  aliases?: string[];
}

// ── Matching (samesake entity resolution) ──────────────────────────────────

export type MatchStatus = "matched" | "review" | "unmatched";

export interface MatchCandidate {
  code: string;
  description: string;
  brand: string;
  /** samesake combined confidence in [0,1]. */
  confidence: number;
  listPrice: number;
  unit: string;
}

export interface MatchedLine {
  line: NormalizedBomLine;
  status: MatchStatus;
  /** The chosen catalog part (top candidate, or a human override). */
  chosen: MatchCandidate | null;
  /** Other actionable candidates for the review UI. */
  alternatives: MatchCandidate[];
  /** Whether a human confirmed/overrode this match. */
  confirmedByUser: boolean;
}

// ── Pricing + quotation ────────────────────────────────────────────────────

export interface QuoteLine {
  lineNo: number;
  code: string;
  description: string;
  brand: string;
  qty: number;
  unit: string;
  listPrice: number;
  /** Applied discount fraction in [0,1]. */
  discount: number;
  unitPrice: number;
  lineTotal: number;
  leadDays: number;
  /** Human-readable trace of which rules fired (audit). */
  priceTrace: string[];
  status: MatchStatus;
}

export interface QuoteTotals {
  subtotal: number;
  discountTotal: number;
  taxes: Array<{ label: string; rate: number; amount: number }>;
  grandTotal: number;
  currency: string;
}

export interface Quotation {
  quoteNo: string;
  date: string;
  validUntil: string;
  company: Company;
  customer: CustomerRef;
  lines: QuoteLine[];
  /** Lines that need a human decision before the quote is final. */
  unresolved: MatchedLine[];
  totals: QuoteTotals;
  notes: string[];
}

// ── Company + rules config (the lift-and-shift surface) ─────────────────────

export interface Company {
  name: string;
  registration: string;
  address: string;
  phone: string;
  email: string;
  currency: string;
  logoText: string;
}

export interface CustomerRef {
  id: string;
  name: string;
  tier: string;
}

export interface PricingRules {
  /** Customer tiers → base discount off list. */
  tiers: Record<string, { label: string; discount: number }>;
  /** Per-category markup added to list before discount (handling/margin). */
  categoryMarkup: Partial<Record<ProductCategory, number>>;
  /** Per-brand extra margin (positive) or rebate (negative). */
  brandMargin: Record<string, number>;
  /** Quantity-break discounts per category: applied when qty ≥ minQty. */
  qtyBreaks: Array<{ category: ProductCategory | "*"; minQty: number; extraDiscount: number }>;
  taxes: Array<{ label: string; rate: number }>;
  /** Round each unit price to this many decimals. */
  priceDecimals: number;
  /** Quote validity in days. */
  validityDays: number;
  /** samesake confidence thresholds. */
  matching: { autoLink: number; suggest: number };
}
