// Full upload loop against REAL R2: fetch a sample image → uploadPublicImage (R2 S3 PutObject)
// → confirm the public URL serves → push → enrich (classify+extract) → compose → index → search.
// Proves the whole feature with live R2 creds.
// Run:  bun --env-file=.env scripts/r2-upload-smoke.ts
import { uploadPublicImage } from "../lib/blob";
import { getMatcher, products, COLLECTION } from "../lib/samesake";
import { composeEmbedDocs, readExtractedAttrs } from "../lib/embed-doc";

const SAMPLE = "https://cdn.shopify.com/s/files/1/0020/1732/9251/files/CopyofPRO_3097.jpg?v=1774424761"; // red dress
const PROJECT = "r2smoke"; // fresh project so the smoke doesn't migrate the real playground schema

async function main() {
  // 1) get sample bytes → upload to R2 (S3 API) → public URL
  const img = await fetch(SAMPLE);
  const bytes = new Uint8Array(await img.arrayBuffer());
  const url = await uploadPublicImage("smoke-red-dress.jpg", bytes, "image/jpeg");
  console.log("R2 public URL:", url);
  let pub = 0;
  for (let i = 0; i < 8; i++) { pub = (await fetch(url, { method: "HEAD" })).status; if (pub === 200) break; await new Promise((r) => setTimeout(r, 4000)); }
  console.log("public fetch:", pub);

  // 2) push → enrich → compose → index
  const matcher = getMatcher();
  await matcher.migrate();
  const applied = await matcher.apply(PROJECT, { entities: [], collections: [products] });
  const id = "r2-smoke-red-dress";
  await matcher.pushDocuments(PROJECT, COLLECTION, [{ id, data: { title: "Uploaded Red Dress", brand: "smoke", price: 0, available: true, image_url: url } }]);
  for (let i = 0; i < 5; i++) { const e = await matcher.enrich(PROJECT, COLLECTION, { concurrency: 2, limit: 3 }); if (e.enriched === 0) break; }
  await composeEmbedDocs(applied.schema);
  while ((await matcher.index(PROJECT, COLLECTION, { limit: 10 })).indexed > 0) {}

  // 3) extracted attrs + search
  const [attrs] = await readExtractedAttrs(applied.schema, [id]);
  console.log("extracted:", JSON.stringify(attrs && { category: attrs.category, colors: attrs.colors, occasions: attrs.occasions }));
  const res = await matcher.search(PROJECT, COLLECTION, { q: "red dress", limit: 5 });
  const found = res.hits.some((h) => h.id === id);
  console.log("search 'red dress' finds the uploaded doc:", found);

  // cleanup the whole temp project (leave the R2 object; harmless)
  const { createDbFromUrl } = await import("@samesake/server");
  const { sql } = await import("drizzle-orm");
  const { db, close } = createDbFromUrl(process.env.DATABASE_URL!);
  await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${applied.schema} CASCADE`));
  await db.execute(sql.raw(`DELETE FROM samesake_projects WHERE slug = '${PROJECT}'`));
  await close();
  await matcher.close();

  const ok = pub === 200 && !!attrs && attrs.colors.includes("red") && found;
  console.log(ok ? "\nR2 UPLOAD SMOKE OK ✅ — upload→R2→enrich→index→search works end-to-end" : "\nR2 UPLOAD SMOKE FAILED");
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
