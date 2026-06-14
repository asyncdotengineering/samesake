"use client";

import { useEffect, useMemo, useState } from "react";

type Hit = {
  id: string;
  title: string;
  brand: string;
  category: string;
  color: string;
  price: number;
  imageUrl: string;
};

const LKR = (n: number) => `LKR ${Number(n).toLocaleString("en-LK")}`;

export default function Storefront() {
  const [all, setAll] = useState<Hit[]>([]);
  const [q, setQ] = useState("");
  const [activeQ, setActiveQ] = useState("");
  const [category, setCategory] = useState<string>("");
  const [searchHits, setSearchHits] = useState<Hit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/products");
        const data = (await res.json()) as { hits: Hit[] };
        setAll(data.hits ?? []);
      } catch {
        setError("Could not load the catalog.");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const categories = useMemo(
    () => Array.from(new Set(all.map((h) => h.category).filter(Boolean))).sort(),
    [all]
  );

  async function runSearch(nextQ: string, nextCat: string) {
    setActiveQ(nextQ);
    if (!nextQ.trim()) {
      setSearchHits([]);
      return; // browse mode
    }
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ q: nextQ, category: nextCat || undefined }),
      });
      const data = (await res.json()) as { hits: Hit[] };
      setSearchHits(data.hits ?? []);
    } catch {
      setError("Search failed. Try again.");
    } finally {
      setLoading(false);
    }
  }

  const displayed = useMemo(() => {
    if (activeQ.trim()) return searchHits;
    return all.filter((h) => !category || h.category === category);
  }, [activeQ, searchHits, all, category]);

  function pickCategory(c: string) {
    const next = category === c ? "" : c;
    setCategory(next);
    if (activeQ.trim()) runSearch(activeQ, next);
  }

  return (
    <div style={{ minHeight: "100dvh" }}>
      <main style={st.shell}>
        <header style={st.masthead}>
          <div style={st.brandRow}>
            <span style={st.mark} aria-hidden />
            <span style={st.brand}>Samesake Fashion</span>
          </div>
          <h1 style={st.h1}>
            Find it by what you mean,
            <br />
            not the exact name.
          </h1>
          <p style={st.lead}>
            A Sri-Lankan apparel catalog on Porulle, searched by samesake. Budgets are understood — try
            &ldquo;party wear under 3000&rdquo;, &ldquo;linen shirt for men&rdquo;, or just browse.
          </p>

          <form
            style={st.controls}
            onSubmit={(e) => {
              e.preventDefault();
              runSearch(q, category);
            }}
          >
            <input
              className="sf-input"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search — intent, attributes, budget"
              aria-label="Search"
              style={{ flex: 1, minWidth: 260 }}
            />
            <button className="sf-btn" type="submit">
              Search
            </button>
          </form>

          <div style={st.chips}>
            <button className="sf-chip" data-active={!category} onClick={() => pickCategory(category)} type="button">
              All
            </button>
            {categories.map((c) => (
              <button key={c} className="sf-chip" data-active={category === c} onClick={() => pickCategory(c)} type="button">
                {c}
              </button>
            ))}
          </div>
        </header>

        <section>
          <div style={st.meta}>
            {error ? (
              <span style={{ color: "#9f2f2d" }}>{error}</span>
            ) : loading ? (
              <span>Loading</span>
            ) : (
              <span>
                {displayed.length} {displayed.length === 1 ? "piece" : "pieces"}
                {activeQ ? ` for “${activeQ}”` : category ? ` in ${category}` : " in the catalog"}
              </span>
            )}
          </div>

          {loading ? (
            <div className="sf-grid">
              {Array.from({ length: 8 }).map((_, i) => (
                <div className="sf-skel" key={i}>
                  <div className="sf-skel-block" style={{ aspectRatio: "3 / 4" }} />
                  <div style={{ padding: 16 }}>
                    <div className="sf-skel-block" style={{ height: 12, width: "40%", borderRadius: 4, marginBottom: 10 }} />
                    <div className="sf-skel-block" style={{ height: 14, width: "85%", borderRadius: 4 }} />
                  </div>
                </div>
              ))}
            </div>
          ) : displayed.length === 0 ? (
            <div style={st.empty}>
              <p style={st.emptyTitle}>Nothing matched.</p>
              <p style={st.emptyBody}>Try a broader phrase or a different category.</p>
            </div>
          ) : (
            <div className="sf-grid">
              {displayed.map((h, i) => (
                <article className="sf-card" key={h.id} style={{ ["--i" as string]: i }}>
                  <div className="sf-thumb">
                    {h.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={h.imageUrl} alt={h.title} loading="lazy" />
                    ) : null}
                  </div>
                  <div style={{ padding: 16 }}>
                    {h.category && <span style={st.badge}>{h.category}</span>}
                    <h3 style={st.cardTitle}>{h.title}</h3>
                    <p style={st.cardBrand}>{h.brand}</p>
                    <p style={st.price}>{LKR(h.price)}</p>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

const st: Record<string, React.CSSProperties> = {
  shell: { maxWidth: 1200, margin: "0 auto", padding: "64px 28px 110px" },
  masthead: { maxWidth: 760, marginBottom: 52 },
  brandRow: { display: "flex", alignItems: "center", gap: 10, marginBottom: 28 },
  mark: { width: 12, height: 12, borderRadius: 3, background: "var(--text-strong)", display: "inline-block" },
  brand: { fontFamily: "var(--font-mono)", fontSize: 13, letterSpacing: "0.04em", color: "var(--text-strong)" },
  h1: { fontFamily: "var(--font-display)", fontSize: 50, lineHeight: 1.04, letterSpacing: "-0.03em", color: "var(--text-strong)", fontWeight: 500 },
  lead: { marginTop: 18, fontSize: 18, color: "var(--muted)", maxWidth: 560 },
  controls: { display: "flex", gap: 10, marginTop: 30, flexWrap: "wrap" },
  chips: { display: "flex", gap: 8, marginTop: 18, flexWrap: "wrap" },
  meta: { fontFamily: "var(--font-mono)", fontSize: 12, letterSpacing: "0.03em", color: "var(--muted)", marginBottom: 22, textTransform: "uppercase" },
  empty: { border: "1px dashed var(--hairline)", borderRadius: 12, padding: "56px 28px", textAlign: "center" },
  emptyTitle: { fontFamily: "var(--font-display)", fontSize: 22, color: "var(--text-strong)" },
  emptyBody: { color: "var(--muted)", marginTop: 8 },
  badge: { display: "inline-block", fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--accent)", background: "var(--accent-bg)", borderRadius: 9999, padding: "3px 9px", marginBottom: 10 },
  cardTitle: { fontFamily: "var(--font-display)", fontSize: 16.5, lineHeight: 1.25, color: "var(--text-strong)", fontWeight: 500 },
  cardBrand: { fontSize: 13, color: "var(--muted)", marginTop: 4 },
  price: { fontFamily: "var(--font-mono)", fontSize: 14, color: "var(--text-strong)", marginTop: 10 },
};
