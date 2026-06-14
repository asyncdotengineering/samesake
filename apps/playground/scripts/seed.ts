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

const SUBSET = join(import.meta.dir, "..", "..", "..", "examples", "fashion-search", "datasets", "lk-snapshot-subset");

type Product = { id: string; title: string; brand: string; category: string; colors: string[]; material: string; price: number; available: boolean };

function imageById(): Record<string, string> {
  const dir = join(SUBSET, "source");
  const out: Record<string, string> = {};
  for (const file of readdirSync(dir).filter((f) => /^q\d+\.json$/.test(f))) {
    const key = file.replace(".json", "");
    const snap = JSON.parse(readFileSync(join(dir, file), "utf8")) as { results: Record<string, unknown>[] };
    snap.results.forEach((r, i) => {
      if (r.image) out[`${key}-${i + 1}`] = String(r.image);
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
  const images = imageById();

  let created = 0;
  let failed = 0;
  for (const p of products) {
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
          imageUrl: images[p.id] ?? "",
        },
      },
      staff
    );
    if (!res.ok) {
      failed++;
      console.warn(`  skip ${p.id}: ${res.error?.message ?? res.error}`);
      continue;
    }
    const id = res.value.id;
    await kernel.services.pricing.setBasePrice({ entityId: id, currency: "LKR", amount: p.price }, staff);
    if (p.available) await kernel.services.catalog.publish(id, staff);
    created++;
  }

  console.log(`seeded ${created}/${products.length} products into Porulle (failed: ${failed})`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
