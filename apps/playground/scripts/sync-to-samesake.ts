/**
 * Sync the Porulle catalog into samesake and index it.
 *
 * Reads active products straight from Porulle's tables (entity + attributes + base price
 * + custom fields), maps them to samesake documents, applies the collection, pushes, and
 * indexes. Ends with a sample query so you can see search working end-to-end.
 *
 * (The same data is also readable over Porulle's REST API at
 *  GET /api/catalog/entities?status=active&include=attributes,pricing — direct SQL is used
 *  here for a dependency-free one-shot sync.)
 *
 * Run: bun --env-file=.env scripts/sync-to-samesake.ts
 */
import postgres from "postgres";
import { getMatcher, products, PROJECT, COLLECTION } from "../lib/samesake";

async function main() {
  const sql = postgres(process.env.DATABASE_URL!, { max: 4 });

  const rows = await sql<
    { id: string; slug: string; title: string | null; metadata: Record<string, unknown> | null; price: number | null }[]
  >`
    SELECT e.id, e.slug, a.title, e.metadata,
      (SELECT amount FROM prices p WHERE p.entity_id = e.id AND p.variant_id IS NULL LIMIT 1) AS price
    FROM sellable_entities e
    LEFT JOIN sellable_attributes a ON a.entity_id = e.id AND a.locale = 'en'
    WHERE e.status = 'active'
  `;

  const cfRows = await sql<{ entity_id: string; field_name: string; text_value: string | null }[]>`
    SELECT entity_id, field_name, text_value FROM sellable_custom_fields
  `;
  const cf = new Map<string, Record<string, string>>();
  for (const r of cfRows) {
    const m = cf.get(r.entity_id) ?? {};
    m[r.field_name] = r.text_value ?? "";
    cf.set(r.entity_id, m);
  }

  const docs = rows.map((r) => {
    const fields = cf.get(r.id) ?? {};
    return {
      id: r.slug,
      data: {
        title: r.title ?? "",
        brand: String(r.metadata?.brand ?? "unknown"),
        category: fields.category || "other",
        color: fields.color || "",
        material: fields.material || "",
        price: r.price ?? 0,
        available: true,
        image_url: fields.imageUrl || "",
      },
    };
  });
  await sql.end();

  console.log(`read ${docs.length} active products from Porulle`);

  const matcher = getMatcher();
  await matcher.migrate(); // create samesake system tables (samesake_projects, ...) if absent
  await matcher.apply(PROJECT, { entities: [], collections: [products] });
  await matcher.pushDocuments(PROJECT, COLLECTION, docs);

  // Vision enrichment — read colours/pattern off each product image (samesake enrich pipeline).
  console.log("enriching (vision)...");
  for (let pass = 0; pass < 5; pass++) {
    const e = await matcher.enrich(PROJECT, COLLECTION, { concurrency: 6, limit: docs.length });
    console.log(`  enrich pass ${pass}: enriched=${e.enriched} failed=${e.failed}`);
    if (e.enriched === 0) break;
  }

  const indexed = await matcher.index(PROJECT, COLLECTION);
  console.log(`indexed into samesake:`, indexed);

  // sample query — proves Porulle -> samesake -> hybrid search end-to-end
  const result = await matcher.search(PROJECT, COLLECTION, {
    q: "linen shirt",
    filters: { available: true },
    limit: 5,
  });
  console.log(
    `\nsample search "linen shirt":\n` +
      result.hits.map((h) => `  ${h.id}  ${h.data.title}  (LKR ${h.data.price})`).join("\n")
  );

  await matcher.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
