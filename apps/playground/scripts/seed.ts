/**
 * Seed the 30 LK fashion products into Porulle (the commerce backend).
 *
 * Reads the eval subset (structured fields) + the source snapshots (image URLs),
 * keyed by the same ids, and creates each as a published Porulle catalog entity
 * with a base price. Run: bun --env-file=.env scripts/seed.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createKernel, ensureDefaultOrg, DEFAULT_ORG_ID, type Actor } from "@porulle/core";
import configPromise from "../commerce.config.ts";

const SUBSET = join(import.meta.dir, "..", "..", "..", "examples", "shop-search", "datasets", "lk-snapshot-subset");

type Product = { id: string; title: string; brand: string; category: string; colors: string[]; material: string; price: number; available: boolean };

// price_numeric is unreliable (commas truncate "21,320.31" -> 21); re-parse the
// price string when it looks junk, and treat genuinely unpriced items as null.
function parsePrice(r: Record<string, unknown>): number | null {
  const num = typeof r.price_numeric === "number" ? r.price_numeric : null;
  if (num != null && num >= 200) return num;
  const m = String(r.price ?? "").match(/(?:LKR\s*)?([\d,]+(?:\.\d+)?)/);
  if (m) {
    const n = Math.round(Number(m[1]!.replace(/,/g, "")));
    if (n >= 200) return n;
  }
  return null; // no usable price -> skip
}

function sourceMeta(): Record<string, { imageUrl: string; price: number | null }> {
  const dir = join(SUBSET, "source");
  const out: Record<string, { imageUrl: string; price: number | null }> = {};
  for (const file of readdirSync(dir).filter((f) => /^q\d+\.json$/.test(f))) {
    const key = file.replace(".json", "");
    const snap = JSON.parse(readFileSync(join(dir, file), "utf8")) as { results: Record<string, unknown>[] };
    snap.results.forEach((r, i) => {
      out[`${key}-${i + 1}`] = { imageUrl: r.image ? String(r.image) : "", price: parsePrice(r) };
    });
  }
  return out;
}

async function main() {
  const config = await configPromise;
  const kernel = createKernel(config);
  await ensureDefaultOrg(kernel.database.db, config.storeName);

  const staff: Actor = {
    type: "user",
    userId: "seed-admin",
    email: "admin@samesake.dev",
    name: "Seed Admin",
    vendorId: null,
    organizationId: DEFAULT_ORG_ID,
    role: "owner",
    permissions: ["*:*"],
  };

  const { products } = JSON.parse(readFileSync(join(SUBSET, "corpus.json"), "utf8")) as { products: Product[] };
  const meta = sourceMeta();

  let created = 0;
  let skipped = 0;
  for (const p of products) {
    const m = meta[p.id] ?? { imageUrl: "", price: null };
    if (m.price == null) {
      skipped++;
      console.warn(`  skip ${p.id} (no usable price): ${p.title}`);
      continue;
    }
    const res = await kernel.services.catalog.create(
      {
        type: "product",
        slug: p.id,
        status: "draft",
        attributes: { title: p.title },
        metadata: { brand: p.brand },
        customFields: {
          material: p.material || "",
          color: p.colors[0] ?? "",
          category: p.category || "other",
          imageUrl: m.imageUrl,
        },
      },
      staff
    );
    if (!res.ok) {
      skipped++;
      console.warn(`  skip ${p.id}: ${res.error?.message ?? res.error}`);
      continue;
    }
    const id = res.value.id;
    await kernel.services.pricing.setBasePrice({ entityId: id, currency: "LKR", amount: m.price }, staff);
    if (p.available) await kernel.services.catalog.publish(id, staff);
    created++;
  }

  console.log(`seeded ${created}/${products.length} products into Porulle (skipped: ${skipped})`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
