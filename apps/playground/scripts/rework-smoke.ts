// Verifies the reworked playground samesake config (fashion template) end-to-end:
// push a product with a public image → enrich (classify+extract) → index → search.
import { getMatcher, products, PROJECT, COLLECTION } from "../lib/samesake";

const IMG = "https://cdn.shopify.com/s/files/1/0020/1732/9251/files/CopyofPRO_3097.jpg?v=1774424761"; // a red dress

async function main() {
  const matcher = getMatcher();
  await matcher.migrate();
  const applied = await matcher.apply(PROJECT, { entities: [], collections: [products] });
  await matcher.pushDocuments(PROJECT, COLLECTION, [
    { id: "smoke-red-dress", data: { title: "Crimson Wrap Dress", brand: "Avirate", price: 5280, available: true, image_url: IMG } },
  ]);
  for (let i = 0; i < 4; i++) {
    const e = await matcher.enrich(PROJECT, COLLECTION, { concurrency: 2, limit: 5 });
    if (e.enriched === 0) break;
  }
  while ((await matcher.index(PROJECT, COLLECTION, { limit: 10 })).indexed > 0) {}

  const res = await matcher.search(PROJECT, COLLECTION, { q: "red dress", limit: 3 });
  const top = res.hits[0];
  console.log("top hit:", top?.id, "| category:", (top as Record<string, unknown>)?.category, "| colors:", JSON.stringify((top as Record<string, unknown>)?.colors));
  const ok = top?.id === "smoke-red-dress" && Array.isArray((top as Record<string, unknown>)?.colors) && ((top as Record<string, unknown>).colors as string[]).includes("red");
  console.log(ok ? "REWORK SMOKE OK — fashion template enriches + searches in the playground" : "REWORK SMOKE FAILED");

  // cleanup
  const { createDbFromUrl } = await import("@samesake/server");
  const { sql } = await import("drizzle-orm");
  const { db, close } = createDbFromUrl(process.env.SAMESAKE_DATABASE_URL!);
  await db.execute(sql.raw(`DELETE FROM ${applied.schema}.c_${COLLECTION} WHERE id = 'smoke-red-dress'`));
  await close();
  await matcher.close();
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
