# bom-web implementation notes

## Decisions

- **Single route** (`src/routes/index.tsx`) — entire UX on one page per brief; no extra routes.
- **Live totals** — client `computeTotals()` mirrors `assembleQuotation` in `server/src/pipeline/quote.ts`; line prices refreshed via `POST /api/price` on override.
- **Override flow** — alternatives `<select>` + catalog search (`POST /api/match`); each override fires `POST /api/confirm` for matcher learning.
- **Vite 8 native tsconfig paths** — dropped `vite-tsconfig-paths`; `resolve.tsconfigPaths: true` only.
- **`strictPort: true`** — dev fails loudly if :3000 taken (avoids silent collision with API on :3001).
- **`routeTree.gen.ts` committed** — required for `tsc --noEmit` before first `vite` run.

## Deviations

None from brief.

## Verification (2026-06-22)

| Check | Result |
|-------|--------|
| `bun install` in `web/` | exit 0 |
| `bun run typecheck` | exit 0 |
| `bun run dev` | Vite 8.0.16 ready on :3000, no errors |
| `GET /` via :3000 | HTML with "Quotation Builder" |
| `GET /api/config` via proxy | company + tiers JSON |
| `POST /api/quote` bom.xlsx via proxy | 200, 16 matched, grand total 284981.21 |
| Browser UI | not driven — curl/API only |
| `bun run build` | see proof |
