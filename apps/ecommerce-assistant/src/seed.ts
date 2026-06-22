#!/usr/bin/env bun
import { getMatcher, PROJECT, PRODUCTS, BRANDS, products, brands } from "./samesake.ts";

// Loads the same demo data the Weaviate recipe uses — the public weaviate/agents datasets on
// Hugging Face — via the datasets-server REST API (no Python / datasets lib needed), then
// applies the collections, pushes the rows, and builds the embeddings + FTS indexes.
const HF = "https://datasets-server.huggingface.co/rows";

async function fetchRows(config: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (let offset = 0; ; offset += 100) {
    const url = `${HF}?dataset=weaviate%2Fagents&config=${config}&split=train&offset=${offset}&length=100`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HF ${config} ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const json = (await res.json()) as { rows: { row: { properties: Record<string, unknown> } }[]; num_rows_total: number };
    out.push(...json.rows.map((r) => r.row.properties));
    if (out.length >= json.num_rows_total || json.rows.length === 0) break;
  }
  return out;
}

async function main() {
  const matcher = getMatcher();

  console.log("[seed] applying collections…");
  await matcher.apply(PROJECT, { entities: [], collections: [products, brands] });

  console.log("[seed] fetching datasets from Hugging Face…");
  const [ecommerceRows, brandRows] = await Promise.all([
    fetchRows("query-agent-ecommerce"),
    fetchRows("query-agent-brands"),
  ]);
  console.log(`[seed] products=${ecommerceRows.length} brands=${brandRows.length}`);

  await matcher.pushDocuments(
    PROJECT,
    PRODUCTS,
    ecommerceRows.map((p) => ({ id: String(p.product_id), data: p }))
  );
  await matcher.pushDocuments(
    PROJECT,
    BRANDS,
    brandRows.map((b) => ({ id: String(b.name), data: b }))
  );

  console.log("[seed] indexing (embeddings + FTS) — this calls gemini-embedding-2 per doc…");
  await matcher.index(PROJECT, PRODUCTS);
  await matcher.index(PROJECT, BRANDS);

  console.log("[seed] done.");
  await matcher.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
