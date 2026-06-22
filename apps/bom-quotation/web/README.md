# BOM Quotation — Web UI

TanStack Start frontend for the BOM → quotation pipeline.

## Prerequisites

- API env vars in the repo-root `.env`: `DATABASE_URL`, `GEMINI_API_KEY`
- Catalog bootstrapped: `bun run setup` (from `apps/bom-quotation`)

## Run

Terminal 1 — API on port **3001**:

```bash
cd apps/bom-quotation
bun run serve
```

Wait for `✓ catalog ready` and `▶ BOM-quotation API on http://localhost:3001`.

Terminal 2 — web on port **3000**:

```bash
cd apps/bom-quotation/web
bun install
bun run dev
```

Open http://localhost:3000. Vite proxies `/api/*` to the Hono server.

## Scripts

| Command | Purpose |
|---------|---------|
| `bun run dev` | Vite dev server (:3000) |
| `bun run build` | Production build |
| `bun run start` | Serve production build |
| `bun run typecheck` | `tsc --noEmit` |

## Flow

1. Upload `.xlsx` or `.pdf` BOM (e.g. `data/sample-bom/bom.xlsx` after `bun run gen:bom`)
2. Set customer name and pricing tier
3. Generate quote — review matches, override uncertain lines, download PDF
