// Hono API. Single long-lived matcher (catalog loaded once on boot); the frontend
// uploads a BOM, reviews/overrides matches, and downloads the quotation PDF.
import { Hono } from "hono";
import { cors } from "hono/cors";
import { writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnv, company, rules, catalog, PROJECT, SCOPE, ENTITY_KIND } from "./config.ts";
import { makeMatcher, setupCatalog, matchLine, buildCodeIndex, entityIdForCode } from "./catalog.ts";
import { activePack, setActivePack } from "./rulepack/load.ts";
import { ensureTable, loadRulePackForCompany, saveRulePack } from "./rulepack/store.ts";
import { RulePackSchema } from "./rulepack/schema.ts";
import { runPipeline } from "./pipeline/index.ts";
import { buildQuotation, renderQuotationPdf } from "./pipeline/quote.ts";
import { priceLine } from "./pipeline/price.ts";
import type { CustomerRef, MatchedLine, Quotation } from "../../shared/types.ts";

loadEnv();
const url = process.env.DATABASE_URL;
if (!url || !process.env.GEMINI_API_KEY) {
  console.error("DATABASE_URL and GEMINI_API_KEY are required");
  process.exit(1);
}

const matcher = makeMatcher(url);
// A company's pack (if saved) overrides the bundled default, and decides whether we
// even need a catalog.
await ensureTable(url);
const dbPack = await loadRulePackForCompany(url, PROJECT);
if (dbPack) setActivePack(dbPack);
if (activePack().pricing.strategy === "catalog") {
  console.log("Loading catalog …");
  const { schema } = await setupCatalog(matcher);
  await buildCodeIndex(url, schema);
}
console.log(`✓ ready (${activePack().pricing.strategy} pricing)`);

const app = new Hono();
app.use("/api/*", cors());

app.get("/api/config", (c) => c.json({ company: company(), rules: rules() }));
app.get("/api/catalog", (c) => c.json(catalog()));

// The active rule pack — read it, or replace it (validated + persisted to the DB).
app.get("/api/rulepack", (c) => c.json(activePack()));
app.put("/api/rulepack", async (c) => {
  const parsed = RulePackSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid rule pack", issues: parsed.error.issues }, 400);
  await saveRulePack(url, PROJECT, parsed.data);
  setActivePack(parsed.data);
  return c.json({ ok: true, strategy: parsed.data.pricing.strategy });
});

// Upload a BOM (multipart "file") → full quote + per-line match detail.
app.post("/api/quote", async (c) => {
  const body = await c.req.parseBody();
  const file = body.file;
  const tier = (body.tier as string) || "contractor-a";
  const customerName = (body.customer as string) || "Walk-in Customer";
  if (!(file instanceof File)) return c.json({ error: "file is required (multipart 'file')" }, 400);

  const dir = join(tmpdir(), "bom-quotation");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, file.name || "bom.xlsx");
  writeFileSync(path, Buffer.from(await file.arrayBuffer()));

  const customer: CustomerRef = { id: customerName.toLowerCase().replace(/\s+/g, "-"), name: customerName, tier };
  const { quotation, matched } = await runPipeline(matcher, path, customer, company());
  return c.json({ quotation, matched });
});

// Look up candidates for a single line (the manual-override picker in the UI).
app.post("/api/match", async (c) => {
  const { text, limit } = await c.req.json<{ text: string; limit?: number }>();
  return c.json({ candidates: await matchLine(matcher, text, limit ?? 6) });
});

// Persist a human decision so future matches learn from it.
app.post("/api/confirm", async (c) => {
  const { queryText, chosenCode } = await c.req.json<{ queryText: string; chosenCode: string | null }>();
  const entityId = chosenCode ? entityIdForCode(chosenCode) : null;
  if (entityId) {
    await matcher.confirm({ project: PROJECT, kind: ENTITY_KIND, queryText, scope: SCOPE, chosenEntityId: entityId });
    return c.json({ ok: true, confirmed: chosenCode });
  }
  // null (declined all) or unknown code — nothing to learn; succeed as a no-op.
  return c.json({ ok: true, confirmed: null });
});

// Re-assemble a quote from (possibly user-edited) matched lines and stream a PDF.
app.post("/api/quote/pdf", async (c) => {
  const { matched, tier, customer } = await c.req.json<{
    matched: MatchedLine[];
    tier: string;
    customer: string;
  }>();
  const cust: CustomerRef = { id: customer.toLowerCase().replace(/\s+/g, "-"), name: customer, tier };
  const now = new Date();
  const quoteNo = `Q-${now.toISOString().slice(0, 10).replace(/-/g, "")}-${(now.getTime() % 9000) + 1000}`;
  const pr = activePack().pricing;
  const priced = matched.filter((m) => m.status === "matched" && m.chosen).map((m) => priceLine(m, cust, pr));
  const unresolved = matched.filter((m) => m.status !== "matched");
  const quotation: Quotation = buildQuotation(priced, unresolved, company(), cust, pr, quoteNo, now);
  const pdf = await renderQuotationPdf(quotation);
  return new Response(Buffer.from(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${quoteNo}.pdf"`,
    },
  });
});

// Re-price a single overridden line (UI live-updates totals).
app.post("/api/price", async (c) => {
  const { line, tier, customer } = await c.req.json<{ line: MatchedLine; tier: string; customer: string }>();
  const cust: CustomerRef = { id: customer, name: customer, tier };
  return c.json({ quoteLine: line.chosen ? priceLine(line, cust, activePack().pricing) : null });
});

const port = Number(process.env.PORT ?? 3001);
console.log(`▶ BOM-quotation API on http://localhost:${port}`);
export default { port, fetch: app.fetch };
