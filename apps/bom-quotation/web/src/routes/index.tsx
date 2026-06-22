import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  Company,
  MatchCandidate,
  MatchedLine,
  PricingRules,
  Quotation,
  QuoteLine,
} from "../../../shared/types.ts";
import {
  downloadQuotePdf,
  fetchConfig,
  postConfirm,
  postMatch,
  postPrice,
  postQuote,
} from "~/lib/api";
import { computeTotals, formatMoney } from "~/lib/pricing";

export const Route = createFileRoute("/")({
  component: QuotationBuilder,
});

const STAGES = [
  "Parsing BOM…",
  "Extracting line items…",
  "Matching catalog parts…",
  "Applying pricing rules…",
];

function QuotationBuilder() {
  const [company, setCompany] = useState<Company | null>(null);
  const [rules, setRules] = useState<PricingRules | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);

  const [file, setFile] = useState<File | null>(null);
  const [customer, setCustomer] = useState("Walk-in Customer");
  const [tier, setTier] = useState("contractor-a");
  const [dragOver, setDragOver] = useState(false);

  const [loading, setLoading] = useState(false);
  const [stageIdx, setStageIdx] = useState(0);
  const [quoteError, setQuoteError] = useState<string | null>(null);

  const [quotation, setQuotation] = useState<Quotation | null>(null);
  const [matched, setMatched] = useState<MatchedLine[]>([]);
  const [pricedLines, setPricedLines] = useState<QuoteLine[]>([]);
  const [pdfLoading, setPdfLoading] = useState(false);

  useEffect(() => {
    fetchConfig()
      .then(({ company: c, rules: r }) => {
        setCompany(c);
        setRules(r);
        const keys = Object.keys(r.tiers);
        if (keys.length && !keys.includes(tier)) setTier(keys[0]);
      })
      .catch((e) => setConfigError(e instanceof Error ? e.message : "Failed to load config"));
  }, [tier]);

  useEffect(() => {
    if (!loading) return;
    const id = setInterval(() => setStageIdx((i) => (i + 1) % STAGES.length), 4000);
    return () => clearInterval(id);
  }, [loading]);

  const totals = useMemo(() => {
    if (!rules || !company) return null;
    return computeTotals(pricedLines, rules, company.currency);
  }, [pricedLines, rules, company]);

  const acceptFile = useCallback((f: File) => {
    const ext = f.name.toLowerCase();
    if (!ext.endsWith(".xlsx") && !ext.endsWith(".pdf")) return;
    setFile(f);
    setQuoteError(null);
  }, []);

  const onGenerate = async () => {
    if (!file) return;
    setLoading(true);
    setStageIdx(0);
    setQuoteError(null);
    setQuotation(null);
    setMatched([]);
    setPricedLines([]);
    try {
      const result = await postQuote(file, tier, customer);
      setQuotation(result.quotation);
      setMatched(result.matched);
      setPricedLines(result.quotation.lines);
    } catch (e) {
      setQuoteError(e instanceof Error ? e.message : "Quote generation failed");
    } finally {
      setLoading(false);
    }
  };

  const repriceLine = async (updated: MatchedLine) => {
    const ql = await postPrice(updated, tier, customer);
    setPricedLines((prev) => {
      if (!ql) return prev.filter((l) => l.lineNo !== updated.line.lineNo);
      const idx = prev.findIndex((l) => l.lineNo === ql.lineNo);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = ql;
        return next;
      }
      return [...prev, ql].sort((a, b) => a.lineNo - b.lineNo);
    });
  };

  const onOverride = async (lineNo: number, chosen: MatchCandidate) => {
    const row = matched.find((m) => m.line.lineNo === lineNo);
    if (!row) return;
    const updated: MatchedLine = {
      ...row,
      chosen,
      status: "matched",
      confirmedByUser: true,
    };
    setMatched((prev) => prev.map((m) => (m.line.lineNo === lineNo ? updated : m)));
    void postConfirm(row.line.normalized, chosen.code);
    await repriceLine(updated);
  };

  const onDownloadPdf = async () => {
    setPdfLoading(true);
    try {
      const blob = await downloadQuotePdf(matched, tier, customer);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${quotation?.quoteNo ?? "quotation"}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setQuoteError(e instanceof Error ? e.message : "PDF download failed");
    } finally {
      setPdfLoading(false);
    }
  };

  const tierOptions = rules ? Object.entries(rules.tiers) : [];

  return (
    <div className="app">
      <header className="header">
        <div>
          <h1>Quotation Builder</h1>
          <p className="subtitle">BOM upload → match → price → PDF</p>
        </div>
        {company && (
          <div className="company">
            <strong>{company.logoText}</strong>
            <br />
            {company.name}
          </div>
        )}
      </header>

      {configError && <div className="error">{configError}</div>}

      <section className="card">
        <h2>Upload BOM</h2>
        <div
          className={`dropzone ${dragOver ? "dragover" : ""} ${file ? "has-file" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const f = e.dataTransfer.files[0];
            if (f) acceptFile(f);
          }}
          onClick={() => document.getElementById("bom-file")?.click()}
        >
          <p>Drop an Excel or PDF BOM here, or click to browse</p>
          {file && <p className="filename">{file.name}</p>}
          <input
            id="bom-file"
            type="file"
            accept=".xlsx,.pdf"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) acceptFile(f);
            }}
          />
        </div>

        <div className="form-row">
          <div className="field">
            <label htmlFor="customer">Customer</label>
            <input
              id="customer"
              value={customer}
              onChange={(e) => setCustomer(e.target.value)}
              placeholder="Customer name"
            />
          </div>
          <div className="field">
            <label htmlFor="tier">Pricing tier</label>
            <select id="tier" value={tier} onChange={(e) => setTier(e.target.value)}>
              {tierOptions.map(([key, t]) => (
                <option key={key} value={key}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <button
          className="btn btn-primary"
          disabled={!file || loading || !rules}
          onClick={() => void onGenerate()}
        >
          Generate quote
        </button>

        {loading && (
          <div className="loading">
            <div className="spinner" />
            <span>{STAGES[stageIdx]}</span>
          </div>
        )}
        {quoteError && <div className="error">{quoteError}</div>}
      </section>

      {quotation && matched.length > 0 && (
        <>
          <p className="quote-meta">
            Quote <strong>{quotation.quoteNo}</strong> · {quotation.date} · valid until{" "}
            {quotation.validUntil}
          </p>

          <div className="layout-bottom">
            <section className="card">
              <h2>Review matches</h2>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Status</th>
                      <th>Qty</th>
                      <th>Description</th>
                      <th>Matched part</th>
                      <th>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {matched.map((row) => (
                      <ReviewRow
                        key={row.line.lineNo}
                        row={row}
                        currency={company?.currency ?? "LKR"}
                        priced={pricedLines.find((l) => l.lineNo === row.line.lineNo)}
                        onOverride={(chosen) => void onOverride(row.line.lineNo, chosen)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            {totals && (
              <section className="card">
                <h2>Summary</h2>
                <div className="summary">
                  <div className="summary-row">
                    <span className="label">Subtotal</span>
                    <span>{formatMoney(totals.subtotal, totals.currency)}</span>
                  </div>
                  {totals.discountTotal > 0 && (
                    <div className="summary-row">
                      <span className="label">Total savings</span>
                      <span className="savings">
                        −{formatMoney(totals.discountTotal, totals.currency)}
                      </span>
                    </div>
                  )}
                  {totals.taxes.map((t) => (
                    <div key={t.label} className="summary-row">
                      <span className="label">
                        {t.label} ({Math.round(t.rate * 100)}%)
                      </span>
                      <span>{formatMoney(t.amount, totals.currency)}</span>
                    </div>
                  ))}
                  <div className="summary-row total">
                    <span>Grand total</span>
                    <span>{formatMoney(totals.grandTotal, totals.currency)}</span>
                  </div>
                </div>

                <div className="actions">
                  <button
                    className="btn btn-primary"
                    disabled={pdfLoading || pricedLines.length === 0}
                    onClick={() => void onDownloadPdf()}
                  >
                    {pdfLoading ? "Generating…" : "Download quotation PDF"}
                  </button>
                </div>
              </section>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: MatchedLine["status"] }) {
  const map = {
    matched: { cls: "pill-matched", label: "✓ Matched" },
    review: { cls: "pill-review", label: "? Review" },
    unmatched: { cls: "pill-unmatched", label: "✗ Unmatched" },
  };
  const { cls, label } = map[status];
  return <span className={`pill ${cls}`}>{label}</span>;
}

function ReviewRow({
  row,
  currency,
  priced,
  onOverride,
}: {
  row: MatchedLine;
  currency: string;
  priced?: QuoteLine;
  onOverride: (chosen: MatchCandidate) => void;
}) {
  const [search, setSearch] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<MatchCandidate[]>([]);
  const [showSearch, setShowSearch] = useState(false);

  const needsOverride = row.status === "review" || row.status === "unmatched";

  const runSearch = async () => {
    if (!search.trim()) return;
    setSearching(true);
    try {
      const candidates = await postMatch(search.trim());
      setSearchResults(candidates);
    } finally {
      setSearching(false);
    }
  };

  const chosen = row.chosen;

  return (
    <tr>
      <td>
        <StatusPill status={row.status} />
      </td>
      <td className="qty-unit">
        {row.line.qty} {row.line.unit}
      </td>
      <td className="line-desc">{row.line.normalized}</td>
      <td>
        {chosen ? (
          <>
            <div className="part-code">{chosen.code}</div>
            <div>{chosen.description}</div>
            <div className="part-brand">{chosen.brand}</div>
            <div className="confidence">
              <div className="confidence-bar">
                <div
                  className="confidence-fill"
                  style={{ width: `${Math.round(chosen.confidence * 100)}%` }}
                />
              </div>
              <span className="confidence-pct">{Math.round(chosen.confidence * 100)}%</span>
            </div>
          </>
        ) : (
          <span className="part-brand">No match</span>
        )}

        {needsOverride && (
          <>
            <select
              className="override-select"
              value=""
              onChange={(e) => {
                const code = e.target.value;
                if (!code) return;
                const alt = row.alternatives.find((a) => a.code === code);
                if (alt) onOverride(alt);
              }}
            >
              <option value="">Override from suggestions…</option>
              {row.alternatives.map((a) => (
                <option key={a.code} value={a.code}>
                  {a.code} — {a.brand} ({Math.round(a.confidence * 100)}%)
                </option>
              ))}
            </select>

            {!showSearch ? (
              <button
                type="button"
                className="btn btn-secondary"
                style={{ marginTop: 6, padding: "4px 10px", fontSize: "0.75rem" }}
                onClick={() => setShowSearch(true)}
              >
                Search catalog
              </button>
            ) : (
              <div className="search-row">
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search catalog…"
                  onKeyDown={(e) => e.key === "Enter" && void runSearch()}
                />
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={searching}
                  onClick={() => void runSearch()}
                >
                  {searching ? "…" : "Go"}
                </button>
              </div>
            )}
            {searchResults.length > 0 && (
              <div className="search-results">
                {searchResults.map((c) => (
                  <button
                    key={c.code}
                    type="button"
                    className="search-result"
                    onClick={() => {
                      onOverride(c);
                      setSearchResults([]);
                      setShowSearch(false);
                    }}
                  >
                    <span className="part-code">{c.code}</span> — {c.description} ({c.brand},{" "}
                    {Math.round(c.confidence * 100)}%)
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </td>
      <td className="line-total">
        {priced ? formatMoney(priced.lineTotal, currency) : "—"}
      </td>
    </tr>
  );
}
