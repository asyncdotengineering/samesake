# BOM → Quotation (electrical / MEP)

A **lift-and-shift** quotation engine for a materials distributor. A contractor emails
a Bill of Quantities (PDF or Excel) full of trade shorthand — `3C x 2.5 sqmm Cu/PVC`,
`32A SP MCB`, `ELCB 40A`, `coil` — and this turns it into a priced, branded quotation
PDF in one pass: parse → extract → normalize → **match (samesake)** → price → quote.

To make it *any* company's: edit three JSON files — `data/company.json`,
`data/catalog.json`, `data/pricing-rules.json`. No code changes.

## Why matching is the hard part (and why samesake)

A BOM line isn't a search — it's **canonical resolution**: "this line *is* part #X, ±confidence."
Plain keyword/FTS is weak on codes and abbreviations. This uses samesake's **entity
resolution**: cosine over the description embedding **+ pg_trgm** over the normalized
name (codes / part numbers / prefix-suffix), with **spec-gating** (a 32 A query never
auto-matches a 40 A part) and **confidence thresholds** (auto-quote / human-review /
reject). Human confirmations feed back via `confirm`/`decline`.

## Pipeline

```
BOM (PDF / XLSX)
 → parse       server/src/pipeline/parse.ts      PDF: @llamaindex/liteparse · XLSX: SheetJS
 → extract     server/src/pipeline/extract.ts    LLM: messy rows → clean line items
 → normalize   server/src/pipeline/normalize.ts  LLM + rules: expand abbrev, parse specs, units
 → match       server/src/pipeline/match.ts      samesake entity resolution + spec gate + thresholds
 → price       server/src/pipeline/price.ts      company rules engine (declarative, auditable)
 → quote       server/src/pipeline/quote.ts      assemble totals + quotation PDF (pdf-lib)
```

## Run

Requires `SAMESAKE_DATABASE_URL` (Postgres + pgvector) and `GEMINI_API_KEY` — already in the
repo-root `.env`.

```bash
cd apps/bom-quotation
bun install
bun run gen:bom     # write data/sample-bom/bom.{xlsx,pdf} (a realistic messy client BOM)
bun run setup       # apply the entity schema + embed the catalog (run after editing catalog.json)
bun run quote       # quote the sample BOM → console summary + data/quote-output.{pdf,json}
bun run quote data/sample-bom/bom.pdf   # …or quote the PDF

bun run serve       # Hono API on :3001  (frontend lives in ./web)
```

### Scanned / image-only PDFs

Text-based PDFs and spreadsheets parse exactly. **Image-only / scanned PDFs are OCR'd**
(liteparse bundles Tesseract) — verified end to end: descriptions extract cleanly and still
match (15/16 on a rasterised sample). The known limit: a scanned *table* loses its column
structure under OCR, so **quantities from a scan are unreliable and should be reviewed**
before sending the quote. For accurate quantities, prefer the original spreadsheet or a
text PDF.

## The lift-and-shift surface

| File | What it controls |
|---|---|
| `data/company.json` | letterhead, currency, contact, registration |
| `data/catalog.json` | every part: code, description, brand, category, unit, list price, lead time, **specs** (for gating), aliases |
| `data/pricing-rules.json` | customer tiers, category markups, brand margins, quantity breaks, taxes, validity, **match thresholds** |

The rules engine (`price.ts`) interprets that JSON; it never changes per company. Every
number on the quote carries a trace of which rules fired (audit).

## API (Hono)

| Route | Purpose |
|---|---|
| `POST /api/quote` | multipart `file` → `{ quotation, matched }` |
| `POST /api/match` | `{ text }` → candidate parts (manual-override picker) |
| `POST /api/confirm` | `{ queryText, chosenCode }` → teaches the matcher |
| `POST /api/quote/pdf` | (edited) matched lines → quotation PDF |
| `GET  /api/config` · `GET /api/catalog` | config + catalog for the UI |

Frontend: **TanStack Start** in `./web` — upload, review/override matches with confidence
badges, live totals, download PDF.

## Going deeper

- [**Getting started**](./docs/getting-started.md) — a plain-language walkthrough of how the
  app *thinks*, from a parts list to a price. Start here if the README jargon moved too fast.
- [**Rule packs**](./docs/rule-packs.md) — write your business (attributes, synonyms,
  matching, pricing) as an editable file; covers both the catalogue and the catalogue-less
  (price-by-rules) modes and how to save a pack to the DB.
- [**Thought process**](./docs/thought-process.md) — the design reasoning, the calibration
  story (1/16 → 15/16), the bugs the build phase missed, and how the rule packs were built.
- [**Architecture decisions**](./docs/adr/) — the formal records: entity resolution for
  matching, the layered pipeline, config-as-data / rule packs, and the rule-pack implementation.
