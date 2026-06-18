"use client";

import { useState } from "react";

type Extracted = {
  id: string;
  title: string;
  imageUrl: string;
  category: string | null;
  gender: string | null;
  colors: string[];
  occasions: string[];
  styles: string[];
  material: string | null;
};

const chip = (label: string) => (
  <span key={label} style={{ display: "inline-block", padding: "2px 8px", margin: "2px", borderRadius: 999, background: "#eef", fontSize: 12 }}>{label}</span>
);

export default function UploadPage() {
  const [files, setFiles] = useState<File[]>([]);
  const [brand, setBrand] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [results, setResults] = useState<Extracted[]>([]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!files.length) return;
    setBusy(true);
    setError("");
    setResults([]);
    const fd = new FormData();
    for (const f of files) fd.append("images", f);
    if (brand.trim()) fd.append("brand", brand.trim());
    try {
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      const data = (await res.json()) as { products?: Extracted[]; error?: string };
      if (!res.ok) throw new Error(data.error || "upload failed");
      setResults(data.products ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "upload failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ maxWidth: 880, margin: "0 auto", padding: 24, fontFamily: "system-ui, sans-serif" }}>
      <p><a href="/">← Storefront</a></p>
      <h1>Upload products</h1>
      <p style={{ color: "#555" }}>
        Drop in product photos. Each runs through the samesake fashion pipeline — <b>classify → extract</b>
        {" "}(category, colors, occasions, styles, material from the image) → <b>index</b> — then it&apos;s searchable on the storefront.
      </p>

      <form onSubmit={submit} style={{ display: "grid", gap: 12, margin: "16px 0", padding: 16, border: "1px solid #ddd", borderRadius: 8 }}>
        <input
          type="file"
          accept="image/*"
          multiple
          onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
        />
        <input
          type="text"
          placeholder="Brand (optional, applied to all)"
          value={brand}
          onChange={(e) => setBrand(e.target.value)}
          style={{ padding: 8, border: "1px solid #ccc", borderRadius: 6 }}
        />
        <button type="submit" disabled={busy || !files.length} style={{ padding: "10px 16px", borderRadius: 6, border: 0, background: busy ? "#999" : "#3b3bff", color: "#fff", cursor: busy ? "default" : "pointer" }}>
          {busy ? "Enriching & indexing…" : `Upload & enrich ${files.length || ""} image${files.length === 1 ? "" : "s"}`}
        </button>
        {error && <p style={{ color: "#c00" }}>{error}</p>}
      </form>

      {results.length > 0 && (
        <>
          <h2>Extracted by the pipeline ({results.length})</h2>
          <p style={{ color: "#555" }}>These are now searchable — try them on the <a href="/">storefront</a>.</p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 16 }}>
            {results.map((p) => (
              <div key={p.id} style={{ border: "1px solid #eee", borderRadius: 8, overflow: "hidden" }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={p.imageUrl} alt={p.title} style={{ width: "100%", height: 220, objectFit: "cover" }} />
                <div style={{ padding: 10 }}>
                  <div style={{ fontWeight: 600 }}>{p.title}</div>
                  <div style={{ fontSize: 13, color: "#555", margin: "4px 0" }}>
                    {p.category ?? "?"}{p.gender ? ` · ${p.gender}` : ""}{p.material ? ` · ${p.material}` : ""}
                  </div>
                  <div>{p.colors.map((c) => chip(c))}</div>
                  <div>{p.occasions.map((o) => chip(o))}{p.styles.map((s) => chip(s))}</div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </main>
  );
}
