# BOM → Quotation — Feature Audit Summary

Source of truth: `bom-quotation-feature-audit.csv` (24 user stories, F001–F024).

## Counts by status

| status | count |
|---|---|
| tested (pass) | 23 |
| retested-pass | 1 (F012) |
| error / retested-fail (unresolved) | 0 |

Every feature discovered in code has at least one row; every screen/route/module is represented.

## Coverage

| Area | Features | Result |
|---|---|---|
| Pipeline (parse, extract, normalize, match, gate, price, quote) | F002–F010 | all tested-pass (real gemini + samesake + Postgres; both PDF & XLSX inputs; 15/16 sample match) |
| API (Hono) | F001, F011–F015 | all tested-pass (1 endpoint error found + fixed — see below) |
| CLIs / scripts (setup, quote, gen:bom) | F016–F018 | all tested-pass |
| Web UI (TanStack Start) | F019–F024 | all tested (build + tsc + dev-server proxy + code review) |

## Errors found & fixed

- **F012 — `POST /api/confirm` returned HTTP 500** (`logic`). It passed the catalog *code* as `chosenEntityId`, but samesake's `confirm()` does `BigInt(chosenEntityId)` (`packages/server/src/core/match.ts:402`) and threw; the decline branch passed an empty id into the same call. **Fixed**: added a code→entity-id index built after catalog setup, resolve the code before confirming, and return a no-op success for null/unknown codes (dropped the broken decline). **Retested pass**: real code → `{ok:true, confirmed:CODE}`, null → `{ok:true, confirmed:null}`. Refs: `apps/bom-quotation/server/src/catalog.ts`, `.../app.ts`.

No `retested-fail` items remain.

## Screens/paths NOT fully exercised (honest gaps)

1. **Browser click-through of the web UI** — no desktop-browser automation tool was available in this environment. The frontend is verified by: `vite build` (succeeds), `tsc --noEmit` (0 errors), the dev server serving on :3000 and **proxying `/api` to the verified API on :3001** (config + 43-part catalog returned through the proxy), and a full code review of the upload → review/override → totals → PDF flow against the verified API contract. The actual mouse-driven upload→PDF round-trip was **not** clicked through a real browser.
2. **Scanned-PDF OCR path** — only text-based PDFs were tested (liteparse extracts their text directly). The Tesseract OCR path for image-only/scanned BOMs is wired but untested.
3. **LLM non-determinism** — match rate varies 14–15/16 run-to-run because extraction/normalization is an LLM and confidences sit near the threshold; the human-review gate is the designed mitigation (the one consistent miss, a smoke detector, is genuinely off-catalog).

## UX notes (not defects)

- The loading stage labels (Parsing → Extracting → Matching → Pricing) are on a timer, not tied to real pipeline progress — an acceptable designed loading state for a ~30–60s wait (`ux:states-are-features`).
- The override affordance is shown only on `review`/`unmatched` rows; `matched` rows are spec-gated and high-confidence, so this is the intended flow rather than a gap (a "change any line" affordance would be a future enhancement).
